-- The UNIQUE(shiur_id,version,segment_index) index covers the same prefix.
DROP INDEX IF EXISTS archive_segments_version;
