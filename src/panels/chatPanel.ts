// src/panels/chatPanel.ts
// Standalone chat-like panel — works entirely via VS Code WebView API.
// Zero Copilot / GitHub dependency. Opens with Ctrl+Shift+P → "PM Agent: Open Chat"
// or via the status bar button.

import * as vscode from 'vscode';
import { CommandRunner } from '../commandRunner';
import { CredentialManager } from '../utils/credentialManager';
import { stripHtml } from '../utils/strings';
import { createProvider } from '../providers/providerFactory';
import { parseIntent } from '../utils/intentParser';
export class ChatPanel {
  static readonly viewType = 'pmAgent.chat';
  private static instance: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly credMgr: CredentialManager;
  private readonly runner: CommandRunner;
  private readonly ctx: vscode.ExtensionContext;

  static createOrShow(
    ctx: vscode.ExtensionContext,
    credMgr: CredentialManager,
    runner: CommandRunner
  ): ChatPanel {
    const col = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(col);
      return ChatPanel.instance;
    }

    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        ChatPanel.viewType,
        'PM Agent',
        col,
        {
          enableScripts:           true,
          retainContextWhenHidden: true,
          localResourceRoots:      [ctx.extensionUri]
        }
      );
    } catch (e: unknown) {
      vscode.window.showErrorMessage(
        'PM Agent: Could not open the chat panel in this environment. ' +
        'Use Ctrl+Shift+P → "PM Agent:" commands instead.'
      );
      return undefined as unknown as ChatPanel;
    }

    ChatPanel.instance = new ChatPanel(panel, ctx, credMgr, runner);
    return ChatPanel.instance;
  }

  /** Restore a panel that VS Code is trying to deserialize from a previous session */
  static restore(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    credMgr: CredentialManager,
    runner: CommandRunner
  ): void {
    if (ChatPanel.instance) {
      // Already have a live panel — dispose the stale one
      panel.dispose();
      return;
    }
    ChatPanel.instance = new ChatPanel(panel, ctx, credMgr, runner);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    ctx: vscode.ExtensionContext,
    credMgr: CredentialManager,
    runner: CommandRunner
  ) {
    this.panel   = panel;
    this.ctx     = ctx;
    this.credMgr = credMgr;
    this.runner  = runner;

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg),
      undefined,
      ctx.subscriptions
    );

    this.panel.onDidDispose(() => { ChatPanel.instance = undefined; this._disposed = true; }, null, ctx.subscriptions);

    // Send welcome message
    setTimeout(() => { if (!this._disposed) { this.send('bot', this.getWelcome()); } }, 200);
  }

  private _disposed = false;

  // ── Message routing ────────────────────────────────────────────────────────

  private async handleMessage(msg: { type: string; text?: string; command?: string; url?: string }) {
    if (msg.type === 'openUrl' && msg.url) {
      const url = String(msg.url);
      if (url.startsWith('https://') || url.startsWith('http://')) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
      return;
    }
    if (msg.type === 'userMessage' && msg.text?.trim()) {
      await this.processInput(msg.text.trim());
    }
    if (msg.type === 'chip' && msg.command) {
      if (msg.command === '__setup__') {
        await vscode.commands.executeCommand('pm-agent.configurePlatform');
        this.send('bot', 'Platform configuration complete. Type /list to verify your connection.');
      } else if (msg.command === '__ai__') {
        await vscode.commands.executeCommand('pm-agent.configureAi');
        this.send('bot', 'AI provider configured.');
      } else if (msg.command === '__user__') {
        await vscode.commands.executeCommand('pm-agent.setDefaultUser');
        this.send('bot', 'Default user updated. Type /list to see their items.');
      } else if (msg.command === '__create__') {
        this.sendTyping(false);
        await vscode.commands.executeCommand('pm-agent.create');
      } else {
        await this.processInput(msg.command);
      }
    }
  }

  private async processInput(raw: string) {
    this.send('user', raw);
    this.sendTyping(true);

    try {
      const configured = await this.credMgr.isConfigured();
      if (!configured) {
        this.sendTyping(false);
        this.send('bot',
          '**PM Agent — configuration required.**\n\nRun the setup wizard to connect Jira or Azure DevOps.',
          [{ label: 'Configure Platform', cmd: '__setup__' }]
        );
        return;
      }

      const creds    = await this.credMgr.getCredentials();
      const provider = createProvider(creds);
      const intent   = parseIntent(
        raw.startsWith('/') ? raw.slice(1).split(' ')[0] : undefined,
        raw.startsWith('/') ? raw.slice(raw.indexOf(' ') + 1) : raw
      );

      switch (intent.kind) {

        case 'list': {
          const du = await this.credMgr.getDefaultUser();
          const items = await provider.searchWorkItems({ assigneeId: du?.id ?? '@me', maxResults: 30 });
          if (!items.length) {
            this.send('bot', 'No work items found. Try `@pm /setuser` to set your default user.'); break;
          }
          const lines = items.slice(0, 20).map(wi =>
            `- **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\``
          ).join('\n');
          this.send('bot', `**${items.length} items assigned to you:**\n\n${lines}`);
          break;
        }

        case 'open': {
          if (!intent.workItemKey) {
            this.send('bot', 'Enter a key to open, e.g. `/open #1234` or `/open ENG-42`'); break;
          }
          const item = await provider.getWorkItem(intent.workItemKey);
          this.ctx.globalState.update('lastItem', item);
          const pts   = item.storyPoints ?? item.effort;
          const lines = [
            `## [${item.key}](${item.url}) ${item.title}`,
            `**Type:** ${item.type}   **Status:** \`${item.status}\``,
            item.assignee  ? `**Assignee:** ${item.assignee.displayName}` : '',
            pts            ? `**Points:** ${pts}` : '',
            item.sprint    ? `**Sprint:** ${item.sprint.split('\\').pop()}` : '',
            item.description ? `\n${stripHtml(item.description).slice(0, 400)}` : ''
          ].filter(Boolean).join('\n');
          this.send('bot', lines, [
            { label: 'Comment',  cmd: `/comment ${item.key}` },
            { label: 'Status',   cmd: `/status ${item.key}` },
            { label: 'Assign',   cmd: `/assign ${item.key}` },
          ]);
          break;
        }

        case 'sprint': {
          const sprints = await (provider as any).getAllSprints?.() ?? [];
          const active  = sprints.find((s: any) => s.state === 'active');
          if (!active) { this.send('bot', 'No active sprint found.'); break; }
          const du2   = await this.credMgr.getDefaultUser();
          const sitems = await provider.searchWorkItems({
            assigneeId: du2?.id ?? '@me',
            sprintId:   (creds.platform === 'azuredevops' ? (active as any).iterationPath : active.id),
            maxResults: 30
          }).catch(() => []);
          const lines2 = [
            `## Sprint: ${active.name}`,
            active.endDate ? `**Ends:** ${active.endDate.slice(0,10)}` : '',
            `**Your items:** ${sitems.length}`,
            '',
            ...sitems.slice(0, 15).map((wi: any) =>
              `• **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\``
            )
          ].filter(s => s !== undefined).join('\n');
          this.send('bot', lines2);
          break;
        }

        case 'status': {
          // Route to CommandRunner which handles the QuickPick UI
          this.sendTyping(false);
          await this.runner.status();
          this.send('bot', 'Status updated.');
          return;
        }

        case 'comment': {
          this.sendTyping(false);
          await this.runner.comment();
          this.send('bot', 'Comment posted.');
          return;
        }

        case 'assign': {
          this.sendTyping(false);
          await this.runner.assign();
          this.send('bot', 'Item assigned.');
          return;
        }

        case 'estimate': {
          this.sendTyping(false);
          await this.runner.estimate();
          this.send('bot', 'Story points updated.');
          return;
        }

        case 'move': {
          this.sendTyping(false);
          await this.runner.move();
          this.send('bot', 'Items moved.');
          return;
        }

        case 'debug': {
          this.sendTyping(false);
          await this.runner.debug();
          this.send('bot', 'Diagnostics written to PM Agent Debug output channel.');
          return;
        }

        case 'setuser': {
          this.sendTyping(false);
          // Open set user via VS Code command
          await vscode.commands.executeCommand('pm-agent.setDefaultUser');
          this.send('bot', 'Default user updated.');
          return;
        }

        case 'create': {
          this.sendTyping(false);
          await this.runner.create();
          this.send('bot', 'Done. Type /list to see your items.');
          return;
        }

        case 'migrate': {
          this.sendTyping(false);
          await this.runner.migrate();
          this.send('bot', this.runner.lastMigrateResult || 'Migration complete.');
          return;
        }

        case 'parent': {
          this.sendTyping(false);
          await this.runner.parent();
          this.send('bot', 'Parent link updated.');
          return;
        }

        case 'setupai': {
          this.sendTyping(false);
          await vscode.commands.executeCommand('pm-agent.configureAi');
          this.send('bot', 'AI provider configured.');
          return;
        }

        case 'unknown':
        default: {
          this.send('bot', this.getHelp());
          break;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.send('bot', `**Error:** ${msg.slice(0, 200)}`);
    }

    this.sendTyping(false);
  }

  // ── Post message helpers ───────────────────────────────────────────────────

  private send(role: 'user' | 'bot', text: string, chips?: Array<{ label: string; cmd: string }>) {
    if (this._disposed) { return; }
    this.panel.webview.postMessage({ type: 'message', role, text: this.mdToHtml(text), chips });
  }

  private sendTyping(on: boolean) {
    if (this._disposed) { return; }
    this.panel.webview.postMessage({ type: 'typing', on });
  }

  // ── Markdown → safe HTML ───────────────────────────────────────────────────

  private mdToHtml(md: string): string {
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^• (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>(\n|$))+/g, s => `<ul>${s}</ul>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^(.+)$/, '<p>$1</p>');
  }

  // ── Content ────────────────────────────────────────────────────────────────

  private getWelcome(): string {
    return [
      '**PM Agent** — manage your work items without leaving VS Code.',
      '',
      'Type a command or natural language. Quick starts:',
    ].join('\n');
  }

  private getHelp(): string {
    return [
      '**Available commands:**',
      '',
      '/list — your assigned tickets',
      '/open #1234 — open a work item',
      '/sprint — current sprint overview',
      '/status — change ticket status',
      '/comment — add a comment',
      '/assign — assign to a team member',
      '/estimate — set story points',
      '/move — move to a sprint',
      '/create — create a new ticket',
      '/migrate — copy tickets between Jira and ADO',
      '/parent — set parent work item',
      '/debug — test your connection',
      '/setuser — set your default user',
      '/setupai — configure AI provider',
    ].join('\n');
  }

  // ── Webview HTML ───────────────────────────────────────────────────────────

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PM Agent</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:var(--vscode-editor-background,#1e1e2e);
  --fg:var(--vscode-editor-foreground,#cdd6f4);
  --border:var(--vscode-panel-border,#313244);
  --input-bg:var(--vscode-input-background,#313244);
  --input-fg:var(--vscode-input-foreground,#cdd6f4);
  --btn:var(--vscode-button-background,#7c6af7);
  --btn-fg:var(--vscode-button-foreground,#fff);
  --bot-bg:var(--vscode-editorWidget-background,#24273a);
  --user-bg:var(--vscode-button-background,#7c6af7);
  --user-fg:var(--vscode-button-foreground,#fff);
  --accent:var(--vscode-focusBorder,#7c6af7);
  --chip-bg:var(--vscode-badge-background,#313244);
  --chip-fg:var(--vscode-badge-foreground,#cdd6f4);
  --section:var(--vscode-sideBar-background,#181825);
  --radius:6px;
  --font:var(--vscode-font-family,'Segoe UI',system-ui,sans-serif);
  --mono:var(--vscode-editor-font-family,'Consolas',monospace);
}
html,body{height:100%;background:var(--bg);color:var(--fg);font-family:var(--font);font-size:13px;line-height:1.5}
#app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── Configure bar ── */
#config-bar{
  background:var(--section);
  border-bottom:1px solid var(--border);
  padding:10px 14px;
  flex-shrink:0;
}
#config-bar summary{
  cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.04em;
  list-style:none;display:flex;align-items:center;gap:8px;
  color:var(--fg);opacity:.7;user-select:none;
}
#config-bar summary:hover{opacity:1}
#config-bar summary::before{content:'';display:inline-block;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:6px solid currentColor;transition:transform .15s}
details[open] summary::before{transform:rotate(90deg)}
.config-inner{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.cfg-btn{
  background:var(--input-bg);color:var(--fg);
  border:1px solid var(--border);border-radius:var(--radius);
  padding:5px 12px;font-size:12px;cursor:pointer;
  display:flex;align-items:center;gap:5px;
  transition:background .15s,border-color .15s;
}
.cfg-btn:hover{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.cfg-btn.primary{background:var(--btn);color:var(--btn-fg);border-color:var(--btn)}
.cfg-status{font-size:11px;opacity:.6;margin-top:6px;padding:0 2px}

/* ── Messages ── */
#messages{flex:1;overflow-y:auto;padding:14px 14px 6px;display:flex;flex-direction:column;gap:10px}
.msg{display:flex;gap:8px;max-width:100%}
.msg.user{flex-direction:row-reverse}
.bubble{max-width:82%;padding:8px 12px;border-radius:var(--radius);font-size:13px;line-height:1.6;word-break:break-word}
.msg.bot  .bubble{background:var(--bot-bg);border:1px solid var(--border);border-top-left-radius:2px}
.msg.user .bubble{background:var(--user-bg);color:var(--user-fg);border-top-right-radius:2px}
.bubble h3{font-size:13px;font-weight:600;margin-bottom:4px}
.bubble ul{padding-left:0;list-style:none}
.bubble li{padding:2px 0}
.bubble code{font-family:var(--mono);font-size:11px;background:rgba(255,255,255,.1);padding:1px 4px;border-radius:3px}
.bubble a{color:var(--accent);text-decoration:none}
.bubble a:hover{text-decoration:underline}
.bubble p:not(:last-child){margin-bottom:5px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.chip{background:var(--chip-bg);color:var(--chip-fg);border:1px solid var(--border);border-radius:10px;padding:3px 9px;font-size:11px;cursor:pointer;transition:all .15s}
.chip:hover{background:var(--accent);color:#fff;border-color:var(--accent)}

/* ── Typing ── */
#typing{display:none;padding:0 14px 4px;align-items:center;gap:4px}
#typing.show{display:flex}
.dot{width:5px;height:5px;border-radius:50%;background:var(--accent);animation:pulse 1.2s ease-in-out infinite}
.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,100%{opacity:.3;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}

/* ── Input bar ── */
#inputbar{border-top:1px solid var(--border);padding:8px 12px;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:var(--bg)}
#input{flex:1;background:var(--input-bg);color:var(--input-fg);border:1px solid var(--border);border-radius:var(--radius);padding:7px 10px;font-family:var(--font);font-size:13px;resize:none;min-height:34px;max-height:120px;outline:none;line-height:1.4}
#input:focus{border-color:var(--accent)}
#input::placeholder{opacity:.45}
#send{background:var(--btn);color:var(--btn-fg);border:none;border-radius:var(--radius);padding:7px 13px;cursor:pointer;font-size:15px;height:34px;display:flex;align-items:center;transition:opacity .15s}
#send:hover{opacity:.85}
#messages::-webkit-scrollbar{width:5px}
#messages::-webkit-scrollbar-track{background:transparent}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<div id="app">

  <!-- ── Configure bar (top) ── -->
  <details id="config-bar">
    <summary><span class="codicon codicon-settings-gear"></span> Configuration &amp; Setup</summary>
    <div class="config-inner">
      <button class="cfg-btn primary" onclick="send_cmd('__setup__')">Configure Platform</button>
      <button class="cfg-btn" onclick="send_cmd('__ai__')">Configure AI</button>
      <button class="cfg-btn" onclick="send_cmd('__user__')">Set Default User</button>
      <button class="cfg-btn" onclick="send_cmd('/debug')">Test Connection</button>
    </div>
    <div class="config-status" id="cfg-status"></div>
  </details>

  <!-- ── Chat messages ── -->
  <div id="messages"></div>

  <div id="typing">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
  </div>

  <!-- ── Input bar (bottom) ── -->
  <div id="inputbar">
    <textarea id="input" rows="1" placeholder="Type a command: /list  /status  /open #1234  /sprint"></textarea>
    <button id="send" title="Send (Enter)"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1l13 7-13 7V9.5l9-1.5-9-1.5V1z"/></svg></button>
  </div>
</div>

<script>
` + this.getScript() + `
</script>
</body>
</html>`;
  }

  /** Webview client-side JavaScript — built with single-quote strings to avoid
   *  backtick escaping issues inside the outer template literal. */
  private getScript(): string {
    // Use String.fromCharCode(96) for backtick in regex
    const BT = 'String.fromCharCode(96)';
    return [
'const vscode   = acquireVsCodeApi();',
'const msgs     = document.getElementById("messages");',
'const input    = document.getElementById("input");',
'const sendBtn  = document.getElementById("send");',
'const typing   = document.getElementById("typing");',
'const cfgStatus = document.getElementById("cfg-status");',
'',
'var QUICK_CHIPS = [',
'  {label:"My Tasks",    cmd:"/list"},',
'  {label:"Sprint",      cmd:"/sprint"},',
'  {label:"Status",      cmd:"/status"},',
'  {label:"Comment",     cmd:"/comment"},',
'  {label:"Move Sprint", cmd:"/move"},',
'  {label:"Create",      cmd:"/create"},',
'  {label:"Migrate",     cmd:"/migrate"},',
'  {label:"Help",        cmd:"/help"}',
'];',
'',
'function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }',
'',
'function mdToHtml(md){',
'  var bt = ' + BT + ';',
'  var re = new RegExp(bt + "([^" + bt + "]+)" + bt, "g");',
'  return String(md)',
'    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")',
'    .replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>")',
'    .replace(re,"<code>$1</code>")',
'    .replace(/^## (.+)$/gm,"<h3>$1</h3>")',
'    .replace(/^[-] (.+)$/gm,"<li>$1</li>")',
'    .replace(/(<li>[\\s\\S]*?<\\/li>)(\\n<li>|$)/g,"$1$2")',
'    .replace(/((?:<li>.*<\\/li>\\n?)+)/g,"<ul>$1</ul>")',
'    .replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,\'<a href="$2" target="_blank">$1</a>\')',
'    .replace(/\\n\\n/g,"</p><p>").replace(/\\n/g,"<br>")',
'    .replace(/^(.+)$/,"<p>$1</p>");',
'}',
'',
'function appendMsg(role, html, chips){',
'  var msg = document.createElement("div");',
'  msg.className = "msg " + role;',
'  var bubble = document.createElement("div");',
'  bubble.className = "bubble";',
'  bubble.innerHTML = html;',
'  if(chips && chips.length){',
'    var cc = document.createElement("div");',
'    cc.className = "chips";',
'    chips.forEach(function(c){',
'      var btn = document.createElement("button");',
'      btn.className = "chip";',
'      btn.textContent = c.label;',
'      btn.onclick = function(){ dispatchCmd(c.cmd); };',
'      cc.appendChild(btn);',
'    });',
'    bubble.appendChild(cc);',
'  }',
'  msg.appendChild(bubble);',
'  msgs.appendChild(msg);',
'  msgs.scrollTop = msgs.scrollHeight;',
'}',
'',
'function appendQuickChips(){',
'  if(msgs.querySelector(".quick-chips")) return;',
'  var cc = document.createElement("div");',
'  cc.className = "chips quick-chips";',
'  QUICK_CHIPS.forEach(function(c){',
'    var btn = document.createElement("button");',
'    btn.className = "chip";',
'    btn.textContent = c.label;',
'    btn.onclick = function(){ dispatchCmd(c.cmd); };',
'    cc.appendChild(btn);',
'  });',
'  var last = msgs.querySelectorAll(".msg.bot .bubble");',
'  var lastEl = last.length ? last[last.length - 1] : null;',
'  if(lastEl) lastEl.appendChild(cc);',
'  msgs.scrollTop = msgs.scrollHeight;',
'}',
'',
'function dispatchCmd(cmd){',
'  if(cmd === "__setup__" || cmd === "__ai__" || cmd === "__user__"){',
'    vscode.postMessage({type:"chip", command:cmd});',
'  } else {',
'    vscode.postMessage({type:"userMessage", text:cmd});',
'  }',
'}',
'',
'function send_cmd(cmd){ dispatchCmd(cmd); }',
'',
'window.addEventListener("message", function(e){',
'  var m = e.data;',
'  if(m.type === "message"){',
'    appendMsg(m.role, m.text, m.chips);',
'    if(m.role === "bot") appendQuickChips();',
'  }',
'  if(m.type === "typing") typing.className = m.on ? "show" : "";',
'  if(m.type === "status") cfgStatus.textContent = m.text || "";',
'});',
'',
'function submit(){',
'  var text = input.value.trim();',
'  if(!text) return;',
'  input.value = "";',
'  input.style.height = "auto";',
'  vscode.postMessage({type:"userMessage", text:text});',
'}',
'sendBtn.addEventListener("click", submit);',
'input.addEventListener("keydown", function(e){',
'  if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submit(); }',
'});',
'input.addEventListener("input", function(){',
'  input.style.height = "auto";',
'  input.style.height = Math.min(input.scrollHeight, 120) + "px";',
'});',
'// Make links clickable — intercept and open via extension host',
'document.addEventListener("click", function(e){',
'  var el = e.target;',
'  while(el && el.tagName !== "A") el = el.parentElement;',
'  if(el && el.href){',
'    e.preventDefault();',
'    vscode.postMessage({type:"openUrl", url:el.href});',
'  }',
'});',
    ].join('\n');
  }
}
