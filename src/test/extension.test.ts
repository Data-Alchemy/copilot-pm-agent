// test/extension.test.ts
import * as vscode from 'vscode';
import { _registered, _reset, createMockContext } from './__mocks__/vscode';

// Must be imported AFTER mock is set up
import { activate, deactivate } from '../src/extension';

beforeEach(() => {
  _reset();
  jest.clearAllMocks();
});

describe('extension activation', () => {
  it('activates without errors', () => {
    const ctx = createMockContext();
    expect(() => activate(ctx)).not.toThrow();
  });

  it('registers the sidebar WebviewViewProvider', () => {
    const ctx = createMockContext();
    activate(ctx);
    expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
      'pm-agent.workItemView',
      expect.any(Object),
    );
    expect(_registered.viewProviders.has('pm-agent.workItemView')).toBe(true);
  });

  it('registers WebviewPanelSerializer for pmAgent.chat', () => {
    const ctx = createMockContext();
    activate(ctx);
    expect(_registered.serializers.has('pmAgent.chat')).toBe(true);
  });

  it('registers WebviewPanelSerializer for pmAgentSetup', () => {
    const ctx = createMockContext();
    activate(ctx);
    expect(_registered.serializers.has('pmAgentSetup')).toBe(true);
  });

  it('registers WebviewPanelSerializer for pmAgentWorkItem', () => {
    const ctx = createMockContext();
    activate(ctx);
    expect(_registered.serializers.has('pmAgentWorkItem')).toBe(true);
  });

  it('pmAgentSetup serializer disposes stale panels', async () => {
    const ctx = createMockContext();
    activate(ctx);
    const serializer = _registered.serializers.get('pmAgentSetup');
    const panel = { dispose: jest.fn() };
    await serializer.deserializeWebviewPanel(panel);
    expect(panel.dispose).toHaveBeenCalled();
  });

  it('pmAgentWorkItem serializer disposes stale panels', async () => {
    const ctx = createMockContext();
    activate(ctx);
    const serializer = _registered.serializers.get('pmAgentWorkItem');
    const panel = { dispose: jest.fn() };
    await serializer.deserializeWebviewPanel(panel);
    expect(panel.dispose).toHaveBeenCalled();
  });

  // ── Commands ────────────────────────────────────────────────────────────

  describe('command registration', () => {
    const expectedCommands = [
      'pm-agent.configurePlatform',
      'pm-agent.configureAi',
      'pm-agent.setDefaultUser',
      'pm-agent.openWorkItemPanel',
      'pm-agent.list',
      'pm-agent.open',
      'pm-agent.comment',
      'pm-agent.status',
      'pm-agent.assign',
      'pm-agent.estimate',
      'pm-agent.move',
      'pm-agent.sprint',
      'pm-agent.debug',
      'pm-agent.create',
      'pm-agent.parent',
      'pm-agent.migrate',
      'pm-agent.openChat',
    ];

    it('registers all expected commands', () => {
      const ctx = createMockContext();
      activate(ctx);
      for (const cmd of expectedCommands) {
        expect(_registered.commands.has(cmd)).toBe(true);
      }
    });

    it('registers exactly the right number of commands', () => {
      const ctx = createMockContext();
      activate(ctx);
      expect(_registered.commands.size).toBe(expectedCommands.length);
    });
  });

  // ── Status bar ──────────────────────────────────────────────────────────

  it('creates a status bar item', () => {
    const ctx = createMockContext();
    activate(ctx);
    expect(vscode.window.createStatusBarItem).toHaveBeenCalled();
    expect(_registered.statusBarItems.length).toBe(1);
    expect(_registered.statusBarItems[0].command).toBe('pm-agent.openChat');
    expect(_registered.statusBarItems[0].show).toHaveBeenCalled();
  });

  // ── Welcome flow ────────────────────────────────────────────────────────

  it('shows welcome message on first install', () => {
    const ctx = createMockContext({
      globalState: {
        get: jest.fn(() => undefined), // welcomeShown not set
        update: jest.fn(() => Promise.resolve()),
      },
    });
    activate(ctx);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'PM Agent installed! Connect Jira or Azure DevOps to get started.',
      'Configure Platform', 'Open Chat', 'Later'
    );
  });

  it('does NOT show welcome message when already shown', () => {
    const ctx = createMockContext({
      globalState: {
        get: jest.fn((key: string) => key === 'welcomeShown' ? true : undefined),
        update: jest.fn(() => Promise.resolve()),
      },
    });
    activate(ctx);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('sets welcomeShown to true after first display', () => {
    const updateFn = jest.fn(() => Promise.resolve());
    const ctx = createMockContext({
      globalState: { get: jest.fn(() => undefined), update: updateFn },
    });
    activate(ctx);
    expect(updateFn).toHaveBeenCalledWith('welcomeShown', true);
  });

  it('focuses sidebar on first install', () => {
    const ctx = createMockContext({
      globalState: { get: jest.fn(() => undefined), update: jest.fn(() => Promise.resolve()) },
    });
    activate(ctx);
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('pm-agent.workItemView.focus');
  });

  // ── Subscriptions ───────────────────────────────────────────────────────

  it('pushes disposables to context.subscriptions', () => {
    const ctx = createMockContext();
    activate(ctx);
    // sidebar provider + 17 commands + status bar = 19 minimum
    expect(ctx.subscriptions.length).toBeGreaterThanOrEqual(19);
  });

  // ── Copilot graceful degradation ────────────────────────────────────────

  it('activates without Copilot (chat API undefined)', () => {
    const ctx = createMockContext();
    // vscode.chat is undefined in our mock — should not throw
    expect(() => activate(ctx)).not.toThrow();
  });

  // ── Deactivate ──────────────────────────────────────────────────────────

  it('deactivate runs without error', () => {
    expect(() => deactivate()).not.toThrow();
  });
});
