// test/providerFactory.test.ts
import { createProvider } from '../src/providers/providerFactory';
import { JiraProvider } from '../src/providers/jiraProvider';
import { AdoProvider } from '../src/providers/adoProvider';
import { ApiCredentials } from '../src/types';

describe('providerFactory', () => {
  it('returns JiraProvider for jira platform', () => {
    const creds: ApiCredentials = {
      platform: 'jira',
      jiraBaseUrl: 'https://test.atlassian.net',
      jiraEmail: 'test@test.com',
      jiraToken: 'token123',
    };
    const provider = createProvider(creds);
    expect(provider).toBeInstanceOf(JiraProvider);
  });

  it('returns AdoProvider for azuredevops platform', () => {
    const creds: ApiCredentials = {
      platform: 'azuredevops',
      adoOrgUrl: 'https://dev.azure.com/org',
      adoProject: 'MyProject',
      adoToken: 'pat123',
    };
    const provider = createProvider(creds);
    expect(provider).toBeInstanceOf(AdoProvider);
  });
});
