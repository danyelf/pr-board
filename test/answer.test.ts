import { describe, expect, it } from 'vitest';
import { FILE_AN_ISSUE, LOOK_CHOICES, LOOK_DEFAULT, NOTE_MAX, asksForLook, checkAnswer, choicesFor, parseAnswer, renderAnswer } from '../src/shared/answer.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import type { Status } from '../src/shared/types.ts';
import { facts, status } from './helpers.ts';

const asked: Status = status({
  ask: 'look and answer',
  questions: [
    { n: 1, text: 'Colour?', choices: ['leave', 'change'], defaultChoice: 'leave' },
    { n: 2, text: 'Anything else?', choices: [], defaultChoice: null },
  ],
});

describe('the look question', () => {
  it('has looks good, prep for merge as its default, then needs changes and file an issue', () => {
    expect(LOOK_CHOICES).toEqual(['looks good, prep for merge', 'needs changes', 'file an issue']);
    expect(LOOK_DEFAULT).toBe('looks good, prep for merge');
  });

  it("is asked of an open PR on the owner's turn that hasn't had prep", () => {
    const s = status({ waitingOn: 'owner' });
    expect(asksForLook(facts({ labels: ['on sam'] }), s)).toBe(true);
    expect(asksForLook(facts({ labels: ['on sam'] }), null)).toBe(true);
    expect(asksForLook(facts({ labels: [] }), s)).toBe(true);
    expect(asksForLook(facts({ labels: ['on sam'], prepDone: true }), s)).toBe(false);
    expect(asksForLook(facts({ labels: ['on sam'], merged: true }), s)).toBe(false);
    expect(asksForLook(facts({ labels: ['on sam'], kind: 'issue' }), s)).toBe(false);
    expect(asksForLook(facts({ labels: ['in-progress'] }), status({ waitingOn: 'claude' }))).toBe(false);
  });
});

describe('choicesFor', () => {
  it("is the question's choices, then file an issue", () => {
    expect(choicesFor(asked.questions[0]!)).toEqual(['leave', 'change', FILE_AN_ISSUE]);
    expect(choicesFor(asked.questions[1]!)).toEqual([FILE_AN_ISSUE]);
    expect(choicesFor({ n: 3, text: 'x', choices: ['a', FILE_AN_ISSUE], defaultChoice: 'a' })).toEqual(['a', FILE_AN_ISSUE]);
  });
});

describe('checkAnswer', () => {
  const ok = { answers: { '1': 'change', look: LOOK_DEFAULT }, note: '' };

  it('accepts listed choices, file an issue, and a note', () => {
    expect(checkAnswer(asked, true, ok)).toBeNull();
    expect(checkAnswer(asked, true, { answers: { '1': FILE_AN_ISSUE, '2': FILE_AN_ISSUE }, note: 'hi' })).toBeNull();
    expect(checkAnswer(asked, false, { answers: {}, note: 'just a note' })).toBeNull();
  });

  it('refuses a choice that is not listed', () => {
    expect(checkAnswer(asked, true, { answers: { '1': 'purple' }, note: '' })).toMatch(/question 1/);
    expect(checkAnswer(asked, true, { answers: { '2': 'free text' }, note: '' })).toMatch(/question 2/);
    expect(checkAnswer(asked, true, { answers: { look: 'meh' }, note: '' })).toMatch(/look/);
  });

  it('refuses a question that does not exist, and the look when it is not asked', () => {
    expect(checkAnswer(asked, true, { answers: { '3': 'leave' }, note: '' })).toMatch(/no question 3/);
    expect(checkAnswer(asked, false, { answers: { look: LOOK_DEFAULT }, note: '' })).toMatch(/look/);
    expect(checkAnswer(null, true, { answers: { '1': 'leave' }, note: '' })).toMatch(/no question 1/);
  });

  it('refuses a long note, a note with a status marker, and an empty answer', () => {
    expect(checkAnswer(asked, true, { answers: {}, note: 'x'.repeat(NOTE_MAX + 1) })).toMatch(/note/i);
    expect(checkAnswer(asked, true, { answers: {}, note: 'x'.repeat(NOTE_MAX) })).toBeNull();
    expect(checkAnswer(asked, true, { answers: {}, note: 'a <!-- status --> b' })).toMatch(/note/i);
    expect(checkAnswer(asked, true, { answers: {}, note: '<!-- pr-board answer {} -->' })).toMatch(/note/i);
    expect(checkAnswer(asked, true, { answers: {}, note: '   ' })).toMatch(/nothing/i);
  });
});

describe('renderAnswer and parseAnswer', () => {
  const answer = { fingerprint: statusFingerprint(asked), answers: { '1': 'leave', look: LOOK_DEFAULT }, note: 'tint is strong --> <b>\r\nsecond line' };

  it('round-trips', () => {
    const body = renderAnswer(asked, answer);
    expect(parseAnswer(body)).toEqual({ ...answer, note: 'tint is strong --> <b>\nsecond line' });
  });

  it('starts with one machine-readable line, then reads as text', () => {
    const lines = renderAnswer(asked, answer).split('\n');
    expect(lines[0]).toMatch(/^<!-- pr-board answer \{"v":1,"fingerprint":"[0-9a-f]{8}","answers":\{.*\},"note":".*"\} -->$/);
    expect(lines[0]!.indexOf('-->')).toBe(lines[0]!.length - 3);
    const text = lines.slice(1).join('\n');
    expect(text).toContain('**Answers from PR Board**');
    expect(text).toContain('1. Colour? → **leave**');
    expect(text).toContain('2. Anything else? → (no answer)');
    expect(text).toContain('How does it look? → **looks good, prep for merge**');
    expect(text).toContain('Note:\n> tint is strong --> <b>\n> second line');
  });

  it('leaves out the look line and the note when there are none', () => {
    const text = renderAnswer(asked, { fingerprint: 'abcdef12', answers: { '1': 'change' }, note: '' });
    expect(text).not.toContain('How does it look?');
    expect(text).not.toContain('Note:');
  });

  it('reads nothing from comments that are not answers or are broken', () => {
    expect(parseAnswer('Answers: 1 leave')).toBeNull();
    expect(parseAnswer('hello\n<!-- pr-board answer {"v":1,"fingerprint":"abcdef12","answers":{},"note":""} -->')).toBeNull();
    expect(parseAnswer('<!-- pr-board answer {broken -->')).toBeNull();
    expect(parseAnswer('<!-- pr-board answer {"v":2,"fingerprint":"abcdef12","answers":{},"note":""} -->')).toBeNull();
    expect(parseAnswer('<!-- pr-board answer {"v":1,"fingerprint":"abcdef12","answers":{"1":3},"note":""} -->')).toBeNull();
    expect(parseAnswer('<!-- pr-board answer {"v":1,"fingerprint":"xyz","answers":{},"note":""} -->')).toBeNull();
    expect(parseAnswer('<!-- pr-board answer {"v":1,"fingerprint":"abcdef12","answers":{},"note":""} -->\r\nrest'))
      .toEqual({ fingerprint: 'abcdef12', answers: {}, note: '' });
  });
});
