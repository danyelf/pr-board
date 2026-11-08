import { WAITING_ON, WRITTEN_ELSEWHERE, type WaitingOn } from './names.ts';
import { statusFingerprint } from './fingerprint.ts';
import type { ItemFacts, Question, Status } from './types.ts';

export const STATUS_OPEN = '<!-- status -->';
export const STATUS_CLOSE = '<!-- /status -->';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WAITING_LINE = new RegExp(`^(${WAITING_ON.map((w) => escapeRegExp(w.spelling)).join('|')})(?:,\\s*since\\s+(\\S+))?$`);
const roleOf = (spelling: string): WaitingOn | null => WAITING_ON.find((w) => w.spelling === spelling)?.role ?? null;
const spellingOf = (role: WaitingOn): string => WAITING_ON.find((w) => w.role === role)!.spelling;

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

/**
 * The text an item's status lives in: a PR's description, or an issue's last status comment.
 * `readStatusText` in cli/gh.ts follows the same rule through `gh`.
 */
export function statusText(f: Pick<ItemFacts, 'kind' | 'body' | 'statusCommentBody'>): string {
  return f.kind === 'pr' ? f.body : f.statusCommentBody ?? '';
}

const DATA_OPEN = '<!-- status-data ';
const DATA_CLOSE = ' -->';
const isDataLine = (line: string): boolean => line.startsWith(DATA_OPEN) && line.endsWith(DATA_CLOSE);

/** JSON with `<` and `>` written as escapes, so no value can end the HTML comment or the section it sits in. */
export function jsonForComment(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isTime = (v: string): boolean => !Number.isNaN(Date.parse(v));

function readQuestion(v: unknown): Question | null {
  if (typeof v !== 'object' || v === null) return null;
  const q = v as Record<string, unknown>;
  if (!Number.isInteger(q.n) || !isString(q.text) || !Array.isArray(q.choices) || !q.choices.every(isString)) return null;
  if (!isStringOrNull(q.defaultChoice)) return null;
  return { n: q.n as number, text: q.text, choices: q.choices, defaultChoice: q.defaultChoice };
}

/** The status in a data line, or null when it isn't JSON of the right shape or its fingerprint is wrong. */
function readData(line: string): Status | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line.slice(DATA_OPEN.length, -DATA_CLOSE.length));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.v !== 1 || !isString(d.fingerprint) || !isString(d.ask) || !isStringOrNull(d.since) || !isStringOrNull(d.toTest)) return null;
  const waitingOn = WAITING_ON.find((w) => w.role === d.waitingOn)?.role;
  if (!waitingOn || !Array.isArray(d.questions)) return null;
  const questions = d.questions.map(readQuestion);
  if (questions.some((q) => q === null)) return null;
  const since = d.since !== null && isTime(d.since) ? d.since : null;
  const status: Status = { waitingOn, since, ask: d.ask, questions: questions as Question[], toTest: d.toTest };
  if (isString(d.writtenAt) && isTime(d.writtenAt)) status.writtenAt = d.writtenAt;
  return statusFingerprint(status) === d.fingerprint ? status : null;
}

/** The status read from the text lines alone, or null when no line says whose turn it is. */
function readText(lines: string[]): Status | null {
  let waitingOn: WaitingOn | null = null;
  let since: string | null = null;
  let ask = '';
  let toTest: string | null = null;
  const questions: Question[] = [];
  let inQuestions = false;

  for (const line of lines) {
    const field = /^\*\*([^*]+):\*\*\s*(.*)$/.exec(line);
    if (field) {
      inQuestions = false;
      const value = field[2]!.trim();
      switch (field[1]) {
        case 'Waiting on': {
          const m = WAITING_LINE.exec(value);
          if (m) {
            waitingOn = roleOf(m[1]!);
            // A time we can't read is no use for working out how long it has waited.
            since = m[2] && isTime(m[2]) ? m[2] : null;
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

/** The lines people see, as `renderStatus` writes them between the markers. */
function textLines(s: Status): string[] {
  const lines = [`**Waiting on:** ${spellingOf(s.waitingOn)}${s.since ? `, since ${s.since}` : ''}`, `**Ask:** ${s.ask}`];
  if (s.questions.length > 0) {
    lines.push('**Questions:**');
    for (const q of s.questions) {
      const choices = q.choices.map((c) => (c === q.defaultChoice ? `**${c}**` : c)).join(' | ');
      lines.push(`${q.n}. ${q.text}${q.choices.length > 0 ? `  (${choices})` : ''}`);
    }
  }
  if (s.toTest) lines.push(`**To test:** ${s.toTest}`);
  return lines;
}

/** Trimmed, without blank lines, so line endings and stray spaces from an editor don't count as a change. */
const tidy = (lines: string[]): string[] => lines.map((l) => l.trim()).filter((l) => l !== '');

/**
 * The status in the text, or null when there is none or it can't be read. The data line that
 * `renderStatus` writes is used only while the text lines are still exactly what that data would
 * render; once someone has edited the text (on GitHub, or by rewriting the description), the text is
 * read and the status is marked as edited by hand. Sections written before the data line existed are
 * read from the text, unmarked.
 */
export function parseStatus(text: string): Status | null {
  const section = findSection(text);
  if (!section) return null;
  const lines = tidy(section.inner.split(/\r?\n/));
  const dataLine = lines.find(isDataLine);
  const visible = lines.filter((l) => !isDataLine(l));
  if (dataLine === undefined) return readText(visible);

  const fromData = readData(dataLine);
  if (fromData && tidy(textLines(fromData)).join('\n') === visible.join('\n')) return fromData;
  const fromText = readText(visible);
  return fromText && { ...fromText, editedByHand: true };
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
  const data = {
    v: 1, waitingOn: s.waitingOn, since: s.since, ask: s.ask, questions: s.questions, toTest: s.toTest,
    ...(s.writtenAt ? { writtenAt: s.writtenAt } : {}),
    fingerprint: statusFingerprint(s),
  };
  return [STATUS_OPEN, ...textLines(s), `${DATA_OPEN}${jsonForComment(data)}${DATA_CLOSE}`, STATUS_CLOSE].join('\n');
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
