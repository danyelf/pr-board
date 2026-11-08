import { describe, expect, it } from 'vitest';
import { extractToTest, parseStatus, pickStatusComment, renderStatus, replaceStatus } from '../src/shared/status.ts';
import { statusFingerprint } from '../src/shared/fingerprint.ts';
import type { Status } from '../src/shared/types.ts';

const example = `<!-- status -->
**Waiting on:** Sam, since 2026-11-02T16:40:00-08:00
**Ask:** look at the preview, and answer one question
**Questions:**
1. Does the tint over the code dull the colours enough to change the shell?  (**leave** | change)
**To test:** pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.
<!-- /status -->`;

const expected: Status = {
  waitingOn: 'owner',
  since: '2026-11-02T16:40:00-08:00',
  ask: 'look at the preview, and answer one question',
  questions: [
    {
      n: 1,
      text: 'Does the tint over the code dull the colours enough to change the shell?',
      choices: ['leave', 'change'],
      defaultChoice: 'leave',
    },
  ],
  toTest: 'pin a verse, leave the mouse on it, press Escape: the popup stays up, unpinned.',
};

describe('parseStatus', () => {
  it('parses the full example', () => {
    expect(parseStatus(example)).toEqual(expected);
  });

  it('uses the last parenthesised group containing a bar as the choices', () => {
    const s = parseStatus(
      '<!-- status -->\n**Waiting on:** Claude\n**Ask:** x\n**Questions:**\n1. Tint (over code)? (**a** | b)\n<!-- /status -->',
    );
    expect(s?.questions[0]).toEqual({ n: 1, text: 'Tint (over code)?', choices: ['a', 'b'], defaultChoice: 'a' });
  });

  it('gives no choices when there is no group with a bar', () => {
    const s = parseStatus(
      '<!-- status -->\n**Waiting on:** nobody\n**Ask:** x\n**Questions:**\n2. Is this (really) fine?\n<!-- /status -->',
    );
    expect(s?.questions[0]).toEqual({ n: 2, text: 'Is this (really) fine?', choices: [], defaultChoice: null });
    expect(s?.since).toBeNull();
    expect(s?.toTest).toBeNull();
  });

  it('parses a section embedded between other text', () => {
    expect(parseStatus(`Intro\n\n${example}\n\n## Rest\nmore`)).toEqual(expected);
  });

  it('drops a since that is not a date, so nothing downstream does arithmetic on it', () => {
    const read = (since: string) => parseStatus(`<!-- status -->\n**Waiting on:** Sam, since ${since}\n<!-- /status -->`);
    expect(read('yesterday')?.since).toBeNull();
    expect(read('2026-11-04T09:00:00Z.')?.since).toBeNull();
    expect(read('2026-11-04T09:00:00Z')?.since).toBe('2026-11-04T09:00:00Z');
    expect(read('yesterday')?.waitingOn).toBe('owner');
  });

  it('returns null, without throwing, for missing or malformed sections', () => {
    expect(parseStatus('no markers here')).toBeNull();
    expect(parseStatus('<!-- status -->\n**Ask:** x\n<!-- /status -->')).toBeNull();
    expect(parseStatus('<!-- status -->\n**Waiting on:** Sam\n**Ask:** x')).toBeNull();
  });
});

describe('renderStatus', () => {
  it('round-trips through parseStatus', () => {
    const s = parseStatus(example)!;
    expect(parseStatus(renderStatus(s))).toEqual(s);
  });

  it('round-trips a status with no optional parts', () => {
    const s: Status = { waitingOn: 'nobody', since: null, ask: 'nothing', questions: [], toTest: null };
    expect(parseStatus(renderStatus(s))).toEqual(s);
  });
});

describe('the status as data', () => {
  const dataLine = (text: string) => text.split('\n').find((l) => l.startsWith('<!-- status-data '));

  it('writes the same content as JSON on the last line inside the markers, with its fingerprint', () => {
    const lines = renderStatus(expected).split('\n');
    expect(lines.at(-1)).toBe('<!-- /status -->');
    const line = lines.at(-2)!;
    expect(line).toMatch(/^<!-- status-data \{.*\} -->$/);
    const data = JSON.parse(line.slice('<!-- status-data '.length, -' -->'.length));
    expect(data).toEqual({ v: 1, ...expected, fingerprint: statusFingerprint(expected) });
  });

  it('reads the data in preference to text that disagrees with it', () => {
    const claude: Status = { ...expected, waitingOn: 'claude', ask: 'from the data' };
    const mixed = example.replace('<!-- /status -->', `${dataLine(renderStatus(claude))}\n<!-- /status -->`);
    expect(parseStatus(mixed)).toEqual(claude);
  });

  it('falls back to the text when the data is broken, the wrong shape, or its fingerprint is wrong', () => {
    const withData = (line: string) => example.replace('<!-- /status -->', `${line}\n<!-- /status -->`);
    const good = JSON.parse(dataLine(renderStatus({ ...expected, ask: 'data' }))!.slice(17, -4));
    expect(parseStatus(withData('<!-- status-data {not json -->'))).toEqual(expected);
    expect(parseStatus(withData(`<!-- status-data ${JSON.stringify({ ...good, waitingOn: 'someone' })} -->`))).toEqual(expected);
    expect(parseStatus(withData(`<!-- status-data ${JSON.stringify({ ...good, questions: 'none' })} -->`))).toEqual(expected);
    expect(parseStatus(withData(`<!-- status-data ${JSON.stringify({ ...good, v: 2 })} -->`))).toEqual(expected);
    expect(parseStatus(withData(`<!-- status-data ${JSON.stringify({ ...good, fingerprint: '00000000' })} -->`))).toEqual(expected);
    expect(parseStatus(withData(`<!-- status-data ${JSON.stringify(good)} -->`))?.ask).toBe('data');
  });

  it('keeps a value holding "-->" from ending the data line early', () => {
    const tricky: Status = { ...expected, ask: 'a --> b <c>', questions: [{ n: 1, text: 'x --> y?', choices: ['<a>', 'b'], defaultChoice: '<a>' }] };
    const rendered = renderStatus(tricky);
    expect(dataLine(rendered)!.indexOf('-->')).toBe(dataLine(rendered)!.length - 3);
    expect(dataLine(rendered)).not.toContain('<a>');
    expect(parseStatus(rendered)).toEqual(tricky);
  });
});

describe('renderStatus guards', () => {
  it('refuses a field with a line break, since each field is one line and a second could change whose turn it is', () => {
    expect(() => renderStatus({ ...expected, toTest: 'step one\nstep two' })).toThrow(/one line/);
    expect(() => renderStatus({ ...expected, ask: 'ok\n**Waiting on:** nobody' })).toThrow(/one line/);
    expect(() => renderStatus({ ...expected, questions: [{ ...expected.questions[0]!, text: 'a\nb' }] })).toThrow(/one line/);
    expect(() => renderStatus({ ...expected, questions: [{ ...expected.questions[0]!, choices: ['leave\nx', 'change'] }] })).toThrow(/one line/);
  });

  it('refuses a field holding a status marker', () => {
    expect(() => renderStatus({ ...expected, ask: 'see <!-- /status -->' })).toThrow(/status marker/);
  });
});

describe('replaceStatus', () => {
  it('replaces the section and leaves surrounding text untouched', () => {
    const out = replaceStatus('A\n<!-- status -->\nold\n<!-- /status -->\nB\n\n## Rest', expected);
    expect(out).toBe(`A\n${renderStatus(expected)}\nB\n\n## Rest`);
  });

  it('puts a new section at the top when none exists', () => {
    expect(replaceStatus('Closes #569\n\nText', expected)).toBe(
      renderStatus(expected) + '\n\nCloses #569\n\nText',
    );
  });
});

describe('pickStatusComment', () => {
  const section = '<!-- status -->\n**Waiting on:** Sam\n<!-- /status -->';
  it('takes the last comment that has a status section', () => {
    const comments = [{ body: 'hi' }, { body: `first ${section}` }, { body: 'chat' }, { body: `second ${section}` }, { body: 'more chat' }];
    expect(pickStatusComment(comments)).toBe(comments[3]);
  });
  it('returns null when none has one', () => {
    expect(pickStatusComment([{ body: 'hi' }, { body: '<!-- status --> never closed' }])).toBeNull();
    expect(pickStatusComment([])).toBeNull();
  });
});

describe('extractToTest', () => {
  it('returns the text after the marker up to the next blank line', () => {
    const body = 'Intro\n\n**To look at on the preview:**  pin a verse,\nthen press Escape.  \n\nMore text';
    expect(extractToTest(body)).toBe('pin a verse,\nthen press Escape.');
  });

  it('returns null when the marker is absent', () => {
    expect(extractToTest('nothing here')).toBeNull();
  });
});
