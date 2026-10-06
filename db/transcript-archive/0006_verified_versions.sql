CREATE TABLE archive_versions (
  shiur_id text NOT NULL,
  version text NOT NULL,
  object_key text NOT NULL,
  segments_key text,
  PRIMARY KEY (shiur_id,version)
);
INSERT INTO archive_versions(shiur_id,version,object_key,segments_key) SELECT id,version,object_key,'transcripts/'||id||'/segments/'||search_version||'.json' FROM archive_items;
