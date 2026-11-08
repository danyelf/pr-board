import { describe, expect, it } from 'vitest';
import { FINGERPRINT_RE, fnv1a, statusFingerprint } from '../src/shared/fingerprint.ts';
import { status } from './helpers.ts';

describe('fnv1a', () => {
  it('matches the published 32-bit FNV-1a test values', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('hashes text beyond plain ASCII as UTF-8 bytes', () => {
    // 'é' is the two bytes C3 A9; worked through the FNV-1a steps by hand.
    expect(fnv1a('é')).toBe(0x1e9de8c1);
  });
});

describe('statusFingerprint', () => {
  const base = status({ ask: 'look' }, 2);

  it('is 8 hex digits, the shape answers are checked for', () => {
    expect(statusFingerprint(base)).toMatch(FINGERPRINT_RE);
    expect(FINGERPRINT_RE.source).toBe('^[0-9a-f]{8}$');
  });

  it('is the FNV-1a hash of what the status asks, written as JSON, in 8 hex digits', () => {
    expect(statusFingerprint(null)).toBe(fnv1a('{"ask":"","questions":[]}').toString(16).padStart(8, '0'));
  });

  it('changes with the ask, a question, a choice or the default', () => {
    const fp = statusFingerprint(base);
    expect(statusFingerprint({ ...base, ask: 'other' })).not.toBe(fp);
    expect(statusFingerprint({ ...base, questions: [{ ...base.questions[0]!, text: 'x' }, base.questions[1]!] })).not.toBe(fp);
    expect(statusFingerprint({ ...base, questions: [{ ...base.questions[0]!, choices: ['a', 'c'] }, base.questions[1]!] })).not.toBe(fp);
    expect(statusFingerprint({ ...base, questions: [{ ...base.questions[0]!, defaultChoice: 'b' }, base.questions[1]!] })).not.toBe(fp);
    expect(statusFingerprint({ ...base, questions: [base.questions[0]!] })).not.toBe(fp);
  });

  it('stays the same when only whose turn it is, since when, or the test steps change', () => {
    const fp = statusFingerprint(base);
    expect(statusFingerprint({ ...base, waitingOn: 'claude', since: '2026-11-08T00:00:00Z', toTest: 'click' })).toBe(fp);
  });

  it('gives a missing status a fingerprint of its own, the same as an empty one', () => {
    expect(statusFingerprint(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(statusFingerprint(null)).toBe(statusFingerprint(status({ ask: '' })));
  });
});
