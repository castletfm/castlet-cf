-- Initial schema (mvp-design.md section 9).
--
-- D1 note: the design template opened with `PRAGMA foreign_keys = ON;`.
-- D1 does not accept `PRAGMA foreign_keys` inside migration files (it is not
-- on D1's supported-PRAGMA list); D1 enforces foreign key constraints by
-- default, so the line is dropped with no behavior change. Everything else is
-- kept exactly as specified.

CREATE TABLE account_usage (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK (active_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO account_usage (
  singleton_id,
  active_bytes,
  reserved_bytes,
  updated_at
) VALUES (1, 0, 0, CURRENT_TIMESTAMP);

CREATE TABLE storage_objects (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('show', 'episode')),
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('artwork', 'audio')),
  object_key TEXT NOT NULL UNIQUE,
  public_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_length INTEGER,
  etag TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'orphaned', 'deleted', 'rejected')
  ),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  orphaned_at TEXT,
  deleted_at TEXT
);

CREATE INDEX idx_storage_owner
  ON storage_objects(owner_kind, owner_id, status);
CREATE INDEX idx_storage_status
  ON storage_objects(status, created_at);

CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  description TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  category_primary TEXT NOT NULL,
  category_secondary TEXT,
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  website_url TEXT,
  copyright_text TEXT,
  artwork_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  feed_revision INTEGER NOT NULL DEFAULT 0,
  feed_published_revision INTEGER NOT NULL DEFAULT 0,
  feed_last_generated_at TEXT,
  feed_error TEXT,
  slug_locked_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_shows_status ON shows(status);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE RESTRICT,
  guid TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'published', 'unpublished', 'archived')
  ),
  episode_type TEXT NOT NULL DEFAULT 'full' CHECK (
    episode_type IN ('full', 'bonus', 'trailer')
  ),
  explicit INTEGER NOT NULL DEFAULT 0 CHECK (explicit IN (0, 1)),
  season_number INTEGER CHECK (season_number IS NULL OR season_number > 0),
  episode_number INTEGER CHECK (episode_number IS NULL OR episode_number > 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  audio_object_id TEXT REFERENCES storage_objects(id) ON DELETE SET NULL,
  published_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_episodes_show_status_date
  ON episodes(show_id, status, published_at DESC);

CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  storage_object_id TEXT NOT NULL UNIQUE REFERENCES storage_objects(id) ON DELETE CASCADE,
  expected_content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  status TEXT NOT NULL CHECK (
    status IN ('initiated', 'completed', 'expired', 'aborted', 'rejected')
  ),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_upload_intents_status_expiry
  ON upload_intents(status, expires_at);
