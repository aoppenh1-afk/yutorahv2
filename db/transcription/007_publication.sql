BEGIN;
-- Direct imports of an older database use generation 1. Future outbox
-- publications must start above that snapshot, even on the first queued ID.
CREATE SEQUENCE transcript_publication_generation START WITH 2;
CREATE TABLE transcript_publications (
  shiur_id text PRIMARY KEY REFERENCES transcription_shiurim(id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT nextval('transcript_publication_generation'),
  published_generation bigint NOT NULL DEFAULT 0,
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transcript_publications_pending ON transcript_publications(available_at)
  WHERE generation>published_generation;
CREATE FUNCTION queue_transcript_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
  IF TG_TABLE_NAME='transcription_shiurim' THEN target=NEW.id;
  ELSIF TG_TABLE_NAME='transcripts' OR TG_TABLE_NAME='transcript_segments' THEN target=NEW.shiur_id;
  ELSE SELECT shiur_id INTO target FROM transcripts WHERE id=NEW.transcript_id;
  END IF;
  INSERT INTO transcript_publications(shiur_id) SELECT id FROM transcription_shiurim
    WHERE id=target AND active_transcript_id IS NOT NULL
  ON CONFLICT(shiur_id) DO UPDATE SET generation=nextval('transcript_publication_generation'),
    available_at=now(),attempt=0,error=NULL,updated_at=now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER transcript_publication_pointer AFTER UPDATE OF active_transcript_id,title,teacher,media_url
  ON transcription_shiurim FOR EACH ROW EXECUTE FUNCTION queue_transcript_publication();
CREATE TRIGGER transcript_publication_correction AFTER UPDATE OF text ON transcripts
  FOR EACH ROW EXECUTE FUNCTION queue_transcript_publication();
CREATE TRIGGER transcript_publication_segment AFTER UPDATE OF text,start_ms,end_ms,speaker,language ON transcript_segments
  FOR EACH ROW EXECUTE FUNCTION queue_transcript_publication();
CREATE TRIGGER transcript_publication_notes AFTER INSERT OR UPDATE OF status ON notes_jobs
  FOR EACH ROW EXECUTE FUNCTION queue_transcript_publication();
CREATE TRIGGER transcript_publication_markdown AFTER INSERT OR UPDATE OF markdown ON transcript_notes
  FOR EACH ROW EXECUTE FUNCTION queue_transcript_publication();
INSERT INTO transcript_publications(shiur_id) SELECT id FROM transcription_shiurim WHERE active_transcript_id IS NOT NULL;
COMMIT;
