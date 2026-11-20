-- Ensemble Room 스키마 (계획 4절). db/index.ts의 마이그레이션 1번으로 적용된다.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'seed'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  persona_public TEXT NOT NULL DEFAULT '',
  variant TEXT
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('my', 'our', 'dm')),
  owner_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  theme TEXT NOT NULL CHECK (theme IN ('studio', 'lounge', 'cafe')),
  theme_variant TEXT CHECK (theme_variant IN ('home', 'meeting'))
);

CREATE TABLE room_agents (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
  name TEXT NOT NULL,
  persona_public TEXT NOT NULL DEFAULT ''
);

CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE visits (
  id TEXT PRIMARY KEY,
  host_room_id TEXT NOT NULL REFERENCES rooms(id),
  visitor_kind TEXT NOT NULL CHECK (visitor_kind IN ('human', 'agent')),
  visitor_user_id TEXT NOT NULL REFERENCES users(id),
  visitor_agent_id TEXT REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('requested', 'active', 'ended', 'declined')),
  permissions_json TEXT NOT NULL DEFAULT '[]',
  mandate_json TEXT,
  start_seq INTEGER,
  end_seq INTEGER,
  requested_in_dm_room_id TEXT REFERENCES rooms(id)
);
CREATE INDEX visits_host ON visits(host_room_id);

CREATE TABLE events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'room_agent', 'system')),
  actor_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'room',
  turn_id TEXT,
  PRIMARY KEY (room_id, seq)
);

CREATE TABLE board_cards (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  card_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  owner_tag TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  agreed INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, card_id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'decision', 'visit', 'takeout')),
  requested_by TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE TABLE approval_votes (
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'edit', 'reject')),
  edited_json TEXT,
  PRIMARY KEY (approval_id, user_id)
);

CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  ns TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'agreement', 'summary')),
  text TEXT NOT NULL,
  source_room_id TEXT REFERENCES rooms(id),
  source_seqs TEXT,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at INTEGER NOT NULL
);
CREATE INDEX memory_ns ON memory_items(ns);

CREATE TABLE room_summaries (
  room_id TEXT PRIMARY KEY REFERENCES rooms(id),
  upto_seq INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE read_cursors (
  user_id TEXT NOT NULL REFERENCES users(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  left_at_seq INTEGER,
  PRIMARY KEY (user_id, room_id)
);
