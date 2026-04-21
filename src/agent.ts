// src/agent.ts
import * as vscode from 'vscode';
import { CredentialManager } from './utils/credentialManager';
import { createProvider } from './providers/providerFactory';
import { AdoProvider } from './providers/adoProvider';
import { parseIntent, ParsedIntent } from './utils/intentParser';
import { formatWorkItem, formatWorkItemList, formatUserList, formatSuccess, formatError } from './utils/formatter';
import { cap, stripHtml } from './utils/strings';
import { WorkItem, WorkItemType, User } from './types';
import { enhanceTicket, enhanceComment, testAiConnection, listCopilotModels, markdownToAdoHtml, generateTasksForStory, AiConfig } from './utils/aiHelper';

export const RESULT_META_KEY = 'pmAgentMeta';

export interface PmResultMeta {
 action: string;
 itemKey?: string;
 itemStatus?: string;
 hasAssignee?: boolean;
 hasEstimate?: boolean;
 itemCount?: number;
 sprintHasUnassigned?: boolean;
 sprintHasUnestimated?: boolean;
}

interface PendingCreate {
 type?: WorkItemType;
 title?: string;
 description?: string;
 acceptanceCriteria?: string;
 priority?: string;
 storyPoints?: number;
 assigneeId?: string;
 labels?: string[];
 parentId?: string;
 sprintId?: string; // GUID — for display/identity
 sprintName?: string; // display name
 iterationPath?: string; // full path e.g. "ProjectName\Sprint 5" — used in ADO field
}

interface AgentMemory {
 lastItem?: WorkItem;
 lastAssignee?: User;
 pendingCreate?: PendingCreate;
 defaultUser?: User; // person we act on behalf of
 aiUnavailableNoted?: boolean;
}

export class PmAgent {
 private mem: AgentMemory = {};

 constructor(
 private readonly credMgr: CredentialManager,
 private readonly ctx: vscode.ExtensionContext
 ) {
 const saved = ctx.workspaceState.get<WorkItem>('lastItem');
 if (saved) { this.mem.lastItem = saved; }
 // Restore default user from secure storage on startup
 void credMgr.getDefaultUser().then(u => { if (u) { this.mem.defaultUser = u; } });
 }

 /** Check if we can actually call the model before attempting */
 private canUseModel(model: vscode.LanguageModelChat): boolean {
 try {
 const access = this.ctx.languageModelAccessInformation.canSendRequest(model);
 // undefined = consent not asked yet (will prompt), true = allowed, false = blocked
 return access !== false;
 } catch {
 return true; // if check fails, try anyway
 }
 }

 async handleRequest(
 request: vscode.ChatRequest,
 _chatCtx: vscode.ChatContext,
 stream: vscode.ChatResponseStream,
 _token: vscode.CancellationToken
 ): Promise<vscode.ChatResult> {

 if (!(await this.credMgr.isConfigured())) {
 stream.markdown(
 '**PM Agent — configuration required.**\n\n' +
 'Click below to connect Jira or Azure DevOps:'
 );
 stream.button({ command: 'pm-agent.configurePlatform', title: 'Connect Platform' });
 return { metadata: { [RESULT_META_KEY]: { action: 'unconfigured' } as PmResultMeta } };
 }

 const creds = await this.credMgr.getCredentials();
 const aiConfig = await this.credMgr.getAiConfig().catch(() => ({ provider: 'copilot' as const }));
 const provider = createProvider(creds);
 const intent = parseIntent(request.command, request.prompt.trim());
 let meta: PmResultMeta = { action: intent.kind };

 // Only pass the model if we're actually allowed to use it.
 // If Copilot engine isn't installed or access is denied, use undefined
 // so all AI calls silently skip rather than throwing.
 const copilotModelOk = aiConfig.provider === 'copilot' && this.canUseModel(request.model);
 const externalOk     = aiConfig.provider !== 'none' && aiConfig.provider !== 'copilot' && !!aiConfig.apiKey;
 const aiReady        = copilotModelOk || externalOk;
 const safeModel: vscode.LanguageModelChat | undefined = copilotModelOk ? request.model : undefined;

    // One-time note when AI is unavailable — command still runs normally
    if (!aiReady && !this.mem.aiUnavailableNoted) {
      this.mem.aiUnavailableNoted = true;
      stream.markdown(
        '_No AI model available — ticket enhancement is disabled. All commands work normally._ '
        + '`@pm /setupai` to configure Anthropic or OpenAI.\n\n'
      );
    }

 try {
 switch (intent.kind) {

 // ── SET DEFAULT USER ──────────────────────────────────────────────────
 case 'setuser': {
 meta = await this.handleSetUser(stream, provider, creds.platform);
 break;
 }

 // ── LIST ──────────────────────────────────────────────────────────────
 case 'list': {
 const q = intent.query ?? {};

 // Use the stored default user unless caller specified someone
 if (!q.type && !q.status && !q.text && !q.sprintId && !q.assigneeId) {
 if (this.mem.defaultUser) {
 q.assigneeId = this.mem.defaultUser.id;
 } else {
 stream.markdown(
 '**No default user set.**\n\n' +
 'Showing all open items this time. ' +
 'Run `@pm /setuser` to always see a specific person\'s tickets.\n'
 );
 q.status = 'open';
 }
 }
 if (!q.status && !q.assigneeId) { q.status = 'open'; }
 q.maxResults = q.maxResults ?? 25;

 const userLabel = this.mem.defaultUser?.displayName ?? 'project';
 stream.progress(`Loading ${userLabel}'s work items...`);
 const items = await provider.searchWorkItems(q);

 if (creds.platform === 'azuredevops') {
 const adoP = provider as any;
 stream.markdown(`\n_Query: \`${adoP.lastWiql}\` — **${adoP.lastRawCount}** result(s)_\n`);
 }

 if (!items.length) {
 const who = this.mem.defaultUser ? `**${this.mem.defaultUser.displayName}**` : 'the project';
 stream.markdown(
 `_No items found for ${who}._\n\n` +
 '**Try:**\n' +
 '- `@pm /setuser` — change the default user\n' +
 '- `@pm list all tasks` — all items regardless of assignee\n' +
 '- `@pm /debug` — verify API connection'
 );
 } else {
 const header = this.mem.defaultUser
 ? `**${items.length}** item${items.length !== 1 ? 's' : ''} assigned to **${this.mem.defaultUser.displayName}**:`
 : `**${items.length}** item${items.length !== 1 ? 's' : ''} in the project:`;
 stream.markdown(formatWorkItemList(items, header));
 stream.markdown('\n_Click any key to open in browser · `@pm comment AB#123` to comment · `@pm summary` for overview_');
 }
 meta = { action: 'listed', itemCount: items.length };
 break;
 }

 // ── OPEN ──────────────────────────────────────────────────────────────
 case 'open': {
 if (!intent.workItemKey) {
 stream.markdown(
 '**Which item?** Give me a key like `AB#123` or `ENG-42`.' +
 (this.mem.lastItem ? `\n\n_Last viewed: **${this.mem.lastItem.key}**_` : '')
 );
 meta = { action: 'open_missing_key' };
 break;
 }
 stream.progress(`Fetching ${intent.workItemKey}...`);
 const item = await provider.getWorkItem(intent.workItemKey);
 this.mem.lastItem = item;
 await this.ctx.workspaceState.update('lastItem', item);

 stream.markdown(formatWorkItem(item));

 if (item.comments?.length) {
 stream.markdown(
 `\n**Recent comments (${item.comments.length}):**\n` +
 item.comments.slice(-3).map((c: any) =>
 `- **${c.author}** _(${c.createdAt.slice(0, 10)})_: ${c.body.slice(0, 120)}`
 ).join('\n')
 );
 }

 stream.button({ command: 'pm-agent.openWorkItemPanel', title: 'Open Full Panel', arguments: [item] });

 const tips: string[] = [];
 if (!item.assignee) { tips.push('unassigned'); }
 if (!item.storyPoints && !item.effort) { tips.push('no estimate'); }
 if (tips.length) { stream.markdown(`\n_${tips.join(' · ')}_`); }

 meta = {
 action: 'opened', itemKey: item.key, itemStatus: item.status,
 hasAssignee: !!item.assignee, hasEstimate: !!(item.storyPoints || item.effort)
 };
 break;
 }

 // ── CREATE ────────────────────────────────────────────────────────────
 case 'create': {
 meta = await this.handleCreate(stream, provider, intent.create ?? {}, creds.platform, aiConfig, aiReady, safeModel);
 break;
 }

 // ── COMMENT ───────────────────────────────────────────────────────────
 case 'comment': {
 meta = await this.handleComment(stream, provider, intent, aiConfig, aiReady, safeModel);
 break;
 }

 // ── STATUS ────────────────────────────────────────────────────────────
 case 'status': {
 meta = await this.handleStatus(stream, provider, intent, creds.platform);
 break;
 }

 // ── ATTACH ────────────────────────────────────────────────────────────
 case 'attach': {
 meta = await this.handleAttach(stream, provider, intent);
 break;
 }

 // ── SUMMARY ───────────────────────────────────────────────────────────
 case 'summary': {
 meta = await this.handleSummary(stream, provider, intent);
 break;
 }

 // ── ESTIMATE ──────────────────────────────────────────────────────────
 case 'estimate': {
 meta = await this.handleEstimate(stream, provider, intent, creds.platform === 'jira', aiConfig, aiReady, safeModel);
 break;
 }

 // ── ASSIGN ────────────────────────────────────────────────────────────
 case 'assign': {
 meta = await this.handleAssign(stream, provider, intent);
 break;
 }

 // ── SET PARENT ────────────────────────────────────────────────────────
 case 'parent': {
 if (creds.platform !== 'azuredevops') {
 stream.markdown('Parent linking is currently only supported for Azure DevOps.');
 meta = { action: 'error' };
 break;
 }
 meta = await this.handleSetParent(stream, provider);
 break;
 }

 case 'move': {
 meta = await this.handleMove(stream, provider, intent, creds.platform);
 break;
 }

 case 'migrate': {
 meta = await this.handleMigrate(stream, intent);
 break;
 }



 // ── MEMBERS ───────────────────────────────────────────────────────────
 case 'members': {
 stream.progress('Loading team...');
 const members = await provider.getProjectMembers();
 stream.markdown(formatUserList(members));
 stream.markdown('\n_Say `@pm /setuser` to pick a default user for list and create._');
 meta = { action: 'members' };
 break;
 }

 // ── SPRINT ────────────────────────────────────────────────────────────
 case 'sprint': {
 stream.progress('Loading active sprint...');
 const sprint = await provider.getActiveSprint();
 if (!sprint) {
 stream.markdown('**No active sprint found.** Try `@pm list all tasks` instead.');
 meta = { action: 'sprint_not_found' };
 break;
 }
 const days = sprint.endDate
 ? Math.ceil((new Date(sprint.endDate).getTime() - Date.now()) / 86_400_000)
 : null;
 stream.markdown(
 `## ${sprint.name}\n\n` +
 (sprint.startDate ? `- **Start:** ${sprint.startDate.slice(0, 10)}\n` : '') +
 (sprint.endDate ? `- **End:** ${sprint.endDate.slice(0, 10)}${days !== null ? ` _(${days} day${days !== 1 ? 's' : ''} left)_` : ''}\n` : '')
 );
 stream.progress('Loading sprint items...');
 const sprintItems = await provider.searchWorkItems({ sprintId: sprint.id, maxResults: 50 });
 stream.markdown(formatWorkItemList(sprintItems));
 const ua = sprintItems.filter((i: any) => !i.assignee).length;
 const ue = sprintItems.filter((i: any) => !i.storyPoints && !i.effort).length;
 if (ua) { stream.markdown(`\nWarning: **${ua} unassigned item${ua !== 1 ? 's' : ''}**`); }
 if (ue) { stream.markdown(`\n**${ue} item${ue !== 1 ? 's' : ''} with no estimate**`); }
 meta = { action: 'sprint', sprintHasUnassigned: ua > 0, sprintHasUnestimated: ue > 0, itemKey: sprintItems[0]?.key };
 break;
 }

 // ── DEBUG ─────────────────────────────────────────────────────────────
 case 'debug': {
 const dc = await this.credMgr.getCredentials();
 const du = this.mem.defaultUser;

 // Show platform config immediately — never block on AI
 stream.markdown(
 `**Diagnostics**\n\n` +
 `**Platform:** ${dc.platform}\n` +
 `**Default user:** ${du ? `${du.displayName} (${du.email ?? du.id})` : '_not set — say \`@pm /setuser\` to pick one_'}\n` +
 (dc.platform === 'azuredevops'
 ? `**Org:** \`${dc.adoOrgUrl}\`\n**Project:** \`${dc.adoProject}\`\n**Token:** ${dc.adoToken ? 'set' : 'missing'}`
 : `**URL:** \`${dc.jiraBaseUrl}\`\n**Email:** \`${dc.jiraEmail}\`\n**Token:** ${dc.jiraToken ? 'set' : 'missing'}`)
 );

 // Test AI separately — wrap completely so it never breaks other tests
 try {
 stream.progress('Checking AI...');
 const aiTest = await testAiConnection(aiConfig);
 const copilotMods = await listCopilotModels();
 stream.markdown(
 `\n**AI:** ${aiTest.ok
 ? `${aiTest.provider} — ${aiTest.modelName}`
 : `${aiTest.error ?? 'unavailable'} — say \`@pm /setupai\` to configure`}\n` +
 (copilotMods.length
 ? `**Copilot models:** ${copilotMods.join(', ')}`
 : `**Copilot models:** none — install the "GitHub Copilot" extension (ID: github.copilot)`)
 );
 } catch {
 stream.markdown('\n**AI:** skipped (not required for core features)');
 }

 if (dc.platform === 'azuredevops') {
 const adoP = provider as any;
 try {
 stream.progress('Test 1: project list...');
 const projects = await adoP.getProjects();
 const match = projects.find((p: any) => p.name.toLowerCase() === (dc.adoProject ?? '').toLowerCase());
 stream.markdown(
 `\n**Test 1 — Projects:** ${match
 ? `"${match.name}" found`
 : `Warning: "${dc.adoProject}" not found. Available: ${projects.map((p: any) => p.name).join(', ')}`
 }`
 );

 stream.progress('Test 2: bare WIQL...');
 const safeP = (dc.adoProject ?? '').replace(/'/g, "''");
 const bareWiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${safeP}' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`;
 const d = await adoP.debugQuery(bareWiql);
 stream.markdown(
 `\n**Test 2 — Bare query:** ${d.ids.length} item(s)\n\`\`\`\n${d.wiql}\n\`\`\``
 );
 if (d.firstItem) {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const fi = d.firstItem as any;
 stream.markdown(
 `\n**First item:** AB#${fi.id} — "${fi.fields?.['System.Title']}" ` +
 `[${fi.fields?.['System.State']}] assigned: ${fi.fields?.['System.AssignedTo']?.displayName ?? 'nobody'}`
 );
 }

 stream.progress('Test 3: @Me filter...');
 const meWiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${safeP}' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC`;
 const md = await adoP.debugQuery(meWiql);
 stream.markdown(
 `\n**Test 3 — @Me:** ${md.ids.length} item(s)` +
 (md.ids.length === 0
 ? ' — your PAT identity has no assigned items. Use `@pm /setuser` to pick a team member.'
 : ' ')
 );

 stream.progress('Test 4: team members...');
 const members = await adoP.getProjectMembers();
 stream.markdown(`\n**Test 4 — Team members found:** ${members.length}`);
 if (members.length) {
 stream.markdown(members.slice(0, 5).map((m: any) => `- ${m.displayName} (${m.email})`).join('\n'));
 }
 } catch (e: unknown) {
 stream.markdown(`\n**Error:** ${e instanceof Error ? e.message : String(e)}`);
 }
 } else {
 // Jira diagnostics
 try {
 stream.progress('Test 1: Jira connection...');
 const projs = await provider.getProjects();
 const dc2 = await this.credMgr.getCredentials();
 const configuredKey = dc2.jiraProject ?? '';
 const match = projs.find((p: { key: string }) => p.key === configuredKey);
 stream.markdown(
 `\n**Test 1 — Connection:** OK (${projs.length} projects accessible)\n` +
 `**Default project:** ${configuredKey || '_not set_'} — ` +
 (match ? 'found' : configuredKey ? `**NOT FOUND** (available: ${projs.slice(0, 8).map((p: { key: string }) => p.key).join(', ')})` : '_none configured_')
 );

 stream.progress('Test 2: project members...');
 const mems = await provider.getProjectMembers();
 const du2 = this.mem.defaultUser;
 stream.markdown(
 `\n**Test 2 — Project members:** ${mems.length} found` +
 (mems.length ? ` (${mems.slice(0, 5).map((m: { displayName: string }) => m.displayName).join(', ')}${mems.length > 5 ? '…' : ''})` : ' — check token has read:jira-user scope') +
 (du2 ? `\n**Default user:** ${du2.displayName} \`${du2.id}\`` +
 (mems.find((m: { id: string }) => m.id === du2.id) ? ' — in member list' : ' — not in list (manual/resolved)') : '')
 );
 } catch (e: unknown) {
 stream.markdown(`\n**Jira error:** ${e instanceof Error ? e.message : String(e)}`);
 }
 }
 meta = { action: 'debug' };
 break;
 }

 case 'setupai': {
 await this.credMgr.runAiSetupWizard();
 const newCfg = await this.credMgr.getAiConfig();
 stream.markdown(newCfg.provider === 'none'
 ? 'AI assistance is **disabled**. Say `@pm /setupai` to enable it.'
 : `AI provider: **${newCfg.provider}**. Ticket creation and estimation are now AI-powered.`);
 stream.button({ command: 'pm-agent.configureAi', title: 'Configure AI Provider' });
 meta = { action: 'setupai' }; break;
 }

 default: {
 this.showHelp(stream);
 meta = { action: 'help' };
 break;
 }
 }
 } catch (err: unknown) {
 const msg = err instanceof Error ? err.message : String(err);
 stream.markdown(formatError(msg) + '\n\n_Run `@pm /debug` to verify your connection._');
 meta = { action: 'error' };
 }

 return { metadata: { [RESULT_META_KEY]: meta } };
 }

 // ── SET DEFAULT USER ────────────────────────────────────────────────────────

 private async handleSetUser(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 platform: string
 ): Promise<PmResultMeta> {
 const current = this.mem.defaultUser;

 stream.markdown(
 '**Set default user**\n\n' +
 (current
 ? `Currently: **${current.displayName}** — choose someone else or clear.\n\n`
 : 'The default user determines whose tickets show in `@pm list`, `@pm summary`, and who gets pre-selected when creating tickets.\n\n') +
 'Loading team members...'
 );

 stream.progress('Loading team...');
 const members = await provider.getProjectMembers();

 if (!members.length) {
 stream.markdown('_No team members found. Check your project permissions or run `@pm /debug`._');
 return { action: 'setuser_error' };
 }

 const options: Array<{ label: string; description: string; userId: string; manual?: boolean }> = [];

 // Clear option first
 options.push({ label: 'Clear — show all items (no user filter)', description: '', userId: '__clear__' });

 // Current user second for quick re-confirm
 if (current) {
 options.push({ label: `Keep: ${current.displayName}`, description: current.email ?? '', userId: current.id });
 }

 // Project members
 for (const m of members) {
 if (!current || m.id !== current.id) {
 options.push({ label: m.displayName, description: m.email ?? '', userId: m.id });
 }
 }

 // Manual entry at bottom — user can type their own name/email if not in the list
 options.push({
 label:       'Enter manually...',
 description: 'Type your name and email if you are not listed above',
 userId:      '__manual__',
 manual:      true
 });

 const picked = await vscode.window.showQuickPick(options, {
 title:       'PM Agent — Select default user',
 placeHolder: 'Search by name or email, or choose "Enter manually" at the bottom',
 ignoreFocusOut: true
 });

 if (!picked) {
 stream.markdown('_Cancelled — default user unchanged._');
 return { action: 'setuser_cancelled' };
 }

 if (picked.userId === '__clear__') {
 await this.credMgr.clearDefaultUser();
 this.mem.defaultUser = undefined;
 stream.markdown('**Default user cleared.** `@pm list` will show all open items.');
 return { action: 'setuser_cleared' };
 }

 // Manual entry — user types their own name and email/ID
 if (picked.userId === '__manual__') {
 // Ask for email first — we'll try to resolve it to a Jira accountId
 const emailInput = await vscode.window.showInputBox({
 title:          'Your email address',
 prompt:         'Enter the email you use to log in',
 placeHolder:    'jane.smith@company.com',
 ignoreFocusOut: true
 });
 if (!emailInput?.trim()) {
 stream.markdown('_Cancelled._');
 return { action: 'setuser_cancelled' };
 }
 const email = emailInput.trim();

 // For Jira Cloud: resolve email to accountId via the API
 if (platform === 'jira') {
 stream.progress('Looking up your account...');
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const resolved = await (provider as any).resolveUser(email);
 if (resolved) {
 await this.credMgr.setDefaultUser(resolved);
 this.mem.defaultUser = resolved;
 stream.markdown(
 `**Default user set to ${resolved.displayName}**\n\n` +
 `Account ID: \`${resolved.id}\`\n\n` +
 `\`@pm list\` will now show **${resolved.displayName}**\'s tickets.`
 );
 return { action: 'setuser_done', itemKey: resolved.id };
 }
 stream.markdown('_Could not find account automatically — enter your name to save manually._');
 } catch { stream.markdown('_API lookup failed — enter your name to save manually._'); }
 }

 const displayName = await vscode.window.showInputBox({
 title:          'Your display name',
 prompt:         'Your full name as shown in the project (for display only)',
 placeHolder:    'Jane Smith',
 ignoreFocusOut: true
 });
 if (!displayName?.trim()) {
 stream.markdown('_Cancelled._');
 return { action: 'setuser_cancelled' };
 }

 const manualUser: User = { id: email, displayName: displayName.trim(), email };
 await this.credMgr.setDefaultUser(manualUser);
 this.mem.defaultUser = manualUser;
 stream.markdown(
 `**Default user set to ${manualUser.displayName}** (${email})\n\n` +
 (platform === 'jira'
 ? '_Note: Jira Cloud requires an account ID for exact matching. If \`@pm list\` returns no results, ' +
 'run \`@pm /debug\` — your admin may need to grant the token \`read:jira-user\` scope._'
 : '_If results look wrong, run \`@pm /debug\` to verify._')
 );
 return { action: 'setuser_done', itemKey: manualUser.id };
 }

 const user = members.find((m: any) => m.id === picked.userId);
 if (!user) { stream.markdown('_Could not find user._'); return { action: 'error' }; }

 await this.credMgr.setDefaultUser(user);
 this.mem.defaultUser = user;

 stream.markdown(
 `**Default user set to ${user.displayName}**\n\n` +
 `From now on:\n` +
 `- \`@pm list\` shows **${user.displayName}**'s assigned tickets\n` +
 `- \`@pm create\` pre-selects **${user.displayName}** as assignee\n` +
 `- \`@pm summary\` shows **${user.displayName}**'s workload\n\n` +
 `_Say \`@pm list\` to see their tickets now._`
 );
 return { action: 'setuser_done', itemKey: user.id };
 }

 // ── CREATE ─────────────────────────────────────────────────────────────────

 private async handleCreate(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 partial: Partial<PendingCreate>,
 platform: string,
 aiConfig: AiConfig,
 aiReady: boolean,
 requestModel?: vscode.LanguageModelChat
 ): Promise<PmResultMeta> {
 const p: PendingCreate = { ...this.mem.pendingCreate, ...partial };
 let rawTypeName: string | undefined;

 // ── WHAT type? ─────────────────────────────────────────────────────────
 if (platform === 'azuredevops') {
 stream.progress('Loading work item types...');
 const adoP = provider as any;
 const adoTypes = await adoP.getWorkItemTypes();
 let hint = '';
 if (p.type) {
 const l = p.type.toLowerCase();
 const match = adoTypes.find((t: string) => {
 const tl = t.toLowerCase();
 if (l === 'story') { return tl.includes('story') || tl.includes('backlog item') || tl.includes('requirement'); }
 if (l === 'bug') { return tl.includes('bug'); }
 if (l === 'epic') { return tl.includes('epic'); }
 if (l === 'feature') { return tl.includes('feature'); }
 if (l === 'task') { return tl === 'task'; }
 return false;
 });
 if (match) { hint = ` (suggested: ${match})`; }
 }
 const picked = await vscode.window.showQuickPick(
 adoTypes.map((t: string) => ({ label: t, value: t })),
 { title: `Work item type${hint}`, placeHolder: 'Select from your project types', ignoreFocusOut: true }
 );
 if (!picked) { stream.markdown('_Cancelled._'); return { action: 'create_cancelled' }; }
 rawTypeName = (picked as any).value ?? (picked as any).label ?? String(picked);
 const l2 = rawTypeName!.toLowerCase();
 if (l2.includes('story') || l2.includes('backlog item') || l2.includes('requirement')) { p.type = 'story'; }
 else if (l2.includes('bug')) { p.type = 'bug'; }
 else if (l2.includes('epic')) { p.type = 'epic'; }
 else if (l2.includes('feature')) { p.type = 'feature'; }
 else if (l2.includes('test')) { p.type = 'testcase'; }
 else { p.type = 'task'; }
 } else {
 // Jira — fetch real issue types from the project
 stream.progress('Loading issue types...');
 let jiraTypes: string[] = ['Story', 'Task', 'Bug', 'Epic', 'Sub-task'];
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 jiraTypes = await (provider as any).getWorkItemTypes();
 } catch { /* use defaults */ }

 // Pre-select a sensible default based on any hint from the intent
 const jiraHint = p.type ?? 'story';
 const jiraDefault = jiraTypes.find((t: string) => t.toLowerCase().includes(jiraHint.toLowerCase())) ?? jiraTypes[0];

 const jiraPicked = await vscode.window.showQuickPick(
 jiraTypes.map((t: string) => ({ label: t, value: t, picked: t === jiraDefault })),
 {
 title: 'Issue type',
 placeHolder: `Suggested: ${jiraDefault}`,
 ignoreFocusOut: true
 }
 );
 if (!jiraPicked) { stream.markdown('_Cancelled._'); return { action: 'create_cancelled' }; }
 rawTypeName = jiraPicked.value;
 const jl = jiraPicked.value.toLowerCase();
 if (jl.includes('story')) { p.type = 'story'; }
 else if (jl.includes('bug')) { p.type = 'bug'; }
 else if (jl.includes('epic')) { p.type = 'epic'; }
 else if (jl.includes('sub')) { p.type = 'subtask'; }
 else if (jl.includes('feature')) { p.type = 'feature'; }
 else { p.type = 'task'; }
 }

 const displayType = rawTypeName ?? cap(p.type ?? 'item');

 // ── PARENT link (Tasks/Bugs/Sub-tasks on both platforms) ────────────────
 if (!p.parentId) {
 const isChildType = ['task','bug','subtask','testcase'].includes(p.type ?? '');
 const rawLower = (rawTypeName ?? '').toLowerCase();
 const isChildRaw = rawLower.includes('task') || rawLower.includes('bug') ||
 rawLower.includes('sub') || rawLower.includes('test');
 // Show parent picker for child types on both ADO and Jira
 if (isChildType || isChildRaw) {
 // Offer to link to a parent — load stories/features/epics
 stream.progress('Loading potential parent items...');
 let parents: WorkItem[] = [];
 try {
 parents = await provider.searchWorkItems({
 query: undefined,
 status: 'open',
 maxResults: 30
 } as any);
 // Filter to parent-capable types only
 parents = parents.filter(i =>
 ['story','epic','feature'].includes(i.type) ||
 (i.rawTypeName ?? '').toLowerCase().match(/story|epic|feature|requirement|backlog/)
 );
 } catch { /* no parents available */ }

 if (parents.length) {
 type ParentOption = { label: string; description: string; id: string | undefined };
 const parentOptions: ParentOption[] = [
 { label: 'No parent — create standalone', description: '', id: undefined }
 ];
 for (const pi of parents) {
 parentOptions.push({
 label:       `${pi.key} — ${pi.title}`,
 description: `${cap(pi.type)} · ${pi.status}`,
 // Jira uses issue key for parent; ADO uses numeric id
 id:          platform === 'jira' ? pi.key : pi.id
 });
 }
 const parentPick = await vscode.window.showQuickPick(parentOptions, {
 title:       `Link to a parent ${displayType}? (optional)`,
 placeHolder: 'Select a parent Story/Epic/Feature, or choose standalone',
 ignoreFocusOut: true
 });
 if (parentPick?.id) {
 p.parentId = parentPick.id;
 stream.markdown(`_Parent set to **${parents.find(pi => pi.id === parentPick.id)?.key}**_`);
 }
 }
 }
 }

 // ── WHAT title? ────────────────────────────────────────────────────────
 if (!p.title) {
 stream.markdown(
 `Creating a **${displayType}**.\n\n` +
 `**Title and any notes** — AI will structure the full description.\n\n` +
 `_For bugs: what broke + when. For stories: what the user needs. For tasks: what to build._`
 );
 const title = await vscode.window.showInputBox({
 title: `${displayType} — title`,
 prompt: 'Brief title (AI will refine it)',
 placeHolder: p.type === 'bug' ? 'e.g. Login fails on Safari with SSO enabled' : 'e.g. User can export reports as PDF',
 ignoreFocusOut: true
 });
 if (!title) { stream.markdown('_Cancelled._'); return { action: 'create_cancelled' }; }
 p.title = title;
 }

 // ── Raw notes → AI enhancement ─────────────────────────────────────────
 stream.markdown(
 `**"${p.title}"**\n\n` +
 `**Context / notes (optional)** _(background, constraints, acceptance criteria, steps to reproduce)_\n\n` +
 `_Press Escape to skip — AI will do its best with the title alone._`
 );
 const rawNotes = await vscode.window.showInputBox({
 title: 'Context / notes (optional)',
 prompt: p.type === 'bug'
 ? 'Steps to reproduce, environment, expected vs actual'
 : 'Any background, constraints or acceptance criteria',
 ignoreFocusOut: true
 });

 // Call AI (skip gracefully if not configured)
 let enhancement: Awaited<ReturnType<typeof enhanceTicket>> | null = null;
 if (aiReady) {
 stream.progress('AI is analysing and structuring the ticket...');
 try {
 enhancement = await enhanceTicket(aiConfig, displayType, p.title, rawNotes ?? '', platform, requestModel);
 } catch (e: unknown) {
 const msg = e instanceof Error ? e.message : String(e);
 if (msg !== 'AI_DISABLED') {
 stream.markdown(`Warning: _AI enhancement failed: ${msg}. Continuing without AI._`);
 }
 }
 } else if (!aiReady) {
 stream.markdown(
 `_AI is disabled. Say \`@pm /setupai\` to enable — uses your existing GitHub Copilot subscription._`
 );
 }

 // ── Show AI's clarifying question if ticket is unclear ─────────────────
 if (enhancement?.clarifyingQuestion) {
 stream.markdown(
 `**Clarifying question before structuring this ticket:**\n\n` +
 `> ${enhancement.clarifyingQuestion}\n\n` +
 `_Answer below, or press Escape to skip and proceed with what we have._`
 );
 const answer = await vscode.window.showInputBox({
 title: 'Answer (optional)',
 prompt: enhancement.clarifyingQuestion,
 ignoreFocusOut: true
 });
 if (answer?.trim()) {
 // Re-run AI with the answer
 stream.progress('Re-analysing with your answer...');
 try {
 enhancement = await enhanceTicket(aiConfig, displayType, p.title, `${rawNotes ?? ''}\n\nAdditional context: ${answer}`, platform, requestModel);
 } catch { /* keep existing */ }
 }
 }

 // ── Show AI-structured description for review ──────────────────────────
 if (enhancement) {
 stream.markdown(
 `## AI-Structured Ticket\n\n` +
 `**Title:** ${enhancement.title}\n\n` +
 `**What** _(scope)_\n${enhancement.what}\n\n` +
 `**Why** _(value/impact)_\n${enhancement.why}\n\n` +
 `**How** _(acceptance criteria / steps)_\n${enhancement.how}\n\n` +
 `---\n` +
 `**AI estimate:** ${enhancement.effortPoints} pts — _${enhancement.effortReasoning}_\n` +
 `**AI priority:** ${enhancement.priority} — _${enhancement.priorityReasoning}_`
 );

 // Let user accept AI title or keep their own
 const titleChoice = await vscode.window.showQuickPick([
 { label: `Use AI title: "${enhancement.title}"`, value: 'ai' },
 { label: `Keep my title: "${p.title}"`, value: 'mine' },
 ], { title: 'Which title?', ignoreFocusOut: true });
 if (!titleChoice) { stream.markdown('_Cancelled._'); return { action: 'create_cancelled' }; }
 if (titleChoice.value === 'ai') { p.title = enhancement.title; }

 // Description = What + Why only.
 // Acceptance Criteria (How) goes to its own field.
 const descMd =
 `**What**\n${enhancement.what}\n\n` +
 `**Why**\n${enhancement.why}`;
 p.description = platform === 'azuredevops' ? markdownToAdoHtml(descMd) : descMd;
 p.acceptanceCriteria = platform === 'azuredevops' ? markdownToAdoHtml(enhancement.how) : enhancement.how;

 } else if (rawNotes) {
 p.description = platform === 'azuredevops' ? markdownToAdoHtml(rawNotes) : rawNotes;
 }

 // ── HOW complex — effort with AI suggestion ────────────────────────────
 const aiPts = enhancement?.effortPoints;
 stream.markdown(
 `**Effort estimate**\n\n` +
 (aiPts ? `AI suggests **${aiPts} pts** — _${enhancement?.effortReasoning}_\n\n` : '') +
 `Pick your estimate (or accept the AI suggestion):`
 );
 const ptsOptions = [
 { label: `1 pt — Trivial (< 1 hr)`, value: 1 },
 { label: `2 pts — Small (half day)`, value: 2 },
 { label: `3 pts — Medium (1 day)`, value: 3 },
 { label: `5 pts — Large (2-3 days)`, value: 5 },
 { label: `8 pts — Very large (1 sprint)`, value: 8 },
 { label: `13 pts — Epic-sized (split it!)`, value: 13 },
 { label: `Skip`, value: 0 },
 ];
 if (aiPts) {
 // Move AI's suggestion to the top
 const idx = ptsOptions.findIndex(o => o.value === aiPts);
 if (idx > 0) {
 const [suggested] = ptsOptions.splice(idx, 1);
 ptsOptions.unshift({ ...suggested, label: `* ${suggested.label} (AI suggested)` });
 }
 }
 const pts = await vscode.window.showQuickPick(ptsOptions, { title: 'Effort / Story Points', ignoreFocusOut: true });
 p.storyPoints = pts && pts.value > 0 ? pts.value : undefined;

 // ── HOW urgent — priority with AI suggestion ───────────────────────────
 const aiPrio = enhancement?.priority ?? 'Medium';

 // For Jira: fetch real priority names from the project
 let priorityNames: string[] = ['Critical', 'High', 'Medium', 'Low'];
 if (platform === 'jira') {
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 priorityNames = await (provider as any).getPriorities();
 } catch { /* use defaults */ }
 }

 // Find closest match for AI suggestion (case-insensitive)
 const aiPrioMatch = priorityNames.find((p: string) =>
 p.toLowerCase() === aiPrio.toLowerCase() ||
 p.toLowerCase().includes(aiPrio.toLowerCase()) ||
 aiPrio.toLowerCase().includes(p.toLowerCase())
 ) ?? priorityNames[Math.floor(priorityNames.length / 2)]; // default to middle

 const prioOptions = priorityNames.map((name: string) => ({
 label: name === aiPrioMatch ? `${name} (AI suggested)` : name,
 value: name
 }));

 const prio = await vscode.window.showQuickPick(prioOptions, {
 title: 'Priority',
 placeHolder: `AI suggests: ${aiPrioMatch}`,
 ignoreFocusOut: true
 });
 p.priority = prio?.value;

 // ── LABELS — Jira only ────────────────────────────────────────────────
 if (platform === 'jira') {
 stream.progress('Loading labels...');
 let availableLabels: string[] = [];
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 availableLabels = await (provider as any).getLabels();
 } catch { /* labels unavailable */ }

 if (availableLabels.length) {
 const labelPicks = await vscode.window.showQuickPick(
 availableLabels.map((l: string) => ({ label: l, picked: false })),
 {
 title: 'Labels (optional)',
 placeHolder: 'Select one or more labels, or press Escape to skip',
 canPickMany: true,
 ignoreFocusOut: true
 }
 );
 if (labelPicks?.length) {
 p.labels = labelPicks.map((l: any) => l.label);
 }
 } else {
 // No labels from API — allow free-text entry
 const labelInput = await vscode.window.showInputBox({
 title: 'Labels (optional)',
 prompt: 'Enter comma-separated labels, or press Escape to skip',
 placeHolder: 'e.g. frontend, auth, sprint-cleanup',
 ignoreFocusOut: true
 });
 if (labelInput?.trim()) {
 p.labels = labelInput.split(',').map(l => l.trim()).filter(Boolean);
 }
 }
 }

 // ── WHO — assign (default user pre-selected) ───────────────────────────
 stream.progress('Loading team...');
 const members = await provider.getProjectMembers();
 const du = this.mem.defaultUser;
 const assignOptions: Array<{ label: string; description: string; userId: string }> = [];
 if (du) {
 assignOptions.push({ label: `${du.displayName} (default user)`, description: du.email ?? '', userId: du.id });
 assignOptions.push({ label: 'Leave unassigned', description: '', userId: '' });
 for (const m of members) {
 if (m.id !== du.id) { assignOptions.push({ label: m.displayName, description: m.email ?? '', userId: m.id }); }
 }
 } else {
 assignOptions.push({ label: 'Leave unassigned', description: '', userId: '' });
 for (const m of members) { assignOptions.push({ label: m.displayName, description: m.email ?? '', userId: m.id }); }
 }
 const assignPick = await vscode.window.showQuickPick(assignOptions, {
 title: 'Assign to',
 placeHolder: du ? `Default: ${du.displayName}` : 'Choose assignee...',
 ignoreFocusOut: true
 });
 p.assigneeId = assignPick?.userId || undefined;

 // ── WHICH sprint? ──────────────────────────────────────────────────────
 stream.progress('Loading sprints...');
 let sprints: import('./types').Sprint[] = [];
 try {
 if (platform === 'azuredevops') {
 sprints = await (provider as any).getAllSprints();
 } else {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 sprints = await (provider as any).getAllSprints();
 }
 } catch { /* sprints unavailable */ }

    if (sprints.length) {
      type SprintOption = { label: string; description: string; sprintId: string; sprintName: string; iterationPath: string };
      const activeSprint = sprints.find((s: any) => s.state === 'active');

      // Active sprint FIRST — so pressing Enter immediately selects it
      const sprintOptions: SprintOption[] = [];

      if (activeSprint) {
        sprintOptions.push({
          label:         activeSprint.name,
          description:   'Active sprint' + (activeSprint.endDate ? ` · ends ${activeSprint.endDate.slice(0, 10)}` : ''),
          sprintId:      activeSprint.id,
          sprintName:    activeSprint.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          iterationPath: (activeSprint as any).iterationPath ?? activeSprint.id
        });
      }
      for (const s of sprints.filter((s: any) => s.state === 'future')) {
        sprintOptions.push({
          label:         s.name,
          description:   'Upcoming' + (s.startDate ? ` · starts ${s.startDate.slice(0, 10)}` : ''),
          sprintId:      s.id,
          sprintName:    s.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          iterationPath: (s as any).iterationPath ?? s.id
        });
      }
      for (const s of sprints.filter((s: any) => s.state === 'closed').slice(-3)) {
        sprintOptions.push({
          label:         s.name,
          description:   'Past' + (s.endDate ? ` · ended ${s.endDate.slice(0, 10)}` : ''),
          sprintId:      s.id,
          sprintName:    s.name,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          iterationPath: (s as any).iterationPath ?? s.id
        });
      }
      sprintOptions.push({ label: 'No sprint — backlog', description: 'Leave unscheduled', sprintId: '', sprintName: '', iterationPath: '' });

      // Pre-set active sprint so it's used if user presses Escape
      if (activeSprint && !p.sprintId) {
        p.sprintId      = activeSprint.id;
        p.sprintName    = activeSprint.name;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        p.iterationPath = (activeSprint as any).iterationPath ?? activeSprint.id;
      }

      const sprintPick = await vscode.window.showQuickPick(sprintOptions, {
        title:          'Which sprint?',
        placeHolder:    activeSprint
          ? `Press Enter to use "${activeSprint.name}" (active), or select another`
          : 'Select a sprint or leave unscheduled',
        ignoreFocusOut: true
      });

      if (sprintPick !== undefined) {
        // Explicit pick — apply it (including "No sprint" which clears the value)
        p.sprintId      = sprintPick.sprintId      || undefined;
        p.sprintName    = sprintPick.sprintName    || undefined;
        p.iterationPath = sprintPick.iterationPath || undefined;
      }
      // undefined (Escape pressed) = keep the pre-set active sprint
    }
 // ── Confirm ────────────────────────────────────────────────────────────
 const assigneeName = p.assigneeId
 ? (members.find((m: any) => m.id === p.assigneeId)?.displayName ?? p.assigneeId)
 : '_unassigned_';

 stream.markdown(
 `## Ready to Create\n\n` +
 `| Field | Value |\n|-|-|\n` +
 `| **Type** | ${displayType} |\n` +
 `| **Title** | ${p.title} |\n` +
 `| **Sprint** | ${p.sprintName ?? '_backlog_'} |\n` +
 `| **Points** | ${p.storyPoints ?? '_unset_'} |\n` +
 `| **Priority** | ${p.priority ?? '_unset_'} |\n` +
 `| **Assignee** | ${assigneeName} |\n` +
 (p.labels?.length  ? `| **Labels** | ${p.labels.join(', ')} |\n` : '') +
 (p.parentId ? `| **Parent** | #${p.parentId} |\n` : '') +
 `\n` +
 (p.description ? `**Description preview:**\n\n${p.description.slice(0, 300)}${p.description.length > 300 ? '...' : ''}\n\n` : '') +
 `**Create this ticket?**`
 );
 const confirm = await vscode.window.showQuickPick(
 [{ label: 'Yes, create it', value: 'yes' }, { label: 'Cancel', value: 'no' }],
 { title: 'Confirm', ignoreFocusOut: true }
 );
 if (!confirm || confirm.value === 'no') {
 this.mem.pendingCreate = p;
 stream.markdown('_Cancelled — say `@pm create` to resume._');
 return { action: 'create_cancelled' };
 }

 stream.progress('Creating story...');

 // Load stored field defaults and prompt for missing required fields (Jira only)
 let customFields: Record<string, unknown> | undefined;
 if (platform === 'jira' && rawTypeName) {
 customFields = {};
 const allDefaults = this.credMgr.getJiraFieldDefaults();
 const typeDefaults = allDefaults[rawTypeName] ?? {};

 // Apply stored defaults
 for (const [k, v] of Object.entries(typeDefaults)) {
 if (v && typeof v === 'object' && 'id' in (v as any)) {
 customFields[k] = { id: (v as any).id };
 } else {
 customFields[k] = v;
 }
 }

 // Scan for required fields that still need values
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const jiraP = provider as any;
 if (jiraP.getCreateFields) {
 stream.progress('Checking required fields...');
 const createFields = await jiraP.getCreateFields(rawTypeName);
 const missing = createFields.filter((f: any) =>
   f.required && !customFields![f.key]
 );

 for (const field of missing) {
   if (field.allowedValues?.length) {
     // AI suggestion for option fields
     let aiSuggestion: string | undefined;
     if (aiReady && enhancement) {
       const fieldDesc = `${field.name}: ${field.allowedValues.map((v: any) => v.value).join(', ')}`;
       // Simple heuristic — check if AI description mentions any value
       const combined = `${p.title} ${p.description ?? ''}`.toLowerCase();
       aiSuggestion = field.allowedValues.find((v: any) =>
         combined.includes(v.value.toLowerCase())
       )?.value;
     }

     type FO = vscode.QuickPickItem & { fieldValue: { id: string; value: string } };
     const opts: FO[] = field.allowedValues.map((v: any) => ({
       label: v.value + (aiSuggestion === v.value ? ' (suggested)' : ''),
       fieldValue: v
     }));

     const pick = await vscode.window.showQuickPick(opts, {
       title: `${field.name} (required)`,
       placeHolder: aiSuggestion ? `Suggested: ${aiSuggestion}` : `Select a value for ${field.name}`,
       ignoreFocusOut: true
     });
     if (pick) {
       customFields[field.key] = { id: pick.fieldValue.id };
     }
   } else if (field.type === 'string' || field.type === 'number') {
     const val = await vscode.window.showInputBox({
       title: `${field.name} (required)`,
       prompt: field.type === 'number' ? 'Enter a number' : 'Enter a value',
       ignoreFocusOut: true
     });
     if (val?.trim()) {
       customFields[field.key] = field.type === 'number' ? Number(val) : val.trim();
     }
   }
 }
 }
 } catch { /* field scan failed — proceed with defaults only */ }

 if (!Object.keys(customFields).length) { customFields = undefined; }
 }

 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const created = await (provider as any).createWorkItem({
 type: p.type!,
 title: p.title!,
 description: p.description,
 acceptanceCriteria: p.acceptanceCriteria,
 storyPoints: p.storyPoints,
 priority: p.priority,
 assigneeId: p.assigneeId,
 labels: p.labels,
 sprintId: platform === 'azuredevops' ? p.iterationPath : p.sprintId,
 parentId: p.parentId,
 rawTypeName: rawTypeName,
 customFields
 });

 this.mem.lastItem = created;
 this.mem.pendingCreate = undefined;
 await this.ctx.workspaceState.update('lastItem', created);

 stream.markdown(
 formatSuccess(`Created **[${created.key}](${created.url})** — ${created.title}`) +
 '\n\n' + formatWorkItem(created)
 );
 stream.button({ command: 'pm-agent.openWorkItemPanel', title: 'Open Panel', arguments: [created] });

 // ── Auto-generate child tasks (only for stories/features/epics) ────────
 const isStoryLike = ['story', 'epic', 'feature'].includes(p.type ?? '');
 if (isStoryLike && aiReady) {
 stream.markdown('\nGenerating implementation tasks...');

 // For ADO: get the task-type names available in this project
 // Fetch all work item types for the task type picker
 let allWorkItemTypes: string[] = ['Task'];
 if (platform === 'azuredevops') {
 try {
 allWorkItemTypes = await (provider as any).getWorkItemTypes();
 } catch { /* use default */ }
 }

 // Default candidate: prefer plain "Task", then any type containing "task"
 const defaultTaskType =
 allWorkItemTypes.find((t: string) => t.toLowerCase() === 'task') ??
 allWorkItemTypes.find((t: string) => t.toLowerCase().includes('task')) ??
 allWorkItemTypes[0] ??
 'Task';

 let generatedTasks: Awaited<ReturnType<typeof generateTasksForStory>> = [];
 try {
 generatedTasks = await generateTasksForStory(
 aiConfig,
 p.title!,
 enhancement?.what ?? p.description ?? p.title ?? '',
 enhancement?.how ?? p.acceptanceCriteria ?? '',
 platform,
 allWorkItemTypes,
 rawTypeName ?? p.type ?? 'story',
 requestModel
 );
 } catch (e: unknown) {
 const emsg = e instanceof Error ? e.message : String(e);
 const isUnavailable = emsg.includes('AI_DISABLED') || emsg.includes('AI_UNAVAILABLE') || emsg.includes('NO_COPILOT_MODEL');
 if (!isUnavailable) {
 stream.markdown(`Warning: _Task generation failed: ${emsg.slice(0,120)}_`);
 }
 }

 if (generatedTasks.length) {
 stream.markdown(
 `\n## AI-Generated Tasks (${generatedTasks.length})\n\n` +
 generatedTasks.map((t, i) => {
 const resolvedType = (() => {
 if (!t.suggestedType || platform !== 'azuredevops') { return defaultTaskType; }
 const sl = t.suggestedType.toLowerCase().trim();
 return allWorkItemTypes.find(wt => wt.toLowerCase() === sl)
 ?? allWorkItemTypes.find(wt => wt.toLowerCase().includes(sl) || sl.includes(wt.toLowerCase()))
 ?? defaultTaskType;
 })();
 return `**${i + 1}. ${t.title}**\n` +
 `_Type: ${resolvedType} · ${t.area} · ${t.effortPoints}pts_\n${t.description}`;
 }).join('\n\n') +
 '\n\n**Create these tasks as children of the story?**'
 );

 const createTasks = await vscode.window.showQuickPick([
 { label: `Yes — create all ${generatedTasks.length} tasks`, value: 'all' },
 { label: ' Let me pick which ones to create', value: 'pick' },
 { label: 'Skip — create tasks manually', value: 'skip' },
 ], { title: 'Create child tasks?', ignoreFocusOut: true });

 if (createTasks?.value === 'all' || createTasks?.value === 'pick') {
 let tasksToCreate = generatedTasks;

 if (createTasks.value === 'pick') {
 const picks = await vscode.window.showQuickPick(
 generatedTasks.map((t, i) => ({
 label: `${t.title}`,
 description: `${t.area} · ${t.effortPoints}pts`,
 picked: true,
 index: i
 })),
 { title: 'Select tasks to create', canPickMany: true, ignoreFocusOut: true }
 );
 if (picks?.length) {
 tasksToCreate = picks.map(pk => generatedTasks[pk.index]);
 } else {
 tasksToCreate = [];
 }
 }

 if (tasksToCreate.length) {
 // ── Resolve best type per task using AI suggestion ─────────────
 // Helper: find the best matching ADO type for a suggested name
 const resolveType = (suggested: string): string => {
 if (!suggested || !platform.includes('azure')) { return defaultTaskType; }
 const sl = suggested.toLowerCase().trim();
 // Exact match first
 const exact = allWorkItemTypes.find((t: string) => t.toLowerCase() === sl);
 if (exact) { return exact; }
 // Partial match (e.g. "task" matches "Task" or "Engineering Task")
 const partial = allWorkItemTypes.find((t: string) => t.toLowerCase().includes(sl) || sl.includes(t.toLowerCase()));
 if (partial) { return partial; }
 // Default to plain Task
 return defaultTaskType;
 };

 // Show a single confirmation picker only if ALL tasks have the same type
 // Otherwise create each task with its AI-suggested type directly
 const taskTypes = tasksToCreate.map(t => resolveType(t.suggestedType));
 const uniqueTypes = [...new Set(taskTypes)];

 // If all tasks use the same type and there are multiple types available,
 // let the user confirm/change it once
 if (platform === 'azuredevops' && allWorkItemTypes.length > 1 && uniqueTypes.length === 1) {
 const typePick = await vscode.window.showQuickPick(
 allWorkItemTypes.map(t => ({ label: t, picked: t === uniqueTypes[0], value: t })),
 {
 title: `Child task type (AI suggests: ${uniqueTypes[0]})`,
 placeHolder: `Press Enter to use "${uniqueTypes[0]}", or pick another`,
 ignoreFocusOut: true
 }
 );
 if (typePick) {
 // User confirmed or changed — apply to all tasks
 taskTypes.fill(typePick.value);
 }
 }
 // If tasks have mixed types, use AI suggestion per task (show summary)
 else if (uniqueTypes.length > 1) {
 stream.markdown(
 `
_Using AI-suggested types per task: ${tasksToCreate.map((t, i) => `${t.title} → **${taskTypes[i]}**`).join(', ')}_`
 );
 }

 stream.progress(`Creating ${tasksToCreate.length} tasks...`);
 const createdTasks: WorkItem[] = [];

 for (let i = 0; i < tasksToCreate.length; i++) {
 const task = tasksToCreate[i];
 const chosenType = taskTypes[i] ?? defaultTaskType;
 try {
 const taskDescHtml = platform === 'azuredevops'
 ? `<p>${task.description}</p>`
 : task.description;
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const ct = await (provider as any).createWorkItem({
 type: 'task' as WorkItemType,
 title: task.title,
 description: taskDescHtml,
 storyPoints: task.effortPoints,
 assigneeId: p.assigneeId,
 sprintId: platform === 'azuredevops' ? p.iterationPath : p.sprintId,
 rawTypeName: chosenType,
 parentId: created.id
 });
 createdTasks.push(ct);
 } catch (e: unknown) {
 stream.markdown(`Warning: _Failed to create "${task.title}": ${e instanceof Error ? e.message : String(e)}_`);
 }
 }

 if (createdTasks.length) {
 stream.markdown(
 formatSuccess(`Created **${createdTasks.length} child task${createdTasks.length !== 1 ? 's' : ''}** under [${created.key}](${created.url})`) +
 '\n\n' +
 createdTasks.map(t => `- [${t.key}](${t.url}) ${t.title}`).join('\n')
 );
 }
 }
 }
 }
 }

 return { action: 'created', itemKey: created.key, hasAssignee: !!created.assignee, hasEstimate: !!(created.storyPoints || created.effort) };
 }

 // ── PICK WORK ITEM ────────────────────────────────────────────────────────
 // Shown when the user runs @pm comment or @pm assign without specifying a key.
 // Fetches their assigned items and shows a searchable list.
 // Falls back to manual key entry at the bottom of the list.
 private async pickWorkItem(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 title: string
 ): Promise<string | undefined> {
 stream.progress('Loading your work items...');

 let items: WorkItem[] = [];
 try {
 // Use default user if set, otherwise try @me
 const assigneeId = this.mem.defaultUser?.id ?? '@me';
 items = await provider.searchWorkItems({ assigneeId, maxResults: 50 });
 } catch { /* fall through to manual entry */ }

 type PickOption = { label: string; description: string; key: string; manual?: boolean };

 const options: PickOption[] = [];

 // Last viewed item at the top for convenience
 if (this.mem.lastItem) {
 options.push({
 label: `${this.mem.lastItem.key} — ${this.mem.lastItem.title}`,
 description: `Last viewed · ${this.mem.lastItem.status}`,
 key: this.mem.lastItem.key
 });
 }

 // Assigned items
 for (const item of items) {
 // Skip if already shown as last item
 if (item.key === this.mem.lastItem?.key) { continue; }
 const pts = item.storyPoints ?? item.effort;
 options.push({
 label: `${item.key} — ${item.title}`,
 description: [
 item.status,
 pts !== undefined ? `${pts} pts` : '',
 item.sprint ? item.sprint.split('\\').pop() ?? item.sprint : ''
 ].filter(Boolean).join(' · '),
 key: item.key
 });
 }

 // Manual entry option at the bottom
 options.push({
 label: 'Enter key manually...',
 description: 'Type the work item key (e.g. #1234 or ENG-42)',
 key: '',
 manual: true
 });

 const picked = await vscode.window.showQuickPick(options, {
 title,
 placeHolder: 'Search by key or title, or enter manually',
 ignoreFocusOut: true
 });

 if (!picked) { return undefined; }

 if (picked.manual) {
 const k = await vscode.window.showInputBox({
 title: 'Work item key',
 prompt: 'Enter the key of the work item',
 placeHolder: 'e.g. #1234 or ENG-42',
 ignoreFocusOut: true
 });
 return k?.trim() || undefined;
 }

 return picked.key;
 }

 private async handleComment(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent,
 aiConfig: AiConfig,
 aiReady: boolean,
 requestModel?: vscode.LanguageModelChat
 ): Promise<PmResultMeta> {
 let key = intent.workItemKey;
 if (!key) {
 // Always show picker — lastItem is pre-highlighted but user can choose any
 key = await this.pickWorkItem(stream, provider, 'Which item do you want to comment on?');
 if (!key) { stream.markdown('_Cancelled._'); return { action: 'comment_cancelled' }; }
 }

 stream.progress(`Loading ${key}...`);
 const item = await provider.getWorkItem(key);
 stream.markdown(
 `**[${item.key}](${item.url})** ${item.title} \`${item.status}\`` +
 (item.assignee ? ` · assigned to **${item.assignee.displayName}**` : '') +
 '\n\n**Your comment** _(AI will polish it before posting)_ _(AI will help structure it professionally)_'
 );

 let commentText = intent.commentText;
 if (!commentText) {
 commentText = await vscode.window.showInputBox({
 title: `Comment on ${key}`,
 prompt: 'Your draft — AI will enhance it before posting',
 placeHolder: 'e.g. looked into this, found the issue is in the auth middleware, will fix today',
 ignoreFocusOut: true
 }) ?? '';
 }
 if (!commentText.trim()) { stream.markdown('_No comment posted._'); return { action: 'comment_cancelled' }; }

 // AI enhancement
 let enhanced = commentText;
 let suggestions: string[] = [];
 if (aiReady) {
 stream.progress('AI is polishing your comment...');
 try {
 const result = await enhanceComment(aiConfig, item.key, item.title, item.status, commentText, requestModel);
 enhanced = result.enhanced;
 suggestions = result.suggestions ?? [];
 } catch (e: unknown) {
 const msg = e instanceof Error ? e.message : String(e);
 const isUnavailable = msg.includes('AI_DISABLED') || msg.includes('AI_UNAVAILABLE') || msg.includes('NO_COPILOT_MODEL');
 if (!isUnavailable) {
 stream.markdown(`Warning: _AI polish failed — posting your original comment._`);
 }
 }
 }

 // Show AI version and let user approve / edit / use original
 if (enhanced !== commentText) {
 stream.markdown(
 `## AI-Enhanced Comment\n\n` +
 `> ${enhanced}\n\n` +
 (suggestions.length ? `**AI suggests also adding:** ${suggestions.join(' · ')}\n\n` : '')
 );
 const choice = await vscode.window.showQuickPick([
 { label: 'Post AI version', value: 'ai' },
 { label: 'Post my original', value: 'original' },
 { label: 'Cancel', value: 'cancel' },
 ], { title: 'Which comment to post?', ignoreFocusOut: true });

 if (!choice || choice.value === 'cancel') {
 stream.markdown('_Comment cancelled._');
 return { action: 'comment_cancelled' };
 }
 if (choice.value === 'original') { enhanced = commentText; }
 }

 stream.progress('Posting comment...');
 const comment = await provider.addComment(key, enhanced);
 stream.markdown(formatSuccess(`Comment posted on **[${item.key}](${item.url})**\n\n> ${comment.body}`));
 this.mem.lastItem = item;
 return { action: 'commented', itemKey: item.key };
 }

 private async handleStatus(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent,
 platform: string
 ): Promise<PmResultMeta> {
 let key = intent.workItemKey;
 if (!key) {
 key = await this.pickWorkItem(stream, provider, 'Which item do you want to update status for?');
 if (!key) { stream.markdown('_Cancelled._'); return { action: 'status_cancelled' }; }
 }

 stream.progress(`Loading ${key}...`);
 const item = await provider.getWorkItem(key);
 stream.markdown(
 `**[${item.key}](${item.url})** ${item.title}\n` +
 `Type: ${cap(item.type)} · Currently: **${item.status}**\n\n` +
 `**New status:**`
 );

 // Fetch real states for this specific work item type
 let states: string[] = [];
 if (platform === 'jira') {
 // Jira transitions are fetched from the item's actual available transitions
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const transitions = await (provider as any).getAvailableTransitions?.(key);
 if (transitions?.length) { states = transitions; }
 } catch { /* fall through */ }
 if (!states.length) {
 states = ['To Do', 'In Progress', 'In Review', 'Done', 'Blocked'];
 }
 } else {
 // ADO: fetch states for this work item type from the API
 try {
 const adoP = provider as any;
 // Use rawTypeName from the item (exact ADO type) or fall back to a map
 const typeMap: Record<string, string> = {
 story: 'User Story', task: 'Task', bug: 'Bug', epic: 'Epic',
 feature: 'Feature', testcase: 'Test Case', subtask: 'Task'
 };
 const adoTypeName = item.rawTypeName ?? typeMap[item.type] ?? cap(item.type);
 const fetched = await adoP.getWorkItemStates(adoTypeName);
 if (fetched.length) { states = fetched; }
 } catch { /* fall through */ }
 if (!states.length) {
 // Sensible defaults per type
 const typeDefaults: Record<string, string[]> = {
 story:   ['New', 'Active', 'Resolved', 'Closed'],
 task:    ['To Do', 'In Progress', 'Done'],
 bug:     ['New', 'Active', 'Resolved', 'Closed'],
 epic:    ['New', 'In Progress', 'Resolved', 'Closed'],
 feature: ['New', 'In Progress', 'Resolved', 'Closed'],
 };
 states = typeDefaults[item.type] ?? ['New', 'Active', 'Resolved', 'Closed'];
 }
 }

 let target = intent.statusHint;
 if (!target || !states.map(s => s.toLowerCase()).includes(target.toLowerCase())) {
 const picked = await vscode.window.showQuickPick(
 states
 .filter(s => s.toLowerCase() !== item.status.toLowerCase())
 .map(s => ({ label: s })),
 { title: `Transition ${key} from "${item.status}"`, ignoreFocusOut: true }
 );
 if (!picked) { stream.markdown('_Cancelled._'); return { action: 'status_cancelled' }; }
 target = picked.label;
 }

 if (target.toLowerCase() === 'blocked') {
 stream.markdown('Warning: **Why is this blocked?**');
 const blocker = await vscode.window.showInputBox({ title: 'Blocker reason', prompt: 'What is preventing progress?', ignoreFocusOut: true });
 if (blocker) { await provider.addComment(key, `BLOCKED: ${blocker}`); }
 }

 stream.progress(`Transitioning to "${target}"...`);
 const result = await provider.transitionWorkItem(key, target);
 if (result.success) {
 stream.markdown(formatSuccess(`**[${item.key}](${item.url})** moved to **${target}**`));
 if (['Done', 'Closed', 'Resolved'].includes(target)) { stream.markdown('\n'); }
 } else {
 stream.markdown(formatError(result.error ?? 'Transition failed'));
 }
 return { action: 'status_updated', itemKey: item.key, itemStatus: target };
 }

 // ── ATTACH ─────────────────────────────────────────────────────────────────

 private async handleAttach(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent
 ): Promise<PmResultMeta> {
 let key = intent.workItemKey;
 if (!key) {
 key = await this.pickWorkItem(stream, provider, 'Which item do you want to attach a file to?');
 if (!key) { stream.markdown('_No file selected._'); return { action: 'attach_cancelled' }; }
 }

 const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach', title: `Attach file to ${key}` });
 if (!uris?.length) { stream.markdown('_No file selected._'); return { action: 'attach_cancelled' }; }

 const fileUri = uris[0];
 const fileName = fileUri.path.split('/').pop() ?? 'attachment';
 stream.progress(`Uploading ${fileName}...`);

 const fileBytes = await vscode.workspace.fs.readFile(fileUri);
 const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
 const mimeMap: Record<string, string> = {
 png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
 pdf: 'application/pdf', txt: 'text/plain', json: 'application/json',
 zip: 'application/zip',
 docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
 };
 const result = await provider.addAttachment!(key, fileName, Buffer.from(fileBytes), mimeMap[ext] ?? 'application/octet-stream');
 if (result.success) {
 stream.markdown(formatSuccess(`Attached **${fileName}** to **[${key}]**`));
 } else {
 stream.markdown(formatError(result.error ?? 'Upload failed'));
 }
 return { action: 'attached', itemKey: key };
 }

 // ── SUMMARY ────────────────────────────────────────────────────────────────

 private async handleSummary(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent
 ): Promise<PmResultMeta> {
 const key = intent.workItemKey ?? (intent.raw.match(/\b(AB#\d+|[A-Z]+-\d+)\b/i)?.[1]);

 if (!key) {
 // Workload summary — use default user or @me
 const assigneeId = this.mem.defaultUser?.id ?? '@me';
 const userName = this.mem.defaultUser?.displayName ?? 'you';

 stream.progress(`Loading ${userName}'s items...`);
 const items = await provider.searchWorkItems({ assigneeId, maxResults: 50 });

 if (!items.length) {
 stream.markdown(
 `_No items assigned to **${userName}**._\n\n` +
 'Say `@pm /setuser` to change the default user.'
 );
 return { action: 'summary_empty' };
 }

 const byStatus: Record<string, typeof items> = {};
 for (const i of items) {
 (byStatus[i.status] = byStatus[i.status] ?? []).push(i);
 }
 const totalPts = items.reduce((s: number, i: any) => s + (i.storyPoints ?? i.effort ?? 0), 0);

 stream.markdown(
 `## ${userName}'s Work Summary\n\n` +
 `**${items.length} item${items.length !== 1 ? 's' : ''} · ${totalPts} total pts**\n\n` +
 Object.entries(byStatus).map(([status, its]) =>
 `**${status}** (${its.length})\n` +
 its.map((i: any) => `- [${i.key}](${i.url}) ${i.title}${i.storyPoints ? ` · ${i.storyPoints}pts` : ''}`).join('\n')
 ).join('\n\n')
 );
 return { action: 'summary_all', itemCount: items.length };
 }

 // Single item summary
 stream.progress(`Summarising ${key}...`);
 const item = await provider.getWorkItem(key);
 this.mem.lastItem = item;

 const age = item.createdAt ? Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 86_400_000) : null;
 const updated = item.updatedAt ? Math.floor((Date.now() - new Date(item.updatedAt).getTime()) / 86_400_000) : null;
 const pts = item.storyPoints ?? item.effort;

 stream.markdown(
 `## [${item.key}](${item.url}) Summary\n\n**${item.title}**\n\n` +
 `| | |\n|-|-|\n` +
 `| Type | ${item.type} |\n` +
 `| Status | **${item.status}** |\n` +
 (item.assignee ? `| Assignee | ${item.assignee.displayName} |\n` : `| Assignee | Warning: Unassigned |\n`) +
 (item.priority ? `| Priority | ${item.priority} |\n` : '') +
 (pts !== undefined ? `| Effort | ${pts} pts |\n` : `| Effort | Warning: No estimate |\n`) +
 (item.sprint ? `| Sprint | ${item.sprint} |\n` : '') +
 (age !== null ? `| Age | ${age} day${age !== 1 ? 's' : ''} |\n` : '') +
 (updated !== null ? `| Last updated | ${updated === 0 ? 'today' : `${updated} day${updated !== 1 ? 's' : ''} ago`} |\n` : '')
 );

 if (item.description) {
 stream.markdown(`\n**Description:**\n\n${item.description.slice(0, 400)}${item.description.length > 400 ? '...' : ''}`);
 }

 if (item.comments?.length) {
 stream.markdown(
 `\n\n**Last ${Math.min(3, item.comments.length)} comment${item.comments.length !== 1 ? 's' : ''}:**\n\n` +
 item.comments.slice(-3).map((c: any) =>
 `> **${c.author}** _(${c.createdAt.slice(0, 10)})_: ${c.body.slice(0, 150)}${c.body.length > 150 ? '...' : ''}`
 ).join('\n\n')
 );
 }

 const flags: string[] = [];
 if (!item.assignee) { flags.push('Warning: No assignee'); }
 if (!item.storyPoints && !item.effort) { flags.push('Warning: No estimate'); }
 if (updated !== null && updated > 14) { flags.push(`Warning: Not updated in ${updated} days`); }
 if (flags.length) { stream.markdown(`\n\n**Action needed:** ${flags.join(' · ')}`); }

 stream.button({ command: 'pm-agent.openWorkItemPanel', title: 'Open Full Panel', arguments: [item] });
 return { action: 'summary', itemKey: item.key };
 }

 // ── ESTIMATE ───────────────────────────────────────────────────────────────

 private async handleEstimate(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent,
 isJira: boolean,
 aiConfig: AiConfig,
 aiReady: boolean,
 requestModel?: vscode.LanguageModelChat
 ): Promise<PmResultMeta> {
 let key = intent.workItemKey;
 if (!key) {
 key = await this.pickWorkItem(stream, provider, 'Which item do you want to estimate?');
 if (!key) { stream.markdown('_Cancelled._'); return { action: 'estimate_cancelled' }; }
 }
 stream.progress(`Loading ${key}...`);
 const item = await provider.getWorkItem(key);
 const current = item.storyPoints ?? item.effort;
 stream.markdown(
 `**[${item.key}](${item.url})** ${item.title}\n_Status: ${item.status}_\n\n` +
 (current !== undefined ? `Warning: Current: **${current} pts** — will be replaced.\n\n` : '') +
 `**New estimate?**`
 );
 let pts = intent.estimateValue;
 if (pts === undefined) {
 const pick = await vscode.window.showQuickPick(
 [1, 2, 3, 5, 8, 13, 21].map(n => ({ label: `${n} pt${n !== 1 ? 's' : ''}`, value: n })),
 { title: `Estimate for ${key}`, ignoreFocusOut: true }
 );
 if (!pick) { stream.markdown('_Cancelled._'); return { action: 'estimate_cancelled' }; }
 pts = pick.value;
 }
 stream.progress('Saving...');
 const updated = await provider.updateWorkItem(key, { storyPoints: pts, effort: pts });
 this.mem.lastItem = updated;
 stream.markdown(formatSuccess(`Set **${pts} ${isJira ? 'story points' : 'effort'}** on **[${updated.key}](${updated.url})**`));
 return { action: 'estimated', itemKey: updated.key, hasAssignee: !!updated.assignee };
 }

 // ── ASSIGN ─────────────────────────────────────────────────────────────────

 private async handleAssign(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent: ParsedIntent
 ): Promise<PmResultMeta> {
 let key = intent.workItemKey;
 if (!key) {
 key = await this.pickWorkItem(stream, provider, 'Which item do you want to assign?');
 if (!key) { stream.markdown('_Cancelled._'); return { action: 'assign_cancelled' }; }
 }
 stream.progress('Loading...');
 const item = await provider.getWorkItem(key);
 stream.progress('Loading team...');
 const members = await provider.getProjectMembers();

 let assignee: User | undefined;
 if (intent.assigneeHint) {
 const h = intent.assigneeHint.toLowerCase();
 assignee = members.find((m: any) =>
 m.displayName.toLowerCase().includes(h) || (m.email ?? '').toLowerCase().includes(h)
 );
 }
 if (!assignee) {
 // Pre-select default user at top
 const du = this.mem.defaultUser;
 const opts: Array<{ label: string; description: string; userId: string }> = [
 { label: 'Unassign', description: '', userId: '' }
 ];
 if (du) {
 opts.push({ label: `${du.displayName} (default user)`, description: du.email ?? '', userId: du.id });
 }
 for (const m of members) {
 if (!du || m.id !== du.id) {
 opts.push({ label: m.displayName, description: m.email ?? '', userId: m.id });
 }
 }
 const pick = await vscode.window.showQuickPick(opts, { title: `Assign ${key}`, ignoreFocusOut: true });
 if (!pick) { stream.markdown('_Cancelled._'); return { action: 'assign_cancelled' }; }
 if (!pick.userId) {
 await provider.updateWorkItem(key, { assigneeId: null });
 stream.markdown(formatSuccess(`Unassigned **[${item.key}](${item.url})**`));
 return { action: 'unassigned', itemKey: item.key };
 }
 assignee = members.find(m => m.id === pick.userId);
 }
 if (!assignee) { stream.markdown('_Could not find assignee._'); return { action: 'error' }; }
 stream.progress('Assigning...');
 const updated = await provider.updateWorkItem(key, { assigneeId: assignee.id });
 this.mem.lastItem = updated;
 stream.markdown(formatSuccess(`**[${updated.key}](${updated.url})** assigned to **${assignee.displayName}**`));
 return { action: 'assigned', itemKey: updated.key, hasEstimate: !!(updated.storyPoints || updated.effort) };
 }

 // ── SET PARENT ────────────────────────────────────────────────────────────

 private async handleSetParent(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 platform: string = 'azuredevops'
 ): Promise<PmResultMeta> {
 // Step 1: pick the child item
 const childKey = await this.pickWorkItem(stream, provider, 'Which item needs a parent?');
 if (!childKey) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 stream.progress(`Loading ${childKey}...`);
 const child = await provider.getWorkItem(childKey);
 stream.markdown(
 `Setting parent for **[${child.key}](${child.url})** — ${child.title} _(${cap(child.type)})_`
 );

 // Step 2: pick the parent — load stories, epics, features
 stream.progress('Loading potential parents...');
 let parents: WorkItem[] = [];
 try {
 const all = await provider.searchWorkItems({ status: 'open', maxResults: 50 } as any);
 parents = all.filter(i =>
 i.key !== child.key &&
 (['story', 'epic', 'feature'].includes(i.type) ||
 (i.rawTypeName ?? '').toLowerCase().match(/story|epic|feature|requirement|backlog/))
 );
 } catch { /* no results */ }

 if (!parents.length) {
 stream.markdown(
 '_No parent items found. Make sure Stories, Epics, or Features exist in the project._'
 );
 return { action: 'error' };
 }

 type ParentOpt = { label: string; description: string; id: string };
 const opts: ParentOpt[] = parents.map(p => ({
 label:       `${p.key} — ${p.title}`,
 description: `${cap(p.type)} · ${p.status}`,
 id:          p.id
 }));

 const picked = await vscode.window.showQuickPick(opts, {
 title:          `Select parent for ${child.key}`,
 placeHolder:    'Search by key or title',
 ignoreFocusOut: true
 });
 if (!picked) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 stream.progress('Linking...');
 const parent = parents.find(p => p.id === picked.id)!;
 try {
 if (platform === 'azuredevops') {
 await (provider as any).addParentLink(child.id, picked.id);
 } else {
 // Jira: set parent field using the parent's key or id
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 await (provider as any).addParentLink(child.key, parent.key || picked.id);
 }
 stream.markdown(
 formatSuccess(
 `**[${child.key}](${child.url})** is now a child of **[${parent.key}](${parent.url})** — ${parent.title}`
 )
 );
 return { action: 'opened', itemKey: child.key };
 } catch (e: unknown) {
 stream.markdown(formatError(e instanceof Error ? e.message : String(e)));
 return { action: 'error' };
 }
 }

 // ── MOVE (change sprint / iteration) ─────────────────────────────────────

 // ── MOVE (change sprint / iteration) — multi-select ─────────────────────

 private async handleMove(
 stream: vscode.ChatResponseStream,
 provider: ReturnType<typeof createProvider>,
 intent:   ParsedIntent,
 platform: string
 ): Promise<PmResultMeta> {

 // ── Step 1: multi-select items to move ───────────────────────────────
 stream.progress('Loading your work items...');
 let items: WorkItem[] = [];
 try {
 const assigneeId = this.mem.defaultUser?.id ?? '@me';
 items = await provider.searchWorkItems({ assigneeId, maxResults: 100 });
 } catch { /* fall through */ }

 // Build item options — last viewed item pre-selected if no key in intent
 type ItemOpt = { label: string; description: string; item: WorkItem; picked: boolean };
 const itemOpts: ItemOpt[] = [];

 // If key was specified in intent, pre-select it
 const intentKey = intent.workItemKey;

 for (const wi of items) {
 const pts = wi.storyPoints ?? wi.effort;
 itemOpts.push({
 label:       `${wi.key} — ${wi.title}`,
 description: [
 cap(wi.type),
 wi.status,
 pts !== undefined ? `${pts} pts` : '',
 wi.sprint ? (wi.sprint.split('\\').pop() ?? wi.sprint) : 'backlog'
 ].filter(Boolean).join(' · '),
 item:   wi,
 picked: intentKey ? wi.key === intentKey : wi.key === this.mem.lastItem?.key
 });
 }

 if (!itemOpts.length) {
 stream.markdown('_No work items found. Try `@pm /list` to verify your default user is set._');
 return { action: 'error' };
 }

 const selectedItems = await vscode.window.showQuickPick(itemOpts, {
 title:          'Select items to move (multi-select)',
 placeHolder:    'Select one or more items, then press Enter',
 canPickMany:    true,
 ignoreFocusOut: true
 });

 if (!selectedItems?.length) {
 stream.markdown('_Cancelled._');
 return { action: 'error' };
 }

 // ── Step 2: pick target sprint ────────────────────────────────────────
 stream.progress('Loading sprints...');
 let sprints: import('./types').Sprint[] = [];
 try {
 if (platform === 'azuredevops') {
 sprints = await (provider as any).getAllSprints();
 } else {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 sprints = await (provider as any).getAllSprints?.() ?? [];
 }
 } catch { /* no sprints */ }

 if (!sprints.length) {
 stream.markdown('_No sprints found. Check your project configuration._');
 return { action: 'error' };
 }

 type SprintOpt = { label: string; description: string; sprintId: string; iterationPath: string };
 const sprintOpts: SprintOpt[] = [];

 const active = sprints.find(s => s.state === 'active');
 if (active) {
 sprintOpts.push({
 label:         active.name,
 description:   'Active sprint' + (active.endDate ? ` · ends ${active.endDate.slice(0, 10)}` : ''),
 sprintId:      active.id,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 iterationPath: (active as any).iterationPath ?? active.id
 });
 }
 for (const s of sprints.filter(s => s.state === 'future')) {
 sprintOpts.push({
 label:         s.name,
 description:   'Upcoming' + (s.startDate ? ` · starts ${s.startDate.slice(0, 10)}` : ''),
 sprintId:      s.id,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 iterationPath: (s as any).iterationPath ?? s.id
 });
 }
 for (const s of sprints.filter(s => s.state === 'closed').slice(-3)) {
 sprintOpts.push({
 label:         s.name,
 description:   'Past' + (s.endDate ? ` · ended ${s.endDate.slice(0, 10)}` : ''),
 sprintId:      s.id,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 iterationPath: (s as any).iterationPath ?? s.id
 });
 }
 sprintOpts.push({ label: 'Backlog — remove from sprint', description: 'Unscheduled', sprintId: '', iterationPath: '' });

 const targetSprint = await vscode.window.showQuickPick(sprintOpts, {
 title:          `Move ${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''} to sprint`,
 placeHolder:    active ? `Press Enter for "${active.name}" (active)` : 'Select target sprint',
 ignoreFocusOut: true
 });
 if (!targetSprint) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 // ── Step 3: move each item ────────────────────────────────────────────
 const dest = targetSprint.sprintId ? `**${targetSprint.label}**` : 'the **backlog**';
 stream.progress(`Moving ${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''} to ${targetSprint.label || 'backlog'}...`);

 const moved: string[] = [];
 const failed: string[] = [];

 for (const opt of selectedItems) {
 const wi = opt.item;
 try {
 if (platform === 'azuredevops') {
 const adoP = provider as any;
 const n = wi.id.replace(/^#/, '').replace(/^AB#/i, '');
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const cur = await (adoP as any).http(
 `${(adoP as any).orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 ) as any;
 const iterPath = targetSprint.iterationPath ||
 (cur.fields?.['System.IterationPath'] ?? '').split('\\')[0];
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const ops: any[] = [
 { op: 'replace', path: '/fields/System.IterationPath', value: iterPath }
 ];
 if (cur.fields?.['System.AreaPath']) {
 ops.push({ op: 'replace', path: '/fields/System.AreaPath', value: cur.fields['System.AreaPath'] });
 }
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 await (adoP as any).http(
 `${(adoP as any).orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
 { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
 );
 } else {
 // Jira: update sprint via customfield_10020
 const sid = Number(targetSprint.sprintId);
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 await (provider as any).http(`/issue/${encodeURIComponent(wi.key)}`, {
 method: 'PUT',
 body: JSON.stringify({ fields: { customfield_10020: (!isNaN(sid) && sid > 0) ? sid : null } })
 });
 }
 moved.push(`[${wi.key}](${wi.url}) ${wi.title}`);
 } catch (e: unknown) {
 failed.push(`${wi.key}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
 }
 }

 // ── Report results ────────────────────────────────────────────────────
 if (moved.length) {
 stream.markdown(
 formatSuccess(`Moved **${moved.length}** item${moved.length !== 1 ? 's' : ''} to ${dest}`) +
 '\n\n' + moved.map(m => `- ${m}`).join('\n')
 );
 }
 if (failed.length) {
 stream.markdown('\n**Failed:**\n' + failed.map(f => `- ${f}`).join('\n'));
 }

 return { action: 'status_updated', itemKey: moved.length ? selectedItems[0].item.key : undefined };
 }

 // ── MIGRATE (copy ticket between ADO and Jira) ────────────────────────────

 private async handleMigrate(
 stream: vscode.ChatResponseStream,
 intent: ParsedIntent
 ): Promise<PmResultMeta> {
 // Check both platforms are configured
 stream.progress('Checking platform connections...');
 const both = await this.credMgr.getBothCredentials();

 if (!both.jira && !both.ado) {
 stream.markdown('**Migrate requires both platforms to be configured.**\n\nRun `@pm /setup` to configure the missing platform credentials.');
 return { action: 'error' };
 }
 if (!both.jira) {
 stream.markdown('**Jira credentials not configured.**\n\nRun `@pm /setup` and connect Jira to enable migration.');
 return { action: 'error' };
 }
 if (!both.ado) {
 stream.markdown('**Azure DevOps credentials not configured.**\n\nRun `@pm /setup` and connect Azure DevOps to enable migration.');
 return { action: 'error' };
 }

 // Build providers for both platforms
 const { createProvider } = await import('./providers/providerFactory');
 const jiraProvider  = createProvider(both.jira);
 const adoProvider   = createProvider(both.ado);

 // Determine direction — which platform is the source?
 const currentCreds = await this.credMgr.getCredentials();
 const activePlatform = currentCreds.platform;

 const directionOpts = [
 {
 label:       activePlatform === 'jira'
 ? 'Jira → Azure DevOps  (copy this Jira ticket to ADO)'
 : 'Azure DevOps → Jira  (copy this ADO ticket to Jira)',
 value:       activePlatform === 'jira' ? 'jira-to-ado' : 'ado-to-jira'
 },
 {
 label:       activePlatform === 'jira'
 ? 'Azure DevOps → Jira  (copy an ADO ticket to Jira)'
 : 'Jira → Azure DevOps  (copy a Jira ticket to ADO)',
 value:       activePlatform === 'jira' ? 'ado-to-jira' : 'jira-to-ado'
 }
 ];

 const dirPick = await vscode.window.showQuickPick(directionOpts, {
 title:          'Migration direction',
 ignoreFocusOut: true
 });
 if (!dirPick) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 const direction = dirPick.value as 'jira-to-ado' | 'ado-to-jira';
 const sourceProvider = direction === 'jira-to-ado' ? jiraProvider  : adoProvider;
 const destProvider   = direction === 'jira-to-ado' ? adoProvider   : jiraProvider;
 const sourceName     = direction === 'jira-to-ado' ? 'Jira'         : 'Azure DevOps';
 const destName       = direction === 'jira-to-ado' ? 'Azure DevOps' : 'Jira';

 // Select scope
 const scopeOpts = [
 { label: 'My assigned items', description: 'Items assigned to you', value: 'mine' },
 { label: 'All project items', description: 'All items in the project', value: 'all' },
 ];
 const scopePick = await vscode.window.showQuickPick(scopeOpts, {
 title: `What to load from ${sourceName}?`, ignoreFocusOut: true
 });
 if (!scopePick) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 // Pick source items (multi-select)
 stream.progress(`Loading items from ${sourceName}...`);
 let sourceItems: WorkItem[] = [];
 try {
 if (scopePick.value === 'all') {
 sourceItems = await sourceProvider.searchWorkItems({ maxResults: 200 });
 } else {
 const assigneeId = this.mem.defaultUser?.id ?? '@me';
 sourceItems = await sourceProvider.searchWorkItems({ assigneeId, maxResults: 100 });
 }
 } catch { /* fall through */ }

 if (intent.workItemKey) {
 // Key specified — fetch it directly
 try {
 const single = await sourceProvider.getWorkItem(intent.workItemKey);
 sourceItems = [single, ...sourceItems.filter(i => i.key !== single.key)];
 } catch { /* use list */ }
 }

 if (!sourceItems.length) {
 stream.markdown(`_No items found in ${sourceName}. Check your default user is set._`);
 return { action: 'error' };
 }

 // Filter by type
 const availableTypes = [...new Set(sourceItems.map(wi => wi.rawTypeName ?? cap(wi.type)))].sort();
 type TypeFilter = vscode.QuickPickItem & { typeName: string };
 const typeFilterOpts: TypeFilter[] = availableTypes.map(t => {
 const count = sourceItems.filter(wi => (wi.rawTypeName ?? cap(wi.type)) === t).length;
 return { label: t, description: `${count} item${count !== 1 ? 's' : ''}`, typeName: t, picked: true };
 });

 const selectedTypes = await vscode.window.showQuickPick<TypeFilter>(typeFilterOpts, {
 title: `Filter by type — which types to show from ${sourceName}?`,
 placeHolder: 'Uncheck types you want to exclude, then press Enter',
 canPickMany: true,
 ignoreFocusOut: true
 });
 if (!selectedTypes?.length) { stream.markdown('_Cancelled._'); return { action: 'error' }; }
 const allowedTypes = new Set(selectedTypes.map(t => t.typeName));
 let filteredItems = sourceItems.filter(wi => allowedTypes.has(wi.rawTypeName ?? cap(wi.type)));

 // Filter by status
 const availableStatuses = [...new Set(filteredItems.map(wi => wi.status))].sort();
 if (availableStatuses.length > 1) {
 type StatusFilter = vscode.QuickPickItem & { statusName: string };
 const statusOpts: StatusFilter[] = availableStatuses.map(s => {
 const count = filteredItems.filter(wi => wi.status === s).length;
 return { label: s, description: `${count} item${count !== 1 ? 's' : ''}`, statusName: s, picked: true };
 });
 const selectedStatuses = await vscode.window.showQuickPick<StatusFilter>(statusOpts, {
 title: `Filter by status — ${sourceName}`,
 placeHolder: 'Uncheck statuses to exclude, then press Enter',
 canPickMany: true,
 ignoreFocusOut: true
 });
 if (!selectedStatuses?.length) { stream.markdown('_Cancelled._'); return { action: 'error' }; }
 const allowedStatuses = new Set(selectedStatuses.map(s => s.statusName));
 filteredItems = filteredItems.filter(wi => allowedStatuses.has(wi.status));
 }

 type ItemOpt = { label: string; description: string; item: WorkItem; picked: boolean };
 const itemOpts: ItemOpt[] = filteredItems.map(wi => ({
 label:       `${wi.key} — ${wi.title}`,
 description: [wi.rawTypeName ?? cap(wi.type), wi.status, wi.storyPoints ? `${wi.storyPoints} pts` : ''].filter(Boolean).join(' · '),
 item:        wi,
 picked:      intent.workItemKey ? wi.key === intent.workItemKey : false
 }));

 const selectedItems = await vscode.window.showQuickPick(itemOpts, {
 title:          `Select items to copy from ${sourceName} to ${destName}`,
 placeHolder:    'Space to select multiple, Enter to confirm',
 canPickMany:    true,
 ignoreFocusOut: true
 });
 if (!selectedItems?.length) { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 // Options: what to copy
 type FieldOpt = { label: string; description: string; field: string; picked: boolean };
 const fieldOpts: FieldOpt[] = [
 { label: 'Title',                description: 'Always copied',                 field: 'title',       picked: true  },
 { label: 'Description',          description: 'Body / what + why',             field: 'description', picked: true  },
 { label: 'Acceptance Criteria',  description: 'How / definition of done',      field: 'ac',          picked: true  },
 { label: 'Story Points',         description: 'Effort estimate',               field: 'points',      picked: true  },
 { label: 'Priority',             description: 'Critical / High / Medium / Low',field: 'priority',    picked: true  },
 { label: 'Assignee',             description: 'Will try to match by email',    field: 'assignee',    picked: false },
 { label: 'Labels / Tags',        description: 'Copied as-is',                 field: 'labels',      picked: true  },
 { label: 'Comments',             description: 'Copies up to 20 per item',     field: 'comments',    picked: true  },
 { label: 'Child Items',          description: 'Migrate subtasks/children and link to parent', field: 'children', picked: false },
 ];

 const fieldPicks = await vscode.window.showQuickPick(fieldOpts, {
 title:          `What to copy (${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''})`,
 placeHolder:    'Space to toggle fields, Enter to proceed',
 canPickMany:    true,
 ignoreFocusOut: true
 });
 if (!fieldPicks?.length) { stream.markdown('_Cancelled._'); return { action: 'error' }; }
 const fields = new Set(fieldPicks.map(f => f.field));
 fields.add('title'); // always copy title

 // ── Type mapping ──────────────────────────────────────────────────
 // Fetch destination types and let user confirm mapping
 let dstTypes: string[] = [];
 try {
 dstTypes = await destProvider.getWorkItemTypes();
 } catch {
 dstTypes = direction === 'jira-to-ado'
 ? ['Task', 'Bug', 'Epic', 'Feature', 'User Story', 'Product Backlog Item']
 : ['Story', 'Task', 'Bug', 'Epic', 'Sub-task'];
 }

 const srcTypeNames = [...new Set(selectedItems.map(i => i.item.rawTypeName ?? cap(i.item.type)))];
 const typeMap: Record<string, string> = {};
 for (const srcType of srcTypeNames) {
 const exact = dstTypes.find(d => d.toLowerCase() === srcType.toLowerCase());
 type TQ = vscode.QuickPickItem & { rawType: string };
 const typeOpts: TQ[] = dstTypes.map(t => ({
 label: t,
 description: t.toLowerCase() === srcType.toLowerCase() ? '(auto-matched)' : '',
 rawType: t,
 }));
 if (exact) {
 typeOpts.sort((a, b) => a.rawType === exact ? -1 : b.rawType === exact ? 1 : 0);
 }
 const picked = await vscode.window.showQuickPick<TQ>(typeOpts, {
 title: `Map "${srcType}" → ${destName} type`,
 placeHolder: exact
 ? `"${srcType}" matched "${exact}" — press Enter to accept or pick a different type`
 : `"${srcType}" has no match in ${destName} — choose a type`,
 ignoreFocusOut: true
 });
 if (!picked) { stream.markdown('_Cancelled._'); return { action: 'error' }; }
 typeMap[srcType] = picked.rawType;
 }

 // Confirm
 stream.markdown(
 `**Migration plan**\n\n` +
 `- **From:** ${sourceName}\n` +
 `- **To:** ${destName}\n` +
 `- **Items:** ${selectedItems.length}\n` +
 `- **Fields:** ${[...fields].join(', ')}\n` +
 `- **Type mapping:** ${Object.entries(typeMap).map(([s,d]) => `${s} → ${d}`).join(', ')}\n\n` +
 `Proceed?`
 );
 const confirm = await vscode.window.showQuickPick(
 [{ label: 'Yes, migrate', value: 'yes' }, { label: 'Cancel', value: 'no' }],
 { title: 'Confirm migration', ignoreFocusOut: true }
 );
 if (!confirm || confirm.value === 'no') { stream.markdown('_Cancelled._'); return { action: 'error' }; }

 // Migrate each item
 interface MigratedNode { source: WorkItem; dest: WorkItem; children: MigratedNode[] }
 // Pre-fetch destination members for assignee matching
 let dstMembers: User[] = [];
 if (fields.has('assignee')) {
 try { dstMembers = await destProvider.getProjectMembers(); } catch { /* empty */ }
 }

 const created: MigratedNode[] = [];
 const failed:  Array<{ key: string; error: string }> = [];

 for (const opt of selectedItems) {
 const src = opt.item;
 stream.progress(`Copying ${src.key} — ${src.title}...`);
 try {
 // Fetch full item (with comments, description etc.)
 const full = await sourceProvider.getWorkItem(src.key);

 // Resolve assignee by email if requested
 let assigneeId: string | undefined;
 if (fields.has('assignee') && full.assignee?.email) {
 try {
 if (direction === 'jira-to-ado') {
 const members = await destProvider.getProjectMembers();
 const match = members.find(m =>
 m.email?.toLowerCase() === full.assignee!.email?.toLowerCase() ||
 m.displayName.toLowerCase() === full.assignee!.displayName.toLowerCase()
 );
 assigneeId = match?.id;
 } else {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const resolved = await (destProvider as any).resolveUser?.(full.assignee.email);
 assigneeId = resolved?.id;
 }
 } catch { /* skip assignee if lookup fails */ }
 }

 // Build description — strip HTML tags from ADO descriptions
 const cleanDesc = stripHtml(full.description ?? '');
 const cleanAc   = stripHtml(full.acceptanceCriteria as string | undefined ?? '');

 // Ensure description is non-empty for ADO
 let desc = fields.has('description') ? cleanDesc : undefined;
 if (!desc && direction === 'jira-to-ado') { desc = full.title; }

 // Map the type
 const srcTypeName = full.rawTypeName ?? cap(full.type);
 const dstTypeName = typeMap[srcTypeName] ?? cap(full.type);

 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const createInput: any = {
 type:               full.type,
 rawTypeName:        dstTypeName,
 title:              full.title,
 description:        desc,
 acceptanceCriteria: fields.has('ac') && cleanAc ? cleanAc : undefined,
 storyPoints:        fields.has('points') ? (full.storyPoints ?? full.effort) : undefined,
 priority:           fields.has('priority') ? full.priority : undefined,
 labels:             fields.has('labels') && full.labels?.length ? full.labels : undefined,
 assigneeId,
 };

 const destItem = await destProvider.createWorkItem(createInput);

 // Add migration note
 await destProvider.addComment(
 destItem.key,
 `Migrated from ${sourceName} — original: ${full.url}`
 ).catch(() => {});

 // Copy comments if requested
 if (fields.has('comments')) {
 if (!full.comments?.length) {
 try { full.comments = await sourceProvider.getComments(full.key ?? full.id); } catch { /* unavailable */ }
 }
 if (full.comments?.length) {
 stream.progress(`Copying ${full.comments.length} comment(s) for ${src.key}...`);
 for (const c of full.comments.slice(0, 20)) {
 try {
 await destProvider.addComment(destItem.key,
 `**From ${sourceName} (${c.author}${c.createdAt ? ' — ' + c.createdAt.slice(0, 10) : ''}):**\n\n${c.body}`
 );
 } catch { /* skip individual */ }
 }
 }
 }

 // Migrate child items recursively if selected
 const migratedChildren: MigratedNode[] = [];
 if (fields.has('children')) {
 const migrateChildrenRec = async (
   parentSrcId: string, parentDstId: string, parentDstKey: string,
   depth: number
 ): Promise<MigratedNode[]> => {
   if (depth >= 5) { return []; }
   const kids: WorkItem[] = await (sourceProvider as any).getChildItems?.(parentSrcId).catch(() => []) ?? [];
   if (!kids.length) { return []; }
   stream.progress(`Copying ${kids.length} child item(s) at level ${depth + 1}...`);
   const nodes: MigratedNode[] = [];
   for (const child of kids) {
     try {
       const cf = await sourceProvider.getWorkItem(child.key);
       const cDesc = stripHtml(cf.description ?? '');
       const cAc = stripHtml((cf as any).acceptanceCriteria ?? '');
       const cSrcType = cf.rawTypeName ?? cap(cf.type);
       let cDstType = typeMap[cSrcType];
       if (!cDstType) {
         const match = dstTypes.find((d: string) => d.toLowerCase() === cSrcType.toLowerCase());
         cDstType = match ?? 'Task';
       }
       // Jira hierarchy: depth 0 = Sub-task under Story/Epic; depth 1+ = Task (can't nest Sub-tasks)
       const isJiraDst = destName.toLowerCase().includes('jira');
       let useParentField = true;
       if (isJiraDst) {
         if (depth === 0) {
           const subTask = dstTypes.find((d: string) => d.toLowerCase() === 'sub-task' || d.toLowerCase() === 'subtask');
           if (subTask) { cDstType = subTask; }
         } else {
           cDstType = dstTypes.find((d: string) => d.toLowerCase() === 'task') ?? 'Task';
           useParentField = false;
         }
       }
       let cDescF = fields.has('description') ? cDesc : undefined;
       if (!cDescF && direction === 'jira-to-ado') { cDescF = cf.title; }

       // Resolve assignee for child
       let cAssigneeId: string | undefined;
       if (fields.has('assignee') && cf.assignee?.email) {
         try {
           if (direction === 'jira-to-ado') {
             const match = dstMembers.find((m: any) =>
               m.email?.toLowerCase() === cf.assignee!.email?.toLowerCase() ||
               m.displayName.toLowerCase() === cf.assignee!.displayName.toLowerCase()
             );
             cAssigneeId = match?.id;
           } else {
             const resolved = await (destProvider as any).resolveUser?.(cf.assignee.email);
             cAssigneeId = resolved?.id;
           }
         } catch { /* skip */ }
       }

       const cDest = await destProvider.createWorkItem({
         type: cf.type, rawTypeName: cDstType, title: cf.title,
         description: cDescF,
         acceptanceCriteria: fields.has('ac') && cAc ? cAc : undefined,
         storyPoints: fields.has('points') ? (cf.storyPoints ?? cf.effort) : undefined,
         priority: fields.has('priority') ? cf.priority : undefined,
         labels: fields.has('labels') && cf.labels?.length ? cf.labels : undefined,
         assigneeId: cAssigneeId,
         parentId: useParentField ? parentDstId : undefined,
       });
       // Link to parent
       if (useParentField) {
         await (destProvider as any).addParentLink?.(cDest.key ?? cDest.id, parentDstId).catch(() => {});
       } else {
         try {
           await (destProvider as any).addParentLink?.(cDest.key ?? cDest.id, parentDstId);
         } catch {
           await destProvider.addComment(cDest.key,
             `Linked to parent: ${parentDstKey} (hierarchy too deep for native parent link)`
           ).catch(() => {});
         }
       }
       await destProvider.addComment(cDest.key,
         `Migrated from ${sourceName} — original: ${child.url}, parent: ${parentDstKey}`
       ).catch(() => {});

       // Copy comments if selected
       if (fields.has('comments')) {
         if (!cf.comments?.length) {
           try { cf.comments = await sourceProvider.getComments(cf.key ?? cf.id); } catch { /* unavailable */ }
         }
         if (cf.comments?.length) {
           for (const cm of cf.comments.slice(0, 20)) {
             try {
               await destProvider.addComment(cDest.key,
                 `**From ${sourceName} (${cm.author}${cm.createdAt ? ' — ' + cm.createdAt.slice(0, 10) : ''}):**\n\n${cm.body}`
               );
             } catch { /* skip */ }
           }
         }
       }

       // Recurse
       const grandchildren = await migrateChildrenRec(cf.id ?? child.key, cDest.key ?? cDest.id, cDest.key, depth + 1);
       nodes.push({ source: cf, dest: cDest, children: grandchildren });
     } catch (childErr) {
       failed.push({ key: `${child.key} (child L${depth+1})`, error: childErr instanceof Error ? childErr.message.slice(0, 120) : String(childErr) });
     }
   }
   return nodes;
 };
 migratedChildren.push(...await migrateChildrenRec(full.id ?? src.key, destItem.key ?? destItem.id, destItem.key, 0));
 }

 created.push({ source: full, dest: destItem, children: migratedChildren });
 } catch (e: unknown) {
 failed.push({ key: src.key, error: e instanceof Error ? e.message.slice(0, 120) : String(e) });
 }
 }

 // Report results with clickable links
 if (created.length) {
 const lines: string[] = [];
 const renderTree = (nodes: typeof created, indent: string) => {
   for (const { source, dest, children } of nodes) {
     const suffix = indent ? ' _(child)_' : '';
     lines.push(`${indent}- [${source.key}](${source.url}) → [${dest.key}](${dest.url}) ${dest.title}${suffix}`);
     renderTree(children, indent + '  ');
   }
 };
 renderTree(created, '');
 let totalCount = 0;
 const countTree = (nodes: typeof created): number => nodes.reduce((n, c) => n + 1 + countTree(c.children), 0);
 totalCount = countTree(created);
 stream.markdown(
 formatSuccess(`Migrated **${totalCount}** item${totalCount !== 1 ? 's' : ''} to ${destName}`) +
 '\n\n' + lines.join('\n')
 );
 }
 if (failed.length) {
 stream.markdown(
 `\n**Failed (${failed.length}):**\n` +
 failed.map(f => `- ${f.key}: ${f.error}`).join('\n')
 );
 }

 return { action: 'created', itemKey: created[0]?.dest.key };
 }

 // ── HELP ───────────────────────────────────────────────────────────────────

 private showHelp(stream: vscode.ChatResponseStream): void {
 const du = this.mem.defaultUser;
 stream.markdown(
 '**PM Agent** — manage work items without leaving VS Code\n\n' +
 (du
 ? ` **Default user:** ${du.displayName} — \`@pm /setuser\` to change\n\n`
 : ` **No default user set** — say \`@pm /setuser\` to pick one\n\n`) +
 '| Command | What it does |\n|---------|-------------|\n' +
 '| `@pm /setuser` | Set default user for all actions |\n' +
 '| `@pm list` | Tickets assigned to default user |\n' +
 '| `@pm list all tasks` | All tasks in project |\n' +
 '| `@pm open AB#123` | View item + clickable link |\n' +
 '| `@pm summary` | Default user\'s workload |\n' +
 '| `@pm summary AB#123` | One item in detail |\n' +
 '| `@pm create` | Create story/task/bug (guided) |\n' +
 '| `@pm comment AB#123` | Post a comment |\n' +
 '| `@pm status AB#123 done` | Change status |\n' +
 '| `@pm attach AB#123` | Upload attachment |\n' +
 '| `@pm estimate AB#123` | Set story points |\n' +
 '| `@pm show current sprint` | Sprint overview |\n' +
 '| `@pm /debug` | Test API + show team members |\n'
 );
 }
}

// ── Follow-up chips ─────────────────────────────────────────────────────────

export function buildFollowups(
  _result: vscode.ChatResult,
  _ctx:    vscode.ChatContext,
  _token:  vscode.CancellationToken
): vscode.ChatFollowup[] {
  // Followup chips removed — use the chat interface directly
  return [];
}


