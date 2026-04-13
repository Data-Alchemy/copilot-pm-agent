// src/commandRunner.ts
// Standalone command-palette interface — works without GitHub Copilot entirely.
// Every @pm chat action is also available via Ctrl+Shift+P → "PM Agent: ..."

import * as vscode from 'vscode';
import { CredentialManager } from './utils/credentialManager';
import { createProvider } from './providers/providerFactory';
import { AdoProvider } from './providers/adoProvider';
import { WorkItem } from './types';
import { cap, truncate } from './utils/strings';


export class CommandRunner {
  constructor(
    private readonly credMgr: CredentialManager,
    private readonly context: vscode.ExtensionContext
  ) {}

  // ── helpers ─────────────────────────────────────────────────────────────

  private async getProvider() {
    const creds = await this.credMgr.getCredentials();
    return { provider: createProvider(creds), creds };
  }

  private async defaultUser() {
    return this.credMgr.getDefaultUser();
  }

  private setLastItem(item: WorkItem): void {
    void this.context.workspaceState.update('pmAgent.lastItem', item);
  }

  private lastItem(): WorkItem | undefined {
    return this.context.workspaceState.get<WorkItem>('pmAgent.lastItem');
  }

  // ── Pick a work item from a quick-pick list ──────────────────────────────

  async pickItem(title: string): Promise<WorkItem | undefined> {
    const { provider } = await this.getProvider();
    const du = await this.defaultUser();

    let items: WorkItem[] = [];
    try {
      items = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading work items…' },
        () => provider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 100 })
      ) as WorkItem[];
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to load items: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }

    type Opt = vscode.QuickPickItem & { item?: WorkItem };
    const opts: Opt[] = [];

    const last = this.lastItem();
    if (last) {
      opts.push({ label: `${last.key} — ${last.title}`, description: `Last viewed · ${last.status}`, item: last });
    }
    for (const wi of items) {
      if (wi.key === last?.key) { continue; }
      opts.push({
        label:       `${wi.key} — ${wi.title}`,
        description: `${cap(wi.type)} · ${wi.status}`,
        item:        wi
      });
    }
    opts.push({ label: '$(edit) Enter key manually...', description: '', item: undefined });

    const picked = await vscode.window.showQuickPick(opts, { title, matchOnDescription: true, ignoreFocusOut: true });
    if (!picked) { return undefined; }

    if (!picked.item) {
      const raw = await vscode.window.showInputBox({ title: 'Work item key', placeHolder: '#1234 or ENG-42', ignoreFocusOut: true });
      if (!raw?.trim()) { return undefined; }
      try {
        return await provider.getWorkItem(raw.trim());
      } catch (e) {
        vscode.window.showErrorMessage(`Not found: ${raw}`);
        return undefined;
      }
    }
    return picked.item;
  }

  // ── LIST ─────────────────────────────────────────────────────────────────

  async list() {
    const { provider } = await this.getProvider();
    const du = await this.defaultUser();
    const label = du?.displayName ?? 'your';

    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading ${label}'s items...` },
      () => provider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 50 })
    );

    if (!items.length) {
      vscode.window.showInformationMessage('No work items found. Check your default user with PM Agent: Set Default User.');
      return;
    }

    type Opt = vscode.QuickPickItem & { item: WorkItem };
    const opts: Opt[] = items.map(wi => ({
      label:       `${wi.key} — ${wi.title}`,
      description: `${cap(wi.type)} · ${wi.status}` + (wi.storyPoints ? ` · ${wi.storyPoints}pts` : ''),
      detail:      wi.sprint ? `Sprint: ${wi.sprint.split('\\').pop() ?? wi.sprint}` : 'Backlog',
      item:        wi
    }));

    const picked = await vscode.window.showQuickPick(opts, {
      title:             `${label}'s work items (${items.length})`,
      placeHolder:       'Select to open in browser, or press Escape to close',
      matchOnDescription: true,
      matchOnDetail:      true,
      ignoreFocusOut:    true
    });

    if (picked) {
      this.setLastItem(picked.item);
      await vscode.env.openExternal(vscode.Uri.parse(picked.item.url));
    }
  }

  // ── OPEN ─────────────────────────────────────────────────────────────────

  async open(keyHint?: string) {
    const { provider } = await this.getProvider();

    let key = keyHint;
    if (!key) {
      key = await vscode.window.showInputBox({
        title:          'Open work item',
        prompt:         'Enter the work item key',
        placeHolder:    '#1234 or ENG-42',
        ignoreFocusOut: true
      });
    }
    if (!key?.trim()) { return; }

    let item: import('./types').WorkItem | null = null;
    try {
      item = await (vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${key}...` },
        () => provider.getWorkItem(key!.trim())
      ) as unknown as Promise<import('./types').WorkItem>);
    } catch(e) { vscode.window.showErrorMessage(String(e)); return; }

    if (!item) { return; }
    this.setLastItem(item);

    const info = [
      `${item.key}  ${item.title}`,
      `Type: ${cap(item.type)}   Status: ${item.status}`,
      item.assignee ? `Assignee: ${item.assignee.displayName}` : '',
      item.storyPoints ? `Points: ${item.storyPoints}` : '',
      item.sprint ? `Sprint: ${item.sprint.split('\\').pop() ?? item.sprint}` : '',
      item.description ? `\n${item.description.slice(0, 300)}` : ''
    ].filter(Boolean).join('\n');

    const choice = await vscode.window.showInformationMessage(info, 'Open in Browser', 'Close');
    if (choice === 'Open in Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(item.url));
    }
  }

  // ── STATUS ───────────────────────────────────────────────────────────────

  async status() {
    const { provider, creds } = await this.getProvider();
    const item = await this.pickItem('Change status of which item?');
    if (!item) { return; }

    let states: string[] = [];
    if (creds.platform === 'azuredevops') {
      try {
        const typeName = item.rawTypeName ?? item.type;
        states = await (provider as AdoProvider).getWorkItemStates(typeName);
      } catch { /* fall through */ }
      if (!states.length) {
        states = ['New', 'Active', 'Resolved', 'Closed'];
      }
    } else {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        states = await (provider as any).getAvailableTransitions?.(item.key) ?? [];
      } catch { /* fall through */ }
      if (!states.length) { states = ['To Do', 'In Progress', 'In Review', 'Done']; }
    }

    const opts = states
      .filter(s => s.toLowerCase() !== item.status.toLowerCase())
      .map(s => ({ label: s }));

    const picked = await vscode.window.showQuickPick(opts, {
      title:          `${item.key} — current: ${item.status}`,
      placeHolder:    'Select new status',
      ignoreFocusOut: true
    });
    if (!picked) { return; }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Moving to "${picked.label}"...` },
      () => provider.transitionWorkItem(item.key, picked.label)
    );

    if (result.success) {
      vscode.window.showInformationMessage(`${item.key}: ${picked.label}`);
    } else {
      vscode.window.showErrorMessage(result.error ?? 'Transition failed');
    }
  }

  // ── COMMENT ──────────────────────────────────────────────────────────────

  async comment() {
    const { provider } = await this.getProvider();
    const item = await this.pickItem('Add comment to which item?');
    if (!item) { return; }

    const text = await vscode.window.showInputBox({
      title:          `Comment on ${item.key} — ${item.title}`,
      prompt:         'Enter your comment',
      placeHolder:    'Your comment here...',
      ignoreFocusOut: true
    });
    if (!text?.trim()) { return; }

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Posting comment...' },
      () => provider.addComment(item.key, text.trim())
    );

    if (result && typeof result === 'object' && 'success' in result) {
      if ((result as any).success) {
        vscode.window.showInformationMessage(`Comment posted on ${item.key}`);
      } else {
        vscode.window.showErrorMessage((result as any).error ?? 'Failed to post comment');
      }
    } else {
      vscode.window.showInformationMessage(`Comment posted on ${item.key}`);
    }
  }

  // ── ASSIGN ───────────────────────────────────────────────────────────────

  async assign() {
    const { provider } = await this.getProvider();
    const item = await this.pickItem('Assign which item?');
    if (!item) { return; }

    const members = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading team members...' },
      () => provider.getProjectMembers()
).then(v => v, () => [] as import('./types').User[]);

    if (!members.length) {
      vscode.window.showErrorMessage('No team members found. Check project configuration.');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (members as any[]).map((m: any) => ({
      label:       String(m.displayName ?? ''),
      description: String(m.email ?? m.id ?? ''),
      id:          String(m.id ?? '')
    }));

    const picked = await vscode.window.showQuickPick(opts, {
      title:          `Assign ${item.key}`,
      placeHolder:    'Select team member',
      ignoreFocusOut: true
    });
    if (!picked) { return; }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Assigning to ${picked.label}...` },
        () => provider.updateWorkItem(item.key, { assigneeId: picked.id })
      );
      vscode.window.showInformationMessage(`${item.key} assigned to ${picked.label}`);
    } catch(e) { vscode.window.showErrorMessage(String(e)); }
  }

  // ── ESTIMATE ─────────────────────────────────────────────────────────────

  async estimate() {
    const { provider } = await this.getProvider();
    const item = await this.pickItem('Set story points for which item?');
    if (!item) { return; }

    const input = await vscode.window.showInputBox({
      title:          `Story points for ${item.key}`,
      prompt:         `Current: ${item.storyPoints ?? 'unset'}. Enter new value.`,
      placeHolder:    '1, 2, 3, 5, 8, 13...',
      ignoreFocusOut: true,
      validateInput:  v => isNaN(Number(v)) ? 'Enter a number' : undefined
    });
    if (!input?.trim()) { return; }

    const pts = Number(input.trim());
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Updating...' },
      () => provider.updateWorkItem(item.key, { storyPoints: pts, effort: pts })
    ).then(() => {
      vscode.window.showInformationMessage(`${item.key}: ${pts} story points`);
    }, e => vscode.window.showErrorMessage(String(e)));
  }

  // ── MOVE (sprint) ────────────────────────────────────────────────────────

  async move() {
    const { provider, creds } = await this.getProvider();

    // Multi-select items
    const du = await this.defaultUser();
    const allItems = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading items...' },
      () => provider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 100 })
).then(v => v, () => [] as WorkItem[]);

    if (!allItems.length) {
      vscode.window.showErrorMessage('No items found.');
      return;
    }

    type IQ = vscode.QuickPickItem & { wi: WorkItem };
    const itemOpts: IQ[] = allItems.map(wi => ({
      label:       `${wi.key} — ${wi.title}`,
      description: `${cap(wi.type)} · ${wi.status} · ${wi.sprint?.split('\\').pop() ?? 'backlog'}`,
      wi
    }));

    const selectedItems = await vscode.window.showQuickPick<IQ>(itemOpts, {
      title:          'Select items to move (multi-select with Space)',
      canPickMany:    true,
      ignoreFocusOut: true
    });
    if (!selectedItems?.length) { return; }

    // Pick sprint
    let sprints: import('./types').Sprint[] = [];
    try {
      if (creds.platform === 'azuredevops') {
        sprints = await (provider as AdoProvider).getAllSprints();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sprints = await (provider as any).getAllSprints?.() ?? [];
      }
    } catch { /* no sprints */ }

    if (!sprints.length) {
      vscode.window.showErrorMessage('No sprints found.');
      return;
    }

    type SprintOpt = vscode.QuickPickItem & { sprintId: string; iterationPath: string };
    const sprintOpts: SprintOpt[] = [];
    const active = sprints.find(s => s.state === 'active');
    if (active) {
      sprintOpts.push({
        label:         active.name,
        description:   'Active sprint' + (active.endDate ? ` · ends ${active.endDate.slice(0,10)}` : ''),
        sprintId:      active.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        iterationPath: (active as any).iterationPath ?? active.id
      });
    }
    for (const s of sprints.filter(s => s.state === 'future')) {
      sprintOpts.push({
        label:         s.name,
        description:   'Upcoming',
        sprintId:      s.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        iterationPath: (s as any).iterationPath ?? s.id
      });
    }
    sprintOpts.push({ label: 'Backlog', description: 'Remove from sprint', sprintId: '', iterationPath: '' });

    const targetSprint = await vscode.window.showQuickPick(sprintOpts, {
      title:          `Move ${selectedItems.length} items to sprint`,
      ignoreFocusOut: true
    });
    if (!targetSprint) { return; }

    let moved = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Moving ${selectedItems.length} items...` },
      async () => {
        for (const opt of selectedItems) {
          try {
            if (creds.platform === 'azuredevops') {
              const adoP = provider as AdoProvider;
              const n = (opt as IQ).wi.id.replace(/^#/, '').replace(/^AB#/i, '');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const cur = await (adoP as any).http(`${(adoP as any).orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`) as any;
              const iterPath = targetSprint.iterationPath || (cur.fields?.['System.IterationPath'] ?? '').split('\\')[0];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ops: any[] = [{ op: 'replace', path: '/fields/System.IterationPath', value: iterPath }];
              if (cur.fields?.['System.AreaPath']) {
                ops.push({ op: 'replace', path: '/fields/System.AreaPath', value: cur.fields['System.AreaPath'] });
              }
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (adoP as any).http(`${(adoP as any).orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
                { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } });
            } else {
              const sid = Number(targetSprint.sprintId);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              await (provider as any).callApi(`/issue/${encodeURIComponent((opt as IQ).wi.key)}`, {
                method: 'PUT',
                body: JSON.stringify({ fields: { customfield_10020: sid > 0 ? sid : null } })
              });
            }
            moved++;
          } catch { /* skip individual failures */ }
        }
      }
    );

    vscode.window.showInformationMessage(
      `Moved ${moved}/${selectedItems.length} items to ${targetSprint.label || 'backlog'}`
    );
  }

  // ── SPRINT ───────────────────────────────────────────────────────────────

  async sprint() {
    const { provider, creds } = await this.getProvider();

    let sprints: import('./types').Sprint[] = [];
    try {
      if (creds.platform === 'azuredevops') {
        sprints = await (provider as AdoProvider).getAllSprints();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sprints = await (provider as any).getAllSprints?.() ?? [];
      }
    } catch { /* no sprints */ }

    const active = sprints.find(s => s.state === 'active');
    if (!active) {
      vscode.window.showInformationMessage('No active sprint found.');
      return;
    }

    const du = await this.defaultUser();
    const items = await provider.searchWorkItems({
      assigneeId: du?.id ?? '@me',
      sprintId:   creds.platform === 'azuredevops'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (active as any).iterationPath ?? active.id
        : active.id,
      maxResults: 50
    }).catch(() => [] as WorkItem[]);

    const summary = [
      `Sprint: ${active.name}`,
      active.endDate ? `Ends: ${active.endDate.slice(0,10)}` : '',
      `Items: ${items.length}`,
      '',
      ...items.slice(0, 15).map(wi => `${wi.key}  [${wi.status}]  ${wi.title}`)
    ].filter(s => s !== undefined).join('\n');

    const choice = await vscode.window.showInformationMessage(summary, { modal: true }, 'Open All in Browser', 'Close');
    if (choice === 'Open All in Browser' && items.length) {
      await vscode.env.openExternal(vscode.Uri.parse(items[0].url));
    }
  }

  // ── DEBUG ────────────────────────────────────────────────────────────────

  async debug() {
    const { provider, creds } = await this.getProvider();
    const channel = vscode.window.createOutputChannel('PM Agent Debug');
    channel.show();
    channel.appendLine('PM Agent — Connection Diagnostics');
    channel.appendLine('='.repeat(40));
    channel.appendLine(`Platform: ${creds.platform}`);

    try {
      channel.appendLine('\nTest 1: Fetching projects...');
      const projects = await provider.getProjects();
      channel.appendLine(`  OK  ${projects.length} projects found: ${projects.map(p => p.key).slice(0,8).join(', ')}`);
    } catch (e) {
      channel.appendLine(`  FAIL  ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      channel.appendLine('\nTest 2: Loading project members...');
      const members = await provider.getProjectMembers();
      channel.appendLine(`  OK  ${members.length} members found`);
      if (members.length) {
        channel.appendLine(`    First 5: ${members.slice(0,5).map(m => m.displayName).join(', ')}`);
      }
    } catch (e) {
      channel.appendLine(`  FAIL  ${e instanceof Error ? e.message : String(e)}`);
    }

    const du = await this.defaultUser();
    channel.appendLine(`\nDefault user: ${du ? `${du.displayName} (${du.id})` : 'not set'}`);
    channel.appendLine('\nDone. If tests failed, run "PM Agent: Configure Platform" to reconnect.');
  }

  // ── CREATE ───────────────────────────────────────────────────────────────
  // Fully standalone — works with zero AI, zero Copilot.
  // AI enhancement is attempted if available but skipped gracefully.

  async create() {
    const { provider, creds } = await this.getProvider();
    const platform = creds.platform;
    const aiCfg    = await this.credMgr.getAiConfig().catch(() => ({ provider: 'none' as const }));

    // ── 1. Work item type ─────────────────────────────────────────────────
    let rawTypeName: string | undefined;
    let workItemType = 'task';

    if (platform === 'azuredevops') {
      const adoTypes = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading work item types...' },
        () => (provider as import('./providers/adoProvider').AdoProvider).getWorkItemTypes()
      ).then(v => v, () => ['User Story', 'Task', 'Bug', 'Epic', 'Feature']);

      const typePick = await vscode.window.showQuickPick(
        adoTypes.map(t => ({ label: t, value: t })),
        { title: 'Work item type', ignoreFocusOut: true }
      );
      if (!typePick) { return; }
      rawTypeName  = typePick.value;
      const tl     = typePick.value.toLowerCase();
      if      (tl.includes('story') || tl.includes('backlog') || tl.includes('requirement')) { workItemType = 'story'; }
      else if (tl.includes('bug'))     { workItemType = 'bug'; }
      else if (tl.includes('epic'))    { workItemType = 'epic'; }
      else if (tl.includes('feature')) { workItemType = 'feature'; }
      else                             { workItemType = 'task'; }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jiraTypes: string[] = await (provider as any).getWorkItemTypes?.().catch(() => ['Story', 'Task', 'Bug', 'Epic', 'Sub-task']) ?? ['Story', 'Task', 'Bug', 'Epic'];
      const typePick = await vscode.window.showQuickPick(
        jiraTypes.map(t => ({ label: t, value: t })),
        { title: 'Issue type', ignoreFocusOut: true }
      );
      if (!typePick) { return; }
      rawTypeName  = typePick.value;
      const tl     = typePick.value.toLowerCase();
      if      (tl.includes('story')) { workItemType = 'story'; }
      else if (tl.includes('bug'))   { workItemType = 'bug'; }
      else if (tl.includes('epic'))  { workItemType = 'epic'; }
      else                           { workItemType = 'task'; }
    }

    // ── 2. Title ──────────────────────────────────────────────────────────
    const title = await vscode.window.showInputBox({
      title:          `${rawTypeName ?? cap(workItemType)} title`,
      prompt:         'Short, descriptive title',
      placeHolder:    'e.g. User can reset password via email',
      ignoreFocusOut: true
    });
    if (!title?.trim()) { return; }

    // ── 3. Notes / description ────────────────────────────────────────────
    const notes = await vscode.window.showInputBox({
      title:          'Background (optional)',
      prompt:         'Any context, constraints, or acceptance criteria',
      placeHolder:    'Leave blank to skip',
      ignoreFocusOut: true
    });

    // ── 4. Try AI enhancement (completely optional) ───────────────────────
    let description: string | undefined;
    let acceptanceCriteria: string | undefined;
    let storyPoints: number | undefined;

    const copilotOk = aiCfg.provider === 'copilot';
    const externalOk = aiCfg.provider !== 'none' && aiCfg.provider !== 'copilot' && !!(aiCfg as any).apiKey;
    const aiReady = copilotOk || externalOk;

    if (aiReady) {
      try {
        const { enhanceTicket } = await import('./utils/aiHelper');
        const enhancement = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Enhancing with AI...' },
          () => enhanceTicket(aiCfg as any, rawTypeName ?? cap(workItemType), title.trim(), notes ?? '', platform, undefined)
        );
        if (enhancement) {
          description        = platform === 'azuredevops' ? `<p>${enhancement.what}</p>` : enhancement.what;
          acceptanceCriteria = platform === 'azuredevops' ? `<p>${enhancement.how}</p>` : enhancement.how;
          storyPoints        = enhancement.effortPoints;
        }
      } catch { /* AI unavailable — continue without it */ }
    }

    // If no AI, use notes as description directly
    if (!description && notes?.trim()) {
      description = platform === 'azuredevops' ? `<p>${notes.trim()}</p>` : notes.trim();
    }

    // ADO requires Description to be non-empty for most work item types
    if (!description && platform === 'azuredevops') {
      description = `<p>${title.trim()}</p>`;
    }

    // ── 5. Story points ───────────────────────────────────────────────────
    if (!storyPoints) {
      const POINT_OPTIONS = [
        { label: '1',  description: 'Trivial — a few hours, minimal complexity' },
        { label: '2',  description: 'Small — half a day, straightforward' },
        { label: '3',  description: 'Medium — about a day, some complexity' },
        { label: '5',  description: 'Large — 2-3 days, moderate complexity' },
        { label: '8',  description: 'Very large — a week, significant complexity' },
        { label: '13', description: 'Epic-sized — 1-2 weeks, high complexity' },
        { label: 'Skip', description: 'No estimate' },
      ];
      const ptPick = await vscode.window.showQuickPick(POINT_OPTIONS, {
        title:          platform === 'azuredevops' ? 'Effort (story points)' : 'Story points',
        placeHolder:    'Select effort estimate',
        ignoreFocusOut: true
      });
      if (ptPick && ptPick.label !== 'Skip') { storyPoints = Number(ptPick.label); }
    }

    // ── 6. Priority ───────────────────────────────────────────────────────
    let priority: string | undefined;
    let priorities: string[] = ['Critical', 'High', 'Medium', 'Low'];
    if (platform === 'jira') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      priorities = await (provider as any).getPriorities?.().catch(() => priorities) ?? priorities;
    }
    const prioPick = await vscode.window.showQuickPick(
      priorities.map(p => ({ label: p })),
      { title: 'Priority', placeHolder: 'Select priority', ignoreFocusOut: true }
    );
    if (prioPick) { priority = prioPick.label; }

    // ── 7. Assignee ───────────────────────────────────────────────────────
    let assigneeId: string | undefined;
    const du = await this.defaultUser();
    const members = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading team…' },
      () => provider.getProjectMembers()
    ).then(v => v, () => [] as import('./types').User[]);

    if (members.length || du) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type MQ = vscode.QuickPickItem & { id: string };
      const assignOpts: MQ[] = [];
      if (du) { assignOpts.push({ label: `${du.displayName} (you)`, description: du.email ?? '', id: du.id }); }
      assignOpts.push({ label: 'Leave unassigned', description: '', id: '' });
      for (const m of members) {
        if (m.id !== du?.id) {
          assignOpts.push({ label: m.displayName, description: m.email ?? '', id: m.id });
        }
      }
      const aPick = await vscode.window.showQuickPick<MQ>(assignOpts, {
        title: 'Assignee', placeHolder: du ? `Default: ${du.displayName}` : 'Select assignee',
        ignoreFocusOut: true
      });
      if (aPick?.id) { assigneeId = aPick.id; }
    }

    // ── 8. Sprint ─────────────────────────────────────────────────────────
    let sprintId: string | undefined;
    let iterationPath: string | undefined;

    try {
      let sprints: import('./types').Sprint[] = [];
      if (platform === 'azuredevops') {
        sprints = await (provider as import('./providers/adoProvider').AdoProvider).getAllSprints();
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sprints = await (provider as any).getAllSprints?.() ?? [];
      }

      if (sprints.length) {
        const active = sprints.find(s => s.state === 'active');
        type SQ = vscode.QuickPickItem & { sprintId: string; iterPath: string };
        const sprintOpts: SQ[] = [];
        if (active) {
          sprintOpts.push({
            label: active.name, description: 'Active sprint',
            sprintId: active.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            iterPath: (active as any).iterationPath ?? active.id
          });
        }
        for (const s of sprints.filter(s => s.state === 'future').slice(0, 3)) {
          sprintOpts.push({
            label: s.name, description: 'Upcoming',
            sprintId: s.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            iterPath: (s as any).iterationPath ?? s.id
          });
        }
        sprintOpts.push({ label: 'Backlog', description: 'No sprint', sprintId: '', iterPath: '' });

        const sPick = await vscode.window.showQuickPick<SQ>(sprintOpts, {
          title:          'Sprint',
          placeHolder:    active ? `Default: ${active.name}` : 'Select sprint',
          ignoreFocusOut: true
        });
        if (sPick) {
          sprintId      = sPick.sprintId || undefined;
          iterationPath = sPick.iterPath || undefined;
        }
      }
    } catch { /* sprints unavailable — skip */ }

    // ── 9. Confirm ────────────────────────────────────────────────────────
    const confirmLines = [
      `Type:     ${rawTypeName ?? cap(workItemType)}`,
      `Title:    ${title.trim()}`,
      storyPoints ? `Points:   ${storyPoints}` : '',
      priority    ? `Priority: ${priority}` : '',
      assigneeId  ? `Assignee: ${members.find(m => m.id === assigneeId)?.displayName ?? assigneeId}` : 'Assignee: unassigned',
      sprintId    ? `Sprint:   ${sprintId}` : 'Sprint:   backlog',
    ].filter(Boolean).join('\n');

    const confirm = await vscode.window.showQuickPick(
      [{ label: 'Create', value: 'yes' }, { label: 'Cancel', value: 'no' }],
      { title: `Create ${rawTypeName}?\n\n${confirmLines}`, ignoreFocusOut: true }
    );
    if (!confirm || confirm.value === 'no') { return; }

    // ── 10. Create ────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created: import('./types').WorkItem = await (provider as any).createWorkItem({
      type:               workItemType as import('./types').WorkItemType,
      title:              title.trim(),
      description,
      acceptanceCriteria,
      storyPoints,
      priority,
      assigneeId,
      sprintId:           platform === 'azuredevops' ? iterationPath : sprintId,
      rawTypeName
    });
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating…` }, () => Promise.resolve());

    const choice = await vscode.window.showInformationMessage(
      `Created ${created.key} — ${created.title}`,
      'Open in Browser', 'Close'
    );
    if (choice === 'Open in Browser') {
      await vscode.env.openExternal(vscode.Uri.parse(created.url));
    }
  }

  // ── SET DEFAULT USER ──────────────────────────────────────────────────────

  async setUser() {
    const { provider, creds } = await this.getProvider();

    const members = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading team members...' },
      () => provider.getProjectMembers()
    ).then(v => v, () => [] as import('./types').User[]);

    type UQ = vscode.QuickPickItem & { user?: import('./types').User };
    const opts: UQ[] = members.map(m => ({
      label:       m.displayName,
      description: m.email ?? m.id,
      user:        m
    }));
    opts.push({ label: '$(edit) Enter manually...', description: 'Type your email', user: undefined });

    const picked = await vscode.window.showQuickPick<UQ>(opts, {
      title:          'Set default user',
      placeHolder:    'Search by name or email',
      matchOnDescription: true,
      ignoreFocusOut: true
    });
    if (!picked) { return; }

    let user: import('./types').User | null = picked.user ?? null;

    if (!user) {
      // Manual entry
      const email = await vscode.window.showInputBox({
        title:          'Your email address',
        prompt:         'Enter the email you use to log in',
        placeHolder:    'jane.smith@company.com',
        ignoreFocusOut: true
      });
      if (!email?.trim()) { return; }

      if (creds.platform === 'jira') {
        // Try to resolve email → accountId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const resolved = await (provider as any).resolveUser?.(email.trim());
        user = resolved ?? { id: email.trim(), displayName: email.trim(), email: email.trim() };
      } else {
        // ADO — use email as ID
        user = { id: email.trim(), displayName: email.trim(), email: email.trim() };
      }
    }

    if (!user) { return; }
    await this.credMgr.setDefaultUser(user);
    this.context.globalState.update('defaultUser', user);
    vscode.window.showInformationMessage(`Default user set to ${user.displayName}`);
  }

  // ── SET PARENT ────────────────────────────────────────────────────────────

  async parent() {
    const { provider, creds } = await this.getProvider();
    if (creds.platform !== 'azuredevops' && creds.platform !== 'jira') {
      vscode.window.showErrorMessage('Parent linking requires ADO or Jira.');
      return;
    }

    const child = await this.pickItem('Set parent for which item?');
    if (!child) { return; }

    // Load parent candidates — stories, epics, features
    const all = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading potential parents...' },
      () => provider.searchWorkItems({ status: 'open', maxResults: 50 } as any)
    ).then(v => v, () => [] as import('./types').WorkItem[]);

    const parents = all.filter(i =>
      i.key !== child.key &&
      (['story', 'epic', 'feature'].includes(i.type) ||
       !!(i.rawTypeName ?? '').toLowerCase().match(/story|epic|feature|requirement|backlog/))
    );

    if (!parents.length) {
      vscode.window.showErrorMessage('No Stories, Epics, or Features found to use as parents.');
      return;
    }

    type PQ = vscode.QuickPickItem & { item: import('./types').WorkItem };
    const opts: PQ[] = parents.map(p => ({
      label:       `${p.key} — ${p.title}`,
      description: `${cap(p.type)} · ${p.status}`,
      item:        p
    }));

    const picked = await vscode.window.showQuickPick<PQ>(opts, {
      title:          `Select parent for ${child.key}`,
      matchOnDescription: true,
      ignoreFocusOut: true
    });
    if (!picked) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Linking...' },
      async () => {
        if (creds.platform === 'azuredevops') {
          await (provider as import('./providers/adoProvider').AdoProvider)
            .addParentLink(child.id, picked.item.id);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (provider as any).addParentLink(child.key, picked.item.key || picked.item.id);
        }
      }
    );

    vscode.window.showInformationMessage(
      `${child.key} is now a child of ${picked.item.key} — ${picked.item.title}`
    );
  }

  // ── MIGRATE ───────────────────────────────────────────────────────────────

  async migrate() {
    const both = await this.credMgr.getBothCredentials();
    if (!both.jira) {
      vscode.window.showErrorMessage('Jira credentials not configured. Run PM Agent: Configure Platform.');
      return;
    }
    if (!both.ado) {
      vscode.window.showErrorMessage('Azure DevOps credentials not configured. Run PM Agent: Configure Platform.');
      return;
    }

    const { createProvider } = await import('./providers/providerFactory');
    const jiraP = createProvider(both.jira);
    const adoP  = createProvider(both.ado);
    const creds = await this.credMgr.getCredentials();

    // Direction
    const dirOpts = [
      { label: 'Jira to Azure DevOps',  description: 'Copy Jira tickets to ADO', value: 'jira-to-ado' },
      { label: 'Azure DevOps to Jira',  description: 'Copy ADO tickets to Jira',  value: 'ado-to-jira' }
    ];
    const dirPick = await vscode.window.showQuickPick(dirOpts, {
      title: 'Migration direction', ignoreFocusOut: true
    });
    if (!dirPick) { return; }

    const direction  = dirPick.value as 'jira-to-ado' | 'ado-to-jira';
    const srcProvider = direction === 'jira-to-ado' ? jiraP : adoP;
    const dstProvider = direction === 'jira-to-ado' ? adoP  : jiraP;
    const srcName     = direction === 'jira-to-ado' ? 'Jira'         : 'Azure DevOps';
    const dstName     = direction === 'jira-to-ado' ? 'Azure DevOps' : 'Jira';

    // Select source items
    const du = await this.defaultUser();
    const srcItems = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading ${srcName} items...` },
      () => srcProvider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 100 })
    ).then(v => v, () => [] as import('./types').WorkItem[]);

    if (!srcItems.length) {
      vscode.window.showErrorMessage(`No items found in ${srcName}.`);
      return;
    }

    type IQ2 = vscode.QuickPickItem & { wi: import('./types').WorkItem };
    const itemOpts2: IQ2[] = srcItems.map(wi => ({
      label:       `${wi.key} — ${wi.title}`,
      description: `${cap(wi.type)} · ${wi.status}`,
      wi
    }));

    const selectedItems = await vscode.window.showQuickPick<IQ2>(itemOpts2, {
      title:       `Select items to copy from ${srcName} to ${dstName}`,
      canPickMany: true,
      ignoreFocusOut: true
    });
    if (!selectedItems?.length) { return; }

    // Field selection
    type FQ = vscode.QuickPickItem & { field: string };
    const fieldOpts: FQ[] = [
      { label: 'Title',               description: 'Always copied',           field: 'title',       picked: true  },
      { label: 'Description',         description: '',                         field: 'description', picked: true  },
      { label: 'Acceptance Criteria', description: '',                         field: 'ac',          picked: true  },
      { label: 'Story Points',        description: '',                         field: 'points',      picked: true  },
      { label: 'Priority',            description: '',                         field: 'priority',    picked: true  },
      { label: 'Labels / Tags',       description: '',                         field: 'labels',      picked: true  },
      { label: 'Assignee',            description: 'Matched by email',         field: 'assignee',    picked: false },
      { label: 'Comments',            description: 'Copies up to 20',          field: 'comments',    picked: false },
    ].map(f => ({ ...f, alwaysShow: true })) as FQ[];

    const fieldPicks = await vscode.window.showQuickPick<FQ>(fieldOpts, {
      title:       `What to copy (${selectedItems.length} item${selectedItems.length !== 1 ? 's' : ''})`,
      canPickMany: true,
      ignoreFocusOut: true
    });
    if (!fieldPicks?.length) { return; }
    const fields = new Set(fieldPicks.map(f => f.field));
    fields.add('title');

    // ── Type mapping ──────────────────────────────────────────────────────
    // Collect unique source types and let the user map them to destination types
    const srcTypes = [...new Set(selectedItems.map(i => i.wi.type))];
    let dstTypes: string[] = [];
    try {
      dstTypes = await dstProvider.getWorkItemTypes();
    } catch {
      // Fallback types
      dstTypes = direction === 'jira-to-ado'
        ? ['Task', 'Bug', 'Epic', 'Feature', 'User Story', 'Product Backlog Item']
        : ['Story', 'Task', 'Bug', 'Epic', 'Sub-task'];
    }

    const typeMap: Record<string, string> = {};
    for (const srcType of srcTypes) {
      // Try exact match first (case-insensitive)
      const exact = dstTypes.find(d => d.toLowerCase() === srcType.toLowerCase());
      if (exact) {
        typeMap[srcType] = srcType; // keep original — the provider will handle normalization
        continue;
      }

      // No exact match — ask the user
      type TQ = vscode.QuickPickItem & { rawType: string };
      const typeOpts: TQ[] = dstTypes.map(t => ({
        label: t,
        rawType: t,
      }));

      const picked = await vscode.window.showQuickPick<TQ>(typeOpts, {
        title: `Map "${srcType}" to which ${dstName} type?`,
        placeHolder: `"${srcType}" does not exist in ${dstName}. Choose a replacement.`,
        ignoreFocusOut: true
      });
      if (!picked) { return; } // user cancelled
      typeMap[srcType] = picked.rawType;
    }

    // Run migration
    let moved = 0, failed = 0;
    const createdKeys: string[] = [];
    const failedKeys: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Migrating to ${dstName}...` },
      async progress => {
        for (let idx = 0; idx < selectedItems.length; idx++) {
          const src = selectedItems[idx].wi;
          progress.report({ message: `${idx+1}/${selectedItems.length}: ${src.key}` });
          try {
            const full = await srcProvider.getWorkItem(src.key);
            const cleanDesc = (full.description ?? '').replace(/<[^>]+>/g, '').trim();
            const cleanAc   = ((full as any).acceptanceCriteria ?? '').replace(/<[^>]+>/g, '').trim();

            let assigneeId: string | undefined;
            if (fields.has('assignee') && full.assignee?.email) {
              if (direction === 'ado-to-jira') {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const r = await (dstProvider as any).resolveUser?.(full.assignee.email);
                assigneeId = r?.id ?? full.assignee.email;
              } else {
                const members = await dstProvider.getProjectMembers().catch(() => []);
                assigneeId = members.find(m =>
                  m.email?.toLowerCase() === full.assignee?.email?.toLowerCase()
                )?.id;
              }
            }

            // Ensure description is non-empty for ADO
            let desc = fields.has('description') ? cleanDesc : undefined;
            if (!desc && direction === 'jira-to-ado') { desc = full.title; }

            // Map the source type to the destination type
            const mappedType = typeMap[full.type] || full.type;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const destItem: import('./types').WorkItem = await (dstProvider as any).createWorkItem({
              type:               mappedType,
              title:              full.title,
              description:        desc,
              acceptanceCriteria: fields.has('ac') && cleanAc ? cleanAc : undefined,
              storyPoints:        fields.has('points') ? (full.storyPoints ?? full.effort) : undefined,
              priority:           fields.has('priority') ? full.priority : undefined,
              labels:             fields.has('labels') && full.labels?.length ? full.labels : undefined,
              assigneeId
            });

            // Migration comment
            await dstProvider.addComment(destItem.key,
              `Migrated from ${srcName} — original: ${full.url}`
            ).catch(() => {});

            if (fields.has('comments') && full.comments?.length) {
              for (const c of full.comments.slice(0, 20)) {
                await dstProvider.addComment(destItem.key,
                  `**From ${srcName} (${c.author}):** ${c.body}`
                ).catch(() => {});
              }
            }
            createdKeys.push(`[${src.key}](${full.url}) -> [${destItem.key}](${destItem.url})`);
            moved++;
          } catch (err) {
            failedKeys.push(`${src.key}: ${err instanceof Error ? err.message : String(err)}`);
            failed++;
          }
        }
      }
    );

    // Store results so the chat panels can read them
    const lines = [];
    lines.push(`**Migration complete:** ${moved} created, ${failed} failed.`);
    if (createdKeys.length) {
      lines.push('');
      for (const k of createdKeys) { lines.push(`- ${k}`); }
    }
    if (failedKeys.length) {
      lines.push('');
      lines.push('**Failed:**');
      for (const k of failedKeys) { lines.push(`- ${k}`); }
    }
    const summary = lines.join('\n');
    this._lastMigrateResult = summary;

    vscode.window.showInformationMessage(
      `Migration complete: ${moved} created, ${failed} failed.`
    );
  }

  /** Last migration result — read by chat panels */
  private _lastMigrateResult = '';
  get lastMigrateResult(): string { return this._lastMigrateResult; }
}
