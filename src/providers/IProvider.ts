// src/providers/IProvider.ts
// Standard interface that every provider must implement.
// Adding a new provider (e.g. Linear, Monday.com) only requires
// implementing this interface and registering it in providerFactory.ts.

import {
  WorkItem, WorkItemType, User, Sprint, Project, Comment,
  CreateWorkItemInput, UpdateWorkItemInput, WorkItemQuery,
  AgentToolResult
} from '../types';

export interface IProvider {
  // ── Core CRUD ──────────────────────────────────────────────────────────
  searchWorkItems(query: WorkItemQuery): Promise<WorkItem[]>;
  getWorkItem(keyOrId: string): Promise<WorkItem>;
  createWorkItem(input: CreateWorkItemInput & {
    acceptanceCriteria?: string;
    parentId?: string;
    customFields?: Record<string, unknown>;
  }): Promise<WorkItem>;
  updateWorkItem(keyOrId: string, input: UpdateWorkItemInput): Promise<WorkItem>;

  // ── Comments ───────────────────────────────────────────────────────────
  getComments(keyOrId: string): Promise<Comment[]>;
  addComment(keyOrId: string, text: string): Promise<Comment>;

  // ── Status ─────────────────────────────────────────────────────────────
  transitionWorkItem(keyOrId: string, status: string): Promise<AgentToolResult>;

  // ── Assignee ───────────────────────────────────────────────────────────
  setAssignee(keyOrId: string, userIdOrEmail: string): Promise<void>;

  // ── Hierarchy ──────────────────────────────────────────────────────────
  addParentLink(childKeyOrId: string, parentKeyOrId: string): Promise<void>;
  getChildItems(parentKeyOrId: string): Promise<WorkItem[]>;

  // ── Team / Members ─────────────────────────────────────────────────────
  getProjectMembers(projectKey?: string): Promise<User[]>;
  resolveUser?(emailOrName: string): Promise<User | null>;

  // ── Sprints / Iterations ───────────────────────────────────────────────
  getActiveSprint(projectKey?: string): Promise<Sprint | null>;
  getAllSprints(projectKey?: string): Promise<Sprint[]>;

  // ── Metadata ───────────────────────────────────────────────────────────
  getProjects(): Promise<Project[]>;
  getWorkItemTypes(): Promise<string[]>;

  // ── Optional — providers implement if supported ────────────────────────
  addAttachment?(keyOrId: string, fileName: string, fileContent: Buffer, mimeType: string): Promise<AgentToolResult>;
  getAvailableTransitions?(keyOrId: string): Promise<string[]>;
  getWorkItemStates?(typeName: string): Promise<string[]>;
  getProjectStatuses?(): Promise<string[]>;
  getProjectFieldOptions?(): Promise<Array<{ name: string; type: string; options?: string[] }>>;
  getCreateFields?(projectKey: string): Promise<any[]>;
  getPriorities?(): Promise<string[]>;
  getLabels?(): Promise<string[]>;
  getStoryPointsField?(): Promise<string | null>;
}
