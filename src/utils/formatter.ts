// src/utils/formatter.ts
import { WorkItem, User } from '../types';
import { cap } from './strings';

// ── Labels ────────────────────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  story:    'Story',
  task:     'Task',
  bug:      'Bug',
  epic:     'Epic',
  subtask:  'Sub-task',
  feature:  'Feature',
  testcase: 'Test Case',
};

function platformLabel(p: string): string {
  if (p === 'jira')   { return 'Jira'; }
  if (p === 'github') { return 'GitHub'; }
  return 'Azure DevOps';
}

function fmtUser(u: User): string {
  return u.email ? `${u.displayName} (${u.email})` : u.displayName;
}

// ── Status ordering ───────────────────────────────────────────────────────────
// In-progress statuses sort to the top so the most actionable work is visible.

const STATUS_ORDER = [
  'in progress', 'in review', 'active', 'in development',
  'to do', 'open', 'new', 'backlog',
  'blocked', 'on hold',
  'done', 'closed', 'resolved', 'won\'t fix', 'duplicate',
];

function statusRank(status: string): number {
  const lower = status.toLowerCase();
  const i = STATUS_ORDER.findIndex(s => lower.includes(s));
  return i === -1 ? STATUS_ORDER.length : i;
}

function sortStatuses(statuses: string[]): string[] {
  return [...statuses].sort((a, b) => statusRank(a) - statusRank(b));
}

// ── Group helpers ─────────────────────────────────────────────────────────────

/** Group items by a string key, preserving insertion order within groups. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) { bucket.push(item); } else { map.set(k, [item]); }
  }
  return map;
}

// ── Single item ────────────────────────────────────────────────────────────────

export function formatWorkItem(item: WorkItem): string {
  const pts       = item.storyPoints ?? item.effort;
  const typeLabel = TYPE_LABEL[item.type] ?? cap(item.type);
  const pLabel    = platformLabel(item.platform);
  const sprint    = item.sprint?.split('\\').pop() ?? item.sprint;

  const lines: string[] = [
    `## [${item.key}](${item.url}) ${item.title}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Type | ${typeLabel} |`,
    `| Status | ${item.status} |`,
    `| Platform | ${pLabel} |`,
  ];

  if (item.priority)       { lines.push(`| Priority | ${item.priority} |`); }
  if (item.assignee)       { lines.push(`| Assignee | ${fmtUser(item.assignee)} |`); }
  if (item.reporter)       { lines.push(`| Reporter | ${fmtUser(item.reporter)} |`); }
  if (pts !== undefined)   { lines.push(`| ${item.platform === 'jira' ? 'Story Points' : 'Effort'} | ${pts} pts |`); }
  if (sprint)              { lines.push(`| Sprint | ${sprint} |`); }
  if (item.labels?.length) { lines.push(`| Labels | ${item.labels.join(', ')} |`); }
  if (item.startDate)      { lines.push(`| Start Date | ${item.startDate.slice(0, 10)} |`); }
  if (item.endDate)        { lines.push(`| End Date | ${item.endDate.slice(0, 10)} |`); }
  if (item.createdAt)      { lines.push(`| Created | ${item.createdAt.slice(0, 10)} |`); }
  if (item.updatedAt)      { lines.push(`| Updated | ${item.updatedAt.slice(0, 10)} |`); }

  lines.push('');

  if (item.description) {
    lines.push('**Description**', '', item.description.slice(0, 500), '');
  }

  lines.push(`[Open in ${pLabel}](${item.url})`);
  return lines.join('\n');
}

// ── Work item list — grouped by status ────────────────────────────────────────

/**
 * Render a list of work items grouped by status.
 * When items span multiple assignees they are also sub-grouped by user.
 * Status groups are sorted: in-progress first, done last.
 */
export function formatWorkItemList(items: WorkItem[], headerLine?: string): string {
  if (!items.length) { return '_No work items found._'; }

  const header = headerLine ?? `${items.length} work item${items.length !== 1 ? 's' : ''}`;
  const lines: string[] = [`**${header}**`];

  // Determine if items belong to more than one assignee
  const assigneeIds = new Set(items.map(i => i.assignee?.id ?? '__unassigned__'));
  const multiUser   = assigneeIds.size > 1;

  // Group by status (sorted), then optionally by user within each status
  const byStatus  = groupBy(items, i => i.status);
  const statuses  = sortStatuses([...byStatus.keys()]);

  for (const status of statuses) {
    const bucket = byStatus.get(status)!;
    lines.push('');
    lines.push(`### ${status} (${bucket.length})`);

    if (multiUser) {
      // Sub-group by assignee within the status bucket
      const byUser = groupBy(bucket, i => i.assignee?.displayName ?? 'Unassigned');
      for (const [user, userItems] of byUser) {
        lines.push('');
        lines.push(`**${user}**`);
        for (const item of userItems) {
          lines.push(formatItemLine(item, false)); // assignee is already the group header
        }
      }
    } else {
      for (const item of bucket) {
        lines.push(formatItemLine(item));
      }
    }
  }

  return lines.join('\n');
}

/**
 * Render a compact single-line summary for one work item inside a list.
 */
function formatItemLine(item: WorkItem, showAssignee = true): string {
  const typeLabel = TYPE_LABEL[item.type] ?? cap(item.type);
  const pts       = item.storyPoints ?? item.effort;
  const sprint    = item.sprint?.split('\\').pop() ?? item.sprint;
  const meta: string[] = [typeLabel];
  if (pts !== undefined) { meta.push(`${pts} pts`); }
  if (sprint)            { meta.push(sprint); }
  if (item.priority && item.priority.toLowerCase() !== 'medium') {
    meta.push(item.priority);
  }
  if (showAssignee && item.assignee?.displayName) {
    meta.push(item.assignee.displayName);
  }
  return `- [**${item.key}**](${item.url}) ${item.title} — ${meta.join(' · ')}`;
}

// ── Workload summary — grouped aggregate ──────────────────────────────────────

export interface WorkloadSummary {
  userName:       string;
  items:          WorkItem[];
  /** Markdown string ready to stream */
  markdown:       string;
}

/**
 * Build a full workload summary grouped by status, with aggregate counts,
 * story-point totals per status group, and a top-level rollup.
 */
export function formatWorkloadSummary(items: WorkItem[], userName: string): string {
  if (!items.length) {
    return `_No items found for **${userName}**._`;
  }

  const totalPts     = items.reduce((s, i) => s + (i.storyPoints ?? i.effort ?? 0), 0);
  const byType       = groupBy(items, i => TYPE_LABEL[i.type] ?? cap(i.type));
  const byStatus     = groupBy(items, i => i.status);
  const statuses     = sortStatuses([...byStatus.keys()]);

  // Classify statuses into buckets for the aggregate bar
  const inProgress   = items.filter(i => statusRank(i.status) < statusRank('to do') + 2 && statusRank(i.status) < statusRank('done'));
  const blocked      = items.filter(i => i.status.toLowerCase().includes('block'));
  const done         = items.filter(i => statusRank(i.status) >= statusRank('done'));
  const unestimated  = items.filter(i => (i.storyPoints ?? i.effort) === undefined);
  const unassigned   = items.filter(i => !i.assignee);
  const stale        = items.filter(i => {
    if (!i.updatedAt) { return false; }
    const days = Math.floor((Date.now() - new Date(i.updatedAt).getTime()) / 86_400_000);
    return days > 14 && statusRank(i.status) < statusRank('done');
  });

  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push(`## ${userName} — Work Summary`);
  lines.push('');

  // ── Aggregate rollup table ────────────────────────────────────────────────
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Total items | **${items.length}** |`);
  lines.push(`| Story points | **${totalPts > 0 ? totalPts + ' pts' : 'none estimated'}** |`);

  // Type breakdown on one row
  const typeBreakdown = [...byType.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([type, its]) => `${its.length} ${type}${its.length !== 1 ? 's' : ''}`)
    .join(', ');
  lines.push(`| Types | ${typeBreakdown} |`);

  // Status breakdown
  const statusBreakdown = statuses
    .map(s => `${byStatus.get(s)!.length} ${s}`)
    .join(', ');
  lines.push(`| Statuses | ${statusBreakdown} |`);

  if (inProgress.length)  { lines.push(`| In progress | ${inProgress.length} item${inProgress.length !== 1 ? 's' : ''}${inProgress.reduce((s, i) => s + (i.storyPoints ?? i.effort ?? 0), 0) > 0 ? ` (${inProgress.reduce((s, i) => s + (i.storyPoints ?? i.effort ?? 0), 0)} pts)` : ''} |`); }
  if (blocked.length)     { lines.push(`| Blocked | **${blocked.length}** — needs attention |`); }
  if (stale.length)       { lines.push(`| Stale (14+ days) | ${stale.length} open item${stale.length !== 1 ? 's' : ''} not updated |`); }
  if (unestimated.length) { lines.push(`| No estimate | ${unestimated.length} item${unestimated.length !== 1 ? 's' : ''} |`); }
  if (unassigned.length)  { lines.push(`| Unassigned | ${unassigned.length} item${unassigned.length !== 1 ? 's' : ''} |`); }

  lines.push('');

  // ── Per-status groups ─────────────────────────────────────────────────────
  for (const status of statuses) {
    const bucket    = byStatus.get(status)!;
    const bucketPts = bucket.reduce((s, i) => s + (i.storyPoints ?? i.effort ?? 0), 0);
    const ptsStr    = bucketPts > 0 ? ` · ${bucketPts} pts` : '';

    lines.push(`### ${status} (${bucket.length}${ptsStr})`);
    lines.push('');

    for (const item of bucket) {
      lines.push(formatItemLine(item));
    }
    lines.push('');
  }

  // ── Action items ──────────────────────────────────────────────────────────
  const actions: string[] = [];
  if (blocked.length)     { actions.push(`${blocked.length} blocked item${blocked.length !== 1 ? 's' : ''} need attention`); }
  if (stale.length)       { actions.push(`${stale.length} item${stale.length !== 1 ? 's' : ''} not updated in 14+ days`); }
  if (unestimated.length) { actions.push(`${unestimated.length} item${unestimated.length !== 1 ? 's' : ''} have no story point estimate`); }

  if (actions.length) {
    lines.push('---');
    lines.push('');
    lines.push('**Action items:**');
    for (const a of actions) { lines.push(`- ${a}`); }
    lines.push('');
  }

  return lines.join('\n');
}

// ── User list ─────────────────────────────────────────────────────────────────

export function formatUserList(users: User[]): string {
  if (!users.length) { return '_No team members found._'; }
  const lines = [`**Team Members** (${users.length})\n`];
  for (const u of users) {
    const email = u.email ? ` — ${u.email}` : '';
    lines.push(`- **${u.displayName}**${email}`);
  }
  return lines.join('\n');
}

// ── Feedback helpers ──────────────────────────────────────────────────────────

export function formatSuccess(message: string): string { return `**Done:** ${message}`; }
export function formatError(message: string):   string { return `**Error:** ${message}`; }
