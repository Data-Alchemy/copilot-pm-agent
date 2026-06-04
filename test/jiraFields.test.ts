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
