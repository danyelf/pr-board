-- When the Mac service finished carrying out a proposal's answers. Carried but not finished at a later look means it
-- stopped partway, so a note session must not start as if every choice were done.
ALTER TABLE proposal ADD COLUMN carry_done_at TEXT;
