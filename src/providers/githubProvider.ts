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

  private async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await globalThis.fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
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

    const max = Math.min(query.maxResults ?? 30, 100);
    const q = parts.join(' ');
    const data = await this.rest<{ items?: any[] }>(
      `/search/issues?q=${encodeURIComponent(q)}&per_page=${max}&sort=updated&order=desc`
    );

    return (data.items ?? []).map((i: any) => this.mapIssue(i));
  }

  /** Load items directly from GitHub Projects v2 board with their project-specific status */
  private async _searchFromProject(query: WorkItemQuery): Promise<WorkItem[]> {
    const projectId = await this.getProjectId();
    const max = query.maxResults ?? 100;
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

        // Extract project-specific status from field values
        let projectStatus = content.state === 'CLOSED' ? 'Closed' : 'Open';
        for (const fv of (node.fieldValues?.nodes ?? [])) {
          if (fv?.field?.name?.toLowerCase() === 'status' && fv?.name) {
            projectStatus = fv.name;
            break;
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

    // Map type to label
    const labels: string[] = [...(input.labels ?? [])];
    const typeLabel = this.typeToLabel(input.rawTypeName ?? input.type);
    if (typeLabel) { labels.push(typeLabel); }
    if (input.priority) { labels.push(`priority:${input.priority.toLowerCase()}`); }

    const issueBody: any = {
      title: input.title,
      body,
      assignees: input.assigneeId ? [input.assigneeId] : undefined,
    };

    let issue: any;
    // Try with labels first; if that fails (no label permission), retry without
    if (labels.length) {
      try {
        issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
          method: 'POST',
          body: JSON.stringify({ ...issueBody, labels }),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('403') || msg.includes('label') || msg.includes('422')) {
          // Retry without labels
          issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
            method: 'POST',
            body: JSON.stringify(issueBody),
          });
        } else {
          throw e;
        }
      }
    } else {
      issue = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues`, {
        method: 'POST',
        body: JSON.stringify(issueBody),
      });
    }

    const item = this.mapIssue(issue);

    // Add to GitHub Project if configured
    if (this.projectNumber) {
      try {
        const projectId = await this.getProjectId();
        await this.graphql(`
          mutation($projectId: ID!, $contentId: ID!) {
            addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
              item { id }
            }
          }
        `, { projectId, contentId: issue.node_id });
      } catch { /* project add is best-effort */ }
    }

    // Parent linking via task list (add reference in parent body)
    if (input.parentId) {
      try {
        const parentNum = String(input.parentId).replace(/^#/, '');
        await this.addComment(parentNum, `Child issue: #${issue.number} — ${input.title}`);
      } catch { /* best effort */ }
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
    // GitHub doesn't have native parent/child — use sub-issue if available, otherwise comment
    try {
      // Try the sub-issues API (GitHub Projects beta)
      await this.rest(`/repos/${this.owner}/${this.repo}/issues/${parent}/sub_issues`, {
        method: 'POST',
        body: JSON.stringify({ sub_issue_id: Number(child) }),
      });
    } catch {
      // Fallback: add a comment referencing the parent
      await this.addComment(child, `Parent: #${parent}`);
    }
  }

  async getChildItems(parentNumber: string): Promise<WorkItem[]> {
    const num = String(parentNumber).replace(/^#/, '');
    // Try sub-issues API first
    try {
      const data = await this.rest<any>(`/repos/${this.owner}/${this.repo}/issues/${num}/sub_issues?per_page=50`);
      if (Array.isArray(data) && data.length) {
        return data.map((i: any) => this.mapIssue(i));
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
    // Try project-specific members via GraphQL (assignees from project items)
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
                        assignees(first: 10) {
                          nodes { login avatarUrl email: databaseId }
                        }
                      }
                      ... on PullRequest {
                        assignees(first: 10) {
                          nodes { login avatarUrl }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        `, { projectId });
        const seen = new Set<string>();
        const users: User[] = [];
        const items = data?.node?.items?.nodes ?? [];
        for (const item of items) {
          const assignees = item?.content?.assignees?.nodes ?? [];
          for (const a of assignees) {
            if (a?.login && !seen.has(a.login)) {
              seen.add(a.login);
              users.push({ id: a.login, displayName: a.login, email: undefined });
            }
          }
        }
        if (users.length) { return users; }
      } catch { /* fall through */ }
    }

    // Fallback: repo collaborators
    try {
      const data = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/collaborators?per_page=100`);
      return (data ?? []).map((u: any) => ({
        id: u.login,
        displayName: u.login,
        email: u.email ?? undefined,
      }));
    } catch {
      // Fallback: org members
      try {
        const data = await this.rest<any[]>(`/orgs/${this.owner}/members?per_page=100`);
        return (data ?? []).map((u: any) => ({
          id: u.login,
          displayName: u.login,
        }));
      } catch { return []; }
    }
  }

  // ── Sprints (milestones) ─────────────────────────────────────────────────

  async getActiveSprint(): Promise<Sprint | null> {
    try {
      const data = await this.rest<any[]>(
        `/repos/${this.owner}/${this.repo}/milestones?state=open&sort=due_on&direction=asc&per_page=1`
      );
      if (!data?.length) { return null; }
      const m = data[0];
      return {
        id: String(m.number),
        name: m.title,
        state: 'active',
        startDate: m.created_at,
        endDate: m.due_on,
      };
    } catch { return null; }
  }

  async getAllSprints(): Promise<Sprint[]> {
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
    // Try to get labels actually used in the project
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
                        labels(first: 20) { nodes { name } }
                      }
                    }
                  }
                }
              }
            }
          }
        `, { projectId });
        const seen = new Set<string>();
        const items = data?.node?.items?.nodes ?? [];
        for (const item of items) {
          const labels = item?.content?.labels?.nodes ?? [];
          for (const l of labels) {
            if (l?.name) { seen.add(l.name); }
          }
        }
        if (seen.size) { return [...seen].sort(); }
      } catch { /* fall through */ }
    }

    // Fallback: repo labels
    try {
      const data = await this.rest<any[]>(`/repos/${this.owner}/${this.repo}/labels?per_page=100`);
      return (data ?? []).map((l: any) => String(l.name));
    } catch {
      return ['bug', 'enhancement', 'task', 'epic', 'question', 'documentation'];
    }
  }

  // ── Project status field options (Projects v2 custom statuses) ──────────

  async getProjectStatuses(): Promise<string[]> {
    if (!this.projectNumber) { return ['Open', 'Closed']; }
    try {
      const projectId = await this.getProjectId();
      const data = await this.graphql<any>(`
        query($projectId: ID!) {
          node(id: $projectId) {
            ... on ProjectV2 {
              fields(first: 50) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `, { projectId });
      const fields = data?.node?.fields?.nodes ?? [];
      const statusField = fields.find((f: any) =>
        f?.name?.toLowerCase() === 'status' && f?.options?.length
      );
      if (statusField) {
        return statusField.options.map((o: any) => o.name);
      }
    } catch { /* fall through */ }
    return ['Open', 'Closed'];
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
    if (t === 'bug') { return 'bug'; }
    if (t === 'story' || t === 'enhancement' || t === 'feature') { return 'enhancement'; }
    if (t === 'epic') { return 'epic'; }
    return null;
  }
}
