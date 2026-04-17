// src/panels/setupWizardPanel.ts
import * as vscode from 'vscode';

export type Platform = 'jira' | 'azuredevops';

export interface SetupResult {
  platform:     Platform;
  jiraBaseUrl?: string;
  jiraEmail?:   string;
  jiraToken?:   string;
  jiraProject?: string;
  adoOrgUrl?:   string;
  adoProject?:  string;
  adoToken?:    string;
  _jiraToken?:  string;
  _adoToken?:   string;
  /** Per-issueType default values for custom/required fields */
  jiraFieldDefaults?: Record<string, Record<string, unknown>>;
}

const ALLOWED_URLS: Record<string, string> = {
  jiraTokenPage: 'https://id.atlassian.com/manage-profile/security/api-tokens',
};

export class SetupWizardPanel {
  static async show(
    context: vscode.ExtensionContext,
    existingCreds: Partial<SetupResult>
  ): Promise<SetupResult | undefined> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'pmAgentSetup',
        'PM Agent — Platform Configuration',
        vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [context.extensionUri] }
      );

      const pre = existingCreds ?? {};
      panel.webview.html = getHtml(pre);

      let settled = false;
      const settle = (result: SetupResult | undefined) => {
        if (settled) { return; }
        settled = true;
        panel.dispose();
        resolve(result);
      };

      panel.webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg.type) {
          case 'openUrl': {
            const raw = String(msg.url ?? '');
            const resolved = ALLOWED_URLS[raw] ?? raw;
            const isWhitelisted = Object.values(ALLOWED_URLS).includes(resolved);
            const isAdoTokenPage = /^https:\/\/dev\.azure\.com\/[a-zA-Z0-9_-]+\/_usersSettings\/tokens$/.test(resolved);
            if (isWhitelisted || isAdoTokenPage) {
              await vscode.env.openExternal(vscode.Uri.parse(resolved));
            }
            break;
          }
          case 'fetchAdoProjects': {
            const orgUrl = String(msg.orgUrl ?? '').replace(/\/$/, '');
            const token = String(msg.token ?? '');
            if (!orgUrl || !token) { break; }
            try {
              const auth = 'Basic ' + Buffer.from(`:${token}`).toString('base64');
              const res = await globalThis.fetch(`${orgUrl}/_apis/projects?api-version=7.1`, { headers: { Authorization: auth, Accept: 'application/json' } });
              if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
              const data: any = await res.json();
              panel.webview.postMessage({ type: 'adoProjects', projects: (data.value ?? []).map((p: any) => ({ name: p.name })) });
            } catch (err) {
              panel.webview.postMessage({ type: 'adoProjectsError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'fetchJiraProjects': {
            const baseUrl = String(msg.baseUrl ?? '').replace(/\/$/, '');
            const email = String(msg.email ?? '');
            const token = String(msg.token ?? '');
            if (!baseUrl || !email || !token) { break; }
            try {
              const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
              const headers: Record<string, string> = { Authorization: auth, Accept: 'application/json' };
              const allProjects: Array<{ key: string; name: string }> = [];
              const pageSize = 50;
              let startAt = 0;
              let total = Infinity;
              while (allProjects.length < total) {
                const qs = new URLSearchParams({ startAt: String(startAt), maxResults: String(pageSize) }).toString();
                const res = await globalThis.fetch(`${baseUrl}/rest/api/3/project/search?${qs}`, { headers });
                if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
                const data: any = await res.json();
                const page = (data.values ?? []).map((p: any) => ({ key: p.key, name: p.name }));
                allProjects.push(...page);
                total = data.total ?? allProjects.length;
                startAt += page.length;
                if (allProjects.length % 100 === 0 && allProjects.length > 0) {
                  panel.webview.postMessage({ type: 'jiraProjectCount', count: allProjects.length });
                }
                if (data.isLast || page.length === 0 || allProjects.length >= 2000) { break; }
              }
              panel.webview.postMessage({ type: 'jiraProjects', projects: allProjects, total: allProjects.length });
            } catch (err) {
              panel.webview.postMessage({ type: 'jiraProjectsError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'save': {
            // Save WITHOUT closing the panel — user can switch tabs
            const data = msg.data as SetupResult;
            try {
              const config = vscode.workspace.getConfiguration('pmAgent');
              if (data.platform === 'jira') {
                await config.update('platform', 'jira', vscode.ConfigurationTarget.Global);
                await config.update('jira.baseUrl', data.jiraBaseUrl!, vscode.ConfigurationTarget.Global);
                await config.update('jira.email', data.jiraEmail!, vscode.ConfigurationTarget.Global);
                await config.update('jira.defaultProject', data.jiraProject || '', vscode.ConfigurationTarget.Global);
                if (data.jiraToken) {
                  await context.secrets.store('pmAgent.jira.apiToken', data.jiraToken);
                }
                if (data.jiraFieldDefaults && Object.keys(data.jiraFieldDefaults).length) {
                  await context.globalState.update('pmAgent.jiraFieldDefaults', data.jiraFieldDefaults);
                }
                panel.webview.postMessage({ type: 'saveSuccess', platform: 'jira' });
              } else {
                await config.update('platform', 'azuredevops', vscode.ConfigurationTarget.Global);
                await config.update('azureDevOps.orgUrl', data.adoOrgUrl!, vscode.ConfigurationTarget.Global);
                await config.update('azureDevOps.project', data.adoProject!, vscode.ConfigurationTarget.Global);
                if (data.adoToken) {
                  await context.secrets.store('pmAgent.ado.personalAccessToken', data.adoToken);
                }
                panel.webview.postMessage({ type: 'saveSuccess', platform: 'ado' });
              }
            } catch (err) {
              panel.webview.postMessage({ type: 'saveError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'cancel':
            settle(undefined);
            break;
          case 'done':
            // User clicks "Done" after saving — close the panel
            settle(msg.lastSaved ?? undefined);
            break;
          case 'validateToken': {
            // Heartbeat check — try a lightweight API call to verify the token
            const platform = String(msg.platform ?? '');
            if (platform === 'jira') {
              const baseUrl = String(msg.baseUrl ?? '').replace(/\/$/, '');
              const email = String(msg.email ?? '');
              let token = String(msg.token ?? '');
              if (msg.useStored) {
                token = await context.secrets.get('pmAgent.jira.apiToken') ?? '';
              }
              if (!baseUrl || !email || !token) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'jira', valid: false, error: 'Missing credentials' });
                break;
              }
              try {
                const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
                const res = await globalThis.fetch(`${baseUrl}/rest/api/3/myself`, {
                  headers: { Authorization: auth, Accept: 'application/json' }
                });
                if (res.ok) {
                  const user = await res.json() as any;
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'jira', valid: true, user: user.displayName ?? user.emailAddress ?? 'OK' });
                } else {
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'jira', valid: false, error: `HTTP ${res.status}` });
                }
              } catch (err) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'jira', valid: false, error: err instanceof Error ? err.message : String(err) });
              }
            } else if (platform === 'ado') {
              const orgUrl = String(msg.orgUrl ?? '').replace(/\/$/, '');
              let token = String(msg.token ?? '');
              if (msg.useStored) {
                token = await context.secrets.get('pmAgent.ado.personalAccessToken') ?? '';
              }
              if (!orgUrl || !token) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'ado', valid: false, error: 'Missing credentials' });
                break;
              }
              try {
                const auth = 'Basic ' + Buffer.from(`:${token}`).toString('base64');
                const res = await globalThis.fetch(`${orgUrl}/_apis/connectionData?api-version=7.1`, {
                  headers: { Authorization: auth, Accept: 'application/json' }
                });
                if (res.ok) {
                  const data = await res.json() as any;
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'ado', valid: true, user: data.authenticatedUser?.providerDisplayName ?? 'OK' });
                } else {
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'ado', valid: false, error: `HTTP ${res.status}` });
                }
              } catch (err) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'ado', valid: false, error: err instanceof Error ? err.message : String(err) });
              }
            }
            break;
          }
          case 'fetchJiraFields': {
            // Fetch all required fields for each issue type in the selected project
            const baseUrl = String(msg.baseUrl ?? '').replace(/\/$/, '');
            const email = String(msg.email ?? '');
            const token = String(msg.token ?? '');
            const projectKey = String(msg.projectKey ?? '');
            if (!baseUrl || !email || !token || !projectKey) { break; }
            try {
              const { JiraProvider } = await import('../providers/jiraProvider');
              const jp = new JiraProvider({
                platform: 'jira',
                jiraBaseUrl: baseUrl,
                jiraEmail: email,
                jiraToken: token,
                jiraProject: projectKey,
              });
              const types = await jp.getWorkItemTypes();
              const fieldsByType: Record<string, any[]> = {};
              for (const typeName of types) {
                try {
                  const fields = await jp.getCreateFields(typeName);
                  if (fields.length) { fieldsByType[typeName] = fields; }
                } catch { /* skip */ }
              }
              panel.webview.postMessage({ type: 'jiraFields', fieldsByType, types });
            } catch (err) {
              panel.webview.postMessage({ type: 'jiraFieldsError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'fetchJiraFieldsStored': {
            // Same as above but reads token from SecretStorage
            const secrets = context.secrets;
            const storedToken = await secrets.get('pmAgent.jira.apiToken');
            const bUrl = String(pre.jiraBaseUrl ?? '').replace(/\/$/, '');
            const em = String(pre.jiraEmail ?? '');
            const pk = String(msg.projectKey ?? '');
            if (!storedToken || !bUrl || !em || !pk) { break; }
            try {
              const { JiraProvider } = await import('../providers/jiraProvider');
              const jp = new JiraProvider({
                platform: 'jira',
                jiraBaseUrl: bUrl,
                jiraEmail: em,
                jiraToken: storedToken,
                jiraProject: pk,
              });
              const types = await jp.getWorkItemTypes();
              const fieldsByType: Record<string, any[]> = {};
              for (const typeName of types) {
                try {
                  const fields = await jp.getCreateFields(typeName);
                  if (fields.length) { fieldsByType[typeName] = fields; }
                } catch { /* skip */ }
              }
              panel.webview.postMessage({ type: 'jiraFields', fieldsByType, types });
            } catch (err) {
              panel.webview.postMessage({ type: 'jiraFieldsError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'requestAutoFetch': {
            // The webview asks the extension host to auto-fetch projects
            // using stored tokens — tokens never leave the extension host.
            const secrets = context.secrets;
            if (msg.platform === 'jira') {
              const token = await secrets.get('pmAgent.jira.apiToken');
              const baseUrl = String(pre.jiraBaseUrl ?? '').replace(/\/$/, '');
              const email = String(pre.jiraEmail ?? '');
              if (token && baseUrl && email) {
                try {
                  const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
                  const headers: Record<string, string> = { Authorization: auth, Accept: 'application/json' };
                  const allProjects: Array<{ key: string; name: string }> = [];
                  const pageSize = 50;
                  let startAt = 0;
                  let total = Infinity;
                  while (allProjects.length < total) {
                    const qs = new URLSearchParams({ startAt: String(startAt), maxResults: String(pageSize) }).toString();
                    const res = await globalThis.fetch(`${baseUrl}/rest/api/3/project/search?${qs}`, { headers });
                    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
                    const data: any = await res.json();
                    const page = (data.values ?? []).map((p: any) => ({ key: p.key, name: p.name }));
                    allProjects.push(...page);
                    total = data.total ?? allProjects.length;
                    startAt += page.length;
                    if (allProjects.length % 100 === 0 && allProjects.length > 0) {
                      panel.webview.postMessage({ type: 'jiraProjectCount', count: allProjects.length });
                    }
                    if (data.isLast || page.length === 0 || allProjects.length >= 2000) { break; }
                  }
                  panel.webview.postMessage({ type: 'jiraProjects', projects: allProjects, total: allProjects.length });
                } catch (err) {
                  panel.webview.postMessage({ type: 'jiraProjectsError', error: err instanceof Error ? err.message : String(err) });
                }
              }
            } else if (msg.platform === 'ado') {
              const token = await secrets.get('pmAgent.ado.personalAccessToken');
              const orgUrl = String(pre.adoOrgUrl ?? '').replace(/\/$/, '');
              if (token && orgUrl) {
                try {
                  const auth = 'Basic ' + Buffer.from(`:${token}`).toString('base64');
                  const res = await globalThis.fetch(`${orgUrl}/_apis/projects?api-version=7.1`, { headers: { Authorization: auth, Accept: 'application/json' } });
                  if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
                  const data: any = await res.json();
                  panel.webview.postMessage({ type: 'adoProjects', projects: (data.value ?? []).map((p: any) => ({ name: p.name })) });
                } catch (err) {
                  panel.webview.postMessage({ type: 'adoProjectsError', error: err instanceof Error ? err.message : String(err) });
                }
              }
            }
            break;
          }
        }
      });

      panel.onDidDispose(() => settle(undefined));
    });
  }
}

// ── HTML builder ────────────────────────────────────────────────────────────

function getHtml(pre: Partial<SetupResult>): string {
  const safeJson = JSON.stringify(pre)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  const css = getCss();
  const body = getBody();
  const script = getScript(safeJson);

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n'
    + '<meta charset="UTF-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>PM Agent — Platform Configuration</title>\n'
    + '<style>' + css + '</style>\n'
    + '</head>\n<body>\n'
    + body
    + '\n<script>\n' + script + '\n</script>\n'
    + '</body>\n</html>';
}

function getCss(): string {
  return [
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:28px 36px 48px;max-width:600px}',
    'h1{font-size:18px;font-weight:600;margin-bottom:4px;letter-spacing:-.2px}',
    '.subtitle{color:var(--vscode-descriptionForeground);margin-bottom:24px;font-size:12px;line-height:1.5}',
    '.tabs{display:flex;gap:6px;margin-bottom:24px}',
    '.tab{flex:1;padding:8px 0;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer;text-align:center;font-size:13px;font-weight:500;background:var(--vscode-editor-background);color:var(--vscode-foreground);transition:background .1s,border-color .1s}',
    '.tab:hover{background:var(--vscode-list-hoverBackground)}',
    '.tab.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:var(--vscode-button-background)}',
    '.section{display:none}.section.visible{display:block}',
    '.info-box{background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--vscode-textBlockQuote-border);border-radius:0 3px 3px 0;padding:10px 14px;margin-bottom:20px;font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6}',
    '.info-box strong{color:var(--vscode-foreground)}',
    '.info-box a{color:var(--vscode-textLink-foreground);text-decoration:none}',
    '.info-box a:hover{text-decoration:underline}',
    '.field{margin-bottom:16px}',
    'label{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);margin-bottom:5px}',
    'input[type=text],input[type=password],input[type=url],select{width:100%;padding:7px 9px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:13px;font-family:inherit;outline:none}',
    'input:focus,select:focus{border-color:var(--vscode-focusBorder)}',
    '.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;line-height:1.4}',
    '.input-row{display:flex;gap:6px;align-items:flex-start}.input-row input{flex:1}',
    '.btn{display:inline-flex;align-items:center;gap:5px;padding:6px 12px;border-radius:3px;border:none;cursor:pointer;font-size:12px;font-family:inherit;white-space:nowrap;font-weight:500}',
    '.btn-primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}',
    '.btn-primary:hover{background:var(--vscode-button-hoverBackground)}',
    '.btn-primary:disabled{opacity:.5;cursor:default}',
    '.btn-secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
    '.btn-secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}',
    '.btn-secondary:disabled{opacity:.5;cursor:default}',
    '.btn-outline{background:transparent;color:var(--vscode-textLink-foreground);border:1px solid var(--vscode-textLink-foreground);padding:6px 10px}',
    '.btn-outline:hover{background:var(--vscode-textLink-foreground);color:var(--vscode-editor-background)}',
    '.project-status{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:5px;min-height:16px;line-height:1.4}',
    '.project-status.ok{color:var(--vscode-testing-iconPassed,#4caf50)}',
    '.project-status.error{color:var(--vscode-errorForeground)}',
    'select{margin-top:6px}',
    '.proj-item{padding:6px 10px;cursor:pointer;font-size:12px;border-top:1px solid var(--vscode-widget-border,#3c3c3c)}',
    '.proj-item:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)!important}',
    '.proj-none{opacity:0.6;border-top:none}',
    '.footer{display:flex;gap:8px;margin-top:24px;align-items:center}',
    '@keyframes spin{to{transform:rotate(360deg)}}',
    '.spinner{display:inline-block;width:10px;height:10px;border:2px solid var(--vscode-descriptionForeground);border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:4px}',
    'hr{border:none;border-top:1px solid var(--vscode-panel-border);margin:20px 0}',
  ].join('\n');
}

function getBody(): string {
  return [
    '<h1>PM Agent — Platform Configuration</h1>',
    '<p class="subtitle">This panel stays open when you switch to your browser to generate tokens.</p>',
    '<div class="tabs">',
    '  <button class="tab" id="tab-jira">Jira</button>',
    '  <button class="tab" id="tab-ado">Azure DevOps</button>',
    '</div>',
    '',
    '<div class="section" id="section-jira">',
    '  <div class="info-box">',
    '    <strong>Required:</strong> Jira URL &middot; Account email &middot; API token<br>',
    '    Generate an API token at <a href="#" id="jira-token-link">id.atlassian.com/manage-profile/security/api-tokens</a>',
    '  </div>',
    '  <div class="field"><label>Jira Base URL</label><input type="url" id="jira-url" placeholder="https://yourorg.atlassian.net" autocomplete="off" spellcheck="false"/><div class="hint">Your Atlassian Cloud or Server URL</div></div>',
    '  <div class="field"><label>Account Email</label><input type="text" id="jira-email" placeholder="you@example.com" autocomplete="email"/></div>',
    '  <div class="field"><label>API Token</label><div class="input-row"><input type="password" id="jira-token" placeholder="Paste API token here" autocomplete="new-password"/><button class="btn btn-outline" id="jira-gen-btn">Generate token</button><button class="btn btn-secondary" id="jira-validate-btn" style="margin-left:4px">Validate</button></div><div id="jira-token-status" style="font-size:11px;margin-top:4px;min-height:16px"></div><div class="hint">Switch to your browser, generate the token, paste it here.</div></div>',
    '  <div class="field"><label>Default Project</label><button class="btn btn-secondary" id="jira-fetch-btn">Load projects</button><div class="project-status" id="jira-project-status"></div><div id="jira-project-search-row" style="display:none;margin-top:8px"><input type="text" id="jira-project-search" placeholder="Search by key or name..." autocomplete="off" spellcheck="false"/></div><input type="hidden" id="jira-project" value=""><div id="jira-project-list" style="display:none;margin-top:6px;max-height:200px;overflow-y:auto;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background)"></div><div class="hint" id="jira-project-count" style="display:none"></div></div>',
    '  <div id="jira-fields-section" style="display:none;margin-top:16px">',
    '    <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Required Field Defaults</label>',
    '    <div class="hint" style="margin-bottom:8px">Set default values for required fields. These will auto-fill when creating tickets.</div>',
    '    <div id="jira-fields-loading" style="display:none"><span class="spinner"></span> Loading fields...</div>',
    '    <div id="jira-fields-container"></div>',
    '    <div class="project-status" id="jira-fields-status"></div>',
    '  </div>',
    '</div>',
    '',
    '<div class="section" id="section-ado">',
    '  <div class="info-box">',
    '    <strong>Required:</strong> Organisation URL &middot; Personal Access Token (PAT)<br>',
    '    The PAT needs <strong>Work Items: Read &amp; Write</strong> and <strong>Project and Team: Read</strong> scope.',
    '  </div>',
    '  <div class="field"><label>Organisation URL</label><input type="url" id="ado-org" placeholder="https://dev.azure.com/yourorg" autocomplete="off" spellcheck="false"/><div class="hint">The root URL of your Azure DevOps organisation</div></div>',
    '  <div class="field"><label>Personal Access Token (PAT)</label><div class="input-row"><input type="password" id="ado-token" placeholder="Paste PAT here" autocomplete="new-password"/><button class="btn btn-outline" id="ado-pat-btn">Generate PAT</button><button class="btn btn-secondary" id="ado-validate-btn" style="margin-left:4px">Validate</button></div><div id="ado-token-status" style="font-size:11px;margin-top:4px;min-height:16px"></div><div class="hint">Switch to your browser, create the PAT, paste it here.</div></div>',
    '  <div class="field"><label>Project</label><button class="btn btn-secondary" id="ado-fetch-btn">Load projects</button><div class="project-status" id="ado-project-status"></div><select id="ado-project" style="display:none"><option value="">— Select a project —</option></select></div>',
    '</div>',
    '',
    '<hr>',
    '<div class="footer">',
    '  <button class="btn btn-primary" id="save-btn">Save and Connect</button>',
    '  <button class="btn btn-secondary" id="done-btn">Done</button>',
    '</div>',
  ].join('\n');
}

function getScript(safeJson: string): string {
  return [
    'var vscode = acquireVsCodeApi();',
    'var pre = ' + safeJson + ';',
    'var _allJiraProjects = [];',
    '',
    '// ── Init ──',
    'document.getElementById("tab-jira").addEventListener("click", function(){ switchTab("jira"); });',
    'document.getElementById("tab-ado").addEventListener("click", function(){ switchTab("ado"); });',
    'document.getElementById("jira-token-link").addEventListener("click", function(e){ e.preventDefault(); openUrl("jiraTokenPage"); });',
    'document.getElementById("jira-gen-btn").addEventListener("click", function(){ openUrl("jiraTokenPage"); });',
    'document.getElementById("jira-fetch-btn").addEventListener("click", function(){ fetchJiraProjects(); });',
    'document.getElementById("jira-project-search").addEventListener("input", function(){ filterJiraProjects(); });',
    'document.getElementById("ado-pat-btn").addEventListener("click", function(){ openAdoTokenPage(); });',
    'document.getElementById("ado-fetch-btn").addEventListener("click", function(){ fetchAdoProjects(); });',
    'document.getElementById("save-btn").addEventListener("click", function(){ save(); });',
    'document.getElementById("done-btn").addEventListener("click", function(){ vscode.postMessage({type:"done",lastSaved:_lastSaved}); });',
    'document.getElementById("jira-validate-btn").addEventListener("click", function(){ validateToken("jira"); });',
    'document.getElementById("ado-validate-btn").addEventListener("click", function(){ validateToken("ado"); });',
    '',
    '// Clear on input change',
    'document.getElementById("jira-url").addEventListener("input", function(){ clearJiraProjects(); });',
    'document.getElementById("jira-email").addEventListener("input", function(){ clearJiraProjects(); });',
    'document.getElementById("jira-token").addEventListener("input", function(){ clearJiraProjects(); });',
    'document.getElementById("ado-org").addEventListener("input", function(){ clearAdoProjects(); });',
    'document.getElementById("ado-token").addEventListener("input", function(){ clearAdoProjects(); });',
    '',
    '// Pre-fill',
    'if(pre.jiraBaseUrl) document.getElementById("jira-url").value = pre.jiraBaseUrl;',
    'if(pre.jiraEmail) document.getElementById("jira-email").value = pre.jiraEmail;',
    'if(pre.adoOrgUrl) document.getElementById("ado-org").value = pre.adoOrgUrl;',
    'if(pre._hasJiraToken){ var jt=document.getElementById("jira-token"); jt.value="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022"; jt.dataset.hasStored="1"; jt.addEventListener("input",function(){ jt.dataset.hasStored="0"; }); }',
    'if(pre._hasAdoToken){ var at=document.getElementById("ado-token"); at.value="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022"; at.dataset.hasStored="1"; at.addEventListener("input",function(){ at.dataset.hasStored="0"; }); }',
    'switchTab(pre.platform === "azuredevops" ? "ado" : "jira");',
    '',
    '// Auto-fetch projects using stored tokens (tokens stay in extension host)',
    'if(pre._hasJiraToken && pre.jiraBaseUrl && pre.jiraEmail){ setStatus("jira","","Loading projects..."); document.getElementById("jira-fetch-btn").disabled=true; vscode.postMessage({type:"requestAutoFetch",platform:"jira"}); }',
    'if(pre._hasAdoToken && pre.adoOrgUrl){ setStatus("ado","ok","Loading projects..."); document.getElementById("ado-fetch-btn").disabled=true; vscode.postMessage({type:"requestAutoFetch",platform:"ado"}); }',
    '',
    'window.addEventListener("message", onMessage);',
    '',
    '// ── Functions ──',
    'function switchTab(tab){ document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")}); document.querySelectorAll(".section").forEach(function(s){s.classList.remove("visible")}); document.getElementById("tab-"+tab).classList.add("active"); document.getElementById("section-"+tab).classList.add("visible"); }',
    'function activeTab(){ return document.getElementById("tab-ado").classList.contains("active") ? "ado" : "jira"; }',
    'function openUrl(key){ vscode.postMessage({type:"openUrl",url:key}); }',
    'function openAdoTokenPage(){ var orgUrl=document.getElementById("ado-org").value.trim(); var orgName=orgUrl?orgUrl.replace(/\\/$/, "").split("/").pop():null; var url=orgName?"https://dev.azure.com/"+orgName+"/_usersSettings/tokens":"https://dev.azure.com/_usersSettings/tokens"; vscode.postMessage({type:"openUrl",url:url}); }',
    'function setStatus(platform,cls,html){ var el=document.getElementById(platform+"-project-status"); el.className="project-status"+(cls?" "+cls:""); el.innerHTML=html; }',
    '',
    'function fetchAdoProjects(){ var orgUrl=document.getElementById("ado-org").value.trim(); var token=document.getElementById("ado-token").value.trim(); if(!orgUrl||!token){setStatus("ado","error","Enter the Organisation URL and PAT first.");return;} setStatus("ado","","Loading projects..."); document.getElementById("ado-fetch-btn").disabled=true; vscode.postMessage({type:"fetchAdoProjects",orgUrl:orgUrl,token:token}); }',
    '',
    'function fetchJiraProjects(){ var baseUrl=document.getElementById("jira-url").value.trim(); var email=document.getElementById("jira-email").value.trim(); var jtEl=document.getElementById("jira-token"); if(jtEl.dataset.hasStored==="1"){ if(!baseUrl||!email){setStatus("jira","error","Enter the URL and email first.");return;} document.getElementById("jira-project-list").style.display="block"; document.getElementById("jira-project-search-row").style.display="block"; setStatus("jira","","Loading all projects..."); document.getElementById("jira-fetch-btn").disabled=true; vscode.postMessage({type:"requestAutoFetch",platform:"jira"}); return; } var token=jtEl.value.trim(); if(!baseUrl||!email||!token){setStatus("jira","error","Enter the URL, email and token first, then click Load.");return;} document.getElementById("jira-project-list").style.display="block"; document.getElementById("jira-project-search-row").style.display="block"; setStatus("jira","","Loading all projects..."); document.getElementById("jira-fetch-btn").disabled=true; vscode.postMessage({type:"fetchJiraProjects",baseUrl:baseUrl,email:email,token:token}); }',
    '',
    'function clearAdoProjects(){ var sel=document.getElementById("ado-project"); sel.innerHTML=\'<option value="">\\u2014 Select a project \\u2014</option>\'; sel.style.display="none"; setStatus("ado","",""); document.getElementById("ado-fetch-btn").disabled=false; }',
    '',
    'function clearJiraProjects(){ document.getElementById("jira-project").value=""; var list=document.getElementById("jira-project-list"); list.innerHTML=""; list.style.display="none"; var sr=document.getElementById("jira-project-search-row"); if(sr)sr.style.display="none"; var s=document.getElementById("jira-project-search"); if(s)s.value=""; var c=document.getElementById("jira-project-count"); if(c)c.style.display="none"; _allJiraProjects=[]; setStatus("jira","",""); document.getElementById("jira-fetch-btn").disabled=false; }',
    '',
    'function selectJiraProject(el, collapse){ document.querySelectorAll("#jira-project-list .proj-item").forEach(function(e){e.style.background="";e.style.color="";e.style.fontWeight="";}); el.style.background="var(--vscode-list-activeSelectionBackground,#094771)"; el.style.color="var(--vscode-list-activeSelectionForeground,#fff)"; el.style.fontWeight="600"; document.getElementById("jira-project").value=el.getAttribute("data-key"); var key=el.getAttribute("data-key"); if(key){setStatus("jira","ok","Selected: "+key); if(collapse){document.getElementById("jira-project-list").style.display="none"; document.getElementById("jira-project-search-row").style.display="none";} loadJiraFields(key);}else{setStatus("jira","",""); document.getElementById("jira-fields-section").style.display="none";} }',
    '',
    'function renderJiraProjects(projects){',
    '  var list=document.getElementById("jira-project-list");',
    '  var currentVal=document.getElementById("jira-project").value;',
    '  list.innerHTML="";',
    '  // No-default option',
    '  var noneRow=document.createElement("div");',
    '  noneRow.className="proj-item proj-none";',
    '  noneRow.setAttribute("data-key","");',
    '  noneRow.textContent="\\u2014 No default (specify per request) \\u2014";',
    '  noneRow.addEventListener("click",function(){selectJiraProject(noneRow, true);});',
    '  list.appendChild(noneRow);',
    '  // Project rows',
    '  projects.forEach(function(p){',
    '    var row=document.createElement("div");',
    '    row.className="proj-item";',
    '    row.setAttribute("data-key",p.key);',
    '    row.innerHTML="<strong>"+p.key.replace(/</g,"&lt;")+"</strong> \\u2014 "+p.name.replace(/</g,"&lt;");',
    '    if(p.key===currentVal){ row.style.background="var(--vscode-list-activeSelectionBackground,#094771)"; row.style.color="var(--vscode-list-activeSelectionForeground,#fff)"; row.style.fontWeight="600"; }',
    '    row.addEventListener("click",function(){selectJiraProject(row, true);});',
    '    list.appendChild(row);',
    '  });',
    '  list.style.display="block";',
    '  var target=currentVal||(pre&&pre.jiraProject)||"";',
    '  if(target){ var found=list.querySelector("[data-key=\'" + target + "\']"); if(found){selectJiraProject(found, false);} }',
    '  var total=(_allJiraProjects||[]).length;',
    '  var countEl=document.getElementById("jira-project-count");',
    '  if(projects.length<total){countEl.textContent="Showing "+projects.length+" of "+total;countEl.style.display="block";}else{countEl.style.display="none";}',
    '}',
    '',
    'function filterJiraProjects(){ var q=document.getElementById("jira-project-search").value.toLowerCase().trim(); var all=_allJiraProjects||[]; if(!q){renderJiraProjects(all);return;} var filtered=all.filter(function(p){return p.key.toLowerCase().indexOf(q)>=0||p.name.toLowerCase().indexOf(q)>=0;}); renderJiraProjects(filtered); }',
    '',
    '// ── Jira field defaults ──',
    'var _jiraFieldsByType = {};',
    'var _jiraFieldDefaults = pre.jiraFieldDefaults || {};',
    '',
    'function loadJiraFields(projectKey){',
    '  var section = document.getElementById("jira-fields-section");',
    '  var loading = document.getElementById("jira-fields-loading");',
    '  var container = document.getElementById("jira-fields-container");',
    '  section.style.display = "block";',
    '  loading.style.display = "block";',
    '  container.innerHTML = "";',
    '  var jtEl = document.getElementById("jira-token");',
    '  var baseUrl = document.getElementById("jira-url").value.trim();',
    '  var email = document.getElementById("jira-email").value.trim();',
    '  var token = jtEl.dataset.hasStored === "1" ? "__stored__" : jtEl.value.trim();',
    '  if(token === "__stored__"){ vscode.postMessage({type:"fetchJiraFieldsStored", projectKey:projectKey}); }',
    '  else{ vscode.postMessage({type:"fetchJiraFields", baseUrl:baseUrl, email:email, token:token, projectKey:projectKey}); }',
    '}',
    '',
    'function renderJiraFields(fieldsByType, types){',
    '  _jiraFieldsByType = fieldsByType;',
    '  var container = document.getElementById("jira-fields-container");',
    '  var loading = document.getElementById("jira-fields-loading");',
    '  loading.style.display = "none";',
    '  container.innerHTML = "";',
    '  var hasFields = false;',
    '  types.forEach(function(typeName){',
    '    var fields = fieldsByType[typeName];',
    '    if(!fields || !fields.length) return;',
    '    hasFields = true;',
    '    var group = document.createElement("div");',
    '    group.style.cssText = "margin-bottom:12px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;padding:10px;";',
    '    var title = document.createElement("div");',
    '    title.style.cssText = "font-weight:600;font-size:12px;margin-bottom:8px;";',
    '    title.textContent = typeName;',
    '    group.appendChild(title);',
    '    fields.forEach(function(f){',
    '      var row = document.createElement("div");',
    '      row.style.cssText = "margin-bottom:6px;";',
    '      var lbl = document.createElement("label");',
    '      lbl.style.cssText = "display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;";',
    '      lbl.textContent = f.name + (f.required ? " *" : "");',
    '      row.appendChild(lbl);',
    '      var saved = (_jiraFieldDefaults[typeName] && _jiraFieldDefaults[typeName][f.key]) || "";',
    '      if(f.allowedValues && f.allowedValues.length){',
    '        var sel = document.createElement("select");',
    '        sel.setAttribute("data-type", typeName);',
    '        sel.setAttribute("data-field", f.key);',
    '        sel.setAttribute("data-ftype", f.type);',
    '        sel.style.cssText = "width:100%;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px;";',
    '        var empty = document.createElement("option");',
    '        empty.value = ""; empty.textContent = "-- select --";',
    '        sel.appendChild(empty);',
    '        f.allowedValues.forEach(function(av){',
    '          var opt = document.createElement("option");',
    '          opt.value = JSON.stringify({id:av.id, value:av.value});',
    '          opt.textContent = av.value;',
    '          if(saved && (JSON.stringify({id:av.id,value:av.value}) === JSON.stringify(saved))) opt.selected = true;',
    '          sel.appendChild(opt);',
    '        });',
    '        row.appendChild(sel);',
    '      } else {',
    '        var inp = document.createElement("input");',
    '        inp.type = f.type === "number" ? "number" : "text";',
    '        inp.setAttribute("data-type", typeName);',
    '        inp.setAttribute("data-field", f.key);',
    '        inp.setAttribute("data-ftype", f.type);',
    '        inp.placeholder = f.type === "date" ? "YYYY-MM-DD" : "";',
    '        inp.style.cssText = "width:100%;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px;";',
    '        if(saved) inp.value = typeof saved === "string" ? saved : JSON.stringify(saved);',
    '        row.appendChild(inp);',
    '      }',
    '      group.appendChild(row);',
    '    });',
    '    container.appendChild(group);',
    '  });',
    '  if(!hasFields){',
    '    container.innerHTML = "<div style=\\"font-size:11px;color:var(--vscode-descriptionForeground);padding:6px\\">No additional required fields found for this project.</div>";',
    '  }',
    '  setStatus("jira-fields","ok","Fields loaded. Set defaults for required fields.");',
    '}',
    '',
    'function collectJiraFieldDefaults(){',
    '  var defaults = {};',
    '  var inputs = document.querySelectorAll("#jira-fields-container [data-field]");',
    '  inputs.forEach(function(el){',
    '    var typeName = el.getAttribute("data-type");',
    '    var fieldKey = el.getAttribute("data-field");',
    '    var ftype = el.getAttribute("data-ftype");',
    '    var val = null;',
    '    if(el.tagName === "SELECT"){',
    '      if(el.value) try{ val = JSON.parse(el.value); }catch(e){ val = el.value; }',
    '    } else {',
    '      if(el.value.trim()){',
    '        val = ftype === "number" ? Number(el.value) : el.value.trim();',
    '      }',
    '    }',
    '    if(val !== null){',
    '      if(!defaults[typeName]) defaults[typeName] = {};',
    '      defaults[typeName][fieldKey] = val;',
    '    }',
    '  });',
    '  return defaults;',
    '}',
    '',
    'function onMessage(e){',
    '  var msg=e.data;',
    '  if(msg.type==="adoProjects"){ var sel=document.getElementById("ado-project"); sel.innerHTML=\'<option value="">\\u2014 Select a project \\u2014</option>\'; msg.projects.forEach(function(p){var opt=document.createElement("option");opt.value=opt.textContent=p.name;sel.appendChild(opt);}); sel.style.display="block"; setStatus("ado","ok",msg.projects.length+" project"+(msg.projects.length!==1?"s":"")+" loaded."); document.getElementById("ado-fetch-btn").disabled=false; }',
    '  if(msg.type==="adoProjectsError"){ setStatus("ado","error","Could not load projects: "+msg.error); document.getElementById("ado-fetch-btn").disabled=false; }',
    '  if(msg.type==="jiraProjects"){ _allJiraProjects=msg.projects; renderJiraProjects(msg.projects); var total=msg.total||msg.projects.length; setStatus("jira","ok",total+" project"+(total!==1?"s":"")+" loaded."); document.getElementById("jira-fetch-btn").disabled=false; document.getElementById("jira-project-search-row").style.display="block"; document.getElementById("jira-project-search").focus(); }',
    '  if(msg.type==="jiraProjectCount"){ setStatus("jira","","Loaded "+msg.count+" projects so far..."); }',
    '  if(msg.type==="jiraProjectsError"){ setStatus("jira","error","Could not load projects: "+msg.error); document.getElementById("jira-fetch-btn").disabled=false; }',
    '  if(msg.type==="jiraFields"){ renderJiraFields(msg.fieldsByType, msg.types); }',
    '  if(msg.type==="jiraFieldsError"){ document.getElementById("jira-fields-loading").style.display="none"; setStatus("jira-fields","error","Could not load fields: "+msg.error); }',
    '  if(msg.type==="saveSuccess"){ setStatus(msg.platform,"ok","Saved successfully. You can switch tabs to configure the other platform."); document.getElementById("save-btn").textContent="Save and Connect"; _lastSaved=msg.platform; }',
    '  if(msg.type==="saveError"){ setStatus(activeTab(),"error","Save failed: "+msg.error); }',
    '  if(msg.type==="tokenStatus"){',
    '    var el=document.getElementById(msg.platform+"-token-status");',
    '    if(el){',
    '      if(msg.valid){ el.innerHTML="<span style=\\"color:var(--vscode-testing-iconPassed,#4caf50)\\">\\u2713 Valid \\u2014 "+msg.user+"</span>"; }',
    '      else{ el.innerHTML="<span style=\\"color:var(--vscode-errorForeground)\\">\\u2717 Invalid \\u2014 "+msg.error+"</span>"; }',
    '    }',
    '  }',
    '}',
    '',
    'var _lastSaved = null;',
    '',
    'function validateToken(platform){',
    '  if(platform==="jira"){',
    '    var baseUrl=document.getElementById("jira-url").value.trim();',
    '    var email=document.getElementById("jira-email").value.trim();',
    '    var jtEl=document.getElementById("jira-token");',
    '    if(jtEl.dataset.hasStored==="1"){ vscode.postMessage({type:"validateToken",platform:"jira",baseUrl:baseUrl,email:email,useStored:true}); }',
    '    else{ var token=jtEl.value.trim(); if(baseUrl&&email&&token){ vscode.postMessage({type:"validateToken",platform:"jira",baseUrl:baseUrl,email:email,token:token}); } }',
    '  } else {',
    '    var orgUrl=document.getElementById("ado-org").value.trim();',
    '    var atEl=document.getElementById("ado-token");',
    '    if(atEl.dataset.hasStored==="1"){ vscode.postMessage({type:"validateToken",platform:"ado",orgUrl:orgUrl,useStored:true}); }',
    '    else{ var token2=atEl.value.trim(); if(orgUrl&&token2){ vscode.postMessage({type:"validateToken",platform:"ado",orgUrl:orgUrl,token:token2}); } }',
    '  }',
    '}',
    '',
    '// Auto-validate stored tokens on load',
    'if(pre._hasJiraToken && pre.jiraBaseUrl && pre.jiraEmail){ validateToken("jira"); }',
    'if(pre._hasAdoToken && pre.adoOrgUrl){ validateToken("ado"); }',
    '',
    'function save(){',
    '  var tab=activeTab();',
    '  if(tab==="jira"){',
    '    var baseUrl=document.getElementById("jira-url").value.trim();',
    '    var email=document.getElementById("jira-email").value.trim();',
    '    var jtEl=document.getElementById("jira-token");',
    '    var project=document.getElementById("jira-project").value;',
    '    var token=jtEl.dataset.hasStored==="1"?"":jtEl.value.trim();',
    '    if(!baseUrl){alert("Enter your Jira Base URL.");return;}',
    '    if(!email){alert("Enter your Jira account email.");return;}',
    '    if(!token&&jtEl.dataset.hasStored!=="1"){alert("Enter your Jira API token.");return;}',
    '    vscode.postMessage({type:"save",data:{platform:"jira",jiraBaseUrl:baseUrl,jiraEmail:email,jiraToken:token,jiraProject:project,jiraFieldDefaults:collectJiraFieldDefaults()}});',
    '  } else {',
    '    var orgUrl=document.getElementById("ado-org").value.trim();',
    '    var atEl=document.getElementById("ado-token");',
    '    var project2=document.getElementById("ado-project").value;',
    '    var token2=atEl.dataset.hasStored==="1"?"":atEl.value.trim();',
    '    if(!orgUrl){alert("Enter your Azure DevOps Organisation URL.");return;}',
    '    if(!token2&&atEl.dataset.hasStored!=="1"){alert("Enter your Personal Access Token.");return;}',
    '    if(!project2){alert("Load and select a project first.");return;}',
    '    vscode.postMessage({type:"save",data:{platform:"azuredevops",adoOrgUrl:orgUrl,adoToken:token2,adoProject:project2}});',
    '  }',
    '}',
  ].join('\n');
}
