// src/providers/jiraProvider.ts
import {
  WorkItem, WorkItemType, User, Sprint, Project, Comment,
  CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery,
  ApiCredentials, AgentToolResult
} from '../types';

export class JiraProvider {
  private baseUrl:        string;
  private authHeader:     string;
  private defaultProject:    string;

  constructor(creds: ApiCredentials) {
    if (!creds.jiraBaseUrl || !creds.jiraEmail || !creds.jiraToken) {
      throw new Error('Jira credentials incomplete. Run PM Agent: Configure Platform.');
    }
    this.baseUrl        = creds.jiraBaseUrl.replace(/\/$/, '');
    this.authHeader     = 'Basic ' + Buffer.from(`${creds.jiraEmail}:${creds.jiraToken}`).toString('base64');
    this.defaultProject = creds.jiraProject ?? '';
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async http<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/3${path}`;
    const res = await globalThis.fetch(url, {
      ...options,
      headers: {
        'Authorization':  this.authHeader,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        ...(options.headers as Record<string,string> ?? {})
      }
    });
    if (!res.ok) {
      const b = await res.text();
      throw new Error(`Jira ${res.status}: ${b.slice(0, 400)}`);
    }
    return res.json() as Promise<T>;
  }

  // Agile APIs live under a different path prefix
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async httpAgile<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}/rest/agile/1.0${path}`;
    const res = await globalThis.fetch(url, {
      headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' }
    });
    if (!res.ok) {
      const b = await res.text();
      throw new Error(`Jira Agile ${res.status}: ${b.slice(0, 400)}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Search / List ─────────────────────────────────────────────────────────

  async searchWorkItems(query: WorkItemQuery): Promise<WorkItem[]> {
    const parts: string[] = [];
    const project = query.projectKey ?? this.defaultProject;
    if (project) { parts.push(`project = "${project}"`); }

    if (query.assigneeId === '@me' || query.assigneeId === 'currentUser()') {
      parts.push(`assignee = currentUser()`);
    } else if (query.assigneeId) {
      // Jira Cloud: accountId is a long hash string
      // Jira Server: username or email
      // In both cases, JQL `assignee = "value"` works — Jira resolves the identifier
      parts.push(`assignee = "${query.assigneeId.trim()}"`);
    }

    if (query.status === 'open') {
      parts.push(`status NOT IN ("Done","Closed","Resolved","Won't Fix","Duplicate")`);
    } else if (query.status) {
      const map: Record<string,string> = {
        'Active':'In Progress', 'active':'In Progress',
        'New':'To Do',          'new':'To Do',
        'Closed':'Done',        'closed':'Done'
      };
      parts.push(`status = "${map[query.status] ?? query.status}"`);
    }

    if (query.type) {
      const map: Record<WorkItemType,string> = {
        story:'Story', task:'Task', bug:'Bug', epic:'Epic',
        subtask:'Sub-task', feature:'Feature', testcase:'Test'
      };
      parts.push(`issuetype = "${map[query.type]}"`);
    }

    if (query.sprintId) { parts.push(`sprint = ${query.sprintId}`); }
    if (query.text)     { parts.push(`text ~ "${query.text}"`); }

    const jql    = (parts.length ? parts.join(' AND ') : `project = "${project}"`) + ' ORDER BY updated DESC';
    const fields = 'summary,status,issuetype,assignee,reporter,priority,labels,customfield_10016,customfield_10028,customfield_10014,story_points,customfield_10020,sprint,created,updated,description,project,comment';

    // Use /search/jql (Jira deprecated /search in favour of this endpoint)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await this.http<any>('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: query.maxResults ?? 25,
        fields:     fields.split(',')
      })
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r.issues ?? []).map((i: any) => this.mapIssue(i));
  }

  // ── Single item ───────────────────────────────────────────────────────────

  async getWorkItem(keyOrId: string): Promise<WorkItem> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issue = await this.http<any>(`/issue/${encodeURIComponent(keyOrId)}?expand=renderedFields,comment`);
    return this.mapIssue(issue);
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async getComments(keyOrId: string): Promise<Comment[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await this.http<any>(`/issue/${encodeURIComponent(keyOrId)}/comment?maxResults=25&orderBy=-created`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r.comments ?? []).map((c: any) => ({
      id:        String(c.id),
      author:    c.author?.displayName ?? 'Unknown',
      body:      extractAdfText(c.body),
      createdAt: c.created ?? ''
    }));
  }

  async addComment(keyOrId: string, text: string): Promise<Comment> {
    const body = {
      body: {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await this.http<any>(`/issue/${encodeURIComponent(keyOrId)}/comment`, {
      method: 'POST', body: JSON.stringify(body)
    });
    return {
      id:        String(r.id),
      author:    r.author?.displayName ?? 'You',
      body:      text,
      createdAt: r.created ?? new Date().toISOString()
    };
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  async addAttachment(keyOrId: string, fileName: string, fileContent: Buffer, _mimeType: string): Promise<AgentToolResult> {
    const form = new FormData();
    form.append('file', new Blob([fileContent]), fileName);
    const res = await globalThis.fetch(
      `${this.baseUrl}/rest/api/3/issue/${encodeURIComponent(keyOrId)}/attachments`,
      {
        method:  'POST',
        headers: { 'Authorization': this.authHeader, 'X-Atlassian-Token': 'no-check' },
        body:    form
      }
    );
    if (!res.ok) {
      const b = await res.text();
      return { success: false, error: `Jira ${res.status}: ${b.slice(0, 200)}` };
    }
    return { success: true };
  }

  // ── Create / Update ───────────────────────────────────────────────────────

  async createWorkItem(input: CreateWorkItemInput & {
    acceptanceCriteria?: string;
    parentId?: string;
    customFields?: Record<string, unknown>;
  }): Promise<WorkItem> {
    if (!this.defaultProject) { throw new Error('No default Jira project configured. Run @pm /setupai to set one.'); }
    const typeMap: Record<WorkItemType,string> = {
      story:'Story', task:'Task', bug:'Bug', epic:'Epic',
      subtask:'Sub-task', feature:'Feature', testcase:'Test'
    };
    // Use rawTypeName if provided (e.g. from migration), otherwise map from enum
    const issuetypeName = input.rawTypeName || typeMap[input.type] || 'Task';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields: any = {
      project:   { key: this.defaultProject },
      summary:   input.title,
      issuetype: { name: issuetypeName },
    };

    // priority set via post-create update below (may not be on create screen)
    if (input.labels?.length) { fields.labels   = input.labels; }
    if (input.parentId) {
      const pid = input.parentId.trim().replace(/^#/, '');
      const isNum = /^\d+$/.test(pid);
      fields.parent = isNum ? { id: pid } : { key: pid };
    }

    if (input.description) {
      fields.description = toAdf(input.description);
    }

    // Merge any custom field defaults (from Configure Platform or AI suggestions)
    if (input.customFields) {
      for (const [k, v] of Object.entries(input.customFields)) {
        if (v !== undefined && v !== null && v !== '') {
          fields[k] = v;
        }
      }
    }

    // Create with safe fields only — custom fields (story points, sprint, assignee,
    // acceptance criteria) go into a post-create update using the edit screen,
    // which bypasses Jira's create-screen field restrictions entirely.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let created: any;
    try {
      created = await this.http<any>('/issue', { method: 'POST', body: JSON.stringify({ fields }) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('400')) {
        // Strip the specific bad field and retry
        const stripped: any = { ...fields };
        const fm = msg.match(/'([^']+)'|"([^"]+)"/);
        const bad = fm?.[1] ?? fm?.[2];
        if (bad && !['Story','Task','Bug','Epic','Sub-task','Feature','Test'].includes(bad)) {
          delete stripped[bad];
        }
        created = await this.http<any>('/issue', { method: 'POST', body: JSON.stringify({ fields: stripped }) });
      } else {
        throw err;
      }
    }

    // ── Post-create: set custom fields via the edit screen ──────────────────
    // Edit screen has far fewer restrictions than the create screen.
    // Each field is set individually so one failure doesn't block the others.
    const postFields: Array<[string, unknown]> = [];

    // Story points — try discovered field first, then common field IDs as fallback
    if (input.storyPoints !== undefined) {
      const spf = await this.getStoryPointsField();
      if (spf) {
        postFields.push([spf, input.storyPoints]);
      } else {
        // Field discovery failed — try each common field ID individually.
        // One of these will work; the others will fail silently in the loop below.
        for (const fallback of ['customfield_10016', 'customfield_10028', 'customfield_10014', 'story_points']) {
          postFields.push([fallback, input.storyPoints]);
        }
      }
    }

    // Sprint
    if (input.sprintId) {
      const sid = Number(input.sprintId);
      if (!isNaN(sid) && sid > 0) { postFields.push(['customfield_10020', sid]); }
    }

    // Priority — set via post-create to avoid screen restrictions
    if (input.priority) {
      postFields.push(['priority', { name: input.priority }]);
    }

    // Assignee — use dedicated /assignee endpoint (more reliable than fields PUT)
    // Queued separately after other postFields
    const pendingAssigneeId = input.assigneeId?.trim();

    // Acceptance criteria
    if (input.acceptanceCriteria) {
      const acf = await this.getAcceptanceCriteriaField();
      if (acf) {
        postFields.push([acf, toAdf(input.acceptanceCriteria)]);
      } else {
        // No dedicated AC field — append to description
        postFields.push(['description', toAdf(
          (input.description ?? '') + '\n\n**Acceptance Criteria**\n' + input.acceptanceCriteria
        )]);
      }
    }

    // Set each post-create field individually so partial success is possible
    for (const [key, val] of postFields) {
      try {
        await this.http(`/issue/${created.key}`, {
          method: 'PUT',
          body:   JSON.stringify({ fields: { [key]: val } })
        });
      } catch { /* field not available on this instance — skip silently */ }
    }

    // Set assignee via the dedicated endpoint — more reliable than fields PUT.
    // Tries accountId first, falls back to name (for Jira Server).
    if (pendingAssigneeId) {
      await this.setAssignee(created.key, pendingAssigneeId);
    }

    return this.getWorkItem(created.key);
  }

  /** Set assignee via dedicated endpoint — handles both Cloud (accountId) and Server (name) */
  async setAssignee(keyOrId: string, idOrEmail: string): Promise<void> {
    const key = encodeURIComponent(keyOrId);
    const id  = idOrEmail.trim();
    // Jira Cloud: accountId is a long hash-like string (no @, no spaces, 20+ chars)
    // Jira Server: name is a username or email
    const isAccountId = id.length >= 20 && !id.includes('@') && !id.includes(' ');
    try {
      // Try accountId format first (Jira Cloud)
      await this.http(`/issue/${key}/assignee`, {
        method: 'PUT',
        body:   JSON.stringify({ accountId: isAccountId ? id : undefined, name: !isAccountId ? id : undefined })
      });
    } catch {
      // Fallback: set via fields update
      try {
        await this.http(`/issue/${key}`, {
          method: 'PUT',
          body:   JSON.stringify({ fields: {
            assignee: isAccountId ? { accountId: id } : { name: id }
          }})
        });
      } catch { /* skip if neither works */ }
    }
  }

  async updateWorkItem(keyOrId: string, input: UpdateWorkItemInput): Promise<WorkItem> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields: any = {};
    if (input.title)                   { fields.summary = input.title; }
    if (input.storyPoints !== undefined) {
      const spField2 = await this.getStoryPointsField();
      if (spField2) {
        fields[spField2] = input.storyPoints;
      } else {
        // Try all common field IDs — the PUT will ignore unknown ones
        fields['customfield_10016'] = input.storyPoints;
        fields['customfield_10028'] = input.storyPoints;
        fields['customfield_10014'] = input.storyPoints;
        fields['story_points']      = input.storyPoints;
      }
    }
    if (input.priority)                { fields.priority = { name: input.priority }; }
    if (input.labels)                  { fields.labels   = input.labels; }
    // Assignee is handled separately via setAssignee after the main update
    const pendingAssignee2 = input.assigneeId;
    if (input.description) { fields.description = toAdf(input.description); }

    await this.http(`/issue/${encodeURIComponent(keyOrId)}`, {
      method: 'PUT', body: JSON.stringify({ fields })
    });
    if (input.status) { await this.transitionWorkItem(keyOrId, input.status); }
    return this.getWorkItem(keyOrId);
  }

  /** Link a Jira issue to a parent (works for sub-tasks and child issues) */
  async addParentLink(childKey: string, parentKeyOrId: string): Promise<void> {
    const child = encodeURIComponent(childKey.trim());
    const parent = parentKeyOrId.trim().replace(/^#/, '');
    const isNumeric = /^\d+$/.test(parent);

    // Method 1: Set parent field with key
    try {
      await this.http(`/issue/${child}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: { parent: isNumeric ? { id: parent } : { key: parent } } })
      });
      return;
    } catch { /* try next */ }

    // Method 2: Set parent field with the other format
    try {
      await this.http(`/issue/${child}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: { parent: isNumeric ? { key: parent } : { id: parent } } })
      });
      return;
    } catch { /* try next */ }

    // Method 3: Use issuelinks API (works for all Jira versions)
    try {
      // Fetch the parent issue to get both key and id
      const parentIssue = await this.http<any>(`/issue/${encodeURIComponent(parent)}?fields=summary`);
      const parentKey = parentIssue.key;
      await this.http('/issueLink', {
        method: 'POST',
        body: JSON.stringify({
          type: { name: 'Hierarchy' },
          inwardIssue:  { key: parentKey },
          outwardIssue: { key: childKey.trim() }
        })
      });
      return;
    } catch { /* try next */ }

    // Method 4: Try "Parent/Child" link type name (varies by Jira instance)
    try {
      const parentIssue = await this.http<any>(`/issue/${encodeURIComponent(parent)}?fields=summary`);
      await this.http('/issueLink', {
        method: 'POST',
        body: JSON.stringify({
          type: { name: 'Parent-Child' },
          inwardIssue:  { key: parentIssue.key },
          outwardIssue: { key: childKey.trim() }
        })
      });
    } catch {
      // All methods failed — log but don't throw
    }
  }

  /** Fetch child issues (subtasks + child links) for a given issue */
  async getChildItems(parentKey: string): Promise<WorkItem[]> {
    try {
      // JQL: parent = KEY returns subtasks and child issues
      const jql = `parent = "${parentKey}" ORDER BY created ASC`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<any>('/search/jql', {
        method: 'POST',
        body: JSON.stringify({ jql, fields: 'summary,status,issuetype,assignee,priority,labels,customfield_10016,customfield_10028,customfield_10014,story_points,description,project,comment', maxResults: 100 })
      });
      return (r.issues ?? []).map((i: any) => this.mapIssue(i));
    } catch {
      return [];
    }
  }

  /** Expose http for agent-level calls (e.g. sprint update in /move) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callApi(path: string, options: RequestInit = {}): Promise<any> {
    return this.http(path, options);
  }

  /** Returns the names of states reachable from the current state */
  async getAvailableTransitions(keyOrId: string): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { transitions } = await this.http<any>(`/issue/${encodeURIComponent(keyOrId)}/transitions`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (transitions ?? []).map((t: any) => String(t.to?.name ?? t.name ?? '')).filter(Boolean);
    } catch { return []; }
  }

  async transitionWorkItem(keyOrId: string, targetStatus: string): Promise<AgentToolResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { transitions } = await this.http<any>(`/issue/${encodeURIComponent(keyOrId)}/transitions`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const match = transitions.find((t: any) =>
      t.name.toLowerCase() === targetStatus.toLowerCase() ||
      t.to?.name?.toLowerCase() === targetStatus.toLowerCase()
    );
    if (!match) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const available = transitions.map((t: any) => t.name).join(', ');
      return { success: false, error: `No transition to "${targetStatus}". Available: ${available}` };
    }
    await this.http(`/issue/${encodeURIComponent(keyOrId)}/transitions`, {
      method: 'POST', body: JSON.stringify({ transition: { id: match.id } })
    });
    return { success: true };
  }

  // ── People ────────────────────────────────────────────────────────────────

  async getProjectMembers(projectKey?: string): Promise<User[]> {
    const key = projectKey ?? this.defaultProject;

    // Strategy 1: assignable users scoped to this project (most accurate)
    // Strategy 2: all users via /users/search (broader, better for large orgs)
    // Strategy 3: recent assignees from project issues (always works)
    const all: User[] = [];
    const seen = new Set<string>();

    const addUser = (u: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const id = u.accountId ?? u.name ?? '';
      if (!id || seen.has(id)) { return; }
      seen.add(id);
      all.push({
        id,
        displayName: u.displayName ?? u.name ?? id,
        email:       u.emailAddress,
        avatarUrl:   u.avatarUrls?.['48x48']
      });
    };

    // Strategy 1 — assignable/search for this project
    try {
      let startAt = 0;
      while (true) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page = await this.http<any[]>(
          `/user/assignable/search?project=${encodeURIComponent(key)}&maxResults=50&startAt=${startAt}`
        );
        if (!page?.length) { break; }
        page.forEach(addUser);
        if (page.length < 50) { break; }
        startAt += page.length;
        if (all.length >= 200) { break; }
      }
    } catch { /* fall through to strategy 2 */ }

    // Strategy 2 — /users/search (Jira Cloud: returns active users searchable by query)
    // Use empty query to get all users if strategy 1 returned nothing
    if (all.length === 0) {
      try {
        let startAt = 0;
        while (true) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const page = await this.http<any[]>(
            `/users/search?maxResults=50&startAt=${startAt}`
          );
          if (!page?.length) { break; }
          page.forEach(addUser);
          if (page.length < 50) { break; }
          startAt += page.length;
          if (all.length >= 200) { break; }
        }
      } catch { /* fall through to strategy 3 */ }
    }

    // Strategy 3 — extract assignees from recent issues in the project
    // Guaranteed to return at least the people who have worked on this project
    if (all.length === 0) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await this.http<any>('/search/jql', {
          method: 'POST',
          body: JSON.stringify({
            jql:        `project = "${key}" AND assignee is not EMPTY ORDER BY updated DESC`,
            maxResults: 50,
            fields:     ['assignee']
          })
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const issue of (r.issues ?? [])) {
          if (issue.fields?.assignee) { addUser(issue.fields.assignee); }
        }
      } catch { /* give up */ }
    }

    return all.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  /**
   * Resolve an email or display name to a Jira accountId.
   * Used when a user enters their details manually in /setuser.
   */
  async resolveUser(emailOrName: string): Promise<User | null> {
    const q = encodeURIComponent(emailOrName.trim());
    try {
      // /user/search accepts email and display name
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await this.http<any[]>(`/user/search?query=${q}&maxResults=5`);
      if (!results?.length) { return null; }
      const u = results[0];
      return {
        id:          u.accountId,
        displayName: u.displayName,
        email:       u.emailAddress,
        avatarUrl:   u.avatarUrls?.['48x48']
      };
    } catch { return null; }
  }

  // ── Sprints ───────────────────────────────────────────────────────────────

  async getAllSprints(projectKey?: string): Promise<Sprint[]> {
    const key = projectKey ?? this.defaultProject;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const boards = await this.httpAgile<any>(`/board?projectKeyOrId=${encodeURIComponent(key)}&maxResults=5`);
      if (!boards.values?.length) { return []; }
      const boardId = boards.values[0].id;

      const [active, future, closed] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.httpAgile<any>(`/board/${boardId}/sprint?state=active`).catch(() => ({ values: [] })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.httpAgile<any>(`/board/${boardId}/sprint?state=future`).catch(() => ({ values: [] })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.httpAgile<any>(`/board/${boardId}/sprint?state=closed&maxResults=3`).catch(() => ({ values: [] }))
      ]);

      const sprints: Sprint[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (s: any, state: Sprint['state']): Sprint => ({
        id: String(s.id), name: s.name, state, startDate: s.startDate, endDate: s.endDate
      });
      for (const s of active.values  ?? []) { sprints.push(map(s, 'active')); }
      for (const s of future.values  ?? []) { sprints.push(map(s, 'future')); }
      for (const s of (closed.values ?? []).slice(-3)) { sprints.push(map(s, 'closed')); }
      return sprints;
    } catch { return []; }
  }

  async getActiveSprint(projectKey?: string): Promise<Sprint | null> {
    const key = projectKey ?? this.defaultProject;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const boards = await this.httpAgile<any>(`/board?projectKeyOrId=${encodeURIComponent(key)}`);
      if (!boards.values?.length) { return null; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sprints = await this.httpAgile<any>(`/board/${boards.values[0].id}/sprint?state=active`);
      if (!sprints.values?.length) { return null; }
      const s = sprints.values[0];
      return { id: String(s.id), name: s.name, state: 'active', startDate: s.startDate, endDate: s.endDate };
    } catch { return null; }
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async getProjects(): Promise<Project[]> {
    try {
      const all: Project[] = [];
      let startAt = 0;
      const pageSize = 50;
      let isLast = false;

      while (!isLast) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await this.http<any>(`/project/search?startAt=${startAt}&maxResults=${pageSize}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const page: Project[] = (r.values ?? []).map((p: any) => ({ id: p.id, key: p.key, name: p.name }));
        all.push(...page);
        isLast = r.isLast ?? (page.length < pageSize);
        startAt += page.length;
        if (all.length >= 500) { break; }
      }
      return all;
    } catch {
      return [];
    }
  }

  // ── Story points field discovery ─────────────────────────────────────────

  /**
   * Jira instances vary in which custom field holds story points.
   * Common IDs: customfield_10016 (classic), customfield_10028 (some cloud),
   * customfield_10014 (next-gen), story_points (server).
   * We discover the correct one from the field metadata API once and cache it.
   */
  private _fieldCache: Record<string, string | null> = {};

  /** Discover field ID by name — cached */
  private async findField(names: string[], keys: string[]): Promise<string | null> {
    const cacheKey = keys[0];
    if (cacheKey in this._fieldCache) { return this._fieldCache[cacheKey]; }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allFields = await this.http<any[]>('/field');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = (allFields ?? []).find((f: any) => {
        const n = (f.name ?? '').toLowerCase();
        const k = (f.key  ?? '').toLowerCase();
        return names.some(x => n === x.toLowerCase()) || keys.some(x => k === x.toLowerCase());
      });
      this._fieldCache[cacheKey] = found?.key ?? null;
    } catch {
      this._fieldCache[cacheKey] = null;
    }
    return this._fieldCache[cacheKey];
  }

  async getStoryPointsField(): Promise<string | null> {
    return this.findField(
      ['story points', 'story point estimate'],
      ['story_points', 'customfield_10016', 'customfield_10028', 'customfield_10014']
    );
  }

  async getAcceptanceCriteriaField(): Promise<string | null> {
    return this.findField(
      ['acceptance criteria', 'acceptance criterion'],
      ['customfield_10097', 'customfield_10068', 'customfield_10033']
    );
  }

  // ── Priorities ───────────────────────────────────────────────────────────

  async getPriorities(): Promise<string[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<any[]>('/priority');
      return ((r ?? []) as any[]).map((p: any) => String(p.name ?? '')).filter(Boolean);
    } catch {
      return ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
    }
  }

  // ── Issue types & labels ─────────────────────────────────────────────────

  /** Returns issue type names available for this project */
  async getWorkItemTypes(): Promise<string[]> {
    try {
      const key = this.defaultProject;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<any>(`/project/${encodeURIComponent(key)}/statuses`);
      const types = (r ?? []).map((t: any) => String(t.name ?? '')).filter(Boolean);
      return ([...new Set(types)] as string[]).sort();
    } catch {
      try {
        const r = await this.http<any[]>('/issuetype');
        return ((r ?? []) as any[]).map((t: any) => String(t.name ?? '')).filter(Boolean).sort() as string[];
      } catch {
        return ['Story', 'Task', 'Bug', 'Epic', 'Sub-task'];
      }
    }
  }

  /**
   * Fetch all fields on the create screen for a given issue type in the current project.
   * Returns each field's key, name, whether it's required, its type, and allowed values.
   * Skips fields already handled by the standard create flow.
   */
  async getCreateFields(issueTypeName: string): Promise<Array<{
    key: string;
    name: string;
    required: boolean;
    type: 'string' | 'number' | 'option' | 'array' | 'user' | 'date' | 'any';
    allowedValues?: Array<{ id: string; value: string }>;
  }>> {
    const project = this.defaultProject;
    // Fields already handled by our standard create flow — don't show in the wizard
    const skip = new Set([
      'summary', 'issuetype', 'project', 'description', 'priority',
      'labels', 'parent', 'assignee', 'reporter', 'attachment',
      'customfield_10020', // sprint
    ]);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allTypes = await this.http<any[]>('/issuetype');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typeObj = (allTypes ?? []).find((t: any) => t.name?.toLowerCase() === issueTypeName.toLowerCase());
      if (!typeObj) { return []; }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let fieldEntries: Array<{ key: string; field: any }> = [];

      // Method 1: New createmeta v3 endpoint (Jira Cloud)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let allValues: any[] = [];
        let startAt = 0;
        const maxResults = 50;
        let total = Infinity;
        while (startAt < total) {
          const meta = await this.http<any>(
            `/issue/createmeta/${encodeURIComponent(project)}/issuetypes/${typeObj.id}?startAt=${startAt}&maxResults=${maxResults}`
          );
          const vals = meta?.values ?? [];
          allValues = allValues.concat(vals);
          total = meta?.total ?? vals.length;
          startAt += vals.length;
          if (vals.length === 0 || startAt >= 500) { break; }
        }
        fieldEntries = allValues.map((v: any) => ({ key: v.fieldId ?? '', field: v }));
      } catch {
        // Method 2: Old createmeta with expand (Jira Server / older Cloud)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const meta = await this.http<any>(
            `/issue/createmeta?projectKeys=${encodeURIComponent(project)}&issuetypeIds=${typeObj.id}&expand=projects.issuetypes.fields`
          );
          const fields = meta?.projects?.[0]?.issuetypes?.[0]?.fields ?? {};
          fieldEntries = Object.entries(fields).map(([k, v]: [string, any]) => ({ key: k, field: { ...v, fieldId: k } }));
        } catch { return []; }
      }

      const result: Array<{
        key: string; name: string; required: boolean;
        type: 'string' | 'number' | 'option' | 'array' | 'user' | 'date' | 'any';
        allowedValues?: Array<{ id: string; value: string }>;
      }> = [];

      for (const { key, field } of fieldEntries) {
        if (!key || skip.has(key)) { continue; }

        const schema = field.schema ?? {};
        const schemaType = schema.type ?? '';
        const customType = schema.custom ?? '';

        let type: 'string' | 'number' | 'option' | 'array' | 'user' | 'date' | 'any' = 'string';
        if (schemaType === 'number') { type = 'number'; }
        else if (schemaType === 'option' || customType.includes('select') || customType.includes('radiobuttons') || field.allowedValues?.length) { type = 'option'; }
        else if (schemaType === 'array' && (schema.items === 'option' || schema.items === 'string')) { type = 'array'; }
        else if (schemaType === 'array') { type = 'array'; }
        else if (schemaType === 'user') { type = 'user'; }
        else if (schemaType === 'date' || schemaType === 'datetime') { type = 'date'; }
        else if (schemaType === 'any' || schemaType === 'json') { type = 'any'; }

        let allowedValues: Array<{ id: string; value: string }> | undefined;
        if (field.allowedValues?.length) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          allowedValues = field.allowedValues.map((v: any) => ({
            id:    String(v.id ?? v.value ?? ''),
            value: String(v.value ?? v.name ?? v.label ?? v.id ?? '')
          }));
        }

        result.push({
          key,
          name:     field.name ?? key,
          required: !!field.required,
          type,
          allowedValues,
        });
      }

      // Sort: required first, then alphabetical
      result.sort((a, b) => {
        if (a.required !== b.required) { return a.required ? -1 : 1; }
        return a.name.localeCompare(b.name);
      });

      return result;
    } catch {
      return [];
    }
  }

  /** Returns labels used in this project (best-effort — Jira label API is limited) */
  async getLabels(): Promise<string[]> {
    const labels = new Set<string>();

    // Strategy 1: /label endpoint — returns { values: ["label1", "label2"] } in Cloud
    // or { values: [{ label: "..." }] } in some versions
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await this.http<any>('/label?maxResults=200');
      const values = r?.values ?? r?.suggestions ?? [];
      for (const v of values) {
        if (typeof v === 'string' && v.trim()) {
          labels.add(v.trim());
        } else if (v && typeof v === 'object') {
          // Could be { label: "..." } or { value: "..." } or { name: "..." }
          const text = v.label ?? v.value ?? v.name ?? v.displayName ?? '';
          if (typeof text === 'string' && text.trim()) { labels.add(text.trim()); }
        }
      }
    } catch { /* fall through */ }

    // Strategy 2: extract labels from recent issues in this project
    // This is always accurate — real labels actually in use
    if (labels.size === 0) {
      try {
        const key = this.defaultProject;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = await this.http<any>('/search/jql', {
          method: 'POST',
          body: JSON.stringify({
            jql:        key ? `project = "${key}" AND labels is not EMPTY ORDER BY updated DESC` : 'labels is not EMPTY ORDER BY updated DESC',
            maxResults: 100,
            fields:     ['labels']
          })
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const issue of (r.issues ?? [])) {
          for (const label of (issue.fields?.labels ?? [])) {
            if (typeof label === 'string' && label.trim()) { labels.add(label.trim()); }
          }
        }
      } catch { /* give up */ }
    }

    return [...labels].sort();
  }

  // ── Map issue ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapIssue(issue: any): WorkItem {
    const f = issue.fields;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const comments: Comment[] = (f.comment?.comments ?? []).map((c: any) => ({
      id:        String(c.id),
      author:    c.author?.displayName ?? 'Unknown',
      body:      extractAdfText(c.body),
      createdAt: c.created ?? ''
    }));

    const t = (f.issuetype?.name ?? 'task').toLowerCase();
    let type: WorkItemType = 'task';
    if      (t.includes('story'))   { type = 'story'; }
    else if (t.includes('epic'))    { type = 'epic'; }
    else if (t.includes('bug'))     { type = 'bug'; }
    else if (t.includes('sub'))     { type = 'subtask'; }
    else if (t.includes('feature')) { type = 'feature'; }

    // Sprint name — customfield_10020 is an array in newer Jira
    const sprintField = f.customfield_10020;
    const sprintName  = Array.isArray(sprintField)
      ? sprintField[0]?.name
      : sprintField?.name;

    return {
      id:          issue.id,
      key:         issue.key,
      title:       f.summary,
      description: extractAdfText(f.description),
      type,
      status:      f.status?.name ?? 'Unknown',
      priority:    f.priority?.name,
      assignee:    f.assignee ? {
        id:          f.assignee.accountId,
        displayName: f.assignee.displayName,
        email:       f.assignee.emailAddress,
        avatarUrl:   f.assignee.avatarUrls?.['48x48']
      } : undefined,
      reporter: f.reporter ? {
        id:          f.reporter.accountId,
        displayName: f.reporter.displayName,
        email:       f.reporter.emailAddress
      } : undefined,
      storyPoints: f.customfield_10016 ?? f.customfield_10028 ?? f.customfield_10014 ?? f.story_points,
      labels:      f.labels,
      sprint:      sprintName,
      url:         `${this.baseUrl}/browse/${issue.key}`,
      platform:    'jira',
      projectKey:  f.project?.key ?? this.defaultProject,
      createdAt:   f.created,
      updatedAt:   f.updated,
      comments
    };
  }
}

// ── ADF utilities ─────────────────────────────────────────────────────────────

/** Convert plain text to Atlassian Document Format (ADF) */
function toAdf(text: string): object {
  const paragraphs = text.split('\n\n').filter(Boolean);
  return {
    type: 'doc', version: 1,
    content: paragraphs.map(para => ({
      type: 'paragraph',
      content: para.split('\n').flatMap((line, i, arr) => {
        const nodes: object[] = [{ type: 'text', text: line }];
        if (i < arr.length - 1) { nodes.push({ type: 'hardBreak' }); }
        return nodes;
      })
    }))
  };
}

/** Recursively extract plain text from an ADF document */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAdfText(node: any): string {
  if (!node)              { return ''; }
  if (typeof node === 'string') { return node; }
  if (node.type === 'text')     { return node.text ?? ''; }
  if (node.type === 'hardBreak') { return '\n'; }
  if (Array.isArray(node.content)) {
    const text = node.content.map(extractAdfText).join('');
    // Add paragraph spacing
    if (node.type === 'paragraph') { return text + '\n'; }
    return text;
  }
  return '';
}
