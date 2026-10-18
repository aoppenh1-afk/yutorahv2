CREATE TABLE catalog_snapshots (
  resource text NOT NULL,
  version text NOT NULL,
  payload text NOT NULL,
  bytes integer NOT NULL CHECK(bytes >= 0),
  updated integer NOT NULL,
  expires integer NOT NULL,
  PRIMARY KEY(resource,version)
);
--> statement-breakpoint
CREATE INDEX catalog_snapshots_latest ON catalog_snapshots(resource,updated DESC);
--> statement-breakpoint
CREATE INDEX catalog_snapshots_expires ON catalog_snapshots(expires);
--> statement-breakpoint
CREATE TABLE catalog_refresh_leases (
  resource text PRIMARY KEY,
  owner text NOT NULL,
  expires integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE catalog_artwork (
  id integer PRIMARY KEY,
  image text NOT NULL,
  updated integer NOT NULL
);
