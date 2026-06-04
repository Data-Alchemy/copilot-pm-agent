// test/tools.test.ts
// Verifies the Language Model Tools surface: registration + headless,
// structured JSON behavior (no UI prompts) — i.e. callable by other agents.
import * as vscode from 'vscode';
import { registerLanguageModelTools } from '../src/tools';
import { createMockContext } from './__mocks__/vscode';

// A CredentialManager-shaped stub
function fakeCredMgr(configured: boolean): any {
  return {
    isConfigured: jest.fn(() => Promise.resolve(configured)),
    getCredentials: jest.fn(() => Promise.resolve({ platform: 'jira', jiraBaseUrl: 'https://x.atlassian.net', jiraEmail: 'a@b.c', jiraToken: 't', jiraProject: 'ENG' })),
  };
}

// Make createProvider return a controllable fake by mocking the factory
jest.mock('../src/providers/providerFactory', () => ({
  createProvider: jest.fn(() => (global as any).__fakeProvider),
}));

afterEach(() => {
  (vscode as any)._lmRegistry?.clear?.();
  jest.clearAllMocks();
});

describe('registerLanguageModelTools', () => {
  it('registers all pm_* tools', () => {
    const disposables = registerLanguageModelTools(fakeCredMgr(true));
    expect(disposables.length).toBeGreaterThanOrEqual(10);
    const names = (vscode as any).lm.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'pm_listWorkItems', 'pm_getWorkItem', 'pm_createWorkItem',
      'pm_updateWorkItem', 'pm_transitionWorkItem', 'pm_addComment',
      'pm_listProjectMembers', 'pm_getSprints', 'pm_listProjects', 'pm_getWorkItemTypes'
    ]));
  });

  it('returns a structured "not configured" error instead of throwing', async () => {
    registerLanguageModelTools(fakeCredMgr(false));
    const res = await (vscode as any).lm.invokeTool('pm_listWorkItems', { input: {} });
    const payload = JSON.parse(res.content[0].value);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/not configured/i);
  });

  it('pm_listWorkItems returns slimmed items + paging info (no UI prompts)', async () => {
    (global as any).__fakeProvider = {
      searchWorkItemsPage: jest.fn(async () => ({
        items: [{ key: 'ENG-1', title: 'Fix', type: 'bug', status: 'To Do', url: 'u', assignee: { displayName: 'Jo', id: '42' } }],
        nextCursor: 'tok2', isLast: false,
      })),
    };
    registerLanguageModelTools(fakeCredMgr(true));
    const res = await (vscode as any).lm.invokeTool('pm_listWorkItems', { input: { status: 'open' } });
    const payload = JSON.parse(res.content[0].value);
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.items[0]).toMatchObject({ key: 'ENG-1', assignee: 'Jo', assigneeId: '42' });
    expect(payload.nextCursor).toBe('tok2');
    expect(payload.isLast).toBe(false);
    // No modal prompt was used
    expect((vscode as any).window.showQuickPick).not.toHaveBeenCalled();
    expect((vscode as any).window.showInputBox).not.toHaveBeenCalled();
  });

  it('pm_createWorkItem surfaces missing-required-fields structurally', async () => {
    const { MissingFieldsError } = require('../src/providers/jiraProvider');
    (global as any).__fakeProvider = {
      createWorkItem: jest.fn(async () => { throw new MissingFieldsError({ customfield_1: 'Team is required.' }, 'ENG', 'Story'); }),
    };
    registerLanguageModelTools(fakeCredMgr(true));
    const res = await (vscode as any).lm.invokeTool('pm_createWorkItem', { input: { type: 'story', title: 'X' } });
    const payload = JSON.parse(res.content[0].value);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('missing_required_fields');
    expect(payload.requiredFields).toHaveProperty('customfield_1');
    expect(payload.projectKey).toBe('ENG');
  });
});
