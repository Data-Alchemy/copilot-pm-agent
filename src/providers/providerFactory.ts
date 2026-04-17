// src/providers/providerFactory.ts
import { ApiCredentials } from '../types';
import { JiraProvider } from './jiraProvider';
import { AdoProvider } from './adoProvider';
import { GitHubProvider } from './githubProvider';

export type AnyProvider = JiraProvider | AdoProvider | GitHubProvider;

export function createProvider(creds: ApiCredentials): AnyProvider {
  if (creds.platform === 'jira') {
    return new JiraProvider(creds);
  }
  if (creds.platform === 'github') {
    return new GitHubProvider(creds);
  }
  return new AdoProvider(creds);
}
