// test/formatter.test.ts
import { formatWorkItem, formatWorkItemList, formatWorkloadSummary, formatUserList, formatSuccess, formatError } from '../src/utils/formatter';
import { WorkItem, User } from '../src/types';

const mockItem: WorkItem = {
  id: '1', key: 'ENG-42', title: 'Fix login bug', type: 'bug', status: 'In Progress',
  priority: 'High', platform: 'jira', projectKey: 'ENG', url: 'https://jira.example.com/ENG-42',
  assignee: { id: 'u1', displayName: 'Alice', email: 'alice@test.com' },
  reporter: { id: 'u2', displayName: 'Bob' },
  storyPoints: 5, sprint: 'Sprint 10', labels: ['frontend', 'urgent'],
  createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-03-20T00:00:00Z',
  description: '<p>Login button is broken on mobile</p>',
};

const mockAdoItem: WorkItem = {
  id: '100', key: '#100', title: 'Add dark mode', type: 'story', status: 'Active',
  platform: 'azuredevops', projectKey: 'MyProject', url: 'https://dev.azure.com/org/proj/_workitems/edit/100',
  effort: 8,
};

describe('formatter', () => {
  describe('formatWorkItem', () => {
    it('includes key and title as header', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('## [ENG-42]');
      expect(out).toContain('Fix login bug');
    });
    it('includes type, status, platform fields', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Bug');
      expect(out).toContain('In Progress');
      expect(out).toContain('Jira');
    });
    it('includes assignee with email', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Alice (alice@test.com)');
    });
    it('includes reporter', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Bob');
    });
    it('shows Story Points for Jira items', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Story Points');
      expect(out).toContain('5 pts');
    });
    it('shows Effort for ADO items', () => {
      const out = formatWorkItem(mockAdoItem);
      expect(out).toContain('Effort');
      expect(out).toContain('8 pts');
    });
    it('includes sprint, labels, dates', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Sprint 10');
      expect(out).toContain('frontend, urgent');
      expect(out).toContain('2026-01-15');
      expect(out).toContain('2026-03-20');
    });
    it('includes description', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('Description');
      expect(out).toContain('Login button is broken');
    });
    it('includes open in browser link', () => {
      const out = formatWorkItem(mockItem);
      expect(out).toContain('[Open in Jira]');
    });
    it('says Azure DevOps for ADO items', () => {
      const out = formatWorkItem(mockAdoItem);
      expect(out).toContain('Azure DevOps');
    });
    it('omits optional fields when absent', () => {
      const out = formatWorkItem(mockAdoItem);
      expect(out).not.toContain('Priority');
      expect(out).not.toContain('Assignee');
      expect(out).not.toContain('Labels');
    });
  });

  describe('formatWorkItemList', () => {
    it('returns no items message for empty list', () => {
      expect(formatWorkItemList([])).toContain('No work items found');
    });
    it('formats items with key, title, type, status', () => {
      const out = formatWorkItemList([mockItem]);
      expect(out).toContain('**ENG-42**');
      expect(out).toContain('Fix login bug');
      expect(out).toContain('Bug');
      expect(out).toContain('In Progress');
    });
    it('shows count in header', () => {
      const out = formatWorkItemList([mockItem, mockAdoItem]);
      expect(out).toContain('2 work items');
    });
    it('uses custom header when provided', () => {
      const out = formatWorkItemList([mockItem], 'My bugs');
      expect(out).toContain('**My bugs**');
    });
    it('includes points and assignee', () => {
      const out = formatWorkItemList([mockItem]);
      expect(out).toContain('5 pts');
      expect(out).toContain('Alice');
    });
  });

  describe('formatUserList', () => {
    it('returns no members message for empty list', () => {
      expect(formatUserList([])).toContain('No team members found');
    });
    it('formats users with names and emails', () => {
      const users: User[] = [
        { id: '1', displayName: 'Alice', email: 'alice@test.com' },
        { id: '2', displayName: 'Bob' },
      ];
      const out = formatUserList(users);
      expect(out).toContain('Alice');
      expect(out).toContain('alice@test.com');
      expect(out).toContain('Bob');
      expect(out).toContain('2');
    });
  });

  describe('formatSuccess / formatError', () => {
    it('formatSuccess wraps message', () => {
      expect(formatSuccess('saved')).toBe('**Done:** saved');
    });
    it('formatError wraps message', () => {
      expect(formatError('failed')).toBe('**Error:** failed');
    });
  });
});

describe('formatWorkItemList — status grouping', () => {
  const base = {
    id: '1', key: 'ENG-1', title: 'A', type: 'task' as const,
    url: 'u', platform: 'jira' as const, projectKey: 'ENG',
  };
  const mkItem = (key: string, status: string, assigneeName?: string) => ({
    ...base, key, title: key,
    status,
    assignee: assigneeName ? { id: assigneeName, displayName: assigneeName } : undefined,
  });

  it('groups items under ### status headers', () => {
    const items = [mkItem('ENG-1','Done'), mkItem('ENG-2','In Progress')];
    const out = formatWorkItemList(items);
    expect(out).toContain('### In Progress');
    expect(out).toContain('### Done');
    // In Progress should appear before Done
    expect(out.indexOf('In Progress')).toBeLessThan(out.indexOf('Done'));
  });

  it('sub-groups by user when multiple assignees present', () => {
    const items = [
      mkItem('ENG-1', 'In Progress', 'Alice'),
      mkItem('ENG-2', 'In Progress', 'Bob'),
    ];
    const out = formatWorkItemList(items);
    expect(out).toContain('**Alice**');
    expect(out).toContain('**Bob**');
    // ENG-1 appears under Alice heading, ENG-2 under Bob
    expect(out.indexOf('Alice')).toBeLessThan(out.indexOf('ENG-1'));
    expect(out.indexOf('Bob')).toBeLessThan(out.indexOf('ENG-2'));
  });
});

describe('formatWorkloadSummary', () => {
  const mkItem = (key: string, status: string, pts?: number) => ({
    id: key, key, title: key, type: 'task' as const,
    url: 'u', platform: 'jira' as const, projectKey: 'ENG',
    status,
    storyPoints: pts,
    updatedAt: new Date().toISOString(),
  });

  it('contains aggregate rollup table', () => {
    const out = formatWorkloadSummary([
      mkItem('ENG-1','In Progress',3),
      mkItem('ENG-2','Done',5),
    ], 'Alice');
    expect(out).toContain('Total items');
    expect(out).toContain('Story points');
    expect(out).toContain('8 pts');
    expect(out).toContain('## Alice');
  });

  it('flags stale items older than 14 days', () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const items = [{ ...mkItem('ENG-1','In Progress'), updatedAt: old }];
    const out = formatWorkloadSummary(items, 'Bob');
    expect(out).toContain('Stale');
  });
});
