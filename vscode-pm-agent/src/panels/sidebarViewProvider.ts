// src/panels/sidebarViewProvider.ts
// Sidebar chat — lives in the activity bar like Copilot Chat.
// Full command processing, message history, input bar.

import * as vscode from 'vscode';
import { CredentialManager } from '../utils/credentialManager';
import { CommandRunner } from '../commandRunner';
import { createProvider } from '../providers/providerFactory';
import { parseIntent } from '../utils/intentParser';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pm-agent.workItemView';

  private _view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly credMgr: CredentialManager,
    private readonly runner: CommandRunner
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri]
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage(
      msg => this._handleMessage(msg),
      undefined,
      this.context.subscriptions
    );

    // Send welcome after a short delay to let the webview initialize
    setTimeout(() => this._send('bot',
      '**PM Agent** — manage work items from the sidebar.\n\nType a command or click a chip below.'
    ), 300);
  }

  // ── Message routing ─────────────────────────────────────────────────────

  private async _handleMessage(msg: { type: string; text?: string; command?: string }) {
    if (msg.type === 'userMessage' && msg.text?.trim()) {
      await this._processInput(msg.text.trim());
    }
    if (msg.type === 'chip' && msg.command) {
      if (msg.command === '__setup__') {
        await vscode.commands.executeCommand('pm-agent.configurePlatform');
        this._send('bot', 'Platform configuration complete. Type /list to verify your connection.');
      } else if (msg.command === '__ai__') {
        await vscode.commands.executeCommand('pm-agent.configureAi');
        this._send('bot', 'AI provider configured.');
      } else if (msg.command === '__user__') {
        await vscode.commands.executeCommand('pm-agent.setDefaultUser');
        this._send('bot', 'Default user updated.');
      } else {
        await this._processInput(msg.command);
      }
    }
  }

  private async _processInput(raw: string) {
    this._send('user', raw);
    this._sendTyping(true);

    try {
      const configured = await this.credMgr.isConfigured();
      if (!configured) {
        this._sendTyping(false);
        this._send('bot',
          '**Configuration required.**\n\nConnect Jira or Azure DevOps first.',
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
          if (!items.length) { this._send('bot', 'No work items found.'); break; }
          const lines = items.slice(0, 20).map(wi =>
            `- **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\``
          ).join('\n');
          this._send('bot', `**${items.length} items:**\n\n${lines}`);
          break;
        }

        case 'open': {
          if (!intent.workItemKey) { this._send('bot', 'Usage: `/open #1234` or `/open ENG-42`'); break; }
          const item = await provider.getWorkItem(intent.workItemKey);
          this.context.globalState.update('lastItem', item);
          const pts = item.storyPoints ?? item.effort;
          const lines = [
            `## [${item.key}](${item.url}) ${item.title}`,
            `**Type:** ${item.type}   **Status:** \`${item.status}\``,
            item.assignee ? `**Assignee:** ${item.assignee.displayName}` : '',
            pts ? `**Points:** ${pts}` : '',
            item.sprint ? `**Sprint:** ${item.sprint.split('\\').pop()}` : '',
            item.description ? `\n${item.description.replace(/<[^>]+>/g, '').slice(0, 300)}` : ''
          ].filter(Boolean).join('\n');
          this._send('bot', lines, [
            { label: 'Comment',  cmd: `/comment ${item.key}` },
            { label: 'Status',   cmd: `/status ${item.key}` },
            { label: 'Assign',   cmd: `/assign ${item.key}` },
          ]);
          break;
        }

        case 'sprint': {
          const sprints = await (provider as any).getAllSprints?.() ?? [];
          const active = sprints.find((s: any) => s.state === 'active');
          if (!active) { this._send('bot', 'No active sprint found.'); break; }
          const du2 = await this.credMgr.getDefaultUser();
          const sitems = await provider.searchWorkItems({
            assigneeId: du2?.id ?? '@me',
            sprintId: (creds.platform === 'azuredevops' ? (active as any).iterationPath : active.id),
            maxResults: 30
          }).catch(() => []);
          const lines2 = [
            `## Sprint: ${active.name}`,
            active.endDate ? `**Ends:** ${active.endDate.slice(0,10)}` : '',
            `**Your items:** ${sitems.length}`,
            '',
            ...sitems.slice(0, 15).map((wi: any) =>
              `- **[${wi.key}](${wi.url})** ${wi.title} \`${wi.status}\``
            )
          ].filter(s => s !== undefined).join('\n');
          this._send('bot', lines2);
          break;
        }

        case 'status':   { this._sendTyping(false); await this.runner.status();   this._send('bot', 'Status updated.'); return; }
        case 'comment':  { this._sendTyping(false); await this.runner.comment();  this._send('bot', 'Comment posted.'); return; }
        case 'assign':   { this._sendTyping(false); await this.runner.assign();   this._send('bot', 'Item assigned.'); return; }
        case 'estimate': { this._sendTyping(false); await this.runner.estimate(); this._send('bot', 'Story points updated.'); return; }
        case 'move':     { this._sendTyping(false); await this.runner.move();     this._send('bot', 'Items moved.'); return; }
        case 'debug':    { this._sendTyping(false); await this.runner.debug();    this._send('bot', 'Diagnostics written to output channel.'); return; }
        case 'create':   { this._sendTyping(false); await this.runner.create();   this._send('bot', 'Done. Type /list to see your items.'); return; }
        case 'migrate':  { this._sendTyping(false); await this.runner.migrate();  this._send('bot', 'Migration complete.'); return; }
        case 'parent':   { this._sendTyping(false); await this.runner.parent();   this._send('bot', 'Parent link updated.'); return; }
        case 'setuser':  { this._sendTyping(false); await vscode.commands.executeCommand('pm-agent.setDefaultUser'); this._send('bot', 'Default user updated.'); return; }
        case 'setupai':  { this._sendTyping(false); await vscode.commands.executeCommand('pm-agent.configureAi'); this._send('bot', 'AI provider configured.'); return; }

        case 'unknown':
        default: {
          this._send('bot', [
            '**Commands:** /list, /open, /sprint, /status, /comment, /assign,',
            '/estimate, /move, /create, /migrate, /parent, /debug, /setuser, /setupai',
          ].join('\n'));
          break;
        }
      }
    } catch (e: unknown) {
      const emsg = e instanceof Error ? e.message : String(e);
      this._send('bot', `**Error:** ${emsg.slice(0, 200)}`);
    }

    this._sendTyping(false);
  }

  // ── Post message helpers ────────────────────────────────────────────────

  private _send(role: 'user' | 'bot', text: string, chips?: Array<{ label: string; cmd: string }>) {
    if (!this._view) { return; }
    this._view.webview.postMessage({ type: 'message', role, text: this._mdToHtml(text), chips });
  }

  private _sendTyping(on: boolean) {
    if (!this._view) { return; }
    this._view.webview.postMessage({ type: 'typing', on });
  }

  private _mdToHtml(md: string): string {
    return md
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>(\n|$))+/g, s => `<ul>${s}</ul>`)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>')
      .replace(/^(.+)$/, '<p>$1</p>');
  }

  public refresh(): void {
    // no-op for compatibility
  }

  // ── HTML ────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    const css = this._getCss();
    const body = this._getBody();
    const script = this._getScript();

    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
      + '<meta charset="UTF-8">\n'
      + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">\n'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
      + '<style>' + css + '</style>\n'
      + '</head>\n<body>\n'
      + body
      + '\n<script>\n' + script + '\n</script>\n'
      + '</body>\n</html>';
  }

  private _getCss(): string {
    return [
      '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
      'html,body{height:100%;overflow:hidden}',
      'body{font-family:var(--vscode-font-family,"Segoe UI",system-ui,sans-serif);font-size:12px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background)}',
      '#app{display:flex;flex-direction:column;height:100vh}',
      '',
      '#messages{flex:1;overflow-y:auto;padding:8px 10px 4px;display:flex;flex-direction:column;gap:8px}',
      '.msg{display:flex;gap:6px;max-width:100%}',
      '.msg.user{flex-direction:row-reverse}',
      '.bubble{max-width:92%;padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.5;word-break:break-word}',
      '.msg.bot .bubble{background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#3c3c3c);border-top-left-radius:2px}',
      '.msg.user .bubble{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-top-right-radius:2px}',
      '.bubble h3{font-size:12px;font-weight:600;margin-bottom:3px}',
      '.bubble ul{padding-left:0;list-style:none}',
      '.bubble li{padding:1px 0;font-size:11px}',
      '.bubble code{font-family:var(--vscode-editor-font-family,"Consolas",monospace);font-size:10px;background:rgba(255,255,255,.1);padding:1px 3px;border-radius:2px}',
      '.bubble a{color:var(--vscode-textLink-foreground,#3794ff);text-decoration:none}',
      '.bubble a:hover{text-decoration:underline}',
      '.bubble p{margin:0}.bubble p+p{margin-top:4px}',
      '.bubble strong{font-weight:600}',
      '',
      '.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
      '.chip{background:var(--vscode-badge-background,#3c3c3c);color:var(--vscode-badge-foreground,#ccc);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:10px;padding:2px 8px;font-size:10px;cursor:pointer;transition:all .15s}',
      '.chip:hover{background:var(--vscode-focusBorder,#007acc);color:#fff;border-color:var(--vscode-focusBorder,#007acc)}',
      '',
      '#typing{display:none;padding:0 10px 3px;align-items:center;gap:3px}',
      '#typing.show{display:flex}',
      '.dot{width:4px;height:4px;border-radius:50%;background:var(--vscode-focusBorder,#007acc);animation:pulse 1.2s ease-in-out infinite}',
      '.dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}',
      '@keyframes pulse{0%,100%{opacity:.3;transform:scale(.9)}50%{opacity:1;transform:scale(1.1)}}',
      '',
      '#inputbar{border-top:1px solid var(--vscode-panel-border,#3c3c3c);padding:6px 8px;display:flex;gap:6px;align-items:flex-end;flex-shrink:0;background:var(--vscode-sideBar-background)}',
      '#input{flex:1;background:var(--vscode-input-background,#3c3c3c);color:var(--vscode-input-foreground,#ccc);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;padding:5px 8px;font-family:inherit;font-size:11px;resize:none;min-height:28px;max-height:80px;outline:none;line-height:1.4}',
      '#input:focus{border-color:var(--vscode-focusBorder,#007acc)}',
      '#input::placeholder{opacity:.5}',
      '#send{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border:none;border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px;height:28px;display:flex;align-items:center;transition:opacity .15s}',
      '#send:hover{opacity:.85}',
      '',
      '#messages::-webkit-scrollbar{width:4px}',
      '#messages::-webkit-scrollbar-track{background:transparent}',
      '#messages::-webkit-scrollbar-thumb{background:var(--vscode-panel-border,#3c3c3c);border-radius:2px}',
    ].join('\n');
  }

  private _getBody(): string {
    return [
      '<div id="app">',
      '  <div id="messages"></div>',
      '  <div id="typing"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>',
      '  <div id="inputbar">',
      '    <textarea id="input" rows="1" placeholder="/list  /open  /sprint  /create"></textarea>',
      '    <button id="send" title="Send">&#9654;</button>',
      '  </div>',
      '</div>',
    ].join('\n');
  }

  private _getScript(): string {
    return [
      'var vscode = acquireVsCodeApi();',
      'var msgs = document.getElementById("messages");',
      'var input = document.getElementById("input");',
      'var sendBtn = document.getElementById("send");',
      'var typing = document.getElementById("typing");',
      '',
      'var QUICK = [',
      '  {label:"My Tasks",cmd:"/list"},{label:"Sprint",cmd:"/sprint"},',
      '  {label:"Create",cmd:"/create"},{label:"Status",cmd:"/status"},',
      '  {label:"Migrate",cmd:"/migrate"},{label:"Setup",cmd:"__setup__"},',
      '  {label:"Help",cmd:"/help"}',
      '];',
      '',
      'function appendMsg(role, html, chips){',
      '  var msg=document.createElement("div");',
      '  msg.className="msg "+role;',
      '  var bubble=document.createElement("div");',
      '  bubble.className="bubble";',
      '  bubble.innerHTML=html;',
      '  if(chips&&chips.length){',
      '    var cc=document.createElement("div");cc.className="chips";',
      '    chips.forEach(function(c){',
      '      var btn=document.createElement("button");btn.className="chip";btn.textContent=c.label;',
      '      btn.addEventListener("click",function(){dispatch(c.cmd);});',
      '      cc.appendChild(btn);',
      '    });',
      '    bubble.appendChild(cc);',
      '  }',
      '  msg.appendChild(bubble);msgs.appendChild(msg);msgs.scrollTop=msgs.scrollHeight;',
      '}',
      '',
      'function appendQuickChips(){',
      '  if(msgs.querySelector(".quick-chips"))return;',
      '  var cc=document.createElement("div");cc.className="chips quick-chips";',
      '  QUICK.forEach(function(c){',
      '    var btn=document.createElement("button");btn.className="chip";btn.textContent=c.label;',
      '    btn.addEventListener("click",function(){dispatch(c.cmd);});',
      '    cc.appendChild(btn);',
      '  });',
      '  var last=msgs.querySelectorAll(".msg.bot .bubble");',
      '  var el=last.length?last[last.length-1]:null;',
      '  if(el)el.appendChild(cc);',
      '  msgs.scrollTop=msgs.scrollHeight;',
      '}',
      '',
      'function dispatch(cmd){',
      '  if(cmd==="__setup__"||cmd==="__ai__"||cmd==="__user__"){',
      '    vscode.postMessage({type:"chip",command:cmd});',
      '  }else{',
      '    vscode.postMessage({type:"userMessage",text:cmd});',
      '  }',
      '}',
      '',
      'window.addEventListener("message",function(e){',
      '  var m=e.data;',
      '  if(m.type==="message"){',
      '    appendMsg(m.role,m.text,m.chips);',
      '    if(m.role==="bot")appendQuickChips();',
      '  }',
      '  if(m.type==="typing")typing.className=m.on?"show":"";',
      '});',
      '',
      'function submit(){',
      '  var text=input.value.trim();',
      '  if(!text)return;',
      '  input.value="";input.style.height="auto";',
      '  vscode.postMessage({type:"userMessage",text:text});',
      '}',
      'sendBtn.addEventListener("click",submit);',
      'input.addEventListener("keydown",function(e){',
      '  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();submit();}',
      '});',
      'input.addEventListener("input",function(){',
      '  input.style.height="auto";',
      '  input.style.height=Math.min(input.scrollHeight,80)+"px";',
      '});',
    ].join('\n');
  }
}
