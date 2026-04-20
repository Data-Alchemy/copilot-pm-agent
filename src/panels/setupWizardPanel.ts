// src/panels/setupWizardPanel.ts
import * as vscode from 'vscode';

export type Platform = 'jira' | 'azuredevops' | 'github';

export interface SetupResult {
  platform:     Platform;
  jiraBaseUrl?: string;
  jiraEmail?:   string;
  jiraToken?:   string;
  jiraProject?: string;
  adoOrgUrl?:   string;
  adoProject?:  string;
  adoToken?:    string;
  githubOwner?: string;
  githubRepo?:  string;
  githubToken?: string;
  githubProjectNumber?: number;
  /** Per-issueType default values for custom/required fields */
  jiraFieldDefaults?: Record<string, Record<string, unknown>>;
  /** Cross-platform type mappings: { "ado-to-jira": {"User Story":"Story"}, ... } */
  typeMappings?: Record<string, Record<string, string>>;
}

const ALLOWED_URLS: Record<string, string> = {
  jiraTokenPage: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  githubTokenPage: 'https://github.com/settings/tokens',
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
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [context.extensionUri] }
      );

      const pre = existingCreds ?? {};
      panel.webview.html = getHtml(pre);

      let _lastSavedResult: SetupResult | undefined;

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
                _lastSavedResult = data;
              } else if (data.platform === 'github') {
                await config.update('platform', 'github', vscode.ConfigurationTarget.Global);
                const root = vscode.workspace.getConfiguration();
                await root.update('pmAgent.github.owner', data.githubOwner!, vscode.ConfigurationTarget.Global);
                await root.update('pmAgent.github.repo', data.githubRepo!, vscode.ConfigurationTarget.Global);
                if (data.githubProjectNumber) {
                  await root.update('pmAgent.github.projectNumber', data.githubProjectNumber, vscode.ConfigurationTarget.Global);
                }
                if (data.githubToken) {
                  await context.secrets.store('pmAgent.github.personalAccessToken', data.githubToken);
                }
                panel.webview.postMessage({ type: 'saveSuccess', platform: 'github' });
                _lastSavedResult = data;
              } else {
                await config.update('platform', 'azuredevops', vscode.ConfigurationTarget.Global);
                await config.update('azureDevOps.orgUrl', data.adoOrgUrl!, vscode.ConfigurationTarget.Global);
                await config.update('azureDevOps.project', data.adoProject!, vscode.ConfigurationTarget.Global);
                if (data.adoToken) {
                  await context.secrets.store('pmAgent.ado.personalAccessToken', data.adoToken);
                }
                panel.webview.postMessage({ type: 'saveSuccess', platform: 'ado' });
                _lastSavedResult = data;
              }
              // Save type mappings (applies across all platforms)
              if (data.typeMappings && Object.keys(data.typeMappings).length) {
                await context.globalState.update('pmAgent.typeMappings', data.typeMappings);
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
            } else if (platform === 'github') {
              let token = String(msg.token ?? '');
              if (msg.useStored) {
                token = await context.secrets.get('pmAgent.github.personalAccessToken') ?? '';
              }
              if (!token) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'github', valid: false, error: 'Missing token' });
                break;
              }
              try {
                const res = await globalThis.fetch('https://api.github.com/user', {
                  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
                });
                if (res.ok) {
                  const user = await res.json() as any;
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'github', valid: true, user: user.login ?? 'OK' });
                } else {
                  panel.webview.postMessage({ type: 'tokenStatus', platform: 'github', valid: false, error: `HTTP ${res.status}` });
                }
              } catch (err) {
                panel.webview.postMessage({ type: 'tokenStatus', platform: 'github', valid: false, error: err instanceof Error ? err.message : String(err) });
              }
            }
            break;
          }
          case 'loadTypeMaps': {
            // Fetch work item types from all configured platforms
            try {
              const cfg = vscode.workspace.getConfiguration('pmAgent');
              const secrets = context.secrets;
              const platformTypes: Record<string, string[]> = {};

              // Jira
              const jiraToken = await secrets.get('pmAgent.jira.apiToken');
              const jiraBase = cfg.get<string>('jira.baseUrl');
              const jiraEmail = cfg.get<string>('jira.email');
              const jiraProj = cfg.get<string>('jira.defaultProject');
              if (jiraToken && jiraBase && jiraEmail && jiraProj) {
                try {
                  const { JiraProvider } = await import('../providers/jiraProvider');
                  const jp = new JiraProvider({ platform: 'jira', jiraBaseUrl: jiraBase, jiraEmail, jiraToken, jiraProject: jiraProj });
                  platformTypes['jira'] = await jp.getWorkItemTypes();
                } catch { /* skip */ }
              }

              // ADO
              const adoToken = await secrets.get('pmAgent.ado.personalAccessToken');
              const adoOrg = cfg.get<string>('azureDevOps.orgUrl');
              const adoProj = cfg.get<string>('azureDevOps.project');
              if (adoToken && adoOrg && adoProj) {
                try {
                  const { AdoProvider } = await import('../providers/adoProvider');
                  const ap = new AdoProvider({ platform: 'azuredevops', adoOrgUrl: adoOrg, adoProject: adoProj, adoToken });
                  platformTypes['ado'] = await ap.getWorkItemTypes();
                } catch { /* skip */ }
              }

              // GitHub
              const ghToken = await secrets.get('pmAgent.github.personalAccessToken');
              const ghOwner = cfg.get<string>('github.owner');
              const ghRepo = cfg.get<string>('github.repo');
              if (ghToken && ghOwner && ghRepo) {
                try {
                  const { GitHubProvider } = await import('../providers/githubProvider');
                  const gp = new GitHubProvider({ platform: 'github', githubOwner: ghOwner, githubRepo: ghRepo, githubToken: ghToken });
                  platformTypes['github'] = await gp.getWorkItemTypes();
                } catch { /* skip */ }
              }

              panel.webview.postMessage({ type: 'typeMaps', platformTypes });
            } catch (err) {
              panel.webview.postMessage({ type: 'typeMapsError', error: err instanceof Error ? err.message : String(err) });
            }
            break;
          }
          case 'fetchGithubProjects': {
            const ghOwner = String(msg.owner ?? '');
            let ghToken = String(msg.token ?? '');
            if (msg.useStored) {
              ghToken = await context.secrets.get('pmAgent.github.personalAccessToken') ?? '';
            }
            if (!ghOwner || !ghToken) {
              panel.webview.postMessage({ type: 'githubProjectsError', error: 'Missing owner or token' });
              break;
            }
            try {
              // Try org projects, then user projects
              let projects: Array<{ number: number; title: string }> = [];
              for (const ownerType of ['organization', 'user']) {
                try {
                  const res = await globalThis.fetch('https://api.github.com/graphql', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${ghToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      query: `query($owner: String!) { ${ownerType}(login: $owner) { projectsV2(first: 50) { nodes { number title } } } }`,
                      variables: { owner: ghOwner }
                    })
                  });
                  if (res.ok) {
                    const data = await res.json() as any;
                    const nodes = data?.data?.[ownerType]?.projectsV2?.nodes ?? [];
                    if (nodes.length) { projects = nodes; break; }
                  }
                } catch { /* try next */ }
              }
              panel.webview.postMessage({ type: 'githubProjects', projects });
            } catch (err) {
              panel.webview.postMessage({ type: 'githubProjectsError', error: err instanceof Error ? err.message : String(err) });
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
            // Read from config (not pre) in case user changed fields
            const cfg = vscode.workspace.getConfiguration('pmAgent');
            const bUrl = String(cfg.get<string>('jira.baseUrl') ?? pre.jiraBaseUrl ?? '').replace(/\/$/, '');
            const em = String(cfg.get<string>('jira.email') ?? pre.jiraEmail ?? '');
            const pk = String(msg.projectKey ?? '');
            if (!storedToken || !bUrl || !em || !pk) {
              panel.webview.postMessage({ type: 'jiraFieldsError', error: 'Missing credentials. Save your Jira config first, then select a project.' });
              break;
            }
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

      panel.onDidDispose(() => {
        if (!settled) {
          settled = true;
          resolve(_lastSavedResult);
        }
      });
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
    '  <button class="tab" id="tab-github">GitHub</button>',
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
    '    <div class="hint" style="margin-bottom:8px">Your board has required fields with fixed options. Set defaults here so tickets create without errors. Fields that depend on context (text, dates) are handled during ticket creation.</div>',
    '    <div id="jira-fields-loading" style="display:none"><span class="spinner"></span> Scanning create screens...</div>',
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
    '<div class="section" id="section-github">',
    '  <div class="info-box">',
    '    <strong>Required:</strong> Owner (org or user) &middot; Repository &middot; Personal Access Token<br>',
    '    Create a PAT at <a href="#" id="gh-token-link">github.com/settings/tokens</a>.<br>Classic PAT: <strong>repo</strong>, <strong>project</strong>, <strong>read:org</strong> scopes.<br>Fine-grained: Issues (RW), Projects (RW), Metadata (R), Org Members (R).',
    '  </div>',
    '  <div class="field"><label>Owner</label><input type="text" id="gh-owner" placeholder="your-org or your-username" autocomplete="off" spellcheck="false"/><div class="hint">GitHub organisation or personal account</div></div>',
    '  <div class="field"><label>Repository</label><input type="text" id="gh-repo" placeholder="my-repo" autocomplete="off" spellcheck="false"/><div class="hint">Repository where issues are created</div></div>',
    '  <div class="field"><label>Personal Access Token</label><div class="input-row"><input type="password" id="gh-token" placeholder="ghp_xxxxxxxxxxxx" autocomplete="new-password"/><button class="btn btn-outline" id="gh-gen-btn">Generate token</button><button class="btn btn-secondary" id="gh-validate-btn" style="margin-left:4px">Validate</button></div><div id="github-token-status" style="font-size:11px;margin-top:4px;min-height:16px"></div><div class="hint">Classic: repo + project + read:org. Fine-grained: Issues, Projects, Metadata, Org Members.</div></div>',
    '  <div class="field"><label>Project Number (optional)</label><input type="number" id="gh-project-num" placeholder="e.g. 1" autocomplete="off"/><div class="hint">GitHub Projects v2 number. Find it in your project URL: github.com/orgs/ORG/projects/<strong>NUMBER</strong></div></div>',
    '  <div class="field"><button class="btn btn-secondary" id="gh-fetch-btn">Load Projects</button><div class="project-status" id="github-project-status"></div><div id="gh-project-list" style="display:none;margin-top:6px;max-height:200px;overflow-y:auto;border:1px solid var(--vscode-input-border);border-radius:3px;background:var(--vscode-input-background)"></div></div>',
    '</div>',
    '',
    '<hr>',
    '<div style="margin-top:16px">',
    '  <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Type Mapping (Migration)</label>',
    '  <div class="hint" style="margin-bottom:8px">Configure how types map when migrating between platforms. Select direction, then map each type.</div>',
    '  <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">',
    '    <select id="typemap-src" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px"><option value="">Source platform</option></select>',
    '    <span style="color:var(--vscode-descriptionForeground)">\\u2192</span>',
    '    <select id="typemap-dst" style="flex:1;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px"><option value="">Destination platform</option></select>',
    '    <button class="btn btn-secondary" id="load-type-maps-btn">Load</button>',
    '  </div>',
    '  <div class="project-status" id="typemap-status"></div>',
    '  <div id="typemap-container" style="margin-top:8px"></div>',
    '</div>',
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
    'document.getElementById("tab-github").addEventListener("click", function(){ switchTab("github"); });',
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
    'document.getElementById("gh-gen-btn").addEventListener("click", function(){ vscode.postMessage({type:"openUrl",url:"githubTokenPage"}); });',
    'document.getElementById("gh-token-link").addEventListener("click", function(e){ e.preventDefault(); vscode.postMessage({type:"openUrl",url:"githubTokenPage"}); });',
    'document.getElementById("gh-validate-btn").addEventListener("click", function(){ validateToken("github"); });',
    'document.getElementById("gh-fetch-btn").addEventListener("click", function(){ fetchGithubProjects(); });',
    'document.getElementById("load-type-maps-btn").addEventListener("click", function(){ vscode.postMessage({type:"loadTypeMaps"}); });',
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
    'if(pre.githubOwner) document.getElementById("gh-owner").value = pre.githubOwner;',
    'if(pre.githubRepo) document.getElementById("gh-repo").value = pre.githubRepo;',
    'if(pre.githubProjectNumber) document.getElementById("gh-project-num").value = pre.githubProjectNumber;',
    'if(pre._hasGithubToken){ var gt=document.getElementById("gh-token"); gt.value="\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022"; gt.dataset.hasStored="1"; gt.addEventListener("input",function(){ gt.dataset.hasStored="0"; }); }',
    'switchTab(pre.platform === "azuredevops" ? "ado" : pre.platform === "github" ? "github" : "jira");',
    '',
    '// Auto-fetch projects using stored tokens (tokens stay in extension host)',
    'if(pre._hasJiraToken && pre.jiraBaseUrl && pre.jiraEmail){ setStatus("jira","","Loading projects..."); document.getElementById("jira-fetch-btn").disabled=true; vscode.postMessage({type:"requestAutoFetch",platform:"jira"}); }',
    'if(pre._hasAdoToken && pre.adoOrgUrl){ setStatus("ado","ok","Loading projects..."); document.getElementById("ado-fetch-btn").disabled=true; vscode.postMessage({type:"requestAutoFetch",platform:"ado"}); }',
    '',
    'window.addEventListener("message", onMessage);',
    '',
    '// ── Functions ──',
    'function switchTab(tab){ document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active")}); document.querySelectorAll(".section").forEach(function(s){s.classList.remove("visible")}); document.getElementById("tab-"+tab).classList.add("active"); document.getElementById("section-"+tab).classList.add("visible"); }',
    'function activeTab(){ if(document.getElementById("tab-ado").classList.contains("active")) return "ado"; if(document.getElementById("tab-github").classList.contains("active")) return "github"; return "jira"; }',
    'function openUrl(key){ vscode.postMessage({type:"openUrl",url:key}); }',
    'function openAdoTokenPage(){ var orgUrl=document.getElementById("ado-org").value.trim(); var orgName=orgUrl?orgUrl.replace(/\\/$/, "").split("/").pop():null; var url=orgName?"https://dev.azure.com/"+orgName+"/_usersSettings/tokens":"https://dev.azure.com/_usersSettings/tokens"; vscode.postMessage({type:"openUrl",url:url}); }',
    'function setStatus(platform,cls,html){ var el=document.getElementById(platform+"-project-status")||document.getElementById(platform+"-status"); if(!el)return; el.className="project-status"+(cls?" "+cls:""); el.innerHTML=html; }',
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
    '  if(!baseUrl || !email){ loading.style.display="none"; setStatus("jira-fields","error","Enter Jira URL and email first."); return; }',
    '  var hasStored = jtEl.dataset.hasStored === "1";',
    '  var token = hasStored ? "" : jtEl.value.trim();',
    '  if(!hasStored && !token){ loading.style.display="none"; setStatus("jira-fields","error","Enter or save your API token first."); return; }',
    '  if(hasStored){ vscode.postMessage({type:"fetchJiraFieldsStored", projectKey:projectKey}); }',
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
    '  var totalDefaults = 0;',
    '  types.forEach(function(typeName){',
    '    var fields = fieldsByType[typeName];',
    '    if(!fields || !fields.length) return;',
    '    // Only show required fields with fixed options — those need defaults',
    '    var defaultable = fields.filter(function(f){ return f.required && f.allowedValues && f.allowedValues.length; });',
    '    if(!defaultable.length) return;',
    '    hasFields = true;',
    '    totalDefaults += defaultable.length;',
    '    var group = document.createElement("div");',
    '    group.style.cssText = "margin-bottom:10px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;padding:10px;";',
    '    var title = document.createElement("div");',
    '    title.style.cssText = "font-weight:600;font-size:12px;margin-bottom:8px;";',
    '    title.textContent = typeName + " (" + defaultable.length + " required)";',
    '    group.appendChild(title);',
    '    defaultable.forEach(function(f){',
    '      var row = document.createElement("div");',
    '      row.style.cssText = "margin-bottom:6px;";',
    '      var lbl = document.createElement("label");',
    '      lbl.style.cssText = "display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;";',
    '      lbl.textContent = f.name + " *";',
    '      row.appendChild(lbl);',
    '      var saved = (_jiraFieldDefaults[typeName] && _jiraFieldDefaults[typeName][f.key]) || "";',
    '      var sel = document.createElement("select");',
    '      sel.setAttribute("data-type", typeName);',
    '      sel.setAttribute("data-field", f.key);',
    '      sel.setAttribute("data-ftype", f.type);',
    '      sel.style.cssText = "width:100%;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px;";',
    '      var empty = document.createElement("option");',
    '      empty.value = ""; empty.textContent = "-- select default --";',
    '      sel.appendChild(empty);',
    '      f.allowedValues.forEach(function(av){',
    '        var opt = document.createElement("option");',
    '        opt.value = JSON.stringify({id:av.id, value:av.value});',
    '        opt.textContent = av.value;',
    '        if(saved && (JSON.stringify({id:av.id,value:av.value}) === JSON.stringify(saved))) opt.selected = true;',
    '        sel.appendChild(opt);',
    '      });',
    '      row.appendChild(sel);',
    '      group.appendChild(row);',
    '    });',
    '    container.appendChild(group);',
    '  });',
    '  if(!hasFields){',
    '    var msg = "No required dropdown fields found \\u2014 your board\\u0027s required fields will be handled during ticket creation";',
    '    var allReq = 0;',
    '    types.forEach(function(t){ var ff=fieldsByType[t]; if(ff) allReq += ff.filter(function(f){return f.required;}).length; });',
    '    if(allReq > 0) msg += " (" + allReq + " required field" + (allReq!==1?"s":"") + " will be prompted).";',
    '    else msg += ".";',
    '    container.innerHTML = "<div style=\\"font-size:11px;color:var(--vscode-descriptionForeground);padding:6px\\">" + msg + "</div>";',
    '    setStatus("jira-fields","ok","No defaults needed \\u2014 all fields handled at create time.");',
    '  } else {',
    '    setStatus("jira-fields","ok",totalDefaults + " required field" + (totalDefaults!==1?"s":"") + " need defaults. Set them above, then Save.");',
    '  }',
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
    '// ── Type mapping ──',
    'var _typeMappings = pre.typeMappings || {};',
    'var _platformTypes = {};',
    'var _defaultMaps = {"User Story":"Story","Product Backlog Item":"Story","Requirement":"Story","Story":"User Story","Enhancement":"Feature","Task":"Task","Bug":"Bug","Epic":"Epic","Feature":"Feature","Sub-task":"Task","Test Case":"Task","Test":"Task","bug":"Bug","enhancement":"Story","task":"Task","epic":"Epic"};',
    '',
    'function renderTypeMaps(platformTypes){',
    '  _platformTypes = platformTypes;',
    '  var srcSel = document.getElementById("typemap-src");',
    '  var dstSel = document.getElementById("typemap-dst");',
    '  var labels = {jira:"Jira",ado:"Azure DevOps",github:"GitHub"};',
    '  srcSel.innerHTML = "<option value=\\"\\">Source</option>";',
    '  dstSel.innerHTML = "<option value=\\"\\">Destination</option>";',
    '  Object.keys(platformTypes).forEach(function(k){',
    '    var o1=document.createElement("option");o1.value=k;o1.textContent=labels[k]||k;srcSel.appendChild(o1);',
    '    var o2=document.createElement("option");o2.value=k;o2.textContent=labels[k]||k;dstSel.appendChild(o2);',
    '  });',
    '  var keys=Object.keys(platformTypes);',
    '  if(keys.length>=2){srcSel.value=keys[0];dstSel.value=keys[1];showMappingForPair();}',
    '  else{setStatus("typemap","","Configure at least 2 platforms first.");}',
    '}',
    '',
    'function showMappingForPair(){',
    '  var src=document.getElementById("typemap-src").value;',
    '  var dst=document.getElementById("typemap-dst").value;',
    '  var container=document.getElementById("typemap-container");',
    '  container.innerHTML="";',
    '  if(!src||!dst||src===dst){setStatus("typemap","","Select different source and destination.");return;}',
    '  var srcTypes=_platformTypes[src]||[];',
    '  var dstTypes=_platformTypes[dst]||[];',
    '  if(!srcTypes.length||!dstTypes.length){setStatus("typemap","error","No types found.");return;}',
    '  var key=src+"-to-"+dst;',
    '  var saved=_typeMappings[key]||{};',
    '  srcTypes.forEach(function(srcType){',
    '    var row=document.createElement("div");',
    '    row.style.cssText="display:flex;align-items:center;gap:8px;margin-bottom:4px;";',
    '    var lbl=document.createElement("span");',
    '    lbl.style.cssText="font-size:12px;min-width:140px;";',
    '    lbl.textContent=srcType;',
    '    row.appendChild(lbl);',
    '    var arrow=document.createElement("span");arrow.textContent="\\u2192";arrow.style.color="var(--vscode-descriptionForeground)";',
    '    row.appendChild(arrow);',
    '    var sel=document.createElement("select");',
    '    sel.setAttribute("data-mapkey",key);',
    '    sel.setAttribute("data-srctype",srcType);',
    '    sel.style.cssText="flex:1;padding:4px 6px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#555);border-radius:3px;font-size:12px;";',
    '    var def=document.createElement("option");def.value="";def.textContent="-- skip --";sel.appendChild(def);',
    '    var best=saved[srcType]||"";',
    '    if(!best){',
    '      var exact=dstTypes.find(function(d){return d.toLowerCase()===srcType.toLowerCase();});',
    '      if(exact)best=exact;',
    '      else if(_defaultMaps[srcType]){var m=_defaultMaps[srcType];var f=dstTypes.find(function(d){return d.toLowerCase()===m.toLowerCase();});if(f)best=f;}',
    '    }',
    '    dstTypes.forEach(function(dt){',
    '      var opt=document.createElement("option");opt.value=dt;opt.textContent=dt;',
    '      if(dt===best)opt.selected=true;',
    '      sel.appendChild(opt);',
    '    });',
    '    row.appendChild(sel);',
    '    container.appendChild(row);',
    '  });',
    '  var labels={jira:"Jira",ado:"Azure DevOps",github:"GitHub"};',
    '  setStatus("typemap","ok",(labels[src]||src)+" \\u2192 "+(labels[dst]||dst)+": "+srcTypes.length+" types. Save to persist.");',
    '}',
    '',
    'document.getElementById("typemap-src").addEventListener("change",showMappingForPair);',
    'document.getElementById("typemap-dst").addEventListener("change",showMappingForPair);',
    '',
    'function collectTypeMappings(){',
    '  var mappings=JSON.parse(JSON.stringify(_typeMappings));',
    '  var selects=document.querySelectorAll("#typemap-container [data-mapkey]");',
    '  selects.forEach(function(sel){',
    '    var key=sel.getAttribute("data-mapkey");',
    '    var srcType=sel.getAttribute("data-srctype");',
    '    var val=sel.value;',
    '    if(val){',
    '      if(!mappings[key])mappings[key]={};',
    '      mappings[key][srcType]=val;',
    '    }',
    '  });',
    '  return mappings;',
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
    '  if(msg.type==="githubProjects"){',
    '    var list=document.getElementById("gh-project-list"); list.innerHTML=""; list.style.display="block";',
    '    if(!msg.projects||!msg.projects.length){ setStatus("github","","No projects found. You can enter the project number manually."); list.style.display="none"; }',
    '    else{',
    '      msg.projects.forEach(function(p){',
    '        var row=document.createElement("div");',
    '        row.style.cssText="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--vscode-panel-border,#333)";',
    '        row.textContent="#"+p.number+" "+p.title;',
    '        row.addEventListener("click",function(){ document.getElementById("gh-project-num").value=p.number; list.style.display="none"; setStatus("github","ok","Project #"+p.number+" selected."); });',
    '        row.addEventListener("mouseenter",function(){row.style.background="var(--vscode-list-hoverBackground)";});',
    '        row.addEventListener("mouseleave",function(){row.style.background="";});',
    '        list.appendChild(row);',
    '      });',
    '      setStatus("github","ok",msg.projects.length+" project"+(msg.projects.length!==1?"s":"")+" found. Click to select.");',
    '    }',
    '  }',
    '  if(msg.type==="githubProjectsError"){ setStatus("github","error","Could not load projects: "+msg.error); }',
    '  if(msg.type==="typeMaps"){ renderTypeMaps(msg.platformTypes); }',
    '  if(msg.type==="typeMapsError"){ setStatus("typemap","error","Could not load types: "+msg.error); }',
    '  if(msg.type==="saveSuccess"){ setStatus(msg.platform,"ok","Saved successfully. You can switch tabs to configure the other platform."); document.getElementById("save-btn").textContent="Save and Connect"; _lastSaved=msg.platform; }',
    '  if(msg.type==="saveError"){ setStatus(activeTab(),"error","Save failed: "+msg.error); }',
    '  if(msg.type==="tokenStatus"){',
    '    var el=document.getElementById(msg.platform+"-token-status");',
    '    if(el){',
    '      var safe=function(s){return String(s||\"\").replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\").replace(/\"/g,\"&quot;\");};',
    '      if(msg.valid){ el.innerHTML="<span style=\\"color:var(--vscode-testing-iconPassed,#4caf50)\\">\\u2713 Valid \\u2014 "+safe(msg.user)+"</span>"; }',
    '      else{ el.innerHTML="<span style=\\"color:var(--vscode-errorForeground)\\">\\u2717 Invalid \\u2014 "+safe(msg.error)+"</span>"; }',
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
    '  } else if(platform==="github"){',
    '    var owner=document.getElementById("gh-owner").value.trim();',
    '    var gtEl=document.getElementById("gh-token");',
    '    if(gtEl.dataset.hasStored==="1"){ vscode.postMessage({type:"validateToken",platform:"github",owner:owner,useStored:true}); }',
    '    else{ var tk=gtEl.value.trim(); if(owner&&tk){ vscode.postMessage({type:"validateToken",platform:"github",owner:owner,token:tk}); } }',
    '  } else {',
    '    var orgUrl=document.getElementById("ado-org").value.trim();',
    '    var atEl=document.getElementById("ado-token");',
    '    if(atEl.dataset.hasStored==="1"){ vscode.postMessage({type:"validateToken",platform:"ado",orgUrl:orgUrl,useStored:true}); }',
    '    else{ var token2=atEl.value.trim(); if(orgUrl&&token2){ vscode.postMessage({type:"validateToken",platform:"ado",orgUrl:orgUrl,token:token2}); } }',
    '  }',
    '}',
    '',
    'function fetchGithubProjects(){',
    '  var owner=document.getElementById("gh-owner").value.trim();',
    '  var gtEl=document.getElementById("gh-token");',
    '  var token=gtEl.dataset.hasStored==="1"?"":gtEl.value.trim();',
    '  if(!owner){setStatus("github","error","Enter the owner first.");return;}',
    '  if(!token&&gtEl.dataset.hasStored!=="1"){setStatus("github","error","Enter your PAT first.");return;}',
    '  setStatus("github","","Loading projects...");',
    '  vscode.postMessage({type:"fetchGithubProjects",owner:owner,token:token,useStored:gtEl.dataset.hasStored==="1"});',
    '}',
    '',
    '// Auto-validate stored tokens on load',
    'if(pre._hasJiraToken && pre.jiraBaseUrl && pre.jiraEmail){ validateToken("jira"); }',
    'if(pre._hasAdoToken && pre.adoOrgUrl){ validateToken("ado"); }',
    'if(pre._hasGithubToken && pre.githubOwner){ validateToken("github"); }',
    '',
    'function save(){',
    '  try{',
    '  var tab=activeTab();',
    '  var tm = {};',
    '  try{ tm = collectTypeMappings(); }catch(e){}',
    '  if(tab==="jira"){',
    '    var baseUrl=document.getElementById("jira-url").value.trim();',
    '    var email=document.getElementById("jira-email").value.trim();',
    '    var jtEl=document.getElementById("jira-token");',
    '    var project=document.getElementById("jira-project").value;',
    '    var token=jtEl.dataset.hasStored==="1"?"":jtEl.value.trim();',
    '    if(!baseUrl){alert("Enter your Jira Base URL.");return;}',
    '    if(!email){alert("Enter your Jira account email.");return;}',
    '    if(!token&&jtEl.dataset.hasStored!=="1"){alert("Enter your Jira API token.");return;}',
    '    var fd = {};',
    '    try{ fd = collectJiraFieldDefaults(); }catch(e){}',
    '    vscode.postMessage({type:"save",data:{platform:"jira",jiraBaseUrl:baseUrl,jiraEmail:email,jiraToken:token,jiraProject:project,jiraFieldDefaults:fd,typeMappings:tm}});',
    '  } else if(tab==="github"){',
    '    var ghOwner=document.getElementById("gh-owner").value.trim();',
    '    var ghRepo=document.getElementById("gh-repo").value.trim();',
    '    var gtEl=document.getElementById("gh-token");',
    '    var ghToken=gtEl.dataset.hasStored==="1"?"":gtEl.value.trim();',
    '    var ghProjNum=document.getElementById("gh-project-num").value.trim();',
    '    if(!ghOwner){alert("Enter the GitHub owner.");return;}',
    '    if(!ghRepo){alert("Enter the repository name.");return;}',
    '    if(!ghToken&&gtEl.dataset.hasStored!=="1"){alert("Enter your GitHub PAT.");return;}',
    '    vscode.postMessage({type:"save",data:{platform:"github",githubOwner:ghOwner,githubRepo:ghRepo,githubToken:ghToken,githubProjectNumber:ghProjNum?Number(ghProjNum):undefined,typeMappings:tm}});',
    '  } else {',
    '    var orgUrl=document.getElementById("ado-org").value.trim();',
    '    var atEl=document.getElementById("ado-token");',
    '    var project2=document.getElementById("ado-project").value;',
    '    var token2=atEl.dataset.hasStored==="1"?"":atEl.value.trim();',
    '    if(!orgUrl){alert("Enter your Azure DevOps Organisation URL.");return;}',
    '    if(!token2&&atEl.dataset.hasStored!=="1"){alert("Enter your Personal Access Token.");return;}',
    '    vscode.postMessage({type:"save",data:{platform:"azuredevops",adoOrgUrl:orgUrl,adoToken:token2,adoProject:project2,typeMappings:tm}});',
    '  }',
    '  }catch(err){ setStatus(activeTab(),"error","Save error: "+err.message); }',
    '}',
  ].join('\n');
}
