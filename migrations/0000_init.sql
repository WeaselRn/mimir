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
  message_ts     TEXT
);

-- 4. IVFFlat index for fast approximate cosine similarity search
--    (Requires at least ~1000 rows before it's faster than a full scan)
CREATE INDEX IF NOT EXISTS decisions_embedding_idx
  ON decisions
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 5. Helpful index for expert look-ups
CREATE INDEX IF NOT EXISTS experts_user_id_idx ON experts (user_id);
CREATE INDEX IF NOT EXISTS experts_skill_idx   ON experts (skill);