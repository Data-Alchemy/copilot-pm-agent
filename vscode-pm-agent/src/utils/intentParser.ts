// src/utils/intentParser.ts
import { WorkItemType, WorkItemQuery, CreateWorkItemInput, UpdateWorkItemInput } from '../types';

export type IntentKind =
  | 'list' | 'open' | 'create' | 'comment' | 'status'
  | 'attach' | 'summary' | 'estimate' | 'assign'
  | 'members' | 'sprint' | 'debug' | 'setuser' | 'setupai' | 'parent' | 'move' | 'migrate' | 'unknown';

export interface ParsedIntent {
  kind:           IntentKind;
  workItemKey?:   string;
  query?:         WorkItemQuery;
  create?:        Partial<CreateWorkItemInput>;
  update?:        UpdateWorkItemInput;
  assigneeHint?:  string;
  statusHint?:    string;
  estimateValue?: number;
  commentText?:   string;
  raw:            string;
}

const KEY_REGEX    = /(?:^|[\s,])#(\d+)|([A-Z][A-Z0-9_]+-\d+|AB#\d+)/i;

/** Extract work item key from text — handles #NNN, ENG-42, AB#123 */
function extractKey(text: string): string | undefined {
  const m = KEY_REGEX.exec(text);
  if (!m) { return undefined; }
  // Group 1 = #NNN (ADO new format), group 2 = classic format
  const raw = m[1] ? `#${m[1]}` : m[2];
  return raw ?? undefined;
}
const POINTS_REGEX = /(\d+(?:\.\d+)?)\s*(?:sp|story\s*points?|points?|pts?|hours?|hrs?)/i;

const TYPE_MAP: Record<WorkItemType, string[]> = {
  story:    ['story', 'user story', 'stories'],
  task:     ['task', 'tasks'],
  bug:      ['bug', 'bugs', 'defect', 'defects', 'issue'],
  epic:     ['epic', 'epics'],
  subtask:  ['subtask', 'sub-task'],
  feature:  ['feature', 'features'],
  testcase: ['test case', 'test cases']
};

export function parseIntent(command: string | undefined, text: string): ParsedIntent {
  const lower = text.toLowerCase().trim();
  const raw   = text;

  // Slash commands are definitive
  if (command === 'list')     { return parseList(text, lower, raw); }
  if (command === 'open')     { return parseOpen(text, raw); }
  if (command === 'create')   { return parseCreate(text, lower, raw); }
  if (command === 'comment')  { return parseComment(text, lower, raw); }
  if (command === 'status')   { return parseStatus(text, lower, raw); }
  if (command === 'attach')   { return { kind: 'attach',  workItemKey: extractKey(text), raw }; }
  if (command === 'summary')  { return { kind: 'summary', workItemKey: extractKey(text), raw }; }
  if (command === 'estimate') { return parseEstimate(text, raw); }
  if (command === 'assign')   { return parseAssign(text, lower, raw); }
  if (command === 'members')  { return { kind: 'members', raw }; }
  if (command === 'sprint')   { return { kind: 'sprint',  raw }; }
  if (command === 'debug')    { return { kind: 'debug',   raw }; }
  if (command === 'setuser')  { return { kind: 'setuser', raw }; }
  if (command === 'setupai')  { return { kind: 'setupai',  raw }; }
  if (command === 'parent')   { return { kind: 'parent',   workItemKey: extractKey(text), raw }; }
  if (command === 'move')     { return { kind: 'move',     workItemKey: extractKey(text), raw }; }
  if (command === 'migrate')  { return { kind: 'migrate',   workItemKey: extractKey(text), raw }; }

  // Natural language — most specific first
  if (/\b(debug|diagnose|test connection|troubleshoot)\b/.test(lower)) { return { kind: 'debug', raw }; }
  if (/\b(set (default )?user|change user|switch user|who am i|my user|set me as)\b/.test(lower)) { return { kind: 'setuser', raw }; }
  if (/\b(setup? ai|configure ai|ai provider|ai key|ai token|enable ai)\b/.test(lower)) { return { kind: 'setupai', raw }; }

  // Sprint — before list/show so "show sprint" doesn't fall into list
  if (/\b(sprint|iteration)\b/.test(lower)) { return { kind: 'sprint', raw }; }

  // Members
  if (/\b(team members?|list members?|who.s on|show members?|the team)\b/.test(lower)) { return { kind: 'members', raw }; }

  // Comment
  if (/\b(comment|add comment|post comment|reply|note on)\b/.test(lower)) { return parseComment(text, lower, raw); }

  // Attachment
  if (/\b(attach|upload|add file|add attachment)\b/.test(lower)) {
    return { kind: 'attach', workItemKey: extractKey(text), raw };
  }

  // Summary
  if (/\b(summar(y|ise|ize)|overview|recap|brief(ing)?|report on)\b/.test(lower)) {
    return { kind: 'summary', workItemKey: extractKey(text), raw };
  }

  // Open specific item by key
  if (KEY_REGEX.test(text) && /\b(open|show|view|get|fetch|look up|details? of|info on)\b/.test(lower)) {
    return parseOpen(text, raw);
  }

  // List
  if (/\b(list|show all|get all|find all|backlog|all tasks|all bugs|all stories|all items|my tasks|my bugs|my stories|my items|assigned to me|what.s assigned|what is assigned)\b/.test(lower)) {
    return parseList(text, lower, raw);
  }
  // "show/get/find" + type word → list
  if (/\b(show|get|find)\b/.test(lower) && hasType(lower)) { return parseList(text, lower, raw); }

  // Create
  if (/\b(create|add|new|make|file|log|raise)\b/.test(lower)) { return parseCreate(text, lower, raw); }

  // Estimate
  if (/\b(estimate|set.*points?|story points?|effort)\b/.test(lower)) { return parseEstimate(text, raw); }

  // Parent
  if (/\b(parent|set parent|link parent|child of|belongs to|under)\b/.test(lower)) { return { kind: 'parent', workItemKey: extractKey(text), raw }; }

  // Move sprint/iteration
  if (/\b(move to sprint|move to iteration|change sprint|change iteration|move.*sprint|sprint.*move)\b/.test(lower)) { return { kind: 'move', workItemKey: extractKey(text), raw }; }

  // Migrate between platforms
  if (/\b(migrate|copy.*to (jira|ado|azure)|move.*to (jira|ado|azure))\b/.test(lower)) { return { kind: 'migrate', workItemKey: extractKey(text), raw }; }

  // Assign
  if (/\b(assign|reassign|give to|hand off)\b/.test(lower)) { return parseAssign(text, lower, raw); }

  // Status
  if (/\b(status|transition|move|change status|mark as|close|resolve|start working|complete|set.*status|done)\b/.test(lower)) {
    return parseStatus(text, lower, raw);
  }

  // Bare key → open
  if (KEY_REGEX.test(text)) { return parseOpen(text, raw); }

  return { kind: 'unknown', raw };
}

// ── Individual parsers ─────────────────────────────────────────────────────

function parseOpen(text: string, raw: string): ParsedIntent {
  return { kind: 'open', workItemKey: extractKey(text), raw };
}

function parseList(text: string, lower: string, raw: string): ParsedIntent {
  const query: WorkItemQuery = { maxResults: 25 };

  // Type
  for (const [type, kws] of Object.entries(TYPE_MAP)) {
    if (kws.some(kw => lower.includes(kw))) { query.type = type as WorkItemType; break; }
  }

  // Status
  if      (/\bin[ -]?progress\b|\bactive\b/.test(lower))         { query.status = 'Active'; }
  else if (/\bnew\b|\bto[ -]?do\b|\bnot started\b/.test(lower))  { query.status = 'New'; }
  else if (/\bdone\b|\bclosed\b/.test(lower))                     { query.status = 'Closed'; }
  else if (/\bresolved\b/.test(lower))                             { query.status = 'Resolved'; }
  else if (/\bblocked\b/.test(lower))                              { query.status = 'Blocked'; }
  else if (/\bopen\b/.test(lower))                                 { query.status = 'open'; }

  // "my" → assigned to current user
  if (/\b(my\b|mine\b|assigned to me|i'?m assigned)\b/.test(lower)) {
    query.assigneeId = '@me';
    if (query.status === 'open') { delete query.status; } // avoid double filter
  }

  // text search
  const sm = lower.match(/(?:about|containing?|titled?|with title|called)\s+"?([^"]+)"?/);
  if (sm) { query.text = sm[1].trim(); }

  return { kind: 'list', query, raw };
}

function parseCreate(text: string, lower: string, raw: string): ParsedIntent {
  const create: Partial<CreateWorkItemInput> = { type: 'task' };
  for (const [type, kws] of Object.entries(TYPE_MAP)) {
    if (kws.some(kw => lower.includes(kw))) { create.type = type as WorkItemType; break; }
  }
  const tm = text.match(/(?:called|titled?|named?)\s+"([^"]+)"/i)
    || text.match(/"([^"]+)"/)
    || text.match(/(?:create|add|new|make)\s+(?:a\s+)?(?:story|task|bug|epic|feature)?\s+(.+?)(?:\s+for|\s+in|\s*$)/i);
  if (tm) { create.title = tm[1].trim(); }
  const pm = text.match(POINTS_REGEX);
  if (pm) { create.storyPoints = parseFloat(pm[1]); }
  const prio = lower.match(/\b(critical|high|medium|low)\s+priority/);
  if (prio) { create.priority = prio[1][0].toUpperCase() + prio[1].slice(1); }
  return { kind: 'create', create, raw };
}

function parseComment(text: string, lower: string, raw: string): ParsedIntent {
  const key = extractKey(text);
  // Extract comment text after "saying/say/that/:" or quoted
  const cm = text.match(/(?:saying|say|that|:)\s+"?(.+)"?\s*$/i)
    || text.match(/"([^"]+)"/);
  return { kind: 'comment', workItemKey: key, commentText: cm?.[1]?.trim(), raw };
}

function parseEstimate(text: string, raw: string): ParsedIntent {
  const pm = POINTS_REGEX.exec(text);
  return { kind: 'estimate', workItemKey: extractKey(text), estimateValue: pm ? parseFloat(pm[1]) : undefined, raw };
}

function parseAssign(text: string, lower: string, raw: string): ParsedIntent {
  const tm = text.match(/\bto\s+([A-Z][a-z]+(?: [A-Z][a-z]+)*)/i)
    || lower.match(/\bassign(?:ed)?\s+(?:it\s+)?to\s+(.+?)(?:\s*$)/);
  return { kind: 'assign', workItemKey: extractKey(text), assigneeHint: tm?.[1]?.trim(), raw };
}

function parseStatus(text: string, lower: string, raw: string): ParsedIntent {
  const hints: Record<string, string> = {
    'in progress': 'Active', 'active': 'Active', 'start': 'Active',
    'done': 'Closed', 'close': 'Closed', 'complete': 'Closed',
    'resolve': 'Resolved', 'review': 'In Review',
    'block': 'Blocked', 'reopen': 'New', 'new': 'New'
  };
  let statusHint: string | undefined;
  for (const [p, s] of Object.entries(hints)) { if (lower.includes(p)) { statusHint = s; break; } }
  if (!statusHint) {
    const m = text.match(/(?:\bto\b|\bas\b)\s+"?([^"]+)"?\s*$/i);
    if (m) { statusHint = m[1].trim(); }
  }
  return { kind: 'status', workItemKey: extractKey(text), statusHint, raw };
}

function hasType(lower: string): boolean {
  return Object.values(TYPE_MAP).some(kws => kws.some(kw => lower.includes(kw)));
}
