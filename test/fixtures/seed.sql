-- The four cards sketched in the design, for looking at the page locally. It empties the local tables first,
-- so it can be applied again. Apply it to the local database only:
--   pnpm exec wrangler d1 execute pr-board --local --file test/fixtures/seed.sql
-- The repo is made up, so GitHub can't be read for it: titles fall back to the item's number and the
-- Prep for merge gate of #626 shows red, since the board can't see that the PR can merge.

DELETE FROM log;
DELETE FROM answer;
DELETE FROM pickup;
DELETE FROM proposal;
DELETE FROM service_look;
DELETE FROM work;

-- #626 Tools state: prep complete, both earlier gates approved.
INSERT INTO work (id, repo, issue, pr, has_design, gate, state, reached, ask, questions, to_test, back_reason, approved, rounds, prep_sha, version, turn_since, written_at, confirmed_at, started_at)
VALUES (626, 'acme/torahmap', NULL, 626, 1, 'prep', 'complete', 'prep', 'Ready to merge', '[]', NULL, NULL,
  '{"design":"2026-11-15T10:00:00.000Z","implementation":"2026-11-19T10:00:00.000Z"}', '{"design":1,"implementation":1,"prep":1}', 'abc626', 7,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 minutes'), NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5000 minutes'));

-- #573 Pinned verses: paused in Implementation with one question. The question's text has HTML in it, to show it stays text.
INSERT INTO work (id, repo, issue, pr, has_design, gate, state, reached, ask, questions, to_test, back_reason, approved, rounds, prep_sha, version, turn_since, written_at, confirmed_at, started_at)
VALUES (573, 'acme/torahmap', NULL, 573, 1, 'implementation', 'paused', 'implementation', 'One thing to decide <script>alert(1)</script>',
  '[{"n":1,"text":"Pin colour? <b>not bold</b>","choices":["gold","grey"],"defaultChoice":"gold"}]', NULL, NULL,
  '{"design":"2026-11-16T10:00:00.000Z"}', '{"design":1,"implementation":0,"prep":0}', NULL, 3,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-120 minutes'), NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4000 minutes'));

-- #580 Search box: an issue with Design complete for the second time.
INSERT INTO work (id, repo, issue, pr, has_design, gate, state, reached, ask, questions, to_test, back_reason, approved, rounds, prep_sha, version, turn_since, written_at, confirmed_at, started_at)
VALUES (580, 'acme/torahmap', 580, NULL, 1, 'design', 'complete', 'design', 'Two mockups to pick from', '[]', NULL, NULL,
  '{}', '{"design":2,"implementation":0,"prep":0}', NULL, 4,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1440 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1440 minutes'), NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3000 minutes'));

-- #564 Layout: moved back from Implementation to Design, with Implementation on hold.
INSERT INTO work (id, repo, issue, pr, has_design, gate, state, reached, ask, questions, to_test, back_reason, approved, rounds, prep_sha, version, turn_since, written_at, confirmed_at, started_at)
VALUES (564, 'acme/torahmap', NULL, 564, 1, 'design', 'working', 'implementation', 'Redoing the grid', '[]', NULL, 'the grid can''t hold long titles',
  '{}', '{"design":1,"implementation":0,"prep":0}', NULL, 5,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 minutes'), NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6000 minutes'));

-- The backlog: the Mac service's last look (3 of 4 sessions running, two repos), a proposal waiting for answers,
-- two issues it says are waiting on other work, a proposal still being looked for, a picked-up issue waiting for a session and one its session gave up on.
INSERT INTO service_look (id, at, running, max_sessions, repos) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 3, 4, '["acme/torahmap","acme/notes"]');

INSERT INTO proposal (id, repo, asked_at, started_at, written_at, items)
VALUES (1, 'acme/torahmap', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-29 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'),
  '[{"issue":25,"title":"Stop hook asks for a status on closed items","suggestion":"pick up","reason":"It blocks the end of nearly every session that files an issue; small and well understood."},{"issue":4,"title":"Make the status hook sturdier <b>not bold</b>","suggestion":"pick up","reason":"Same code as #25; doing them one after the other saves reading it twice."},{"issue":3,"title":"Bring the timeline back","suggestion":"later","reason":"Large, and its first step already exists."},{"issue":11,"title":"Read GitHub in fewer requests","suggestion":"close","reason":"The service no longer reads items from GitHub. Close as done."},{"issue":7,"title":"Colour the echoes by distance","suggestion":"waiting","reason":"Waiting on #640, which changes how distance is counted."},{"issue":9,"title":"Search inside a book","suggestion":"waiting","reason":"Waiting on #580: search by root sets up the index this would use."}]');

INSERT INTO proposal (id, repo, asked_at, started_at) VALUES (2, 'acme/notes', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'));

INSERT INTO pickup (id, repo, issue, proposal_id, asked_at) VALUES (1, 'acme/torahmap', 40, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'));
INSERT INTO pickup (id, repo, issue, proposal_id, asked_at, started_at, failed_at, failure)
VALUES (2, 'acme/torahmap', 41, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-80 minutes'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'),
  'The session ended without writing a first status. Its output is the newest acme-torahmap-41-*.log in ~/.pr-board/logs.');
