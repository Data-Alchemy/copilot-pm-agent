// test/jiraFields.test.ts
import { JiraProvider, MissingFieldsError } from '../src/providers/jiraProvider';

describe('JiraProvider.parseFieldErrors', () => {
  it('extracts the errors{} map from a Jira 400 body', () => {
    const body = JSON.stringify({
      errorMessages: [],
      errors: {
        customfield_10044: 'Epic Name is required.',
        customfield_10070: 'Team is required.'
      }
    });
    const parsed = JiraProvider.parseFieldErrors(body);
    expect(parsed).toEqual({
      customfield_10044: 'Epic Name is required.',
      customfield_10070: 'Team is required.'
    });
  });

  it('returns {} for non-JSON or empty bodies', () => {
    expect(JiraProvider.parseFieldErrors(undefined)).toEqual({});
    expect(JiraProvider.parseFieldErrors('Gateway Timeout')).toEqual({});
    expect(JiraProvider.parseFieldErrors('{"errorMessages":["x"]}')).toEqual({});
  });
});

describe('MissingFieldsError', () => {
  it('carries field errors, project key and issue type', () => {
    const e = new MissingFieldsError(
      { customfield_10044: 'Epic Name is required.' },
      'PROJ',
      'Epic'
    );
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('MissingFieldsError');
    expect(e.projectKey).toBe('PROJ');
    expect(e.issueType).toBe('Epic');
    expect(e.fieldErrors.customfield_10044).toContain('required');
    expect(e.message).toContain('Epic Name is required');
  });
});

describe('getCreateFields pagination is loop-proof', () => {
  afterEach(() => jest.restoreAllMocks());

  function provider() {
    return new (require('../src/providers/jiraProvider').JiraProvider)({
      platform: 'jira', jiraBaseUrl: 'https://x.atlassian.net',
      jiraEmail: 'a@b.c', jiraToken: 't', jiraProject: 'ENG'
    });
  }

  it('terminates on a quirky createmeta that always returns a short page with a large total', async () => {
    let createmetaCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('/issue/createmeta/')) {
        createmetaCalls++;
        // Quirk: claims 500 total but only ever returns 10 values (< maxResults)
        return { ok: true, status: 200, json: async () => ({ total: 500, values: Array(10).fill({ fieldId: 'customfield_1', name: 'F', required: false, schema: { type: 'string' } }) }), text: async () => '' } as any;
      }
      if (url.includes('/issuetype')) {
        return { ok: true, status: 200, json: async () => ([{ id: '1', name: 'Story' }]), text: async () => '' } as any;
      }
      return { ok: true, status: 200, json: async () => ([]), text: async () => '' } as any;
    });

    const p = provider();
    const fields = await p.getCreateFields('Story');
    // Must stop after the first short page, not spin to the guard cap
    expect(createmetaCalls).toBe(1);
    expect(Array.isArray(fields)).toBe(true);
  });
});
