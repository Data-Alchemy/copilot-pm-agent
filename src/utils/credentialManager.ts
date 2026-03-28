// src/utils/credentialManager.ts
// Secure credential storage + setup wizard (WebviewPanel-based so it never
// closes when the user switches to their browser).

import * as vscode from 'vscode';
import { ApiCredentials, Platform } from '../types';
import { SetupWizardPanel } from '../panels/setupWizardPanel';
import { AiConfig, AiProvider } from './aiHelper';

const JIRA_TOKEN_KEY = 'pmAgent.jira.apiToken';
const ADO_TOKEN_KEY = 'pmAgent.ado.personalAccessToken';
const AI_KEY_SECRET = 'pmAgent.ai.apiKey';

export class CredentialManager {

 constructor(
 private readonly secrets: vscode.SecretStorage,
 private readonly context: vscode.ExtensionContext
 ) {}

 async getBothCredentials(): Promise<{ jira?: ApiCredentials; ado?: ApiCredentials }> {
 const config = vscode.workspace.getConfiguration('pmAgent');
 const [jiraToken, adoToken] = await Promise.all([
 this.secrets.get(JIRA_TOKEN_KEY),
 this.secrets.get(ADO_TOKEN_KEY)
 ]);
 const result: { jira?: ApiCredentials; ado?: ApiCredentials } = {};
 const jiraBase = config.get<string>('jira.baseUrl');
 const jiraEmail = config.get<string>('jira.email');
 if (jiraBase && jiraEmail && jiraToken) {
 result.jira = { platform: 'jira', jiraBaseUrl: jiraBase, jiraEmail, jiraToken,
 jiraProject: config.get<string>('jira.defaultProject') };
 }
 const adoOrg = config.get<string>('azureDevOps.orgUrl');
 const adoProj = config.get<string>('azureDevOps.project');
 if (adoOrg && adoProj && adoToken) {
 result.ado = { platform: 'azuredevops', adoOrgUrl: adoOrg, adoProject: adoProj, adoToken };
 }
 return result;
 }

 async getCredentials(): Promise<ApiCredentials> {
 const config = vscode.workspace.getConfiguration('pmAgent');
 const platform = config.get<Platform>('platform', 'jira');
 const creds: ApiCredentials = { platform };

 if (platform === 'jira') {
 creds.jiraBaseUrl = config.get<string>('jira.baseUrl');
 creds.jiraEmail = config.get<string>('jira.email');
 creds.jiraProject = config.get<string>('jira.defaultProject');
 creds.jiraToken = await this.secrets.get(JIRA_TOKEN_KEY);
 } else {
 creds.adoOrgUrl = config.get<string>('azureDevOps.orgUrl');
 creds.adoProject = config.get<string>('azureDevOps.project');
 creds.adoToken = await this.secrets.get(ADO_TOKEN_KEY);
 }
 return creds;
 }

 async storeJiraToken(token: string): Promise<void> {
 await this.secrets.store(JIRA_TOKEN_KEY, token);
 }

 async storeAdoToken(token: string): Promise<void> {
 await this.secrets.store(ADO_TOKEN_KEY, token);
 }

 async clearCredentials(): Promise<void> {
 await this.secrets.delete(JIRA_TOKEN_KEY);
 await this.secrets.delete(ADO_TOKEN_KEY);
 }

 // ── Default user (the person we act on behalf of) ─────────────────────────

 private defaultUserKey(): string {
 const config = vscode.workspace.getConfiguration('pmAgent');
 const plat = config.get<string>('platform', 'jira');
 return `pmAgent.defaultUser.${plat}`;
 }

 async getDefaultUser(): Promise<import('../types').User | null> {
 const raw = await this.secrets.get(this.defaultUserKey());
 if (!raw) { return null; }
 try { return JSON.parse(raw) as import('../types').User; }
 catch { return null; }
 }

 async setDefaultUser(user: import('../types').User): Promise<void> {
 await this.secrets.store(this.defaultUserKey(), JSON.stringify(user));
 }

 async clearDefaultUser(): Promise<void> {
 await this.secrets.delete(this.defaultUserKey());
 }

 // ── AI provider config ─────────────────────────────────────────────────────

 async getAiConfig(): Promise<AiConfig> {
 const config = vscode.workspace.getConfiguration('pmAgent');
 const provider = config.get<AiProvider>('ai.provider', 'copilot'); // default: try Copilot
 const apiKey = await this.secrets.get(AI_KEY_SECRET);
 const azureUrl = config.get<string>('ai.azureUrl');
 const model = config.get<string>('ai.model');
 return { provider, apiKey, azureUrl, model };
 }

 async setAiConfig(provider: AiProvider, apiKey: string, azureUrl?: string, model?: string): Promise<void> {
 const config = vscode.workspace.getConfiguration('pmAgent');
 await config.update('ai.provider', provider, vscode.ConfigurationTarget.Global);
 if (azureUrl) { await config.update('ai.azureUrl', azureUrl, vscode.ConfigurationTarget.Global); }
 if (model) { await config.update('ai.model', model, vscode.ConfigurationTarget.Global); }
 await this.secrets.store(AI_KEY_SECRET, apiKey);
 }

 async clearAiConfig(): Promise<void> {
 const config = vscode.workspace.getConfiguration('pmAgent');
 await config.update('ai.provider', 'none', vscode.ConfigurationTarget.Global);
 await this.secrets.delete(AI_KEY_SECRET);
 }

 /** Interactive wizard to pick and configure an AI provider */
 async runAiSetupWizard(): Promise<boolean> {
 const providerPick = await vscode.window.showQuickPick([
 { label: 'GitHub Copilot', description: 'Uses your existing Copilot subscription — no extra key needed (recommended)', value: 'copilot' as AiProvider },
 { label: ' Anthropic Claude', description: 'Requires your own Anthropic API key', value: 'anthropic' as AiProvider },
 { label: 'OpenAI', description: 'Requires your own OpenAI API key', value: 'openai' as AiProvider },
 { label: 'Azure OpenAI', description: 'Requires your Azure deployment URL + key', value: 'azure-openai' as AiProvider },
 { label: 'No AI — disable', description: 'Skip AI enhancements', value: 'none' as AiProvider },
 ], { title: 'PM Agent — Choose AI Provider', placeHolder: 'GitHub Copilot is recommended — uses your existing subscription', ignoreFocusOut: true });

 if (!providerPick) { return false; }

 if (providerPick.value === 'none') {
 await this.clearAiConfig();
 vscode.window.showInformationMessage('AI assistance disabled. You can re-enable it with PM Agent: Configure AI.');
 return true;
 }

 if (providerPick.value === 'copilot') {
 await this.setAiConfig('copilot', '', undefined, undefined);
 vscode.window.showInformationMessage(
 'AI set to GitHub Copilot — no API key needed. ' +
 'Ticket creation, estimation, and comments are now AI-powered.'
 );
 return true;
 }

 // Key prompt varies by provider
 const keyLabels: Record<string, string> = {
 'anthropic': 'Anthropic API Key (from console.anthropic.com)',
 'openai': 'OpenAI API Key (from platform.openai.com)',
 'azure-openai': 'Azure OpenAI API Key'
 };
 const keyLinks: Record<string, string> = {
 'anthropic': 'https://console.anthropic.com/account/keys',
 'openai': 'https://platform.openai.com/api-keys',
 'azure-openai': 'https://portal.azure.com'
 };

 // Offer to open key generation page
 const openPage = await vscode.window.showQuickPick([
 { label: '$(link-external) Open key generation page in browser', value: 'open' },
 { label: '$(clippy) I already have a key — paste it', value: 'skip' }
 ], { title: `${providerPick.label} — API Key`, ignoreFocusOut: true });
 if (!openPage) { return false; }
 if (openPage.value === 'open') {
 await vscode.env.openExternal(vscode.Uri.parse(keyLinks[providerPick.value]));
 await vscode.window.showInformationMessage('Copy your key, then come back to paste it.', { modal: true }, 'Ready');
 }

 const apiKey = await vscode.window.showInputBox({
 title: keyLabels[providerPick.value],
 prompt: 'Paste your API key here — stored securely in OS keychain',
 password: true,
 ignoreFocusOut: true
 });
 if (!apiKey?.trim()) { return false; }

 let azureUrl: string | undefined;
 if (providerPick.value === 'azure-openai') {
 azureUrl = await vscode.window.showInputBox({
 title: 'Azure OpenAI Endpoint URL',
 prompt: 'Full deployment URL including /chat/completions',
 placeHolder: 'https://yourdeployment.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-02-01',
 ignoreFocusOut: true
 }) ?? undefined;
 if (!azureUrl) { return false; }
 }

 await this.setAiConfig(providerPick.value, apiKey.trim(), azureUrl);
 vscode.window.showInformationMessage(`AI provider set to ${providerPick.label}. Ticket creation and estimates are now AI-powered.`);
 return true;
 }

 async isConfigured(): Promise<boolean> {
 const creds = await this.getCredentials();
 if (creds.platform === 'jira') {
 return !!(creds.jiraBaseUrl && creds.jiraEmail && creds.jiraToken);
 }
 return !!(creds.adoOrgUrl && creds.adoProject && creds.adoToken);
 }

 /** Opens the webview wizard. Returns true if credentials were saved. */
 async runSetupWizard(): Promise<boolean> {
 const config = vscode.workspace.getConfiguration('pmAgent');

 // Read existing tokens from secret store so the wizard can show
 // the •••••••• sentinel and preserve them on save
 const [storedJiraToken, storedAdoToken] = await Promise.all([
   this.secrets.get(JIRA_TOKEN_KEY),
   this.secrets.get(ADO_TOKEN_KEY)
 ]);

 // Pre-fill whatever is already saved so the user doesn't retype it
 const existing: Record<string, any> = {
   platform: config.get<Platform>('platform', 'jira'),
   jiraBaseUrl: config.get<string>('jira.baseUrl') || '',
   jiraEmail: config.get<string>('jira.email') || '',
   jiraProject: config.get<string>('jira.defaultProject') || '',
   adoOrgUrl: config.get<string>('azureDevOps.orgUrl') || '',
   adoProject: config.get<string>('azureDevOps.project') || '',
 };

 // Pass boolean flags so the wizard knows tokens exist (shows sentinel)
 // but NEVER pass the actual token values into the webview HTML.
 if (storedJiraToken) { existing._hasJiraToken = true; }
 if (storedAdoToken)  { existing._hasAdoToken  = true; }

 const result = await SetupWizardPanel.show(this.context, existing);
 if (!result) { return false; }

 if (result.platform === 'jira') {
 await config.update('platform', 'jira', vscode.ConfigurationTarget.Global);
 await config.update('jira.baseUrl', result.jiraBaseUrl!, vscode.ConfigurationTarget.Global);
 await config.update('jira.email', result.jiraEmail!, vscode.ConfigurationTarget.Global);
 await config.update('jira.defaultProject', result.jiraProject || '', vscode.ConfigurationTarget.Global);
 if (result.jiraToken) { await this.storeJiraToken(result.jiraToken); }
 vscode.window.showInformationMessage(
 `Connected to Jira${result.jiraProject ? ' — project: ' + result.jiraProject : ''}. Say @pm in Copilot chat!`
 );
 } else {
 await config.update('platform', 'azuredevops', vscode.ConfigurationTarget.Global);
 await config.update('azureDevOps.orgUrl', result.adoOrgUrl!, vscode.ConfigurationTarget.Global);
 await config.update('azureDevOps.project', result.adoProject!, vscode.ConfigurationTarget.Global);
 if (result.adoToken) { await this.storeAdoToken(result.adoToken); }
 vscode.window.showInformationMessage(
 `Connected to Azure DevOps — project: ${result.adoProject}. Say @pm in Copilot chat!`
 );
 }

 return true;
 }
}
