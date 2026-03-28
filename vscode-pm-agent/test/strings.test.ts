// test/strings.test.ts
import { cap, stripHtml, truncate, escapeHtml, makeNonce } from '../src/utils/strings';

describe('strings utilities', () => {
  describe('cap', () => {
    it('capitalises first character', () => {
      expect(cap('hello')).toBe('Hello');
    });
    it('returns empty string for empty input', () => {
      expect(cap('')).toBe('');
    });
    it('handles single character', () => {
      expect(cap('a')).toBe('A');
    });
    it('does not change already-capitalised strings', () => {
      expect(cap('Hello')).toBe('Hello');
    });
  });

  describe('stripHtml', () => {
    it('removes simple HTML tags', () => {
      expect(stripHtml('<p>hello</p>')).toBe('hello');
    });
    it('removes nested tags', () => {
      expect(stripHtml('<div><strong>bold</strong> text</div>')).toBe('bold text');
    });
    it('handles self-closing tags', () => {
      expect(stripHtml('line1<br/>line2')).toBe('line1line2');
    });
    it('returns plain text unchanged', () => {
      expect(stripHtml('no tags here')).toBe('no tags here');
    });
  });

  describe('truncate', () => {
    it('returns short strings unchanged', () => {
      expect(truncate('hi', 10)).toBe('hi');
    });
    it('truncates long strings with ellipsis', () => {
      expect(truncate('hello world', 5)).toBe('hello…');
    });
    it('handles exact length', () => {
      expect(truncate('abc', 3)).toBe('abc');
    });
  });

  describe('escapeHtml', () => {
    it('escapes ampersands', () => {
      expect(escapeHtml('a & b')).toBe('a &amp; b');
    });
    it('escapes angle brackets', () => {
      expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    });
    it('escapes quotes', () => {
      expect(escapeHtml('"hello" \'world\'')).toBe('&quot;hello&quot; &#39;world&#39;');
    });
    it('handles all special chars together', () => {
      expect(escapeHtml('<a href="x&y">\'z\'')).toBe('&lt;a href=&quot;x&amp;y&quot;&gt;&#39;z&#39;');
    });
    it('returns safe strings unchanged', () => {
      expect(escapeHtml('plain text 123')).toBe('plain text 123');
    });
  });

  describe('makeNonce', () => {
    it('returns a 32-character hex string', () => {
      const nonce = makeNonce();
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    });
    it('generates unique values', () => {
      const a = makeNonce();
      const b = makeNonce();
      expect(a).not.toBe(b);
    });
  });
});
