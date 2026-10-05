ALTER TABLE archive_items ADD COLUMN search_version TEXT;
UPDATE archive_items SET search_version=version;
