// src/types.ts
export type Platform = 'jira' | 'azuredevops';
export type WorkItemType = 'story' | 'task' | 'bug' | 'epic' | 'subtask' | 'feature' | 'testcase';

export interface WorkItem {
  id:           string;
  key:          string;
  title:        string;
  description?:        string;
  acceptanceCriteria?: string;  // ADO: AcceptanceCriteria field
  type:         WorkItemType;
  rawTypeName?: string;   // exact platform type name e.g. "User Story", "Task"
  status:       string;
  priority?:    string;
  assignee?:    User;
  reporter?:    User;
  storyPoints?: number;
  effort?:      number;
  labels?:      string[];
  sprint?:      string;
  url:          string;
  platform:     Platform;
  projectKey:   string;
  createdAt?:   string;
  updatedAt?:   string;
  comments?:    Comment[];
}

export interface Comment {
  id:          string;
  author:      string;
  body:        string;
  createdAt:   string;
}

export interface User {
  id:           string;
  displayName:  string;
  email?:       string;
  avatarUrl?:   string;
}

export interface Sprint {
  id:         string;
  name:       string;
  state:      'active' | 'closed' | 'future';
  startDate?: string;
  endDate?:   string;
}

export interface Project {
  id:   string;
  key:  string;
  name: string;
}

export interface CreateWorkItemInput {
  type:         WorkItemType;
  rawTypeName?: string;        // exact platform type name, bypasses typeMap
  title:        string;
  description?:        string;
  acceptanceCriteria?: string;  // ADO: AcceptanceCriteria field
  assigneeId?:  string;
  storyPoints?: number;
  priority?:    string;
  labels?:      string[];
  sprintId?:    string;
  parentId?:    string;        // parent work item key or ID
}

export interface UpdateWorkItemInput {
  title?:       string;
  description?:        string;
  acceptanceCriteria?: string;  // ADO: AcceptanceCriteria field
  assigneeId?:  string | null;
  storyPoints?: number;
  effort?:      number;
  priority?:    string;
  status?:      string;
  labels?:      string[];
}

export interface WorkItemQuery {
  projectKey?:  string;
  assigneeId?:  string;   // '@me' = current user
  status?:      string;   // 'open' = not closed; or exact state name
  type?:        WorkItemType;
  sprintId?:    string;
  text?:        string;
  maxResults?:  number;
}

export interface ApiCredentials {
  platform:      Platform;
  jiraBaseUrl?:  string;
  jiraEmail?:    string;
  jiraToken?:    string;
  jiraProject?:  string;
  adoOrgUrl?:    string;
  adoProject?:   string;
  adoToken?:     string;
}

export interface AgentToolResult {
  success: boolean;
  data?:   unknown;
  error?:  string;
}
