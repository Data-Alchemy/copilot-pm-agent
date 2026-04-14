/**
 * src/utils/strings.ts
 * Shared string utilities — single source of truth (DRY).
 */

/** Capitalise the first character of a string. */
export const cap = (s: string): string =>
  s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);

/** Strip HTML tags from a string. */
export const stripHtml = (s: string): string =>
  decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).trim();

/** Decode common HTML entities to plain text. */
export const decodeHtmlEntities = (s: string): string =>
  s.replace(/&nbsp;/g, ' ')
   .replace(/&amp;/g, '&')
   .replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>')
   .replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'")
   .replace(/&#x2F;/g, '/')
   .replace(/&apos;/g, "'")
   .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
   .replace(/\s{2,}/g, ' ');

/** Truncate a string to `max` characters, appending `…` if truncated. */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : s.slice(0, max) + '…';

/** Escape HTML special characters for safe injection into HTML templates. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#39;');

/** Generate a random hex nonce string for CSP. */
export const makeNonce = (): string =>
  Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  ).join('');
