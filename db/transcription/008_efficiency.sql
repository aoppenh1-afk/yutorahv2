BEGIN;
ALTER TABLE transcript_publications ADD COLUMN content_changed boolean NOT NULL DEFAULT true;
-- Previously acknowledged publications have no content waiting to be exported.
UPDATE transcript_publications SET content_changed=false WHERE generation=published_generation;
ALTER TABLE transcription_targets ADD COLUMN imported integer NOT NULL DEFAULT 0;
UPDATE transcription_targets t SET imported=(SELECT count(*) FROM transcription_target_jobs j WHERE j.target_id=t.id);
CREATE FUNCTION count_target_imports() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN UPDATE transcription_targets SET imported=imported+1 WHERE id=NEW.target_id;
  ELSE UPDATE transcription_targets SET imported=imported-1 WHERE id=OLD.target_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER target_import_count AFTER INSERT OR DELETE ON transcription_target_jobs FOR EACH ROW EXECUTE FUNCTION count_target_imports();
CREATE OR REPLACE FUNCTION queue_transcript_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; transcript uuid; changed boolean := true;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='transcription_shiurim' THEN
      IF ROW(NEW.active_transcript_id,NEW.title,NEW.teacher,NEW.media_url) IS NOT DISTINCT FROM ROW(OLD.active_transcript_id,OLD.title,OLD.teacher,OLD.media_url) THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='transcripts' THEN
      IF NEW.text IS NOT DISTINCT FROM OLD.text THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='transcript_segments' THEN
      IF ROW(NEW.text,NEW.start_ms,NEW.end_ms,NEW.speaker,NEW.language) IS NOT DISTINCT FROM ROW(OLD.text,OLD.start_ms,OLD.end_ms,OLD.speaker,OLD.language) THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='notes_jobs' THEN
      IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    END IF;
    IF TG_TABLE_NAME='transcript_notes' THEN
      IF NEW.markdown IS NOT DISTINCT FROM OLD.markdown THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='transcription_shiurim' THEN target=NEW.id;
  ELSIF TG_TABLE_NAME='transcripts' THEN target=NEW.shiur_id; transcript=NEW.id;
  ELSIF TG_TABLE_NAME='transcript_segments' THEN target=NEW.shiur_id; transcript=NEW.transcript_id;
  ELSE SELECT shiur_id INTO target FROM transcripts WHERE id=NEW.transcript_id; transcript=NEW.transcript_id;
  END IF;
  changed=TG_TABLE_NAME<>'notes_jobs';
  INSERT INTO transcript_publications(shiur_id,content_changed) SELECT id,changed FROM transcription_shiurim
    WHERE id=target AND active_transcript_id IS NOT NULL AND (transcript IS NULL OR active_transcript_id=transcript)
  ON CONFLICT(shiur_id) DO UPDATE SET generation=nextval('transcript_publication_generation'),
    content_changed=EXCLUDED.content_changed OR (transcript_publications.generation>transcript_publications.published_generation AND transcript_publications.content_changed),
    available_at=now(),attempt=0,error=NULL,updated_at=now();
  RETURN NEW;
END;
$$;
CREATE INDEX notes_jobs_pending ON notes_jobs(created_at) WHERE status IN ('queued','cleaning','generating');
COMMIT;
