// src/extension.ts
import * as vscode from 'vscode';
import { CredentialManager } from './utils/credentialManager';
import { PmAgent, buildFollowups } from './agent';
import { WorkItemPanel } from './panels/workItemPanel';
import { CommandRunner } from './commandRunner';
import { ChatPanel } from './panels/chatPanel';
import { SidebarViewProvider } from './panels/sidebarViewProvider';
import { WorkItem } from './types';

export function activate(context: vscode.ExtensionContext): void {
  const credMgr = new CredentialManager(context.secrets, context);
  const agent   = new PmAgent(credMgr, context);
  const runner  = new CommandRunner(credMgr, context);

  // ── 1. Sidebar WebviewView ────────────────────────────────────────────────
  // Resolves "pm-agent.workItemView" (type: webview) declared in package.json.
  // Without this, VS Code creates the webview iframe with no provider, which
  // causes: "Failed to register a ServiceWorker: The document is in an invalid state"
  const sidebarProvider = new SidebarViewProvider(context, credMgr, runner);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarViewProvider.viewType,
      sidebarProvider,
    )
  );

  // ── 2. Webview panel serializers ──────────────────────────────────────────
  // When retainContextWhenHidden is true AND a user closes VS Code with a
  // panel open, VS Code tries to restore that panel on next startup.  If no
  // serializer is registered for the viewType it creates a blank webview frame
  // whose internal service-worker registration fails.
  //
  // We register serializers that either restore the panel properly or dispose
  // it to prevent the error.
  try {
    vscode.window.registerWebviewPanelSerializer(ChatPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        ChatPanel.restore(panel, context, credMgr, runner);
      }
    });
  } catch { /* serializer already registered or API unavailable */ }

  try {
    vscode.window.registerWebviewPanelSerializer('pmAgentSetup', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose(); // setup wizard should not restore across sessions
      }
    });
  } catch { /* ignore */ }

  try {
    vscode.window.registerWebviewPanelSerializer('pmAgentWorkItem', {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        panel.dispose(); // work-item panel should not restore stale data
      }
    });
  } catch { /* ignore */ }

  // ── 3. Chat Participant (optional — requires GitHub Copilot) ──────────────
  try {
    if (typeof vscode.chat?.createChatParticipant === 'function') {
      const participant = vscode.chat.createChatParticipant(
        'pm-agent.main',
        (request, chatCtx, stream, token) =>
          agent.handleRequest(request, chatCtx, stream, token)
      );
      participant.iconPath = vscode.Uri.joinPath(
        context.extensionUri, 'media', 'pm-agent-icon.svg'
      );
      participant.followupProvider = {
        provideFollowups: (result, ctx, token) =>
          buildFollowups(result, ctx, token)
      };
      context.subscriptions.push(participant);
    }
  } catch {
    // Chat API unavailable — command-palette mode still works
  }

  // ── 4. Command Palette commands ───────────────────────────────────────────
  const reg = (id: string, fn: () => Promise<void>) =>
    vscode.commands.registerCommand(id, () =>
      fn().catch(e =>
        vscode.window.showErrorMessage(
          `PM Agent: ${e instanceof Error ? e.message : String(e)}`
        )
      )
    );

  context.subscriptions.push(
    reg('pm-agent.configurePlatform', () => credMgr.runSetupWizard().then(() => {})),
    reg('pm-agent.configureAi',       () => credMgr.runAiSetupWizard().then(() => {})),
    reg('pm-agent.setDefaultUser',    () => runner.setUser()),

    vscode.commands.registerCommand('pm-agent.openWorkItemPanel', (item?: WorkItem) => {
      try {
        if (item) {
          WorkItemPanel.createOrShow(context, item);
        } else {
          const last = context.workspaceState.get<WorkItem>('lastItem');
          if (last) { WorkItemPanel.createOrShow(context, last); }
          else {
            vscode.window.showInformationMessage(
              'No work item open. Use PM Agent: Open Work Item first.'
            );
          }
        }
      } catch { /* WebView not available */ }
    }),

    reg('pm-agent.list',     () => runner.list()),
    reg('pm-agent.open',     () => runner.open()),
    reg('pm-agent.comment',  () => runner.comment()),
    reg('pm-agent.status',   () => runner.status()),
    reg('pm-agent.assign',   () => runner.assign()),
    reg('pm-agent.estimate', () => runner.estimate()),
    reg('pm-agent.move',     () => runner.move()),
    reg('pm-agent.sprint',   () => runner.sprint()),
    reg('pm-agent.debug',    () => runner.debug()),
    reg('pm-agent.create',   () => runner.create()),
    reg('pm-agent.parent',   () => runner.parent()),
    reg('pm-agent.migrate', async () => {
      await runner.migrate();
      const result = runner.lastMigrateResult;
      if (result) {
        const ch = vscode.window.createOutputChannel('PM Agent — Migration');
        ch.clear();
        // Strip markdown formatting for the output channel
        ch.appendLine(result.replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
        ch.show(true);
      }
    }),

    reg('pm-agent.openChat', async () => {
      try { ChatPanel.createOrShow(context, credMgr, runner); }
      catch { /* WebView not available in this environment */ }
    }),
  );

  // ── 5. Status bar shortcut ────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left, 0
  );
  statusBar.text    = '$(comment-discussion) PM Agent';
  statusBar.tooltip = 'PM Agent — click to open chat';
  statusBar.command = 'pm-agent.openChat';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── 6. First-install welcome ──────────────────────────────────────────────
  if (!context.globalState.get<boolean>('welcomeShown')) {
    void context.globalState.update('welcomeShown', true);

    // Reveal sidebar so user sees the setup panel
    try {
      void vscode.commands.executeCommand('pm-agent.workItemView.focus');
    } catch { /* sidebar might not be visible */ }

    void (async () => {
      const choice = await vscode.window.showInformationMessage(
        'PM Agent installed! Connect Jira or Azure DevOps to get started.',
        'Configure Platform', 'Open Chat', 'Later'
      );
      if (choice === 'Configure Platform') {
        await credMgr.runSetupWizard();
      }
      if (choice === 'Open Chat') {
        ChatPanel.createOrShow(context, credMgr, runner);
      }
    })();
  }
}

export function deactivate(): void { /* nothing to clean up */ }
