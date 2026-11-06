import type { Question, Status } from './types.ts';

const OPEN = '<!-- status -->';
const CLOSE = '<!-- /status -->';

const WAITING_ON = ['Danyel', 'Claude', 'nobody'] as const;

function findSection(text: string): { start: number; end: number; inner: string } | null {
  const start = text.indexOf(OPEN);
  if (start === -1) return null;
  const closeAt = text.indexOf(CLOSE, start + OPEN.length);
  if (closeAt === -1) return null;
  return {
    start,
    end: closeAt + CLOSE.length,
    inner: text.slice(start + OPEN.length, closeAt),
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

export function parseStatus(text: string): Status | null {
  const section = findSection(text);
  if (!section) return null;

  let waitingOn: Status['waitingOn'] | null = null;
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
          const m = /^(Danyel|Claude|nobody)(?:,\s*since\s+(\S+))?$/.exec(value);
          if (m && (WAITING_ON as readonly string[]).includes(m[1]!)) {
            waitingOn = m[1] as Status['waitingOn'];
            since = m[2] ?? null;
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

export function renderStatus(s: Status): string {
  const lines = [OPEN, `**Waiting on:** ${s.waitingOn}${s.since ? `, since ${s.since}` : ''}`, `**Ask:** ${s.ask}`];
  if (s.questions.length > 0) {
    lines.push('**Questions:**');
    for (const q of s.questions) {
      const choices = q.choices.map((c) => (c === q.defaultChoice ? `**${c}**` : c)).join(' | ');
      lines.push(`${q.n}. ${q.text}${q.choices.length > 0 ? `  (${choices})` : ''}`);
    }
  }
  if (s.toTest) lines.push(`**To test:** ${s.toTest}`);
  lines.push(CLOSE);
  return lines.join('\n');
}

export function replaceStatus(body: string, s: Status): string {
  const section = findSection(body);
  const rendered = renderStatus(s);
  if (!section) return `${rendered}\n\n${body}`;
  return body.slice(0, section.start) + rendered + body.slice(section.end);
}

export function extractToTest(body: string): string | null {
  const marker = '**To look at on the preview:**';
  const at = body.indexOf(marker);
  if (at === -1) return null;
  const after = body.slice(at + marker.length);
  const blank = after.search(/\n[ \t]*\n/);
  const chunk = (blank === -1 ? after : after.slice(0, blank)).trim();
  return chunk || null;
}
