// src/panels/workItemPanel.ts
import * as vscode from 'vscode';
import { WorkItem } from '../types';
import { escapeHtml, stripHtml } from '../utils/strings';

export class WorkItemPanel {
  public  static currentPanel: WorkItemPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  // ── Entry ────────────────────────────────────────────────────────────────

  public static createOrShow(context: vscode.ExtensionContext, item: WorkItem): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (WorkItemPanel.currentPanel) {
      WorkItemPanel.currentPanel._panel.reveal(column);
      WorkItemPanel.currentPanel._update(item);
      return;
    }

    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        'pmAgentWorkItem',
        `${item.key} - ${item.title.slice(0, 40)}`,
        column ?? vscode.ViewColumn.One,
{ enableScripts: true }
      );
    } catch {
      // WebView not available — fall back to a notification with key details
      vscode.window.showInformationMessage(
        `${item.key}: ${item.title} [${item.status}]` +
        (item.assignee ? ` — ${item.assignee.displayName}` : '')
      );
      return;
    }

    WorkItemPanel.currentPanel = new WorkItemPanel(panel, context, item);
  }

  // ── Constructor ──────────────────────────────────────────────────────────

  private constructor(
    panel: vscode.WebviewPanel,
    _context: vscode.ExtensionContext,
    item: WorkItem
  ) {
    this._panel = panel;
    this._update(item);

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      (message: { command: string }) => {
        if (message.command === 'openInBrowser') {
          void vscode.env.openExternal(vscode.Uri.parse(item.url));
        }
      },
      null,
      this._disposables
    );
  }

  // ── Update ───────────────────────────────────────────────────────────────

  private _update(item: WorkItem): void {
    this._panel.title          = `${item.key} - ${item.title.slice(0, 40)}`;
    this._panel.webview.html   = this._getHtml(item);
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private _getHtml(item: WorkItem): string {
    const typeColors: Record<string, string> = {
      story: '#0052CC', task: '#36B37E', bug: '#FF5630',
      epic: '#6554C0', feature: '#00B8D9', subtask: '#57D9A3', testcase: '#FF991F'
    };
    const statusColors: Record<string, string> = {
      'To Do': '#DFE1E6', 'In Progress': '#0052CC', 'Done': '#36B37E',
      'Blocked': '#FF5630', 'In Review': '#FF991F', 'Backlog': '#97A0AF'
    };

    const color  = typeColors[item.type]  ?? '#0052CC';
    const sColor = statusColors[item.status] ?? '#DFE1E6';
    const pts    = item.storyPoints ?? item.effort;

    const row = (label: string, value: string) =>
      `<tr><td class="lbl">${label}</td><td>${value}</td></tr>`;

    const badge = (text: string, bg: string) => {
      const fg = bg === '#DFE1E6' ? '#172B4D' : '#fff';
      return `<span class="badge" style="background:${bg};color:${fg}">${text}</span>`;
    };

    const rows = [
      row('Type',     badge(item.type, color)),
      row('Status',   badge(item.status, sColor)),
      item.priority ? row('Priority', escapeHtml(item.priority)) : '',
      item.assignee
        ? row('Assignee', escapeHtml(item.assignee.displayName +
            (item.assignee.email ? ` <${item.assignee.email}>` : '')))
        : '',
      item.reporter ? row('Reporter', escapeHtml(item.reporter.displayName)) : '',
      pts !== undefined
        ? row(item.platform === 'jira' ? 'Story Points' : 'Effort', String(pts))
        : '',
      item.sprint  ? row('Sprint',   escapeHtml(item.sprint))              : '',
      item.labels?.length
        ? row('Labels', item.labels.map(l =>
            `<span class="tag">${escapeHtml(l)}</span>`).join(' '))
        : '',
      row('Platform', item.platform === 'jira' ? 'Jira' : item.platform === 'github' ? 'GitHub' : 'Azure DevOps'),
      item.startDate ? row('Start Date', item.startDate.slice(0, 10)) : '',
      item.endDate   ? row('End Date', item.endDate.slice(0, 10)) : '',
      item.createdAt ? row('Created', item.createdAt.slice(0, 10)) : '',
      item.updatedAt ? row('Updated', item.updatedAt.slice(0, 10)) : '',
    ].filter(Boolean).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body   { font-family:var(--vscode-font-family); font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:20px; margin:0; }
  h1     { font-size:18px; margin-bottom:4px; font-weight:600; }
  .key   { color:var(--vscode-descriptionForeground); font-size:13px; margin-bottom:16px; }
  table  { border-collapse:collapse; width:100%; max-width:600px; margin:16px 0; }
  td     { padding:6px 10px; border-bottom:1px solid var(--vscode-panel-border); vertical-align:top; }
  td.lbl { font-weight:600; width:130px; color:var(--vscode-descriptionForeground); }
  .badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
  .tag   { display:inline-block; background:var(--vscode-badge-background); color:var(--vscode-badge-foreground); padding:1px 6px; border-radius:10px; font-size:11px; margin-right:4px; }
  .desc  { margin-top:16px; max-width:700px; white-space:pre-wrap; background:var(--vscode-textBlockQuote-background); border-left:3px solid var(--vscode-textBlockQuote-border); padding:12px 16px; border-radius:0 4px 4px 0; }
  .sec   { font-weight:700; font-size:14px; margin:20px 0 6px; }
  button { margin-top:20px; padding:8px 16px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; border-radius:4px; cursor:pointer; font-size:13px; }
  button:hover { background:var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div class="key">${item.platform === 'jira' ? 'Jira' : item.platform === 'github' ? 'GitHub' : 'Azure DevOps'} &middot; ${escapeHtml(item.projectKey)}</div>
<h1>${escapeHtml(item.title)}</h1>
<div class="key">${item.key}</div>
<table>${rows}</table>
${item.description
  ? `<div class="sec">Description</div><div class="desc">${escapeHtml(stripHtml(item.description).slice(0, 1000))}</div>`
  : ''}
<button onclick="openInBrowser()">Open in Browser</button>
<script>
  const vscode = acquireVsCodeApi();
  function openInBrowser() { vscode.postMessage({ command: 'openInBrowser' }); }
</script>
</body>
</html>`;
  }

  // ── Exit ─────────────────────────────────────────────────────────────────

  private _dispose(): void {
    WorkItemPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) { d.dispose(); }
    }
  }
}
