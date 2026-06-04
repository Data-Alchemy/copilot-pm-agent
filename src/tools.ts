// src/tools.ts
// ──────────────────────────────────────────────────────────────────────────
// Language Model Tools surface.
//
// These wrap the same provider layer the chat participant uses, but with a
// HEADLESS, parameter-driven contract: every input arrives as structured JSON
// and every result is returned as structured JSON. There are NO modal prompts
// (showQuickPick / showInputBox), so the tools can be invoked:
//   1. By GitHub Copilot's agent mode (it picks + chains them via the model).
//   2. By ANY other VS Code extension via `vscode.lm.invokeTool(name, ...)`.
//   3. By our own chat participant when it wants to act agentically.
//
// This is what makes PM Agent "an agent other agents can call": each tool is a
// self-describing, composable capability rather than a UI command.
// ──────────────────────────────────────────────────────────────────────────

import * as vscode from 'vscode';
import { CredentialManager } from './utils/credentialManager';
import { createProvider } from './providers/providerFactory';
import { IProvider } from './providers/IProvider';
import { WorkItem, WorkItemType, WorkItemQuery } from './types';
import { MissingFieldsError } from './providers/jiraProvider';

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Compact, model-friendly projection of a work item (keeps tokens small). */
function slim(wi: WorkItem) {
  return {
    key:         wi.key,
    title:       wi.title,
    type:        wi.type,
    status:      wi.status,
    assignee:    wi.assignee?.displayName,
    assigneeId:  wi.assignee?.id,
    priority:    wi.priority,
    storyPoints: wi.storyPoints,
    sprint:      wi.sprint,
    labels:      wi.labels,
    url:         wi.url,
    projectKey:  wi.projectKey,
    updatedAt:   wi.updatedAt,
  };
}

/** Wrap any payload as a LanguageModelToolResult containing JSON text. */
function jsonResult(payload: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2))
  ]);
}

/** Standard error payload — tools never throw across the boundary. */
function errResult(message: string): vscode.LanguageModelToolResult {
  return jsonResult({ ok: false, error: message });
}

/**
 * Base class wiring the common lifecycle: resolve credentials → build provider →
 * run. Subclasses implement `run`. Credential/`not configured` errors are
 * returned as structured data, never thrown, so a calling agent can react.
 */
abstract class PmTool<TInput> implements vscode.LanguageModelTool<TInput> {
  constructor(protected readonly credMgr: CredentialManager) {}

  abstract run(
    provider: IProvider,
    input: TInput,
    token: vscode.CancellationToken
  ): Promise<unknown>;

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TInput>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    try {
      if (!(await this.credMgr.isConfigured())) {
        return errResult(
          'PM Agent is not configured. The user must run "PM Agent: Configure Platform" ' +
          'to connect Jira, Azure DevOps, or GitHub before this tool can be used.'
        );
      }
      const provider = createProvider(await this.credMgr.getCredentials());
      const data = await this.run(provider, options.input, token);
      return jsonResult(data);
    } catch (e: unknown) {
      if (e instanceof MissingFieldsError) {
        // Surface required-field info so the calling agent can re-invoke with them
        return jsonResult({
          ok: false,
          error: 'missing_required_fields',
          message: e.message,
          projectKey: e.projectKey,
          issueType: e.issueType,
          requiredFields: e.fieldErrors,
          hint: 'Re-invoke pmCreateWorkItem with these keys supplied in customFields.'
        });
      }
      return errResult(e instanceof Error ? e.message : String(e));
    }
  }
}

// ── Tool: list / search work items ───────────────────────────────────────────

interface ListInput {
  assigneeId?: string;   // accountId/email, or "@me"
  status?:     string;   // "open" or an exact status name
  type?:       WorkItemType;
  text?:       string;   // free-text search
  projectKey?: string;
  sprintId?:   string;
  maxResults?: number;
  pageCursor?: string;   // for paging
}

class ListWorkItemsTool extends PmTool<ListInput> {
  async run(provider: IProvider, input: ListInput): Promise<unknown> {
    const query: WorkItemQuery = {
      assigneeId: input.assigneeId,
      status:     input.status,
      type:       input.type,
      text:       input.text,
      projectKey: input.projectKey,
      sprintId:   input.sprintId,
      maxResults: input.maxResults ?? 50,
      pageCursor: input.pageCursor,
    };
    // Prefer the paged API so agents can walk large result sets deterministically
    if (typeof provider.searchWorkItemsPage === 'function') {
      const page = await provider.searchWorkItemsPage(query);
      return {
        ok: true,
        count: page.items.length,
        items: page.items.map(slim),
        nextCursor: page.nextCursor,
        isLast: page.isLast,
      };
    }
    const items = await provider.searchWorkItems(query);
    return { ok: true, count: items.length, items: items.map(slim), isLast: true };
  }
}

// ── Tool: get a single work item (with comments + children) ──────────────────

interface GetInput { key: string; includeComments?: boolean; includeChildren?: boolean; }

class GetWorkItemTool extends PmTool<GetInput> {
  async run(provider: IProvider, input: GetInput): Promise<unknown> {
    if (!input.key) { return { ok: false, error: 'key is required' }; }
    const wi = await provider.getWorkItem(input.key);
    const out: Record<string, unknown> = { ok: true, item: slim(wi), description: wi.description };
    if (input.includeComments) {
      try { out.comments = (await provider.getComments(input.key)).map(c => ({ author: c.author, body: c.body, createdAt: c.createdAt })); }
      catch { out.comments = []; }
    }
    if (input.includeChildren && typeof provider.getChildItems === 'function') {
      try { out.children = (await provider.getChildItems(input.key)).map(slim); }
      catch { out.children = []; }
    }
    return out;
  }
}

// ── Tool: create a work item ─────────────────────────────────────────────────

interface CreateInput {
  type: WorkItemType;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  assigneeId?: string;
  storyPoints?: number;
  priority?: string;
  labels?: string[];
  sprintId?: string;
  parentId?: string;
  projectKey?: string;
  rawTypeName?: string;
  customFields?: Record<string, unknown>;
}

class CreateWorkItemTool extends PmTool<CreateInput> {
  async run(provider: IProvider, input: CreateInput): Promise<unknown> {
    if (!input.title || !input.type) { return { ok: false, error: 'type and title are required' }; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const created = await (provider as any).createWorkItem(input);
    return { ok: true, item: slim(created), url: created.url };
  }
}

// ── Tool: update a work item ─────────────────────────────────────────────────

interface UpdateInput {
  key: string;
  title?: string;
  description?: string;
  storyPoints?: number;
  priority?: string;
  labels?: string[];
  status?: string;        // triggers a transition
  assigneeId?: string;    // triggers assignment
}

class UpdateWorkItemTool extends PmTool<UpdateInput> {
  async run(provider: IProvider, input: UpdateInput): Promise<unknown> {
    if (!input.key) { return { ok: false, error: 'key is required' }; }
    const { key, assigneeId, ...fields } = input;
    const updated = await provider.updateWorkItem(key, fields);
    if (assigneeId !== undefined && typeof provider.setAssignee === 'function') {
      try { await provider.setAssignee(key, assigneeId); } catch { /* report below via re-fetch */ }
    }
    const fresh = await provider.getWorkItem(key);
    return { ok: true, item: slim(fresh) };
  }
}

// ── Tool: transition status ──────────────────────────────────────────────────

interface StatusInput { key: string; status: string; }

class TransitionTool extends PmTool<StatusInput> {
  async run(provider: IProvider, input: StatusInput): Promise<unknown> {
    if (!input.key || !input.status) { return { ok: false, error: 'key and status are required' }; }
    const res = await provider.transitionWorkItem(input.key, input.status);
    if (!res.success) {
      return { ok: false, error: res.error };
    }
    const fresh = await provider.getWorkItem(input.key);
    return { ok: true, item: slim(fresh) };
  }
}

// ── Tool: add a comment ──────────────────────────────────────────────────────

interface CommentInput { key: string; body: string; }

class CommentTool extends PmTool<CommentInput> {
  async run(provider: IProvider, input: CommentInput): Promise<unknown> {
    if (!input.key || !input.body) { return { ok: false, error: 'key and body are required' }; }
    const c = await provider.addComment(input.key, input.body);
    return { ok: true, comment: { author: c.author, body: c.body, createdAt: c.createdAt } };
  }
}

// ── Tool: list project members ───────────────────────────────────────────────

interface MembersInput { projectKey?: string; }

class MembersTool extends PmTool<MembersInput> {
  async run(provider: IProvider, input: MembersInput): Promise<unknown> {
    const members = await provider.getProjectMembers(input.projectKey);
    return { ok: true, count: members.length, members: members.map(m => ({ id: m.id, displayName: m.displayName, email: m.email })) };
  }
}

// ── Tool: sprints ────────────────────────────────────────────────────────────

interface SprintInput { projectKey?: string; all?: boolean; }

class SprintsTool extends PmTool<SprintInput> {
  async run(provider: IProvider, input: SprintInput): Promise<unknown> {
    if (input.all && typeof provider.getAllSprints === 'function') {
      const sprints = await provider.getAllSprints(input.projectKey);
      return { ok: true, sprints };
    }
    const active = typeof provider.getActiveSprint === 'function'
      ? await provider.getActiveSprint(input.projectKey) : null;
    return { ok: true, activeSprint: active };
  }
}

// ── Tool: list projects / discover types (capability discovery) ──────────────

class ProjectsTool extends PmTool<Record<string, never>> {
  async run(provider: IProvider): Promise<unknown> {
    const projects = typeof provider.getProjects === 'function' ? await provider.getProjects() : [];
    return { ok: true, projects };
  }
}

interface TypesInput { projectKey?: string; }
class WorkItemTypesTool extends PmTool<TypesInput> {
  async run(provider: IProvider): Promise<unknown> {
    const types = typeof provider.getWorkItemTypes === 'function' ? await provider.getWorkItemTypes() : [];
    return { ok: true, types };
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register every PM Agent tool with the Language Model Tools API.
 * Safe no-op on older VS Code where `vscode.lm.registerTool` is unavailable.
 * Returns the disposables so the caller can push them to subscriptions.
 */
export function registerLanguageModelTools(
  credMgr: CredentialManager
): vscode.Disposable[] {
  // Guard: the API exists only on VS Code >= 1.95 with the LM tools proposal shipped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lm: any = vscode.lm;
  if (!lm || typeof lm.registerTool !== 'function') {
    return [];
  }

  const tools: Array<[string, vscode.LanguageModelTool<unknown>]> = [
    ['pm_listWorkItems',   new ListWorkItemsTool(credMgr)   as vscode.LanguageModelTool<unknown>],
    ['pm_getWorkItem',     new GetWorkItemTool(credMgr)     as vscode.LanguageModelTool<unknown>],
    ['pm_createWorkItem',  new CreateWorkItemTool(credMgr)  as vscode.LanguageModelTool<unknown>],
    ['pm_updateWorkItem',  new UpdateWorkItemTool(credMgr)  as vscode.LanguageModelTool<unknown>],
    ['pm_transitionWorkItem', new TransitionTool(credMgr)   as vscode.LanguageModelTool<unknown>],
    ['pm_addComment',      new CommentTool(credMgr)         as vscode.LanguageModelTool<unknown>],
    ['pm_listProjectMembers', new MembersTool(credMgr)      as vscode.LanguageModelTool<unknown>],
    ['pm_getSprints',      new SprintsTool(credMgr)         as vscode.LanguageModelTool<unknown>],
    ['pm_listProjects',    new ProjectsTool(credMgr)        as vscode.LanguageModelTool<unknown>],
    ['pm_getWorkItemTypes', new WorkItemTypesTool(credMgr)  as vscode.LanguageModelTool<unknown>],
  ];

  return tools.map(([name, tool]) => lm.registerTool(name, tool));
}
