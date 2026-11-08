import { describe, expect, it } from 'vitest';
import { sha256Hex, statusFingerprint } from '../src/shared/fingerprint.ts';
import { status } from './helpers.ts';

describe('sha256Hex', () => {
  it('matches the published test values', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes text beyond plain ASCII as UTF-8', () => {
    // From: printf 'é→' | shasum -a 256
    expect(sha256Hex('é→')).toBe('04d4630cd3db3cffd5d551f99e844edcc4dd716925f05300ff91614af5439420');
  });
});

describe('statusFingerprint', () => {
  const base = status({ ask: 'look' }, 2);

  it('is 8 hex digits', () => {
    expect(statusFingerprint(base)).toMatch(/^[0-9a-f]{8}$/);
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
