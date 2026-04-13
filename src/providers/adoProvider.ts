// src/providers/adoProvider.ts
import {
  WorkItem, WorkItemType, User, Sprint, Project, Comment,
  CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery,
  ApiCredentials, AgentToolResult
} from '../types';

export class AdoProvider {
  private orgUrl:     string;
  private project:    string;
  private projectEnc: string;
  private authHeader: string;

  public lastWiql = ''; public lastUrl = ''; public lastRawCount = -1;

  constructor(creds: ApiCredentials) {
    if (!creds.adoOrgUrl || !creds.adoProject || !creds.adoToken) {
      throw new Error('Azure DevOps credentials incomplete. Run PM Agent: Configure Platform.');
    }
    this.orgUrl     = creds.adoOrgUrl.replace(/\/$/, '');
    this.project    = creds.adoProject;
    this.projectEnc = encodeURIComponent(creds.adoProject);
    this.authHeader = 'Basic ' + Buffer.from(`:${creds.adoToken}`).toString('base64');
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async http<T>(url: string, options: RequestInit = {}, attempt = 1): Promise<T> {
    const TRANSIENT = new Set([429, 502, 503, 504]);
    const MAX_ATTEMPTS = 3;

    let res: Response;
    try {
      res = await globalThis.fetch(url, {
        ...options,
        headers: {
          'Authorization': this.authHeader,
          'Accept':        'application/json',
          'Content-Type':  'application/json',
          ...(options.headers as Record<string,string> ?? {})
        }
      });
    } catch (networkErr: unknown) {
      // Network-level failure (DNS, timeout, offline)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, attempt * 1500));
        return this.http<T>(url, options, attempt + 1);
      }
      throw new Error(`ADO network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`);
    }

    if (!res.ok) {
      // Retry transient server errors with exponential backoff
      if (TRANSIENT.has(res.status) && attempt < MAX_ATTEMPTS) {
        const delay = attempt * 2000;  // 2s, 4s
        await new Promise(r => setTimeout(r, delay));
        return this.http<T>(url, options, attempt + 1);
      }

      const body = await res.text();

      // Strip HTML — ADO sometimes returns full error pages for 503/maintenance
      let msg: string;
      if (body.trim().startsWith('<')) {
        const statusMessages: Record<number, string> = {
          400: 'Bad request — check your input',
          401: 'Unauthorised — your PAT may have expired. Run PM Agent: Configure Platform.',
          403: 'Forbidden — your PAT does not have permission for this operation.',
          404: 'Not found — check the work item key or project name.',
          429: 'Rate limited by Azure DevOps — please wait a moment and try again.',
          500: 'Azure DevOps internal server error — try again shortly.',
          502: 'Azure DevOps gateway error — try again shortly.',
          503: 'Azure DevOps is temporarily unavailable — try again in a moment.',
          504: 'Azure DevOps timed out — try again shortly.'
        };
        msg = statusMessages[res.status] ?? `Azure DevOps returned ${res.status}. The service may be temporarily unavailable.`;
      } else {
        // JSON error body — extract the message field if present
        try {
          const json = JSON.parse(body) as { message?: string; errorCode?: number };
          msg = json.message ?? body.slice(0, 300);
        } catch {
          msg = body.slice(0, 300);
        }
      }

      throw new Error(`ADO ${res.status}: ${msg}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchWorkItems(query: WorkItemQuery): Promise<WorkItem[]> {
    const safe = (s: string) => s.replace(/'/g, "''");
    const conds = [`[System.TeamProject] = '${safe(this.project)}'`];

    if (query.type) { conds.push(`[System.WorkItemType] = '${this.adoType(query.type)}'`); }

    if (query.status === 'open') {
      conds.push(`[System.State] <> 'Closed'`);
      conds.push(`[System.State] <> 'Removed'`);
      conds.push(`[System.State] <> 'Resolved'`);
    } else if (query.status) {
      const map: Record<string,string> = {
        'active':'Active','in progress':'Active','new':'New','to do':'New',
        'closed':'Closed','done':'Closed','resolved':'Resolved',
        'blocked':'Blocked','in review':'In Review'
      };
      conds.push(`[System.State] = '${map[query.status.toLowerCase()] ?? query.status}'`);
    } else {
      conds.push(`[System.State] <> 'Removed'`);
    }

    if (query.assigneeId === '@me')   { conds.push(`[System.AssignedTo] = @Me`); }
    else if (query.assigneeId)        { conds.push(`[System.AssignedTo] = '${safe(query.assigneeId)}'`); }
    if (query.sprintId)               { conds.push(`[System.IterationPath] UNDER '${safe(query.sprintId)}'`); }
    if (query.text)                   { conds.push(`[System.Title] Contains '${safe(query.text)}'`); }

    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${conds.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
    const url  = `${this.orgUrl}/${this.projectEnc}/_apis/wit/wiql?$top=${query.maxResults ?? 25}&api-version=7.1`;
    this.lastWiql = wiql; this.lastUrl = url;

    const res = await this.http<{ workItems?: Array<{ id: number }> }>(url, { method: 'POST', body: JSON.stringify({ query: wiql }) });
    const ids = (res.workItems ?? []).map(w => w.id).slice(0, 200);
    this.lastRawCount = ids.length;
    if (!ids.length) { return []; }

    const details = await this.http<{ value?: unknown[] }>(
      `${this.orgUrl}/_apis/wit/workitems?ids=${ids.join(',')}&$expand=all&api-version=7.1`
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (details.value ?? []).map((w: any) => this.map(w));
  }

  // ── Single item ───────────────────────────────────────────────────────────

  async getWorkItem(id: string): Promise<WorkItem> {
    const n = id.replace(/^#/, '').replace(/^AB#/i, '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wi = await this.http<any>(`${this.orgUrl}/_apis/wit/workitems/${n}?$expand=all&api-version=7.1`);
    const item = this.map(wi);
    try { item.comments = await this.getComments(id); } catch { /* optional */ }
    return item;
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async getComments(id: string): Promise<Comment[]> {
    const n = id.replace(/^#/, '').replace(/^AB#/i, '');
    // Try the comments API (requires ADO Services 2019+). Fall back silently if not available.
    for (const ver of ['7.2-preview.4', '7.1-preview.3', '6.0-preview.3']) {
      try {
        const res = await this.http<{ comments?: unknown[] }>(
          `${this.orgUrl}/_apis/wit/workitems/${n}/comments?api-version=${ver}`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (res.comments ?? []).map((c: any) => ({
          id: String(c.id), author: c.createdBy?.displayName ?? 'Unknown',
          body: c.text?.replace(/<[^>]+>/g, '') ?? '', createdAt: c.createdDate ?? ''
        }));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // 404 = endpoint not found on this ADO version — try next
        if (msg.includes('404')) { continue; }
        // Any other error (401, 403, 500) — stop trying
        break;
      }
    }
    return [];   // comments not available on this ADO instance
  }

  async addComment(id: string, text: string): Promise<Comment> {
    const n = id.replace(/^#/, '').replace(/^AB#/i, '');
    // Try the dedicated comments endpoint first; fall back to updating the description field
    for (const ver of ['7.2-preview.4', '7.1-preview.3', '6.0-preview.3']) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await this.http<any>(
          `${this.orgUrl}/_apis/wit/workitems/${n}/comments?api-version=${ver}`,
          { method: 'POST', body: JSON.stringify({ text }) }
        );
        return { id: String(res.id), author: res.createdBy?.displayName ?? 'You', body: text, createdAt: res.createdDate ?? new Date().toISOString() };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('404')) { continue; }
        throw e;   // re-throw non-404 errors
      }
    }
    // Final fallback: append comment as a history note via work item update
    const safeText = text.replace(/<[^>]+>/g, '');
    const ops = [{ op: 'add', path: '/fields/System.History', value: `<p>${safeText}</p>` }];
    await this.http(
      `${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
      { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
    );
    return { id: Date.now().toString(), author: 'You', body: text, createdAt: new Date().toISOString() };
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  async addAttachment(id: string, fileName: string, fileContent: Buffer, mimeType: string): Promise<AgentToolResult> {
    const n = id.replace(/^#/, '').replace(/^AB#/i, '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const upload = await this.http<any>(
      `${this.orgUrl}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`,
      { method: 'POST', body: fileContent, headers: { 'Content-Type': mimeType ?? 'application/octet-stream' } }
    );
    const ops = [{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: upload.url, attributes: { comment: fileName } } }];
    await this.http(`${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
      { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } });
    return { success: true };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createWorkItem(input: CreateWorkItemInput & {
    rawTypeName?:        string;
    acceptanceCriteria?: string;
    parentId?:           string;
  }): Promise<WorkItem> {
    const typeName = input.rawTypeName ?? this.adoType(input.type);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops: any[] = [{ op: 'add', path: '/fields/System.Title', value: input.title }];

    if (input.description) {
      const h = input.description.trim().startsWith('<') ? input.description : `<p>${input.description}</p>`;
      ops.push({ op: 'add', path: '/fields/System.Description', value: h });
    }
    if (input.acceptanceCriteria) {
      const h = input.acceptanceCriteria.trim().startsWith('<') ? input.acceptanceCriteria : `<p>${input.acceptanceCriteria}</p>`;
      ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: h });
    }
    if (input.assigneeId)  { ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: input.assigneeId }); }
    if (input.storyPoints !== undefined) { ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: input.storyPoints }); }
    if (input.priority)    { ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: Number(input.priority) || 2 }); }
    if (input.labels?.length) { ops.push({ op: 'add', path: '/fields/System.Tags', value: input.labels.join('; ') }); }
    if (input.sprintId)    { ops.push({ op: 'add', path: '/fields/System.IterationPath', value: input.sprintId }); }
    if (input.parentId)    {
      ops.push({ op: 'add', path: '/relations/-', value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${this.orgUrl}/_apis/wit/workitems/${input.parentId}`
      }});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wi = await this.http<any>(
      `${this.orgUrl}/${this.projectEnc}/_apis/wit/workitems/${encodeURIComponent('$' + typeName)}?api-version=7.1`,
      { method: 'POST', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
    );
    return this.map(wi);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateWorkItem(id: string, input: UpdateWorkItemInput): Promise<WorkItem> {
    const n = id.replace(/^#/, '').replace(/^AB#/i, '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ops: any[] = [];
    if (input.title) {
      const h = input.title.trim().startsWith('<') ? input.title : `<p>${input.title}</p>`;
      // title is plain text not HTML
      ops.push({ op: 'replace', path: '/fields/System.Title', value: input.title });
      void h;
    }
    if (input.description) {
      const h = input.description.trim().startsWith('<') ? input.description : `<p>${input.description}</p>`;
      ops.push({ op: 'replace', path: '/fields/System.Description', value: h });
    }
    if (input.storyPoints !== undefined) { ops.push({ op: 'replace', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: input.storyPoints }); }
    if (input.effort      !== undefined) { ops.push({ op: 'replace', path: '/fields/Microsoft.VSTS.Scheduling.Effort', value: input.effort }); }
    if (input.assigneeId  !== undefined) { ops.push({ op: 'replace', path: '/fields/System.AssignedTo', value: input.assigneeId ?? '' }); }
    if (input.status)                    { ops.push({ op: 'replace', path: '/fields/System.State', value: input.status }); }
    if (input.labels)                    { ops.push({ op: 'replace', path: '/fields/System.Tags', value: input.labels.join('; ') }); }
    if (!ops.length) { return this.getWorkItem(id); }
    // If we are not explicitly changing sprint/area, fetch current values and
    // re-assert them so ADO does not silently reset them on update.
    const hasSprintChange = ops.some(o => o.path === '/fields/System.IterationPath');
    const hasAreaChange   = ops.some(o => o.path === '/fields/System.AreaPath');
    if (!hasSprintChange || !hasAreaChange) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cur = await this.http<any>(`${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`);
        if (!hasSprintChange && cur.fields?.['System.IterationPath']) {
          ops.push({ op: 'replace', path: '/fields/System.IterationPath', value: cur.fields['System.IterationPath'] });
        }
        if (!hasAreaChange && cur.fields?.['System.AreaPath']) {
          ops.push({ op: 'replace', path: '/fields/System.AreaPath', value: cur.fields['System.AreaPath'] });
        }
      } catch { /* best effort — proceed without */ }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wi = await this.http<any>(
      `${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
      { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
    );
    return this.map(wi);
  }

  /** Link an existing work item to a parent via Hierarchy-Reverse relation */
  async addParentLink(childId: string, parentId: string): Promise<void> {
    const childNum  = childId.replace(/^#/, '').replace(/^AB#/i, '');
    const parentNum = parentId.replace(/^#/, '').replace(/^AB#/i, '');
    const ops = [{
      op:    'add',
      path:  '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${this.orgUrl}/_apis/wit/workitems/${parentNum}`
      }
    }];
    await this.http(
      `${this.orgUrl}/_apis/wit/workitems/${childNum}?api-version=7.1`,
      { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
    );
  }

  /** Fetch child work items linked via Hierarchy-Forward */
  async getChildItems(parentId: string): Promise<WorkItem[]> {
    try {
      const num = parentId.replace(/^#/, '').replace(/^AB#/i, '');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parent = await this.http<any>(
        `${this.orgUrl}/_apis/wit/workitems/${num}?$expand=relations&api-version=7.1`
      );
      const childUrls = (parent.relations ?? [])
        .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
        .map((r: any) => r.url as string);

      if (!childUrls.length) { return []; }

      // Extract IDs from URLs
      const childIds = childUrls.map((u: string) => {
        const m = u.match(/\/workitems\/(\d+)$/);
        return m ? m[1] : null;
      }).filter(Boolean);

      if (!childIds.length) { return []; }

      // Fetch all children in a batch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<{ value?: any[] }>(
        `${this.orgUrl}/_apis/wit/workitems?ids=${childIds.join(',')}&$expand=all&api-version=7.1`
      );
      return (r.value ?? []).map((wi: any) => this.map(wi));
    } catch {
      return [];
    }
  }

  async transitionWorkItem(id: string, status: string): Promise<AgentToolResult> {
    try {
      const n = id.replace(/^#/, '').replace(/^AB#/i, '');
      // Fetch current item so we can preserve iteration path and area path in the same PATCH.
      // ADO can reset IterationPath when state changes if they are not explicitly set.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = await this.http<any>(
        `${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`
      );
      const f = current.fields ?? {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ops: any[] = [
        { op: 'replace', path: '/fields/System.State', value: status }
      ];
      // Explicitly re-assert IterationPath and AreaPath so ADO does not reset them
      if (f['System.IterationPath']) {
        ops.push({ op: 'replace', path: '/fields/System.IterationPath', value: f['System.IterationPath'] });
      }
      if (f['System.AreaPath']) {
        ops.push({ op: 'replace', path: '/fields/System.AreaPath', value: f['System.AreaPath'] });
      }
      await this.http(
        `${this.orgUrl}/_apis/wit/workitems/${n}?api-version=7.1`,
        { method: 'PATCH', body: JSON.stringify(ops), headers: { 'Content-Type': 'application/json-patch+json' } }
      );
      return { success: true };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Fetch valid states for a given work item type from ADO */
  async getWorkItemStates(typeName: string): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<any>(
        `${this.orgUrl}/${this.projectEnc}/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}/states?api-version=7.1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (r.value ?? []).map((s: any) => String(s.name)).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── People ────────────────────────────────────────────────────────────────

  async getProjectMembers(): Promise<User[]> {
    const teams = await this.http<{ value?: Array<{ id: string }> }>(
      `${this.orgUrl}/_apis/projects/${this.projectEnc}/teams?$top=100&api-version=7.1`
    );
    if (!teams.value?.length) { return []; }
    const seen  = new Set<string>();
    const users: User[] = [];
    for (const team of teams.value) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m = await this.http<{ value?: any[] }>(
          `${this.orgUrl}/_apis/projects/${this.projectEnc}/teams/${team.id}/members?api-version=7.1`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const x of m.value ?? []) {
          const id = x.identity?.uniqueName ?? x.identity?.id ?? '';
          if (id && !seen.has(id)) {
            seen.add(id);
            users.push({ id, displayName: x.identity?.displayName ?? '', email: x.identity?.uniqueName ?? '', avatarUrl: x.identity?.imageUrl });
          }
        }
      } catch { /* skip */ }
    }
    return users.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // ── Sprints ───────────────────────────────────────────────────────────────

  async getActiveSprint(): Promise<Sprint | null> {
    try {
      const r = await this.http<{ value?: unknown[] }>(
        `${this.orgUrl}/${this.projectEnc}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`
      );
      if (!r.value?.length) { return null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = r.value[0] as any;
      return { id: s.path, name: s.name, state: 'active', startDate: s.attributes?.startDate, endDate: s.attributes?.finishDate };
    } catch { return null; }
  }

  async getAllSprints(): Promise<Sprint[]> {
    try {
      const r = await this.http<{ value?: unknown[] }>(
        `${this.orgUrl}/${this.projectEnc}/_apis/work/teamsettings/iterations?api-version=7.1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (r.value ?? []).map((s: any): Sprint & { iterationPath: string } => ({
        // id = GUID for reliable identity; iterationPath = full path for System.IterationPath field
        id:            s.id   as string,    // GUID  e.g. "abc-123-..."
        iterationPath: s.path as string,    // full  e.g. "ProjectName\Sprint 5"
        name:          s.name as string,
        state:     (s.attributes?.timeFrame === 'current' ? 'active'
                  : s.attributes?.timeFrame === 'future'  ? 'future'
                  : 'closed') as Sprint['state'],
        startDate: s.attributes?.startDate as string | undefined,
        endDate:   s.attributes?.finishDate as string | undefined
      }));
    } catch { return []; }
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async getProjects(): Promise<Project[]> {
    const r = await this.http<{ value?: unknown[] }>(`${this.orgUrl}/_apis/projects?api-version=7.1`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r.value ?? []).map((p: any) => ({ id: p.id, key: p.name, name: p.name }));
  }

  async getWorkItemTypes(): Promise<string[]> {
    try {
      const r = await this.http<{ value?: Array<{ name: string; isDisabled?: boolean }> }>(
        `${this.orgUrl}/${this.projectEnc}/_apis/wit/workitemtypes?api-version=7.1`
      );
      return (r.value ?? []).filter(t => !t.isDisabled).map(t => t.name).sort();
    } catch {
      return ['Task', 'Bug', 'Epic', 'Feature', 'User Story', 'Product Backlog Item'];
    }
  }

  async debugQuery(wiql: string): Promise<{ wiql: string; url: string; ids: number[]; firstItem: unknown }> {
    const url = `${this.orgUrl}/${this.projectEnc}/_apis/wit/wiql?$top=5&api-version=7.1`;
    const r   = await this.http<{ workItems?: Array<{ id: number }> }>(url, { method: 'POST', body: JSON.stringify({ query: wiql }) });
    const ids = (r.workItems ?? []).map(w => w.id).slice(0, 5);
    const firstItem = ids.length ? await this.http<unknown>(`${this.orgUrl}/_apis/wit/workitems/${ids[0]}?$expand=all&api-version=7.1`) : null;
    return { wiql, url, ids, firstItem };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private adoType(t: WorkItemType): string {
    return ({ story: 'User Story', task: 'Task', bug: 'Bug', epic: 'Epic', subtask: 'Task', feature: 'Feature', testcase: 'Test Case' })[t] ?? 'Task';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private map(wi: any): WorkItem {
    const f = wi.fields;
    const t = (f['System.WorkItemType'] ?? 'Task').toLowerCase();
    let type: WorkItemType = 'task';
    if (t.includes('user story') || t.includes('story')) { type = 'story'; }
    else if (t.includes('epic'))    { type = 'epic'; }
    else if (t.includes('bug'))     { type = 'bug'; }
    else if (t.includes('feature')) { type = 'feature'; }
    else if (t.includes('test'))    { type = 'testcase'; }
    const rawTypeName = f['System.WorkItemType'] ?? 'Task';
    return {
      id: String(wi.id), key: `#${wi.id}`,
      title:       f['System.Title'] ?? '(no title)',
      description:        f['System.Description']?.replace(/<[^>]+>/g, '') ?? '',
      acceptanceCriteria: f['Microsoft.VSTS.Common.AcceptanceCriteria']?.replace(/<[^>]+>/g, '') ?? '',
      type, rawTypeName, status: f['System.State'] ?? 'New',
      priority: String(f['Microsoft.VSTS.Common.Priority'] ?? ''),
      assignee: f['System.AssignedTo'] ? {
        id: f['System.AssignedTo'].uniqueName ?? f['System.AssignedTo'].id,
        displayName: f['System.AssignedTo'].displayName,
        email: f['System.AssignedTo'].uniqueName
      } : undefined,
      reporter: f['System.CreatedBy'] ? {
        id: f['System.CreatedBy'].uniqueName,
        displayName: f['System.CreatedBy'].displayName
      } : undefined,
      effort:      f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.StoryPoints'],
      storyPoints: f['Microsoft.VSTS.Scheduling.StoryPoints'],
      labels:      f['System.Tags'] ? f['System.Tags'].split(';').map((s: string) => s.trim()) : [],
      sprint:      f['System.IterationPath'],
      url:         `${this.orgUrl}/${this.projectEnc}/_workitems/edit/${wi.id}`,
      platform:    'azuredevops', projectKey: this.project,
      createdAt:   f['System.CreatedDate'], updatedAt: f['System.ChangedDate']
    };
  }
}
