// src/providers/providerFactory.ts
import { ApiCredentials } from '../types';
import { JiraProvider } from './jiraProvider';
import { AdoProvider } from './adoProvider';

export type AnyProvider = JiraProvider | AdoProvider;

export function createProvider(creds: ApiCredentials): AnyProvider {
  if (creds.platform === 'jira') {
    return new JiraProvider(creds);
  }
  return new AdoProvider(creds);
}
