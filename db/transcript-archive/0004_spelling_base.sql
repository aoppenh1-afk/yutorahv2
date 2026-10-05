-- Bulk dictionary buckets avoid one initial write per spelling deletion key.
-- Later publications can continue adding individual keys to the delta table.
CREATE TABLE archive_spelling_base (
  bucket INTEGER PRIMARY KEY,
  body TEXT NOT NULL CHECK(json_valid(body))
);
