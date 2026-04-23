// src/providers/githubProvider.ts
// GitHub Issues + Projects v2 provider — uses GraphQL API (v4) and REST API (v3).

import {
  WorkItem, WorkItemType, User, Sprint, Project, Comment,
  CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery,
  ApiCredentials, AgentToolResult
} from '../types';
import { stripHtml } from '../utils/strings';

export class GitHubProvider {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly projectNumber: number;
  private projectId: string | null = null;

  constructor(creds: ApiCredentials) {
    this.owner = creds.githubOwner ?? '';
    this.repo  = creds.githubRepo ?? '';
    this.token = creds.githubToken ?? '';
    this.projectNumber = creds.githubProjectNumber ?? 0;
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  private async rest<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    const res = await globalThis.fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}, extraHeaders?: Record<string, string>): Promise<T> {
    const res = await globalThis.fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub GraphQL ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json() as any;
    if (json.errors?.length) {
      throw new Error(`GraphQL: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  // ── Project ID resolution ────────────────────────────────────────────────

  private async getProjectId(): Promise<string> {
    if (this.projectId) { return this.projectId; }
    if (!this.projectNumber) { throw new Error('No GitHub Project number configured.'); }

    // Try org project first, then user project
    for (const ownerType of ['organization', 'user']) {
      try {
        const data = await this.graphql<any>(`
          query($owner: String!, $number: Int!) {
            ${ownerType}(login: $owner) {
              projectV2(number: $number) { id }
            }
          }
        `, { owner: this.owner, number: this.projectNumber });
        const id = data?.[ownerType]?.projectV2?.id;
        if (id) { this.projectId = id; return id; }
      } catch { /* try next */ }
    }
    throw new Error(`Project #${this.projectNumber} not found for ${this.owner}`);
  }

  // ── Search / List ────────────────────────────────────────────────────────

  async searchWorkItems(query: WorkItemQuery): Promise<WorkItem[]> {
    // If a project is configured and no specific text/type filter, load from project board
    if (this.projectNumber && !query.text && !query.type) {
      try {
        const items = await this._searchFromProject(query);
        if (items.length) { return items; }
      } catch { /* fall through to REST search */ }
    }

    const parts = [`repo:${this.owner}/${this.repo}`, 'is:issue'];
    if (query.status === 'open') { parts.push('is:open'); }
    else if (query.status === 'closed' || query.status === 'done') { parts.push('is:closed'); }
    else if (query.status) { parts.push(`label:"${query.status}"`); }
    else { parts.push('is:open'); }

    if (query.assigneeId === '@me') { parts.push('assignee:@me'); }
    else if (query.assigneeId) { parts.push(`assignee:${query.assigneeId}`); }

    if (query.text) { parts.push(query.text); }

    if (query.type) {
      const labelMap: Record<string, string> = { bug: 'bug', feature: 'enhancement', story: 'enhancement', epic: 'epic' };
      const label = labelMap[query.type];
      if (label) { parts.push(`label:${label}`); }
    }

    const max = query.maxResults ?? 100;
    const q = parts.join(' ');
    const allItems: WorkItem[] = [];
    let page = 1;

    // GitHub search API caps at 100 per page — paginate to get more
    while (allItems.length < max) {
      const perPage = Math.min(100, max - allItems.length);
      const data = await this.rest<{ items?: any[]; total_count?: number }>(
        `/search/issues?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&sort=updated&order=desc`
      );
      const items = (data.items ?? []).map((i: any) => this.mapIssue(i));
      allItems.push(...items);
      if (items.length < perPage || allItems.length >= (data.total_count ?? max)) { break; }
      page++;
      if (page > 10) { break; } // safety cap
    }

    return allItems;
  }

  /** Load items directly from GitHub Projects v2 board with their project-specific status */
  private async _searchFromProject(query: WorkItemQuery): Promise<WorkItem[]> {
    const projectId = await this.getProjectId();
    const max = query.maxResults ?? 500;
    let cursor: string | null = null;
    const allItems: WorkItem[] = [];

    while (allItems.length < max) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gqlResult: any = await this.graphql<any>(`
        query($projectId: ID!, $cursor: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldSingleSelectValue {
                        name
                        field { ... on ProjectV2SingleSelectField { name } }
                      }
                      ... on ProjectV2ItemFieldDateValue {
                        date
                        field { ... on ProjectV2Field { name } }
                      }
                    }
                  }
                  content {
                    ... on Issue {
                      number title body state
                      createdAt updatedAt
                      url
                      assignees(first: 5) { nodes { login email } }
                      labels(first: 20) { nodes { name } }
                      milestone { title }
                      author { login }
                    }
                  }
                }
              }
            }
          }
        }
      `, { projectId, cursor });

      const items: any = gqlResult?.node?.items;
      const nodes = items?.nodes ?? [];

      for (const node of nodes) {
        const content = node?.content;
        if (!content?.number) { continue; } // skip drafts/PRs without number

        // Extract project-specific status and dates from field values
        let projectStatus = content.state === 'CLOSED' ? 'Closed' : 'Open';
        let startDate: string | undefined;
        let endDate: string | undefined;
        for (const fv of (node.fieldValues?.nodes ?? [])) {
          const fieldName = (fv?.field?.name ?? '').toLowerCase();
          if (fieldName === 'status' && fv?.name) {
            projectStatus = fv.name;
          }
          if (fv?.date) {
            if (fieldName === 'start date' || fieldName === 'start' || fieldName === 'startdate') {
              startDate = fv.date;
            } else if (fieldName === 'end date' || fieldName === 'due date' || fieldName === 'target date' || fieldName === 'end' || fieldName === 'due' || fieldName === 'enddate') {
              endDate = fv.date;
            }
          }
        }

        // Filter by status if requested
        if (query.status === 'open' && content.state === 'CLOSED') { continue; }
        if ((query.status === 'closed' || query.status === 'done') && content.state !== 'CLOSED') { continue; }

        // Filter by assignee if requested
        const assignees = (content.assignees?.nodes ?? []).map((a: any) => a?.login).filter(Boolean);
        if (query.assigneeId && query.assigneeId !== '@me') {
          if (!assignees.includes(query.assigneeId)) { continue; }
        }

        const labels = (content.labels?.nodes ?? []).map((l: any) => l?.name).filter(Boolean);
        const type = this.labelsToType(labels);

        allItems.push({
          id: String(content.number),
          key: `#${content.number}`,
          title: content.title ?? '(no title)',
          description: stripHtml(content.body ?? ''),
          type,
          rawTypeName: labels.find((l: string) =>
            ['bug', 'enhancement', 'feature', 'epic', 'task', 'story'].includes(l.toLowerCase())
          ) ?? type,
          status: projectStatus,
          assignee: assignees.length ? { id: assignees[0], displayName: assignees[0] } : undefined,
          reporter: content.author ? { id: content.author.login, displayName: content.author.login } : undefined,
          labels,
          sprint: content.milestone?.title,
          url: content.url ?? `https://github.com/${this.owner}/${this.repo}/issues/${content.number}`,
          platform: 'github',
          projectKey: `${this.owner}/${this.repo}`,
          createdAt: content.createdAt,
          updatedAt: content.updatedAt,
          startDate,
          endDate,
        });
      }

      if (items?.pageInfo?.hasNextPage && items.pageInfo.endCursor) {
        cursor = items.pageInfo.endCursor;
      } else {
        break;
      }
    }

    return allItems.slice(0, max);
  }

  // ── Single item ──────────────────────────────────────────────────────────

  async getWorkItem(numberOrKey: string): Promise<WorkItem> {
    const num = String(numberOrKey).replace(/^#/, '');
    const issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${num}`);
    const item = this.mapIssue(issue);
    try { item.comments = await this.getComments(num); } catch { /* optional */ }
    return item;
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  async getComments(numberOrKey: string): Promise<Comment[]> {
    const num = String(numberOrKey).replace(/^#/, '');
    const data = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/issues/${num}/comments?per_page=30`);
    return (data ?? []).map((c: any) => ({
      id: String(c.id),
      author: c.user?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.created_at ?? '',
    }));
  }

  async addComment(numberOrKey: string, text: string): Promise<Comment> {
    const num = String(numberOrKey).replace(/^#/, '');
    const c = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${num}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: text }),
    });
    return { id: String(c.id), author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at ?? '' };
  }

  // ── Attachments ───────────────────────────────────────────────────────────

  async addAttachment(_numberOrKey: string, _fileName: string, _fileContent: Buffer, _mimeType: string): Promise<AgentToolResult> {
    // GitHub Issues don't support file attachments via API (only via drag-and-drop in the UI)
    return { success: false, error: 'GitHub Issues API does not support file attachments. Upload files via the GitHub web UI.' };
  }

  // ── Create ───────────────────────────────────────────────────────────────

  async createWorkItem(input: CreateWorkItemInput & {
    acceptanceCriteria?: string;
    parentId?: string;
    customFields?: Record<string, unknown>;
  }): Promise<WorkItem> {
    // Build body
    let body = input.description ?? '';
    if (input.acceptanceCriteria) {
      body += `\n\n## Acceptance Criteria\n\n${input.acceptanceCriteria}`;
    }
    if (input.storyPoints) {
      body += `\n\n**Story Points:** ${input.storyPoints}`;
    }

    const issueBody: any = {
      title: input.title,
      body,
      assignees: input.assigneeId ? [input.assigneeId] : undefined,
    };

    // Set the issue type via the REST API type field (not labels)
    const typeName = input.rawTypeName ?? this.typeToLabel(input.type) ?? input.type;
    if (typeName) {
      issueBody.type = typeName;
    }

    // Labels are for actual labels only, not for type
    if (input.labels?.length) {
      issueBody.labels = input.labels;
    }

    let issue: any;
    try {
      issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
        method: 'POST',
        body: JSON.stringify(issueBody),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // If type field fails (org doesn't support issue types), retry without it
      if (msg.includes('type') || msg.includes('422') || msg.includes('validation')) {
        delete issueBody.type;
        delete issueBody.labels; // labels might also fail
        issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
          method: 'POST',
          body: JSON.stringify(issueBody),
        });
      } else if (msg.includes('403') || msg.includes('label')) {
        delete issueBody.labels;
        issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
          method: 'POST',
          body: JSON.stringify(issueBody),
        });
      } else {
        throw e;
      }
    }

    const item = this.mapIssue(issue);

    // Add to GitHub Project if configured + set project fields (dates, status)
    if (this.projectNumber) {
      try {
        const projectId = await this.getProjectId();
        const addResult = await this.graphql<any>(`
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item { id }
            }
          }
        `, { projectId, contentId: issue.node_id });

        const projectItemId = addResult?.addProjectV2ItemById?.item?.id;
        if (projectItemId) {
          await this._setProjectFields(projectId, projectItemId, {
            type: input.type,
            rawTypeName: input.rawTypeName,
            storyPoints: input.storyPoints,
            priority: input.priority,
            labels: input.labels,
            startDate: input.startDate,
            endDate: input.endDate,
            sprintId: input.sprintId,
          });
        }
      } catch { /* project add is best-effort */ }
    }

    // Parent linking — use sub-issues API for real hierarchy
    if (input.parentId) {
      const parentNum = String(input.parentId).replace(/^#/, '');
      await this.addParentLink(String(issue.number), parentNum);
    }

    return item;
  }

  // ── Update ───────────────────────────────────────────────────────────────

  async updateWorkItem(numberOrKey: string, input: UpdateWorkItemInput): Promise<WorkItem> {
    const num = String(numberOrKey).replace(/^#/, '');
    const patch: any = {};
    if (input.title) { patch.title = input.title; }
    if (input.description) { patch.body = input.description; }
    if (input.status) {
      patch.state = input.status.toLowerCase() === 'closed' || input.status.toLowerCase() === 'done'
        ? 'closed' : 'open';
    }

    const issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${num}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });

    return this.mapIssue(issue);
  }

  // ── Assignee ─────────────────────────────────────────────────────────────

  async setAssignee(numberOrKey: string, username: string): Promise<void> {
    const num = String(numberOrKey).replace(/^#/, '');
    await this.rest(`/repos/${this.owner}/${this.repo}/issues/${num}/assignees`, {
      method: 'POST',
      body: JSON.stringify({ assignees: [username] }),
    });
  }

  // ── Status transition ────────────────────────────────────────────────────

  async transitionWorkItem(numberOrKey: string, status: string): Promise<AgentToolResult> {
    const num = String(numberOrKey).replace(/^#/, '');
    const state = status.toLowerCase() === 'closed' || status.toLowerCase() === 'done'
      ? 'closed' : 'open';
    try {
      await this.rest(`/repos/${this.owner}/${this.repo}/issues/${num}`, {
        method: 'PATCH',
        body: JSON.stringify({ state }),
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Parent/Child ─────────────────────────────────────────────────────────

  async addParentLink(childNumber: string, parentNumber: string): Promise<void> {
    const child = String(childNumber).replace(/^#/, '');
    const parent = String(parentNumber).replace(/^#/, '');

    // Fetch both issues to get node_id and numeric id
    const [childIssue, parentIssue] = await Promise.all([
      this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${child}`),
      this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${parent}`)
    ]);

    // Step 1: Try GraphQL addSubIssue (most reliable per community reports)
    // Requires GraphQL-Features: sub_issues header
    try {
      await this.graphql(`
        mutation($parentId: ID!, $childId: ID!) {
          addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) {
            issue { id }
            subIssue { id }
          }
        }
      `, {
        parentId: parentIssue.node_id,
        childId: childIssue.node_id
      }, {
        'GraphQL-Features': 'sub_issues'
      });
      return;
    } catch (e) {
      console.log(`Sub-issue GraphQL failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 2: Try REST sub-issues API with correct API version
    // sub_issue_id must be the numeric database id (not issue number)
    try {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${parent}/sub_issues`;
      const res = await globalThis.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sub_issue_id: childIssue.id }),
      });
      if (res.ok) { return; }
      const errBody = await res.text().catch(() => '');
      console.log(`Sub-issue REST API failed (${res.status}): ${errBody.slice(0, 300)}`);
    } catch (e) {
      console.log(`Sub-issue REST API error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Step 3: Comment fallback
    console.log(`Sub-issue APIs failed — falling back to comment for #${child} → #${parent}`);
    await this.addComment(child, `Parent: #${parent}`);
  }

  async getChildItems(parentNumber: string): Promise<WorkItem[]> {
    const num = String(parentNumber).replace(/^#/, '');
    // Try sub-issues API with correct API version
    try {
      const url = `https://api.github.com/repos/${this.owner}/${this.repo}/issues/${num}/sub_issues?per_page=50`;
      const res = await globalThis.fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });
      if (res.ok) {
        const data = await res.json() as any[];
        if (data?.length) {
          return data.map((i: any) => this.mapIssue(i));
        }
      }
    } catch { /* fallback */ }

    // Fallback: search for issues that reference this one in body
    try {
      const q = `repo:${this.owner}/${this.repo} is:issue "Parent: #${num}"`;
      const data = await this.rest<{ items?: any[] }>(
        `/search/issues?q=${encodeURIComponent(q)}&per_page=50`
      );
      return (data.items ?? []).map((i: any) => this.mapIssue(i));
    } catch { return []; }
  }

  // ── Members ──────────────────────────────────────────────────────────────

  async getProjectMembers(): Promise<User[]> {
    const seen = new Set<string>();
    const users: User[] = [];

    const addUser = (login: string, email?: string) => {
      if (login && !seen.has(login)) {
        seen.add(login);
        users.push({ id: login, displayName: login, email: email ?? undefined });
      }
    };

    // 1. Always include the authenticated user (token owner)
    try {
      const me = await this.rest<any>('/user');
      addUser(me.login, me.email);
    } catch { /* skip */ }

    // 2. Get assignable users from the repo (people who CAN be assigned)
    try {
      const data = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/assignees?per_page=100`);
      for (const u of (data ?? [])) { addUser(u.login, u.email); }
    } catch { /* skip */ }

    // 3. Get users from project items (people who ARE assigned to items)
    if (this.projectNumber) {
      try {
        const projectId = await this.getProjectId();
        const data = await this.graphql<any>(`
          query($projectId: ID!) {
            node(id: $projectId) {
              ... on ProjectV2 {
                items(first: 100) {
                  nodes {
                    content {
                      ... on Issue {
                        assignees(first: 10) { nodes { login } }
                      }
                    }
                  }
                }
              }
            }
          }
        `, { projectId });
        for (const item of (data?.node?.items?.nodes ?? [])) {
          for (const a of (item?.content?.assignees?.nodes ?? [])) {
            addUser(a?.login);
          }
        }
      } catch { /* skip */ }
    }

    // 4. Fallback: org members
    if (!users.length) {
      try {
        const data = await this.rest<any[]>(`/orgs/${this.owner}/members?per_page=100`);
        for (const u of (data ?? [])) { addUser(u.login); }
      } catch { /* skip */ }
    }

    return users;
  }

  // ── Sprints (iterations from project, milestones as fallback) ────────────

  async getActiveSprint(): Promise<Sprint | null> {
    // Try project iterations first
    if (this.projectNumber) {
      try {
        const sprints = await this._getProjectIterations();
        // Find the iteration that contains today
        const today = new Date().toISOString().split('T')[0];
        const active = sprints.find(s => s.state === 'active' && s.startDate && s.startDate <= today);
        if (active) { return active; }
        // Or just the first active one
        const first = sprints.find(s => s.state === 'active');
        if (first) { return first; }
      } catch { /* fall through to milestones */ }
    }

    try {
      const data = await this.rest<any[]>(
        `/repos/${this.owner}/${this.repo}/milestones?state=open&sort=due_on&direction=asc&per_page=1`
      );
      if (!data?.length) { return null; }
      const m = data[0];
      return { id: String(m.number), name: m.title, state: 'active', startDate: m.created_at, endDate: m.due_on };
    } catch { return null; }
  }

  async getAllSprints(): Promise<Sprint[]> {
    // Try project iterations first
    if (this.projectNumber) {
      try {
        const sprints = await this._getProjectIterations();
        if (sprints.length) { return sprints; }
      } catch { /* fall through */ }
    }

    // Fallback: milestones
    try {
      const open = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/milestones?state=open&per_page=50`);
      const closed = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/milestones?state=closed&per_page=20`);
      return [...(open ?? []), ...(closed ?? [])].map((m: any) => ({
        id: String(m.number),
        name: m.title,
        state: m.state === 'open' ? 'active' as const : 'closed' as const,
        startDate: m.created_at,
        endDate: m.due_on,
      }));
    } catch { return []; }
  }

  /** Get iterations from the project's iteration field */
  private async _getProjectIterations(): Promise<Sprint[]> {
    const projectId = await this.getProjectId();
    const fields = await this._getProjectFields(projectId);
    const iterField = fields.find((f: any) => f?.configuration?.iterations);
    if (!iterField) { return []; }

    const sprints: Sprint[] = [];
    const today = new Date().toISOString().split('T')[0];

    // Active/future iterations
    for (const iter of (iterField.configuration.iterations ?? [])) {
      const endDate = iter.startDate && iter.duration
        ? new Date(new Date(iter.startDate).getTime() + iter.duration * 7 * 86400000).toISOString().split('T')[0]
        : undefined;
      const isActive = iter.startDate && iter.startDate <= today && (!endDate || endDate >= today);
      sprints.push({
        id: iter.id,
        name: iter.title ?? `Sprint starting ${iter.startDate}`,
        state: isActive ? 'active' : 'future',
        startDate: iter.startDate,
        endDate,
      });
    }

    // Completed iterations
    for (const iter of (iterField.configuration.completedIterations ?? [])) {
      const endDate = iter.startDate && iter.duration
        ? new Date(new Date(iter.startDate).getTime() + iter.duration * 7 * 86400000).toISOString().split('T')[0]
        : undefined;
      sprints.push({
        id: iter.id,
        name: iter.title ?? `Sprint starting ${iter.startDate}`,
        state: 'closed',
        startDate: iter.startDate,
        endDate,
      });
    }

    return sprints;
  }

  // ── Project field helpers ──────────────────────────────────────────────

  private _projectFields: any[] | null = null;

  /** Get all fields from the project (cached) */
  private async _getProjectFields(projectId: string): Promise<any[]> {
    if (this._projectFields) { return this._projectFields; }
    const data = await this.graphql<any>(`
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            fields(first: 50) {
              nodes {
                ... on ProjectV2Field { id name dataType }
                ... on ProjectV2SingleSelectField { id name dataType options { id name } }
                ... on ProjectV2IterationField {
                  id name dataType
                  configuration {
                    iterations { id title startDate duration }
                    completedIterations { id title startDate duration }
                  }
                }
              }
            }
          }
        }
      }
    `, { projectId });
    this._projectFields = data?.node?.fields?.nodes ?? [];
    return this._projectFields!;
  }

  /** Set ALL project fields on a project item — Status, Size, Estimate, Type, Priority, Iteration, dates */
  async _setProjectFields(projectId: string, itemId: string, input: {
    status?: string;
    type?: string;
    rawTypeName?: string;
    storyPoints?: number;
    priority?: string;
    labels?: string[];
    startDate?: string;
    endDate?: string;
    sprintId?: string;
  }): Promise<void> {
    try {
      const fields = await this._getProjectFields(projectId);

      // Map story points to t-shirt size
      const pointsToSize: Record<number, string> = {
        1: 'XS', 2: 'S', 3: 'M', 5: 'L', 8: 'XL', 13: 'XXL'
      };

      for (const field of fields) {
        if (!field?.id) { continue; }
        const name = (field.name ?? '').toLowerCase();
        const dataType = field.dataType;

        try {
          // ── SingleSelect fields ────────────────────────────────────────
          if (dataType === 'SINGLE_SELECT' && field.options?.length) {
            let targetOptionName: string | undefined;

            if (name === 'status' && input.status) {
              targetOptionName = input.status;
            } else if (name === 'type') {
              targetOptionName = input.rawTypeName ?? input.type;
            } else if (name === 'priority' && input.priority) {
              targetOptionName = input.priority;
            } else if (name === 'size' && input.storyPoints) {
              // Map points to t-shirt size (S/M/L/XL)
              targetOptionName = pointsToSize[input.storyPoints] ?? String(input.storyPoints);
            }

            if (targetOptionName) {
              // Exact match first, then case-insensitive, then partial
              const opt = field.options.find((o: any) => o.name === targetOptionName)
                ?? field.options.find((o: any) => o.name.toLowerCase() === targetOptionName!.toLowerCase())
                ?? field.options.find((o: any) =>
                  o.name.toLowerCase().includes(targetOptionName!.toLowerCase()) ||
                  targetOptionName!.toLowerCase().includes(o.name.toLowerCase())
                );
              if (opt) {
                await this.graphql(`
                  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
                    updateProjectV2ItemFieldValue(input: {
                      projectId: $projectId, itemId: $itemId,
                      fieldId: $fieldId,
                      value: { singleSelectOptionId: $optionId }
                    }) { projectV2Item { id } }
                  }
                `, { projectId, itemId, fieldId: field.id, optionId: opt.id });
              }
            }
          }

          // ── Number fields (Estimate, Story Points) ─────────────────────
          else if (dataType === 'NUMBER' && input.storyPoints) {
            if (name === 'estimate' || name === 'story points' || name === 'points' || name === 'effort') {
              await this.graphql(`
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Float!) {
                  updateProjectV2ItemFieldValue(input: {
                    projectId: $projectId, itemId: $itemId,
                    fieldId: $fieldId,
                    value: { number: $value }
                  }) { projectV2Item { id } }
                }
              `, { projectId, itemId, fieldId: field.id, value: input.storyPoints });
            }
          }

          // ── Iteration fields (Sprint) ──────────────────────────────────
          else if (field.configuration?.iterations && input.sprintId) {
            const allIters = [
              ...(field.configuration.iterations ?? []),
              ...(field.configuration.completedIterations ?? [])
            ];
            const iter = allIters.find((i: any) => i.id === input.sprintId);
            if (iter) {
              await this.graphql(`
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
                  updateProjectV2ItemFieldValue(input: {
                    projectId: $projectId, itemId: $itemId,
                    fieldId: $fieldId,
                    value: { iterationId: $iterationId }
                  }) { projectV2Item { id } }
                }
              `, { projectId, itemId, fieldId: field.id, iterationId: iter.id });
            }
          }

          // ── Date fields ────────────────────────────────────────────────
          else if (dataType === 'DATE') {
            let dateValue: string | undefined;
            if ((name === 'start date' || name === 'start' || name === 'startdate') && input.startDate) {
              dateValue = input.startDate;
            } else if ((name === 'end date' || name === 'due date' || name === 'target date' || name === 'end' || name === 'due' || name === 'enddate') && input.endDate) {
              dateValue = input.endDate;
            }
            if (dateValue) {
              await this.graphql(`
                mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: Date!) {
                  updateProjectV2ItemFieldValue(input: {
                    projectId: $projectId, itemId: $itemId,
                    fieldId: $fieldId,
                    value: { date: $value }
                  }) { projectV2Item { id } }
                }
              `, { projectId, itemId, fieldId: field.id, value: dateValue });
            }
          }
        } catch { /* individual field setting is best-effort */ }
      }
    } catch { /* field setting is best-effort */ }
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  async getProjects(): Promise<Project[]> {
    try {
      const data = await this.graphql<any>(`
        query($owner: String!) {
          organization(login: $owner) {
            projectsV2(first: 50) {
              nodes { id number title }
            }
          }
        }
      `, { owner: this.owner });
      const nodes = data?.organization?.projectsV2?.nodes ?? [];
      return nodes.map((p: any) => ({
        id: String(p.number),
        key: String(p.number),
        name: p.title,
      }));
    } catch {
      // Try user projects
      try {
        const data = await this.graphql<any>(`
          query($owner: String!) {
            user(login: $owner) {
              projectsV2(first: 50) {
                nodes { id number title }
              }
            }
          }
        `, { owner: this.owner });
        const nodes = data?.user?.projectsV2?.nodes ?? [];
        return nodes.map((p: any) => ({
          id: String(p.number),
          key: String(p.number),
          name: p.title,
        }));
      } catch { return []; }
    }
  }

  // ── Work item types (labels) ─────────────────────────────────────────────

  async getWorkItemTypes(): Promise<string[]> {
    // 1. Try org issue-types REST API (new GitHub feature)
    try {
      const data = await this.rest<any[]>(`/orgs/${this.owner}/issue-types`);
      if (data?.length) {
        return data.filter((t: any) => t.is_enabled !== false).map((t: any) => t.name);
      }
    } catch { /* org may not have issue types enabled, or no permission */ }

    // 2. Check if the project has a "Type" single-select field
    if (this.projectNumber) {
      try {
        const projectId = await this.getProjectId();
        const fields = await this._getProjectFields(projectId);
        const typeField = fields.find((f: any) =>
          f?.name?.toLowerCase() === 'type' && f?.options?.length
        );
        if (typeField) {
          return typeField.options.map((o: any) => o.name);
        }
      } catch { /* fall through */ }
    }

    // 3. Fallback: standard types
    return ['Epic', 'Story', 'Task', 'Bug', 'Feature'];
  }

  // ── Project status field options (Projects v2 custom statuses) ──────────

  async getProjectStatuses(): Promise<string[]> {
    if (!this.projectNumber) { return ['Open', 'Closed']; }
    try {
      const projectId = await this.getProjectId();
      const fields = await this._getProjectFields(projectId);
      const statusField = fields.find((f: any) =>
        f?.name?.toLowerCase() === 'status' && f?.options?.length
      );
      if (statusField) {
        return statusField.options.map((o: any) => o.name);
      }
    } catch { /* fall through */ }
    return ['Open', 'Closed'];
  }

  /** Get all project custom fields with their options — used by Configure Platform and create flow */
  async getProjectFieldOptions(): Promise<Array<{ name: string; type: string; options?: string[] }>> {
    if (!this.projectNumber) { return []; }
    try {
      const projectId = await this.getProjectId();
      const fields = await this._getProjectFields(projectId);
      return fields
        .filter((f: any) => f?.name && f?.dataType)
        .map((f: any) => ({
          name: f.name,
          type: f.dataType,
          options: f.options?.map((o: any) => o.name) ?? undefined,
        }));
    } catch { return []; }
  }

  // ── Mapping ──────────────────────────────────────────────────────────────

  private mapIssue(issue: any): WorkItem {
    const labels = (issue.labels ?? []).map((l: any) => typeof l === 'string' ? l : l.name);
    const type = this.labelsToType(labels);
    const rawTypeName = labels.find((l: string) =>
      ['bug', 'enhancement', 'feature', 'epic', 'task', 'story'].includes(l.toLowerCase())
    ) ?? type;

    return {
      id: String(issue.number),
      key: `#${issue.number}`,
      title: issue.title ?? '(no title)',
      description: stripHtml(issue.body ?? ''),
      type,
      rawTypeName,
      status: issue.state === 'closed' ? 'Closed' : 'Open',
      priority: labels.find((l: string) => l.startsWith('priority:'))?.replace('priority:', '') ?? undefined,
      assignee: issue.assignee ? {
        id: issue.assignee.login,
        displayName: issue.assignee.login,
        email: issue.assignee.email,
      } : undefined,
      reporter: issue.user ? {
        id: issue.user.login,
        displayName: issue.user.login,
      } : undefined,
      labels,
      sprint: issue.milestone?.title,
      url: issue.html_url ?? `https://github.com/${this.owner}/${this.repo}/issues/${issue.number}`,
      platform: 'github',
      projectKey: `${this.owner}/${this.repo}`,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    };
  }

  private labelsToType(labels: string[]): WorkItemType {
    const lower = labels.map(l => l.toLowerCase());
    if (lower.includes('bug')) { return 'bug'; }
    if (lower.includes('epic')) { return 'epic'; }
    if (lower.includes('enhancement') || lower.includes('feature')) { return 'story'; }
    if (lower.includes('story')) { return 'story'; }
    return 'task';
  }

  private typeToLabel(type: string): string | null {
    const t = type.toLowerCase();
    if (t === 'bug') { return 'Bug'; }
    if (t === 'story' || t === 'enhancement' || t === 'feature') { return 'Feature'; }
    if (t === 'epic') { return 'Epic'; }
    if (t === 'task') { return 'Task'; }
    return null;
  }

  /** Best-effort mapping from GitHub types to a target platform's types */
  getDefaultTypeMappings(targetTypes: string[]): Record<string, string> {
    const find = (names: string[]) => {
      for (const n of names) {
        const match = targetTypes.find(t => t.toLowerCase() === n.toLowerCase());
        if (match) { return match; }
      }
      return undefined;
    };
    const map: Record<string, string> = {};
    const ghCanonical: Record<string, string[]> = {
      'Epic':        ['Epic'],
      'Feature':     ['Feature', 'User Story', 'Story'],
      'Task':        ['Task'],
      'Bug':         ['Bug'],
      'Story':       ['Story', 'User Story', 'Feature'],
      'enhancement': ['Feature', 'Story', 'User Story'],
      'bug':         ['Bug'],
    };
    for (const [ghType, candidates] of Object.entries(ghCanonical)) {
      const match = find(candidates);
      if (match) { map[ghType] = match; }
    }
    return map;
  }
}
