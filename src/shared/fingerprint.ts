import type { Status } from './types.ts';

/** What a fingerprint looks like: 8 hex digits. */
export const FINGERPRINT_RE = /^[0-9a-f]{8}$/;

/**
 * The 32-bit FNV-1a hash of the text's UTF-8 bytes. Not for security: the fingerprint only has to
 * notice that a status's questions have changed, and the board needs it without `await`.
 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * A short fingerprint of what a status asks: the ask and the questions, with their choices and
 * defaults. Whose turn it is, since when, and the test steps are left out, so handing the same
 * questions back keeps the same fingerprint. An answer carries the fingerprint of what it answered,
 * so nobody applies it to questions that have changed since.
 */
export function statusFingerprint(s: Status | null): string {
  const asked = {
    ask: s?.ask ?? '',
    questions: (s?.questions ?? []).map((q) => [q.n, q.text, q.choices, q.defaultChoice]),
  };
  return fnv1a(JSON.stringify(asked)).toString(16).padStart(8, '0');
}
