// src/commandRunner.ts
// Standalone command-palette interface — works without GitHub Copilot entirely.
// Every @pm chat action is also available via Ctrl+Shift+P → "PM Agent: ..."

import * as vscode from 'vscode';
import { CredentialManager } from './utils/credentialManager';
import { createProvider } from './providers/providerFactory';
import { AdoProvider } from './providers/adoProvider';
import { WorkItem } from './types';
import { cap, stripHtml } from './utils/strings';


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

  /** Prompt user to filter items by type and status. Returns filtered items or undefined if cancelled. */
  private async filterItems(items: WorkItem[], context?: string): Promise<WorkItem[] | undefined> {
    // Type filter
    const types = [...new Set(items.map(wi => wi.rawTypeName ?? cap(wi.type)))].sort();
    if (types.length > 1) {
      type TF = vscode.QuickPickItem & { typeName: string };
      const typeOpts: TF[] = types.map(t => {
        const count = items.filter(wi => (wi.rawTypeName ?? cap(wi.type)) === t).length;
        return { label: t, description: `${count} item${count !== 1 ? 's' : ''}`, typeName: t, picked: true };
      });

      const pickedTypes = await vscode.window.showQuickPick<TF>(typeOpts, {
        title: context ? `Filter by type — ${context}` : 'Filter by type',
        placeHolder: 'Uncheck types to exclude, Enter to continue',
        canPickMany: true,
        ignoreFocusOut: true
      });
      if (!pickedTypes?.length) { return undefined; }

      const allowedTypes = new Set(pickedTypes.map(t => t.typeName));
      items = items.filter(wi => allowedTypes.has(wi.rawTypeName ?? cap(wi.type)));
    }

    // Status filter
    const statuses = [...new Set(items.map(wi => wi.status))].sort();
    if (statuses.length > 1) {
      type SF = vscode.QuickPickItem & { statusName: string };
      const statusOpts: SF[] = statuses.map(s => {
        const count = items.filter(wi => wi.status === s).length;
        return { label: s, description: `${count} item${count !== 1 ? 's' : ''}`, statusName: s, picked: true };
      });

      const pickedStatuses = await vscode.window.showQuickPick<SF>(statusOpts, {
        title: context ? `Filter by status — ${context}` : 'Filter by status',
        placeHolder: 'Uncheck statuses to exclude, Enter to continue',
        canPickMany: true,
        ignoreFocusOut: true
      });
      if (!pickedStatuses?.length) { return undefined; }

      const allowedStatuses = new Set(pickedStatuses.map(s => s.statusName));
      items = items.filter(wi => allowedStatuses.has(wi.status));
    }

    return items;
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

    // Filter by type
    const filtered = await this.filterItems(items, title);
    if (!filtered) { return undefined; }

    type Opt = vscode.QuickPickItem & { item?: WorkItem };
    const opts: Opt[] = [];

    const last = this.lastItem();
    if (last && filtered.some(wi => wi.key === last.key)) {
      opts.push({ label: `${last.key} — ${last.title}`, description: `Last viewed · ${last.status}`, item: last });
    }
    for (const wi of filtered) {
      if (wi.key === last?.key) { continue; }
      opts.push({
        label:       `${wi.key} — ${wi.title}`,
        description: `${wi.rawTypeName ?? cap(wi.type)} · ${wi.status}`,
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

  async list(): Promise<string> {
    const { provider } = await this.getProvider();
    const du = await this.defaultUser();
    const label = du?.displayName ?? 'your';

    const items = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Loading ${label}'s items...` },
      () => provider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 50 })
    );

    if (!items.length) {
      return 'No work items found. Run `/setuser` to set your default user.';
    }

    // Filter by type and status
    const filtered = await this.filterItems(items, `${label}'s items`);
    if (!filtered) { return '_Cancelled._'; }

    const lines = filtered.slice(0, 30).map(wi =>
      `- **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\`` +
      (wi.rawTypeName ? ` · ${wi.rawTypeName}` : '') +
      (wi.storyPoints ? ` · ${wi.storyPoints}pts` : '') +
      (wi.assignee ? ` — ${wi.assignee.displayName}` : '')
    ).join('\n');

    return `**${label}'s items (${filtered.length}):**\n\n${lines}`;
  }

  // ── OPEN ─────────────────────────────────────────────────────────────────

  async open(keyHint?: string): Promise<string> {
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
    if (!key?.trim()) { return '_Cancelled._'; }

    let item: import('./types').WorkItem | null = null;
    try {
      item = await (vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${key}...` },
        () => provider.getWorkItem(key!.trim())
      ) as unknown as Promise<import('./types').WorkItem>);
    } catch(e) { return `Error: ${e instanceof Error ? e.message : String(e)}`; }

    if (!item) { return 'Item not found.'; }
    this.setLastItem(item);

    const pts = item.storyPoints ?? item.effort;
    return [
      `## [${item.key}](${item.url}) ${item.title}`,
      `**Type:** ${item.rawTypeName ?? cap(item.type)}   **Status:** \`${item.status}\``,
      item.assignee  ? `**Assignee:** ${item.assignee.displayName}` : '',
      pts            ? `**Points:** ${pts}` : '',
      item.sprint    ? `**Sprint:** ${item.sprint.split('\\').pop()}` : '',
      item.description ? `\n${stripHtml(item.description).slice(0, 400)}` : ''
    ].filter(Boolean).join('\n');
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

    // Filter by type
    const filtered = await this.filterItems(allItems, 'Move to sprint');
    if (!filtered) { return; }

    type IQ = vscode.QuickPickItem & { wi: WorkItem };
    const itemOpts: IQ[] = filtered.map(wi => ({
      label:       `${wi.key} — ${wi.title}`,
      description: `${wi.rawTypeName ?? cap(wi.type)} · ${wi.status} · ${wi.sprint?.split('\\').pop() ?? 'backlog'}`,
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

  async sprint(): Promise<string> {
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
      return 'No active sprint found.';
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

    const lines = [
      `## Sprint: ${active.name}`,
      active.endDate ? `**Ends:** ${active.endDate.slice(0, 10)}` : '',
      `**Items:** ${items.length}`,
      '',
      ...items.slice(0, 20).map(wi =>
        `- **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\`` +
        (wi.assignee ? ` — ${wi.assignee.displayName}` : '') +
        (wi.storyPoints ? ` (${wi.storyPoints}pts)` : '')
      )
    ].filter(s => s !== undefined).join('\n');

    return lines;
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
    // Load stored field defaults and prompt for missing required fields (Jira only)
    let customFields: Record<string, unknown> | undefined;
    if (platform === 'jira' && rawTypeName) {
      customFields = {};
      const allDefaults = this.credMgr.getJiraFieldDefaults();
      const typeDefaults = allDefaults[rawTypeName] ?? {};

      for (const [k, v] of Object.entries(typeDefaults)) {
        if (v && typeof v === 'object' && 'id' in (v as any)) {
          customFields[k] = { id: (v as any).id };
        } else {
          customFields[k] = v;
        }
      }

      // Prompt for any required fields that don't have stored defaults
      try {
        if ((provider as any).getCreateFields) {
          const createFields = await (provider as any).getCreateFields(rawTypeName);
          const missing = createFields.filter((f: any) =>
            f.required && !customFields![f.key]
          );

          for (const field of missing) {
            if (field.allowedValues?.length) {
              type FO = vscode.QuickPickItem & { fv: { id: string; value: string } };
              const opts: FO[] = field.allowedValues.map((v: any) => ({
                label: v.value, fv: v
              }));
              const pick = await vscode.window.showQuickPick(opts, {
                title: `${field.name} (required)`,
                placeHolder: `Select a value for ${field.name}`,
                ignoreFocusOut: true
              });
              if (pick) { customFields[field.key] = { id: pick.fv.id }; }
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
      } catch { /* proceed with defaults only */ }

      if (!Object.keys(customFields).length) { customFields = undefined; }
    }

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
      rawTypeName,
      customFields
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
    const configured: Array<{ platform: string; label: string; creds: import('./types').ApiCredentials }> = [];
    if (both.jira)   { configured.push({ platform: 'jira',   label: 'Jira',           creds: both.jira }); }
    if (both.ado)    { configured.push({ platform: 'ado',    label: 'Azure DevOps',   creds: both.ado }); }
    if (both.github) { configured.push({ platform: 'github', label: 'GitHub Projects', creds: both.github }); }

    if (configured.length < 2) {
      vscode.window.showErrorMessage(
        `Migration requires at least 2 platforms configured (found ${configured.length}). Run PM Agent: Configure Platform.`
      );
      return;
    }

    // Pick source
    const srcPick = await vscode.window.showQuickPick(
      configured.map(c => ({ label: `From: ${c.label}`, value: c.platform })),
      { title: 'Migration source', ignoreFocusOut: true }
    );
    if (!srcPick) { return; }

    // Pick destination (exclude source)
    const dstOptions = configured.filter(c => c.platform !== srcPick.value);
    const dstPick = await vscode.window.showQuickPick(
      dstOptions.map(c => ({ label: `To: ${c.label}`, value: c.platform })),
      { title: 'Migration destination', ignoreFocusOut: true }
    );
    if (!dstPick) { return; }

    const { createProvider } = await import('./providers/providerFactory');
    const srcEntry = configured.find(c => c.platform === srcPick.value)!;
    const dstEntry = configured.find(c => c.platform === dstPick.value)!;
    const srcProvider = createProvider(srcEntry.creds);
    const dstProvider = createProvider(dstEntry.creds);
    const srcName = srcEntry.label;
    const dstName = dstEntry.label;
    const direction = `${srcPick.value}-to-${dstPick.value}`;

    // Select scope — assigned to me or all project items
    const scopeOpts = [
      { label: 'My assigned items',    description: 'Items assigned to you',           value: 'mine'  },
      { label: 'All project items',    description: 'All items in the project (slower)', value: 'all'   },
    ];
    const scopePick = await vscode.window.showQuickPick(scopeOpts, {
      title: `What to load from ${srcName}?`,
      ignoreFocusOut: true
    });
    if (!scopePick) { return; }

    // Select source items — paginate to get ALL items
    const du = await this.defaultUser();
    const loadAll = scopePick.value === 'all';

    let srcItems: import('./types').WorkItem[] = [];
    try {
      srcItems = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${srcName} items...`, cancellable: true },
        async (progress, token) => {
          const items: import('./types').WorkItem[] = [];
          if (loadAll) {
            // Paginate to get everything
            const pageSize = 100;
            let page = 0;
            let hasMore = true;
            while (hasMore && !token.isCancellationRequested) {
              progress.report({ message: `Loaded ${items.length} items...` });
              const batch = await srcProvider.searchWorkItems({
                maxResults: pageSize,
                // For Jira, use startAt-style pagination by adjusting maxResults
                // Both providers return up to maxResults items
              });
              // On first call we get up to pageSize items. Since we can't easily paginate
              // without provider changes, load a large batch
              if (page === 0) {
                items.push(...batch);
                // Try a second pass with higher limit
                if (batch.length >= pageSize) {
                  try {
                    const batch2 = await srcProvider.searchWorkItems({ maxResults: 500 });
                    const existing = new Set(items.map(i => i.key));
                    for (const b of batch2) { if (!existing.has(b.key)) { items.push(b); } }
                  } catch { /* single batch is fine */ }
                }
              }
              hasMore = false; // single paginated fetch
              page++;
            }
          } else {
            const batch = await srcProvider.searchWorkItems({
              assigneeId: du?.id ?? '@me', maxResults: 200
            });
            items.push(...batch);
          }
          return items;
        }
      );
    } catch (loadErr) {
      const errMsg = loadErr instanceof Error ? loadErr.message : String(loadErr);
      const isAuth = errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized');
      if (isAuth) {
        const action = await vscode.window.showErrorMessage(
          `${srcName} authentication failed — your API token may be expired or invalid.`,
          'Configure Platform'
        );
        if (action === 'Configure Platform') {
          await vscode.commands.executeCommand('pm-agent.configurePlatform');
        }
      } else {
        vscode.window.showErrorMessage(`Failed to load items from ${srcName}: ${errMsg}`);
      }
      return;
    }

    if (!srcItems.length) {
      vscode.window.showErrorMessage(`No items found in ${srcName}.`);
      return;
    }

    // Filter by type
    const filteredItems = await this.filterItems(srcItems, `${srcName} → ${dstName}`);
    if (!filteredItems) { return; }

    type IQ2 = vscode.QuickPickItem & { wi: import('./types').WorkItem };
    const itemOpts2: IQ2[] = filteredItems.map(wi => ({
      label:       `${wi.key} — ${wi.title}`,
      description: `${wi.rawTypeName ?? cap(wi.type)} · ${wi.status}`,
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
      { label: 'Comments',            description: 'Copies up to 20 per item', field: 'comments',    picked: true  },
      { label: 'Child Items',         description: 'Migrate subtasks/children and link to parent', field: 'children', picked: false },
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
    // Fetch destination types and let user confirm the mapping for EVERY type
    let dstTypes: string[] = [];
    try {
      dstTypes = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Loading ${dstName} work item types...` },
        () => dstProvider.getWorkItemTypes()
      );
    } catch {
      dstTypes = direction === 'jira-to-ado'
        ? ['Task', 'Bug', 'Epic', 'Feature', 'User Story', 'Product Backlog Item']
        : ['Story', 'Task', 'Bug', 'Epic', 'Sub-task'];
    }

    // Collect unique source type names from selected items
    const srcTypeNames = [...new Set(selectedItems.map(i => {
      const wi = i.wi;
      return wi.rawTypeName ?? cap(wi.type);
    }))];

    // Load stored type mappings as defaults
    const storedMappings = this.credMgr.getTypeMappings();
    const storedForDirection = storedMappings[direction] ?? {};

    const typeMap: Record<string, string> = {};
    for (const srcType of srcTypeNames) {
      // Check stored mapping first, then auto-match by name
      const stored = storedForDirection[srcType];
      const exact = stored
        ? dstTypes.find(d => d === stored)
        : dstTypes.find(d => d.toLowerCase() === srcType.toLowerCase());

      // Build options with the best match pre-selected at top
      type TQ = vscode.QuickPickItem & { rawType: string };
      const typeOpts: TQ[] = dstTypes.map(t => ({
        label: t,
        description: t === stored ? '(saved default)' : t.toLowerCase() === srcType.toLowerCase() ? '(auto-matched)' : '',
        rawType: t,
      }));

      // Sort so the match appears first
      if (exact) {
        typeOpts.sort((a, b) => {
          if (a.rawType === exact) { return -1; }
          if (b.rawType === exact) { return 1; }
          return 0;
        });
      }

      const picked = await vscode.window.showQuickPick<TQ>(typeOpts, {
        title: `Map "${srcType}" → ${dstName} type`,
        placeHolder: stored
          ? `Saved default: "${stored}" — press Enter to accept or pick a different type`
          : exact
            ? `"${srcType}" matched "${exact}" — press Enter to accept or pick a different type`
            : `"${srcType}" has no match in ${dstName} — choose a type`,
        ignoreFocusOut: true
      });
      if (!picked) { return; }
      typeMap[srcType] = picked.rawType;
    }

    // Pre-fetch destination members for assignee matching (used by parent + child migration)
    let dstMembers: import('./types').User[] = [];
    if (fields.has('assignee')) {
      try { dstMembers = await dstProvider.getProjectMembers(); } catch { /* empty */ }
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
            const cleanDesc = stripHtml(full.description ?? '');
            const cleanAc   = stripHtml((full as any).acceptanceCriteria ?? '');

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

            // Resolve the mapped destination type name
            const srcTypeName = full.rawTypeName ?? cap(full.type);
            const dstTypeName = typeMap[srcTypeName] ?? cap(full.type);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const destItem: import('./types').WorkItem = await (dstProvider as any).createWorkItem({
              type:               full.type,
              rawTypeName:        dstTypeName,
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

            // Migrate child items recursively if selected
            if (fields.has('children')) {
              await this._migrateChildrenRecursive({
                srcProvider, dstProvider, srcName, direction,
                parentSrcId: full.id ?? src.key,
                parentDstId: destItem.key ?? destItem.id,
                parentDstKey: destItem.key,
                fields, typeMap, dstTypes, dstMembers,
                createdKeys, failedKeys,
                counters: { moved: { value: 0 }, failed: { value: 0 } },
                progress, progressPrefix: `${idx+1}/${selectedItems.length}: ${src.key}`,
                depth: 0
              });
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

  /** Recursively migrate children at all levels, up to 5 levels deep */
  private async _migrateChildrenRecursive(opts: {
    srcProvider: any;
    dstProvider: any;
    srcName: string;
    direction: string;
    parentSrcId: string;
    parentDstId: string;
    parentDstKey: string;
    fields: Set<string>;
    typeMap: Record<string, string>;
    dstTypes: string[];
    dstMembers: import('./types').User[];
    createdKeys: string[];
    failedKeys: string[];
    counters: { moved: { value: number }; failed: { value: number } };
    progress: any;
    progressPrefix: string;
    depth: number;
  }): Promise<void> {
    const MAX_DEPTH = 5;
    if (opts.depth >= MAX_DEPTH) { return; }

    const indent = '  '.repeat(opts.depth + 1);
    const children: import('./types').WorkItem[] =
      await opts.srcProvider.getChildItems?.(opts.parentSrcId).catch(() => []) ?? [];

    if (!children.length) { return; }

    opts.progress.report({
      message: `${opts.progressPrefix} — level ${opts.depth + 1}: ${children.length} child item(s)`
    });

    for (const child of children) {
      try {
        const childFull = await opts.srcProvider.getWorkItem(child.key);
        const childDesc = stripHtml(childFull.description ?? '');
        const childAc   = stripHtml((childFull as any).acceptanceCriteria ?? '');

        // Map child type — for Jira destinations, prefer Sub-task to avoid hierarchy errors
        const childSrcType = childFull.rawTypeName ?? cap(childFull.type);
        let childDstType = opts.typeMap[childSrcType];
        if (!childDstType) {
          const match = opts.dstTypes.find((d: string) => d.toLowerCase() === childSrcType.toLowerCase());
          childDstType = match ?? 'Task';
        }
        // If destination is Jira and this is a child item, use Sub-task if available
        if (opts.direction === 'ado-to-jira' || opts.direction === 'github-to-jira') {
          const subTaskType = opts.dstTypes.find((d: string) => d.toLowerCase() === 'sub-task' || d.toLowerCase() === 'subtask');
          if (subTaskType) { childDstType = subTaskType; }
        }

        let childDescFinal = opts.fields.has('description') ? childDesc : undefined;
        if (!childDescFinal && opts.direction === 'jira-to-ado') { childDescFinal = childFull.title; }

        // Resolve assignee
        let childAssigneeId: string | undefined;
        if (opts.fields.has('assignee') && childFull.assignee?.email) {
          try {
            if (opts.direction === 'ado-to-jira') {
              const r = await opts.dstProvider.resolveUser?.(childFull.assignee.email);
              childAssigneeId = r?.id ?? childFull.assignee.email;
            } else {
              const match = opts.dstMembers.find((m: any) =>
                m.email?.toLowerCase() === childFull.assignee?.email?.toLowerCase()
              );
              childAssigneeId = match?.id;
            }
          } catch { /* skip */ }
        }

        const childDest: import('./types').WorkItem = await opts.dstProvider.createWorkItem({
          type:               childFull.type,
          rawTypeName:        childDstType,
          title:              childFull.title,
          description:        childDescFinal,
          acceptanceCriteria: opts.fields.has('ac') && childAc ? childAc : undefined,
          storyPoints:        opts.fields.has('points') ? (childFull.storyPoints ?? childFull.effort) : undefined,
          priority:           opts.fields.has('priority') ? childFull.priority : undefined,
          labels:             opts.fields.has('labels') && childFull.labels?.length ? childFull.labels : undefined,
          assigneeId:         childAssigneeId,
          parentId:           opts.parentDstId,
        });

        // Fallback parent link if parentId wasn't set during creation
        await opts.dstProvider.addParentLink?.(
          childDest.key ?? childDest.id,
          opts.parentDstId
        ).catch(() => {});

        // Migration comment
        await opts.dstProvider.addComment(childDest.key,
          `Migrated from ${opts.srcName} — original: ${child.url}, parent: ${opts.parentDstKey}`
        ).catch(() => {});

        // Copy comments if selected
        if (opts.fields.has('comments') && childFull.comments?.length) {
          for (const c of childFull.comments.slice(0, 20)) {
            await opts.dstProvider.addComment(childDest.key,
              `**From ${opts.srcName} (${c.author}):** ${c.body}`
            ).catch(() => {});
          }
        }

        opts.createdKeys.push(
          `${indent}[${child.key}](${child.url}) -> [${childDest.key}](${childDest.url}) (child of ${opts.parentDstKey})`
        );
        opts.counters.moved.value++;

        // Recurse into this child's children
        await this._migrateChildrenRecursive({
          ...opts,
          parentSrcId:  childFull.id ?? child.key,
          parentDstId:  childDest.key ?? childDest.id,
          parentDstKey: childDest.key,
          depth:        opts.depth + 1,
        });

      } catch (childErr) {
        opts.failedKeys.push(
          `${child.key} (child L${opts.depth + 1}): ${childErr instanceof Error ? childErr.message : String(childErr)}`
        );
        opts.counters.failed.value++;
      }
    }
  }
}
