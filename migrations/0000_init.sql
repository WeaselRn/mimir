-- ============================================================
-- Mimir — Initial migration
-- Run this in the Supabase SQL Editor (or via drizzle-kit push)
-- ============================================================

-- 1. Enable pgvector extension (Supabase keeps it in the extensions schema)
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. decisions table
CREATE TABLE IF NOT EXISTS decisions (
  id           SERIAL PRIMARY KEY,
  question     TEXT NOT NULL,
  answer       TEXT NOT NULL,
  participants JSONB DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_ts   TEXT,
  channel_id   TEXT,
  thread_ts    TEXT,
  embedding    vector(768)
);

-- 3. experts table
CREATE TABLE IF NOT EXISTS experts (
  id             SERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL,
  skill          TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_ts     TEXT,
  CONSTRAINT experts_user_skill_unique UNIQUE (user_id, skill)
);

-- 4. tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  description TEXT NOT NULL,
  owner_id    TEXT,
  due_date    DATE,
  completed   BOOLEAN NOT NULL DEFAULT false,
  message_ts  TEXT,
  channel_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. resources table
CREATE TABLE IF NOT EXISTS resources (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT,
  description TEXT,
  message_ts  TEXT,
  channel_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. IVFFlat index for fast approximate cosine similarity search
--    (Requires at least ~1000 rows before it's faster than a full scan)
CREATE INDEX IF NOT EXISTS decisions_embedding_idx
  ON decisions
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 7. Helpful indexes for expert look-ups
CREATE INDEX IF NOT EXISTS experts_user_id_idx ON experts (user_id);
CREATE INDEX IF NOT EXISTS experts_skill_idx   ON experts (skill);

-- 8. Index for task look-ups
CREATE INDEX IF NOT EXISTS tasks_owner_id_idx  ON tasks (owner_id);

-- 9. Index for resource look-ups
CREATE INDEX IF NOT EXISTS resources_url_idx   ON resources (url);