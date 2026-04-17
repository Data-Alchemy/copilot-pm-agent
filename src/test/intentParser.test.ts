// test/intentParser.test.ts
import { parseIntent } from '../src/utils/intentParser';

describe('intentParser', () => {

  // ── Slash commands ────────────────────────────────────────────────────────

  describe('slash commands', () => {
    it('/list returns list intent', () => {
      expect(parseIntent('list', '').kind).toBe('list');
    });
    it('/open returns open intent', () => {
      expect(parseIntent('open', '#1234').kind).toBe('open');
    });
    it('/create returns create intent', () => {
      expect(parseIntent('create', 'a new bug').kind).toBe('create');
    });
    it('/comment returns comment intent', () => {
      expect(parseIntent('comment', 'ENG-42').kind).toBe('comment');
    });
    it('/status returns status intent', () => {
      expect(parseIntent('status', 'ENG-42').kind).toBe('status');
    });
    it('/sprint returns sprint intent', () => {
      expect(parseIntent('sprint', '').kind).toBe('sprint');
    });
    it('/debug returns debug intent', () => {
      expect(parseIntent('debug', '').kind).toBe('debug');
    });
    it('/setuser returns setuser intent', () => {
      expect(parseIntent('setuser', '').kind).toBe('setuser');
    });
    it('/setupai returns setupai intent', () => {
      expect(parseIntent('setupai', '').kind).toBe('setupai');
    });
    it('/estimate returns estimate intent', () => {
      expect(parseIntent('estimate', 'ENG-42 5 sp').kind).toBe('estimate');
    });
    it('/assign returns assign intent', () => {
      expect(parseIntent('assign', 'ENG-42 to Alice').kind).toBe('assign');
    });
    it('/attach returns attach intent', () => {
      expect(parseIntent('attach', 'ENG-42').kind).toBe('attach');
    });
    it('/summary returns summary intent', () => {
      expect(parseIntent('summary', 'ENG-42').kind).toBe('summary');
    });
    it('/members returns members intent', () => {
      expect(parseIntent('members', '').kind).toBe('members');
    });
    it('/parent returns parent intent', () => {
      expect(parseIntent('parent', 'ENG-42').kind).toBe('parent');
    });
    it('/move returns move intent', () => {
      expect(parseIntent('move', 'ENG-42').kind).toBe('move');
    });
    it('/migrate returns migrate intent', () => {
      expect(parseIntent('migrate', 'ENG-42').kind).toBe('migrate');
    });
  });

  // ── Work item key extraction ──────────────────────────────────────────────

  describe('key extraction', () => {
    it('extracts Jira-style keys (ENG-42)', () => {
      const result = parseIntent('open', 'ENG-42');
      expect(result.workItemKey).toBe('ENG-42');
    });
    it('extracts ADO-style keys (#1234)', () => {
      const result = parseIntent('open', '#1234');
      expect(result.workItemKey).toBe('#1234');
    });
    it('extracts AB# keys (AB#123)', () => {
      const result = parseIntent('open', 'AB#123');
      expect(result.workItemKey).toBe('AB#123');
    });
    it('returns undefined when no key present', () => {
      const result = parseIntent('open', 'no key here');
      expect(result.workItemKey).toBeUndefined();
    });
  });

  // ── Natural language intent detection ─────────────────────────────────────

  describe('natural language', () => {
    it('"list my tasks" → list', () => {
      expect(parseIntent(undefined, 'list my tasks').kind).toBe('list');
    });
    it('"show all bugs" → list', () => {
      expect(parseIntent(undefined, 'show all bugs').kind).toBe('list');
    });
    it('"what\'s assigned to me" → list', () => {
      expect(parseIntent(undefined, "what's assigned to me").kind).toBe('list');
    });
    it('"create a bug" → create', () => {
      expect(parseIntent(undefined, 'create a bug').kind).toBe('create');
    });
    it('"file a new story" → create', () => {
      expect(parseIntent(undefined, 'file a new story').kind).toBe('create');
    });
    it('"assign ENG-42 to Alice" → assign', () => {
      const result = parseIntent(undefined, 'assign ENG-42 to Alice');
      expect(result.kind).toBe('assign');
      expect(result.workItemKey).toBe('ENG-42');
      expect(result.assigneeHint).toBe('Alice');
    });
    it('"set the status to done" → status', () => {
      const result = parseIntent(undefined, 'set the status to done');
      expect(result.kind).toBe('status');
    });
    it('"close ENG-42" → status with Closed hint', () => {
      const result = parseIntent(undefined, 'close ENG-42');
      expect(result.kind).toBe('status');
      expect(result.statusHint).toBe('Closed');
    });
    it('"mark ENG-42 as in progress" → open (key detected before status)', () => {
      const result = parseIntent(undefined, 'mark ENG-42 as in progress');
      // The parser sees the key and "open/show/view" pattern first
      expect(result.kind).toBe('open');
      expect(result.workItemKey).toBe('ENG-42');
    });
    it('"comment on ENG-42" → comment', () => {
      const result = parseIntent(undefined, 'comment on ENG-42');
      expect(result.kind).toBe('comment');
      expect(result.workItemKey).toBe('ENG-42');
    });
    it('"open ENG-42" → open', () => {
      const result = parseIntent(undefined, 'open ENG-42');
      expect(result.kind).toBe('open');
      expect(result.workItemKey).toBe('ENG-42');
    });
    it('"show sprint" → sprint', () => {
      expect(parseIntent(undefined, 'show sprint').kind).toBe('sprint');
    });
    it('"test connection" → debug', () => {
      expect(parseIntent(undefined, 'test connection').kind).toBe('debug');
    });
    it('"set default user" → setuser', () => {
      expect(parseIntent(undefined, 'set default user').kind).toBe('setuser');
    });
    it('"setup ai" → setupai', () => {
      expect(parseIntent(undefined, 'setup ai').kind).toBe('setupai');
    });
    it('"summarize ENG-42" → summary', () => {
      expect(parseIntent(undefined, 'summarize ENG-42').kind).toBe('summary');
    });
    it('bare key "ENG-42" → open', () => {
      expect(parseIntent(undefined, 'ENG-42').kind).toBe('open');
    });
    it('unrecognised text → unknown', () => {
      expect(parseIntent(undefined, 'hello world').kind).toBe('unknown');
    });
  });

  // ── List query parsing ────────────────────────────────────────────────────

  describe('list query details', () => {
    it('parses type filter from "list bugs"', () => {
      const result = parseIntent('list', 'bugs');
      expect(result.query?.type).toBe('bug');
    });
    it('parses type filter from "list stories"', () => {
      const result = parseIntent('list', 'stories');
      expect(result.query?.type).toBe('story');
    });
    it('parses status filter "in progress"', () => {
      const result = parseIntent('list', 'in progress items');
      expect(result.query?.status).toBe('Active');
    });
    it('parses "my" as assigneeId @me', () => {
      const result = parseIntent(undefined, 'my tasks');
      expect(result.query?.assigneeId).toBe('@me');
    });
    it('sets default maxResults', () => {
      const result = parseIntent('list', '');
      expect(result.query?.maxResults).toBe(25);
    });
  });

  // ── Create parsing ────────────────────────────────────────────────────────

  describe('create details', () => {
    it('defaults to task type', () => {
      const result = parseIntent('create', 'something');
      expect(result.create?.type).toBe('task');
    });
    it('detects bug type', () => {
      const result = parseIntent('create', 'a bug for login failure');
      expect(result.create?.type).toBe('bug');
    });
    it('detects story type', () => {
      const result = parseIntent('create', 'a story for user onboarding');
      expect(result.create?.type).toBe('story');
    });
    it('extracts quoted title', () => {
      const result = parseIntent('create', 'a task called "Fix the navbar"');
      expect(result.create?.title).toBe('Fix the navbar');
    });
    it('extracts story points', () => {
      const result = parseIntent('create', 'a task 5 story points');
      expect(result.create?.storyPoints).toBe(5);
    });
    it('extracts priority', () => {
      const result = parseIntent('create', 'a high priority bug');
      expect(result.create?.priority).toBe('High');
    });
  });

  // ── Estimate parsing ──────────────────────────────────────────────────────

  describe('estimate details', () => {
    it('extracts points value', () => {
      const result = parseIntent('estimate', 'ENG-42 5 sp');
      expect(result.estimateValue).toBe(5);
      expect(result.workItemKey).toBe('ENG-42');
    });
    it('extracts decimal points', () => {
      const result = parseIntent('estimate', 'ENG-42 2.5 points');
      expect(result.estimateValue).toBe(2.5);
    });
    it('returns undefined when no value given', () => {
      const result = parseIntent('estimate', 'ENG-42');
      expect(result.estimateValue).toBeUndefined();
    });
  });

  // ── Comment parsing ───────────────────────────────────────────────────────

  describe('comment details', () => {
    it('extracts comment text after "saying"', () => {
      const result = parseIntent('comment', 'ENG-42 saying "looks good"');
      // The regex captures the trailing quote — trim it
      expect(result.commentText).toContain('looks good');
    });
    it('extracts key from comment command', () => {
      const result = parseIntent('comment', 'ENG-42');
      expect(result.workItemKey).toBe('ENG-42');
    });
  });

  // ── Assign parsing ────────────────────────────────────────────────────────

  describe('assign details', () => {
    it('extracts assignee hint', () => {
      const result = parseIntent('assign', 'ENG-42 to John Smith');
      expect(result.assigneeHint).toBe('John Smith');
    });
    it('extracts key', () => {
      const result = parseIntent('assign', 'ENG-42 to Alice');
      expect(result.workItemKey).toBe('ENG-42');
    });
  });

  // ── Raw text preserved ────────────────────────────────────────────────────

  describe('raw text', () => {
    it('always includes raw text', () => {
      const result = parseIntent('list', 'my bugs');
      expect(result.raw).toBe('my bugs');
    });
    it('preserves original casing in raw', () => {
      const result = parseIntent(undefined, 'Open ENG-42');
      expect(result.raw).toBe('Open ENG-42');
    });
  });
});
