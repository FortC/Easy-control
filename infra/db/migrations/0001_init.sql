-- AI People 初始结构（依据 docs/construction-plan.zh-CN.md §11 数据实体）
-- 所有业务表都带 workspace_id；跨租户访问在仓储层强制 WHERE workspace_id = $1。
-- ID 采用带前缀的字符串（user_/ws_/acct_/task_…），便于日志与界面排查。

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  aigc_policy text NOT NULL DEFAULT 'strict' CHECK (aigc_policy IN ('strict', 'in_text', 'off')),
  daily_budget_cny numeric(12, 2),
  brand_tone text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'reviewer', 'viewer')),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  runner_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runners (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'paired' CHECK (status IN ('paired', 'revoked')),
  adapters jsonb NOT NULL DEFAULT '[]',
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_runners_ws ON runners (workspace_id);

CREATE TABLE IF NOT EXISTS account_connections (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('xiaohongshu', 'weibo', 'douyin')),
  channel text NOT NULL CHECK (channel IN ('simulator', 'redbook', 'weibo_cli', 'douyin_api')),
  uid text NOT NULL,
  display_name text,
  avatar_url text,
  secret_ref text,
  -- 服务端加密副本（AES-256-GCM，密钥来自 VAULT_SECRET/JWT_SECRET）；
  -- 生产路径优先使用 Runner 本地凭据库，此列仅作为同机开发/试点的回退。
  secret_encrypted text,
  session_status text NOT NULL DEFAULT 'active' CHECK (session_status IN ('active', 'expired', 'unknown')),
  capabilities jsonb NOT NULL DEFAULT '[]',
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  risk_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, uid)
);
CREATE INDEX IF NOT EXISTS idx_accounts_ws ON account_connections (workspace_id);

CREATE TABLE IF NOT EXISTS capability_grants (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES account_connections(id) ON DELETE CASCADE,
  platform text NOT NULL,
  action text NOT NULL,
  channel text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  evidence text,
  verified_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('brand', 'product', 'case', 'policy')),
  title text NOT NULL,
  content text NOT NULL,
  copyright text,
  license_scope text,
  owner text,
  expires_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sources_ws ON sources (workspace_id);

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  file_path text NOT NULL,
  mime_type text,
  size_bytes bigint,
  ai_involved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  topics jsonb NOT NULL DEFAULT '[]',
  asset_ids jsonb NOT NULL DEFAULT '[]',
  declarations jsonb NOT NULL DEFAULT '{"aiGenerated": true, "commercial": false}',
  citations jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  model_info jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready_for_review', 'approved', 'superseded', 'rejected')),
  hash text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_ws ON content_versions (workspace_id);

CREATE TABLE IF NOT EXISTS approvals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_version_id text NOT NULL REFERENCES content_versions(id) ON DELETE CASCADE,
  platform text NOT NULL,
  account_id text NOT NULL REFERENCES account_connections(id),
  action text NOT NULL,
  content_hash text NOT NULL,
  asset_hashes jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'consumed', 'invalidated')),
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_ws ON approvals (workspace_id);

CREATE TABLE IF NOT EXISTS schedules (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('single', 'recurring')),
  platform text NOT NULL,
  account_id text NOT NULL REFERENCES account_connections(id),
  action text NOT NULL,
  content_version_id text NOT NULL REFERENCES content_versions(id),
  approval_id text NOT NULL REFERENCES approvals(id),
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  at timestamptz,
  weekdays jsonb NOT NULL DEFAULT '[]',
  time_of_day text,
  start_date date,
  until_date date,
  expire_minutes integer NOT NULL DEFAULT 30,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_schedules_ws ON schedules (workspace_id);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  schedule_id text REFERENCES schedules(id) ON DELETE SET NULL,
  occurrence_at timestamptz NOT NULL,
  platform text NOT NULL,
  channel text NOT NULL,
  account_id text NOT NULL,
  action text NOT NULL,
  content_version_id text NOT NULL,
  approval_id text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
    'SCHEDULED', 'PREFLIGHT', 'WAITING_RUNNER', 'RUNNING', 'SUBMITTED', 'UNDER_REVIEW', 'PUBLISHED',
    'REJECTED', 'NEEDS_HUMAN', 'FAILED', 'UNKNOWN', 'MISSED', 'CANCELLED'
  )),
  runner_id text REFERENCES runners(id),
  execution_window_start timestamptz,
  execution_window_end timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  scenario text,
  last_error jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_status ON tasks (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_account_status ON tasks (account_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_release ON tasks (status, execution_window_start) WHERE status IN ('SCHEDULED', 'WAITING_RUNNER');

CREATE TABLE IF NOT EXISTS task_attempts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  runner_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text,
  error_code text,
  error_message text,
  raw jsonb
);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts (task_id);

CREATE TABLE IF NOT EXISTS publications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  task_id text NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  platform text NOT NULL,
  account_id text NOT NULL,
  external_id text,
  url text,
  execution_status text CHECK (execution_status IN ('submitted', 'failed', 'unknown', 'needs_human')),
  publication_status text NOT NULL DEFAULT 'unverified' CHECK (publication_status IN ('unverified', 'under_review', 'published', 'rejected', 'unknown')),
  confirmation_source text NOT NULL DEFAULT 'adapter_receipt' CHECK (confirmation_source IN ('adapter_receipt', 'platform_verified', 'manual')),
  next_action text,
  raw_receipt jsonb,
  manual_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_publications_ws ON publications (workspace_id);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id text PRIMARY KEY,
  publication_id text NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  captured_at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL,
  source text NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  task_id text,
  account_id text,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_ws_id ON events (workspace_id, id);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  account_id text,
  task_id text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  detail jsonb NOT NULL DEFAULT '{}',
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_incidents_ws ON incidents (workspace_id, status);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  task_id text,
  kind text NOT NULL CHECK (kind IN ('model', 'platform', 'other')),
  amount_cny numeric(12, 4) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_ws ON cost_ledger (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS model_providers (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('mock', 'openai_compatible')),
  base_url text,
  api_key_encrypted text,
  model text,
  price_input numeric(12, 4) NOT NULL DEFAULT 0,
  price_output numeric(12, 4) NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 事务性 outbox：业务事务同时写任务与出站事件，由分发器投递到队列（方案 §4.2）
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (status, id);
