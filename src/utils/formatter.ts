// src/utils/formatter.ts
// Plain text only — no emoji, no codicons (codicons don't render in chat markdown)
import { WorkItem, User } from '../types';
import { cap } from './strings';

const TYPE_LABEL: Record<string, string> = {
  story:    'Story',
  task:     'Task',
  bug:      'Bug',
  epic:     'Epic',
  subtask:  'Sub-task',
  feature:  'Feature',
  testcase: 'Test Case'
};

export function formatWorkItem(item: WorkItem): string {
  const pts          = item.storyPoints ?? item.effort;
  const typeLabel    = TYPE_LABEL[item.type] ?? cap(item.type);
  const platformLabel = item.platform === 'jira' ? 'Jira' : 'Azure DevOps';
  const sprintName   = item.sprint?.split('\\').pop() ?? item.sprint;

  const lines: string[] = [
    `## [${item.key}](${item.url}) ${item.title}`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| Type | ${typeLabel} |`,
    `| Status | ${item.status} |`,
    `| Platform | ${platformLabel} |`,
  ];

  if (item.priority)           { lines.push(`| Priority | ${item.priority} |`); }
  if (item.assignee)           { lines.push(`| Assignee | ${fmtUser(item.assignee)} |`); }
  if (item.reporter)           { lines.push(`| Reporter | ${fmtUser(item.reporter)} |`); }
  if (pts !== undefined)       { lines.push(`| ${item.platform === 'jira' ? 'Story Points' : 'Effort'} | ${pts} pts |`); }
  if (sprintName)              { lines.push(`| Sprint | ${sprintName} |`); }
  if (item.labels?.length)     { lines.push(`| Labels | ${item.labels.join(', ')} |`); }
  if (item.createdAt)          { lines.push(`| Created | ${item.createdAt.slice(0, 10)} |`); }
  if (item.updatedAt)          { lines.push(`| Updated | ${item.updatedAt.slice(0, 10)} |`); }

  lines.push('');

  if (item.description) {
    lines.push('**Description**', '', item.description.slice(0, 500), '');
  }

  lines.push(`[Open in ${platformLabel}](${item.url})`);
  return lines.join('\n');
}

export function formatWorkItemList(items: WorkItem[], headerLine?: string): string {
  if (!items.length) { return '_No work items found._'; }

  const count  = items.length;
  const header = headerLine ?? `${count} work item${count !== 1 ? 's' : ''}`;
  const lines: string[] = [`**${header}**`, ''];

  for (const item of items) {
    const pts      = item.storyPoints ?? item.effort;
    const typeLabel = TYPE_LABEL[item.type] ?? cap(item.type);
    const ptsStr   = pts !== undefined ? ` · ${pts} pts` : '';
    const assignee = item.assignee ? ` · ${item.assignee.displayName}` : '';
    const sprint   = item.sprint
      ? ` · ${item.sprint.split('\\').pop() ?? item.sprint}`
      : '';

    lines.push(
      `- [**${item.key}**](${item.url}) ${item.title}` +
      ` — ${typeLabel} · \`${item.status}\`${ptsStr}${assignee}${sprint}`
    );
  }

  return lines.join('\n');
}

export function formatUserList(users: User[]): string {
  if (!users.length) { return '_No team members found._'; }
  const lines = [`**Team Members** (${users.length})\n`];
  for (const u of users) {
    const email = u.email ? ` — ${u.email}` : '';
    lines.push(`- **${u.displayName}**${email}`);
  }
  return lines.join('\n');
}

export function formatSuccess(message: string): string { return `**Done:** ${message}`; }
export function formatError(message: string):   string { return `**Error:** ${message}`; }

function fmtUser(u: User): string {
  return u.email ? `${u.displayName} (${u.email})` : u.displayName;
}

