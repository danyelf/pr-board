-- The four cards sketched in the design, for looking at the page locally. It empties the local tables first,
-- so it can be applied again. Apply it to the local database only:
--   pnpm exec wrangler d1 execute pr-board --local --file test/fixtures/seed.sql
-- The repo is made up, so GitHub can't be read for it: titles fall back to the item's number and the
-- Prep for merge gate of #626 shows red, since the board can't see that the PR can merge.

DELETE FROM log;
DELETE FROM answer;
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
  '[{"n":1,"text":"Pin colour? <b>not bold</b>","choices":["gold","grey","file an issue"],"defaultChoice":"gold"}]', NULL, NULL,
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
