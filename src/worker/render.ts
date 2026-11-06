import type { Board, Card } from './board.ts';
import type { BoxState, ItemFacts } from '../shared/types.ts';
import { DAY_MS } from '../shared/names.ts';
import { boxNamed } from '../shared/stage.ts';
import { formatWait } from '../shared/turn.ts';

const CSS = `
  :root { --bg:#fbfaf7; --ink:#1d1d1b; --mute:#6b6a65; --line:#e3e0d8; --wait:#e8a33a; --waitbg:#fdf3e1; --work:#4a7bd0; --done:#9aa59a; --ok:#3f9a5b; --bad:#a8523a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 -apple-system, system-ui, sans-serif; }
  .pb { max-width:1100px; margin:0 auto; padding:20px 16px 40px; }
  a { color:#1d4f9c; }
  .top { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-size:12px; color:var(--mute); }
  .err { margin:6px 0 0; padding:6px 10px; border:1px solid #e6b9ac; background:#fbece7; color:#8a3a26; border-radius:6px; font-size:12.5px; }
  .sec { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--mute); margin:22px 0 8px; }
  .empty { color:var(--mute); font-size:13px; }
  .card { border:1px solid var(--line); border-left:5px solid var(--wait); background:#fff; border-radius:8px; padding:12px 14px; margin-bottom:10px; }
  .card.ready { border-left-color:var(--ok); }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .row > div { min-width:0; overflow-wrap:anywhere; }
  .num { font-weight:700; margin-right:6px; white-space:nowrap; text-decoration:underline; text-decoration-color:#b7c6e2; text-underline-offset:2px; }
  .num:hover { text-decoration-color:currentColor; }
  .proj { font-size:12px; font-weight:600; color:var(--mute); margin:12px 0 6px; }
  .tags { display:flex; gap:6px; align-items:baseline; flex-wrap:wrap; }
  .why { font-size:12px; font-weight:600; padding:2px 8px; border-radius:20px; background:var(--waitbg); color:#8a5a10; white-space:nowrap; }
  .ready .why { background:#e4f3e8; color:#245e36; }
  .sync { font-size:12px; font-weight:600; padding:2px 8px; border-radius:20px; background:#fbece7; color:#8a3a26; white-space:nowrap; }
  .age { color:var(--mute); font-size:12px; }
  .steps { display:flex; gap:3px; margin:9px 0 4px; }
  .steps span { flex:1; min-width:0; font-size:11px; text-align:center; padding:4px 2px; border-radius:4px; background:#efede7; color:#9a978e; line-height:1.2; }
  .steps span small { display:block; font-size:10px; opacity:.85; overflow-wrap:anywhere; }
  .steps .d { background:#dfe7f5; color:#3d5c95; }
  .steps .now { background:var(--wait); color:#fff; font-weight:600; }
  .steps .ready { background:var(--ok); color:#fff; font-weight:600; }
  .steps .blocked { background:var(--bad); color:#fff; font-weight:600; }
  .links { display:flex; gap:6px; margin:8px 0 0; flex-wrap:wrap; }
  .links a { font-size:12px; padding:3px 9px; border:1px solid #cfccc3; border-radius:5px; background:#fff; color:#1d4f9c; text-decoration:none; }
  .detail { font-size:12.5px; color:#3b3a37; margin-top:8px; overflow-wrap:anywhere; }
  .detail b { color:var(--ink); }
  .q { margin:6px 0 0; padding:0; list-style:none; } .q li { margin-bottom:8px; }
  .choices { display:flex; gap:6px; margin-top:4px; flex-wrap:wrap; }
  .btn { font:inherit; font-size:12px; padding:4px 10px; border:1px solid #cfccc3; border-radius:5px; background:#fff; color:var(--ink); cursor:not-allowed; }
  .btn.default { font-weight:700; border:2px solid var(--ink); padding:3px 9px; }
  .shots { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  .shots img { width:96px; height:auto; border:1px solid var(--line); border-radius:4px; display:block; }
  .quiet { display:flex; gap:10px; align-items:baseline; font-size:13px; padding:7px 12px; border:1px solid var(--line); border-radius:6px; background:#f6f5f1; margin-bottom:6px; }
  .quiet .t { min-width:0; overflow-wrap:anywhere; }
  .quiet .age { margin-left:auto; text-align:right; }
  @media (max-width:480px) {
    .steps span { font-size:9.5px; padding:4px 1px; }
    .steps span small { font-size:8.5px; }
  }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function url(s: string): string {
  return /^https?:\/\//.test(s) ? esc(s) : '#';
}

const updated = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

const BOX_CLASS: Record<BoxState, string> = { done: 'd', now: 'now', ready: 'ready', blocked: 'blocked', todo: '' };

function link(href: string, text: string): string {
  return `<a href="${url(href)}">${esc(text)} ↗</a>`;
}

function issueUrl(f: ItemFacts): string | null {
  if (f.kind === 'issue') return f.url;
  return f.linkedIssue === null ? null : `https://github.com/${f.repo}/issues/${f.linkedIssue}`;
}

/** The item's number as a link to it on GitHub, saying whether it is a PR or an issue. */
function ref(f: ItemFacts): string {
  return `<a class="num" href="${url(f.url)}">${f.kind === 'pr' ? 'PR' : 'Issue'} #${f.number}</a>`;
}

/** One small heading per project, in the order each project's first item comes in the list. */
function byProject(cards: Card[], draw: (c: Card) => string): string {
  const groups = new Map<string, Card[]>();
  for (const c of cards) groups.set(c.facts.repo, [...(groups.get(c.facts.repo) ?? []), c]);
  return [...groups]
    .map(([repo, group]) => `<div class="proj" title="${esc(repo)}">${esc(repo.split('/').pop() ?? repo)}</div>\n${group.map(draw).join('\n')}`)
    .join('\n');
}

function renderCard(c: Card): string {
  const f = c.facts;
  const merge = boxNamed(c.strip, 'Ready for merge');
  const strip = c.strip
    .map((b) => `<span class="${BOX_CLASS[b.state]}">${esc(b.name)}${b.note ? `<small>${esc(b.note)}</small>` : ''}</span>`)
    .join('');

  const links: string[] = [];
  if (f.previewUrl) links.push(link(f.previewUrl, 'Preview'));
  if (f.kind === 'pr') links.push(link(f.url, 'PR'));
  if (f.reviewUrl) links.push(link(f.reviewUrl, "Claude's review"));
  const issue = issueUrl(f);
  if (issue) links.push(link(issue, 'Issue'));
  for (const d of f.addedDocs) links.push(link(d.url, `Design doc ${d.path.split('/').pop() ?? ''}`.trim()));
  if (merge.state === 'ready') links.push(link(f.url, 'Merge on GitHub'));

  const parts: string[] = [];
  if (c.statusUnreadable) parts.push(`<div class="detail age">${esc("The status section couldn't be read")}</div>`);
  else if (c.status === null) parts.push('<div class="detail age">No status written yet</div>');
  if (c.status && c.status.questions.length > 0) {
    const qs = c.status.questions
      .map((q) => {
        const buttons = [...q.choices, 'file an issue']
          .map((choice) => {
            const cls = choice === q.defaultChoice ? 'btn default' : 'btn';
            return `<button type="button" class="${cls}" disabled title="Answering comes next">${esc(choice)}</button>`;
          })
          .join('');
        return `<li>${q.n}. ${esc(q.text)}<div class="choices">${buttons}</div></li>`;
      })
      .join('');
    parts.push(`<div class="detail"><b>Left for you to decide:</b><ol class="q">${qs}</ol></div>`);
  }
  if (c.toTest) parts.push(`<div class="detail"><b>To test:</b> ${esc(c.toTest)}</div>`);
  if (f.screenshots.length > 0) {
    const shots = f.screenshots
      .slice(0, 4)
      .map((s) => `<a href="${url(s)}"><img src="${url(s)}" width="96" alt="Screenshot" loading="lazy"></a>`)
      .join('');
    parts.push(`<div class="shots">${shots}</div>`);
  }

  return `<div class="card${merge.state === 'ready' ? ' ready' : ''}">
    <div class="row"><div>${ref(f)}${esc(f.title)}</div>
      <div class="tags">${c.waited ? `<span class="age">waiting ${esc(c.waited)}</span>` : ''}${c.why ? `<span class="why">${esc(c.why)}</span>` : ''}${c.outOfSync ? '<span class="sync">label out of sync</span>' : ''}</div></div>
    <div class="steps">${strip}</div>
    ${links.length ? `<div class="links">${links.join('')}</div>` : ''}
    ${parts.join('\n    ')}
  </div>`;
}

function ago(iso: string, now: Date): string {
  return `${formatWait(iso, now)} ago`;
}

/** A one-line row: the item, then a short note on the right. */
function listRow(c: Card, note: string): string {
  return `<div class="quiet">${ref(c.facts)}<span class="t">${esc(c.facts.title)}</span><span class="age">${esc(note)}</span></div>`;
}

function claudeRow(c: Card, now: Date): string {
  const noLabel = c.turn === 'none' ? ' · no turn label' : '';
  return listRow(c, `last activity ${ago(c.facts.lastActivityAt, now)}${noLabel}`);
}

function quietRow(c: Card, now: Date): string {
  const days = Math.floor((now.getTime() - new Date(c.facts.lastActivityAt).getTime()) / DAY_MS);
  const noLabel = c.turn === 'none' ? ' · no turn label' : '';
  return listRow(c, c.turn === 'nobody' ? 'parked' : `no activity for ${days} days${noLabel}`);
}

export function renderBoard(b: Board): string {
  const now = new Date(b.generatedAt);
  const errors = b.errors.map((e) => `<div class="err">${esc(e)}</div>`).join('');
  // With anything unread, an empty list proves nothing, so never offer the reassuring line.
  const nothingWaiting = b.errors.length
    ? esc("Couldn't read everything from GitHub, so this list may be incomplete.")
    : 'Nothing is waiting on you.';
  const waiting = b.waiting.length ? byProject(b.waiting, renderCard) : `<div class="empty">${nothingWaiting}</div>`;
  const claude = b.onClaude.length ? byProject(b.onClaude, (c) => claudeRow(c, now)) : '<div class="empty">Nothing in progress.</div>';
  const quiet = b.quiet.length ? byProject(b.quiet, (c) => quietRow(c, now)) : '<div class="empty">Nothing quiet.</div>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>PR Board</title><style>${CSS}</style></head>
<body><div class="pb">
  <div class="top"><span>Updated ${esc(updated.format(now))}</span></div>
  ${errors}
  <div class="sec">Waiting on you</div>
  ${waiting}
  <div class="sec">On Claude</div>
  ${claude}
  <div class="sec">Quiet: nobody is working on these</div>
  ${quiet}
</div></body></html>`;
}
