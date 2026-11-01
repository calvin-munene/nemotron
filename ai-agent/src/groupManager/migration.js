export const GROUP_MANAGER_MIGRATION = Object.freeze({
  version: "2026100501_group_manager_postgres",
  sql: `
    CREATE TABLE IF NOT EXISTS gm_groups (
      group_id BIGINT PRIMARY KEY CHECK (group_id < 0),
      title TEXT NOT NULL DEFAULT '' CHECK(length(title) <= 200),
      settings JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(settings) = 'object'),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gm_admins (
      group_id BIGINT NOT NULL REFERENCES gm_groups(group_id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL CHECK(user_id > 0),
      PRIMARY KEY(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS gm_admins_user ON gm_admins(user_id);
    CREATE TABLE IF NOT EXISTS gm_jobs (
      id BIGSERIAL PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN ('moderate','welcome','delete','report','setup')),
      group_id BIGINT NOT NULL, payload TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, token UUID, lease_until TIMESTAMPTZ,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS gm_jobs_ready ON gm_jobs(run_at,id) WHERE state='pending';
    CREATE UNIQUE INDEX IF NOT EXISTS gm_jobs_group_serial ON gm_jobs(group_id) WHERE state='running' AND kind='moderate';
    CREATE TABLE IF NOT EXISTS gm_cases (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL, message_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL, category TEXT NOT NULL, rule TEXT NOT NULL,
      message_type TEXT NOT NULL, warning INTEGER NOT NULL, action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', pardoned BOOLEAN NOT NULL DEFAULT FALSE,
      trusted BOOLEAN NOT NULL DEFAULT FALSE, reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      mute_seconds INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(group_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS gm_cases_window ON gm_cases(group_id,user_id,created_at) WHERE NOT pardoned;
    CREATE TABLE IF NOT EXISTS gm_once (key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS gm_rate (scope TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS gm_rate_scope ON gm_rate(scope,at);
    CREATE TABLE IF NOT EXISTS gm_ai_cache (
      hash TEXT PRIMARY KEY, result JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gm_inputs (
      user_id BIGINT PRIMARY KEY, chat_id BIGINT NOT NULL, group_id BIGINT NOT NULL,
      field TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 minutes'
    );
    CREATE TABLE IF NOT EXISTS gm_audit (
      id BIGSERIAL PRIMARY KEY, group_id BIGINT NOT NULL, user_id BIGINT,
      actor_id BIGINT, event TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS gm_global (
      id INTEGER PRIMARY KEY CHECK(id=1), ai_per_minute INTEGER NOT NULL DEFAULT 120 CHECK(ai_per_minute BETWEEN 1 AND 1000)
    );
    INSERT INTO gm_global(id) VALUES(1) ON CONFLICT DO NOTHING;
    INSERT INTO feature_flags(feature_key,enabled,description)
      VALUES('group_manager',FALSE,'Isolated, buttons-only Group Manager with PostgreSQL queue')
      ON CONFLICT(feature_key) DO NOTHING;
  `
});

export const GROUP_MANAGER_QUEUE_MIGRATION = Object.freeze({
  version:"2026100502_group_manager_queue_safety",
  sql:`
    ALTER TABLE gm_jobs ADD COLUMN IF NOT EXISTS error_code TEXT;
    ALTER TABLE gm_cases ADD COLUMN IF NOT EXISTS update_version BIGINT;
    CREATE TABLE IF NOT EXISTS gm_versions (
      group_id BIGINT NOT NULL, message_id BIGINT NOT NULL, version BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(group_id,message_id)
    );
  `
});
