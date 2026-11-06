import { WAITING_ON, WRITTEN_ELSEWHERE, type WaitingOn } from './names.ts';
import type { Question, Status } from './types.ts';

export const STATUS_OPEN = '<!-- status -->';
export const STATUS_CLOSE = '<!-- /status -->';

const WAITING_LINE = new RegExp(`^(${WAITING_ON.map((w) => w.status).join('|')})(?:,\\s*since\\s+(\\S+))?$`);

function findSection(text: string): { start: number; end: number; inner: string } | null {
  const start = text.indexOf(STATUS_OPEN);
  if (start === -1) return null;
  const closeAt = text.indexOf(STATUS_CLOSE, start + STATUS_OPEN.length);
  if (closeAt === -1) return null;
  return {
    start,
    end: closeAt + STATUS_CLOSE.length,
    inner: text.slice(start + STATUS_OPEN.length, closeAt),
  };
}

function parseQuestion(n: number, rest: string): Question {
  let choices: string[] = [];
  let defaultChoice: string | null = null;
  let text = rest;
  const groups = [...rest.matchAll(/\(([^()]*)\)/g)].filter((m) => m[1]!.includes('|'));
  const last = groups[groups.length - 1];
  if (last) {
    const parts = last[1]!.split('|').map((p) => p.trim());
    choices = parts.map((p) => {
      const bold = /^\*\*(.*)\*\*$/.exec(p);
      if (bold) defaultChoice = bold[1]!.trim();
      return bold ? bold[1]!.trim() : p;
    });
    text = rest.slice(0, last.index) + rest.slice(last.index! + last[0].length);
  }
  return { n, text: text.trim(), choices, defaultChoice };
}

/** True when the text has a status section, whether or not it can be read. */
export function hasStatusSection(text: string): boolean {
  return findSection(text) !== null;
}

/**
 * The comment that holds an issue's status: the last one, in the order given (oldest first), that has
 * a status section. When more than one has been written, the newest is the one in force.
 */
export function pickStatusComment<T extends { body: string }>(comments: T[]): T | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (hasStatusSection(comments[i]!.body)) return comments[i]!;
  }
  return null;
}

export function parseStatus(text: string): Status | null {
  const section = findSection(text);
  if (!section) return null;

  let waitingOn: WaitingOn | null = null;
  let since: string | null = null;
  let ask = '';
  let toTest: string | null = null;
  const questions: Question[] = [];
  let inQuestions = false;

  for (const raw of section.inner.split('\n')) {
    const line = raw.trim();
    const field = /^\*\*([^*]+):\*\*\s*(.*)$/.exec(line);
    if (field) {
      inQuestions = false;
      const value = field[2]!.trim();
      switch (field[1]) {
        case 'Waiting on': {
          const m = WAITING_LINE.exec(value);
          if (m) {
            waitingOn = m[1] as WaitingOn;
            // A time we can't read is no use for working out how long it has waited.
            since = m[2] && !Number.isNaN(Date.parse(m[2])) ? m[2] : null;
          }
          break;
        }
        case 'Ask':
          ask = value;
          break;
        case 'Questions':
          inQuestions = true;
          break;
        case 'To test':
          toTest = value || null;
          break;
      }
      continue;
    }
    if (inQuestions) {
      const q = /^(\d+)\.\s+(.*)$/.exec(line);
      if (q) questions.push(parseQuestion(Number(q[1]), q[2]!));
    }
  }

  if (waitingOn === null) return null;
  return { waitingOn, since, ask, questions, toTest };
}

/**
 * Why a value can't go into the status section as written, or null if it can. Each field is one line,
 * so a line break would cut the value short when read back, and the next line could pose as another
 * field (a stray "**Waiting on:**" changes whose turn it is). A marker would end the section early.
 */
export function statusValueProblem(value: string): 'line break' | 'status marker' | null {
  if (/[\r\n]/.test(value)) return 'line break';
  if (value.includes(STATUS_OPEN) || value.includes(STATUS_CLOSE)) return 'status marker';
  return null;
}

function checkValue(field: string, value: string): void {
  const problem = statusValueProblem(value);
  if (problem === 'line break') throw new Error(`The status ${field} must be one line: "${value}"`);
  if (problem === 'status marker') throw new Error(`The status ${field} can't contain a status marker: "${value}"`);
}

export function renderStatus(s: Status): string {
  checkValue('ask', s.ask);
  if (s.since) checkValue('since', s.since);
  if (s.toTest) checkValue('test protocol', s.toTest);
  for (const q of s.questions) {
    checkValue(`question ${q.n}`, q.text);
    for (const c of q.choices) checkValue(`question ${q.n} choice`, c);
  }
  const lines = [STATUS_OPEN, `**Waiting on:** ${s.waitingOn}${s.since ? `, since ${s.since}` : ''}`, `**Ask:** ${s.ask}`];
  if (s.questions.length > 0) {
    lines.push('**Questions:**');
    for (const q of s.questions) {
      const choices = q.choices.map((c) => (c === q.defaultChoice ? `**${c}**` : c)).join(' | ');
      lines.push(`${q.n}. ${q.text}${q.choices.length > 0 ? `  (${choices})` : ''}`);
    }
  }
  if (s.toTest) lines.push(`**To test:** ${s.toTest}`);
  lines.push(STATUS_CLOSE);
  return lines.join('\n');
}

export function replaceStatus(body: string, s: Status): string {
  const section = findSection(body);
  const rendered = renderStatus(s);
  if (!section) return `${rendered}\n\n${body}`;
  return body.slice(0, section.start) + rendered + body.slice(section.end);
}

export function extractToTest(body: string): string | null {
  const marker = WRITTEN_ELSEWHERE.toLookAt;
  const at = body.indexOf(marker);
  if (at === -1) return null;
  const after = body.slice(at + marker.length);
  const blank = after.search(/\n[ \t]*\n/);
  const chunk = (blank === -1 ? after : after.slice(0, blank)).trim();
  return chunk || null;
}
