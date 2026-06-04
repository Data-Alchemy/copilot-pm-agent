// test/jiraSearch.test.ts
// Guards the migration to the enhanced /search/jql endpoint (CHANGE-2046).
import { JiraProvider } from '../src/providers/jiraProvider';

type FetchCall = { url: string; body: any };

function makeProvider(pages: any[]): { provider: JiraProvider; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let pageIdx = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = jest.fn(async (url: string, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    calls.push({ url, body });
    const page = pages[pageIdx] ?? { issues: [], isLast: true };
    pageIdx++;
    return {
      ok: true,
      status: 200,
      json: async () => page,
      text: async () => JSON.stringify(page),
    } as any;
  });
  const provider = new JiraProvider({
    platform: 'jira',
    jiraBaseUrl: 'https://example.atlassian.net',
    jiraEmail: 'me@example.com',
    jiraToken: 'tok',
    jiraProject: 'ENG',
  });
  return { provider, calls };
}

const issue = (key: string) => ({
  id: key, key,
  fields: { summary: key, status: { name: 'To Do' }, issuetype: { name: 'Task' }, project: { key: 'ENG' } }
});

describe('JiraProvider search uses the enhanced /search/jql endpoint', () => {
  afterEach(() => jest.restoreAllMocks());

  it('calls /search/jql (never the removed /search)', async () => {
    const { provider, calls } = makeProvider([{ issues: [issue('ENG-1')], isLast: true }]);
    await provider.searchWorkItems({ assigneeId: '@me', maxResults: 10 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toContain('/search/jql');
    // The removed endpoint must never be called
    expect(calls.every(c => !/\/search(\?|$)/.test(c.url.replace('/search/jql', '')))).toBe(true);
  });

  it('paginates with nextPageToken, not startAt', async () => {
    const { provider, calls } = makeProvider([
      { issues: [issue('ENG-1'), issue('ENG-2')], nextPageToken: 'tok-2', isLast: false },
      { issues: [issue('ENG-3')], isLast: true },
    ]);
    const items = await provider.searchWorkItems({ assigneeId: '@me', maxResults: 100 });
    expect(items.map(i => i.key)).toEqual(['ENG-1', 'ENG-2', 'ENG-3']);
    // First call must NOT send a token; second call MUST send the token from page 1
    expect(calls[0].body.nextPageToken).toBeUndefined();
    expect(calls[1].body.nextPageToken).toBe('tok-2');
    // Must never use startAt-based paging
    expect(calls.every(c => c.body.startAt === undefined)).toBe(true);
  });

  it('sends fields as an array and stops at isLast', async () => {
    const { provider, calls } = makeProvider([{ issues: [issue('ENG-1')], isLast: true }]);
    await provider.searchWorkItems({ assigneeId: '@me' });
    expect(Array.isArray(calls[0].body.fields)).toBe(true);
    expect(calls).toHaveLength(1); // isLast:true -> no second request
  });
});

describe('JiraProvider.searchWorkItemsPage (Load more)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns a cursor when more pages exist, and none when last', async () => {
    const { provider, calls } = makeProvider([
      { issues: [issue('ENG-1')], nextPageToken: 'tok-2', isLast: false },
    ]);
    const page = await provider.searchWorkItemsPage({ assigneeId: '@me', maxResults: 1 });
    expect(page.items.map(i => i.key)).toEqual(['ENG-1']);
    expect(page.isLast).toBe(false);
    expect(page.nextCursor).toBe('tok-2');
    // first page must not send a token
    expect(calls[0].body.nextPageToken).toBeUndefined();
  });

  it('passes the cursor back on the next page request', async () => {
    const { provider, calls } = makeProvider([
      { issues: [issue('ENG-2')], isLast: true },
    ]);
    const page = await provider.searchWorkItemsPage({ assigneeId: '@me', maxResults: 1, pageCursor: 'tok-2' });
    expect(calls[0].body.nextPageToken).toBe('tok-2');
    expect(page.isLast).toBe(true);
    expect(page.nextCursor).toBeUndefined();
  });
});
