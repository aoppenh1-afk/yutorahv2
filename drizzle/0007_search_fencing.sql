ALTER TABLE search_runs ADD COLUMN owner text NOT NULL DEFAULT '';
--> statement-breakpoint
-- A failed assertion aborts the entire D1 batch, including title and hit writes.
CREATE TABLE search_pass_guards (
  run text NOT NULL,
  owner text NOT NULL,
  valid integer NOT NULL CONSTRAINT search_pass_owned CHECK (valid = 1),
  PRIMARY KEY (run, owner)
);
