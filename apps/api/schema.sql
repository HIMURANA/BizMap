-- BizMap Postgres schema (Phase 2). Idempotent: safe to run on every start.
-- Business data (biz_*) is a read-only copy refreshed from the pipeline by `npm run pg:sync`.
-- App data (users, workspaces, lists, exports, credits, payments...) is owned by the app and never touched by the sync.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ------------------------------------------------------------------ business data (synced)
CREATE TABLE IF NOT EXISTS biz_categories (id text PRIMARY KEY, label text NOT NULL, sort int NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS biz_subcategories (id text PRIMARY KEY, cat text NOT NULL, label text NOT NULL);

CREATE TABLE IF NOT EXISTS biz (
  id text PRIMARY KEY,
  name text NOT NULL, name_lc text NOT NULL,
  cat text NOT NULL, sub text, status text NOT NULL, layer text NOT NULL,
  src_conf real, score int NOT NULL DEFAULT 0, band text, parent text, first_seen text, description text,
  division text, district text, upazila text, area text, scope text,
  phone text, phone_status text, email text, email_status text, website text, website_status text,
  facebook text, facebook_status text, instagram text, instagram_status text,
  fcommerce boolean NOT NULL DEFAULT false, osm_url text,
  lat double precision, lon double precision,
  geog geography(Point, 4326)
);
CREATE INDEX IF NOT EXISTS biz_geog_idx ON biz USING gist (geog);
CREATE INDEX IF NOT EXISTS biz_cat_idx ON biz (cat, sub);
CREATE INDEX IF NOT EXISTS biz_district_idx ON biz (district);
CREATE INDEX IF NOT EXISTS biz_division_idx ON biz (division);
CREATE INDEX IF NOT EXISTS biz_status_idx ON biz (status);
CREATE INDEX IF NOT EXISTS biz_score_idx ON biz (score DESC, id);
CREATE INDEX IF NOT EXISTS biz_parent_idx ON biz (parent);
CREATE INDEX IF NOT EXISTS biz_name_trgm_idx ON biz USING gin (name_lc gin_trgm_ops);
CREATE INDEX IF NOT EXISTS biz_phone_trgm_idx ON biz USING gin (phone gin_trgm_ops);

CREATE TABLE IF NOT EXISTS biz_contacts (biz_id text NOT NULL, type text NOT NULL, value text NOT NULL, status text, source text);
CREATE INDEX IF NOT EXISTS biz_contacts_biz_idx ON biz_contacts (biz_id);
CREATE TABLE IF NOT EXISTS biz_socials (biz_id text NOT NULL, platform text NOT NULL, url text NOT NULL, status text, source text);
CREATE INDEX IF NOT EXISTS biz_socials_biz_idx ON biz_socials (biz_id);
CREATE TABLE IF NOT EXISTS biz_sources (biz_id text NOT NULL, type text NOT NULL, url text, fetched_at text);
CREATE INDEX IF NOT EXISTS biz_sources_biz_idx ON biz_sources (biz_id);

-- official admin areas with 2022 population (used to estimate people inside a radius)
CREATE TABLE IF NOT EXISTS admin_areas (
  name text NOT NULL, name_bn text, level text NOT NULL, population bigint,
  geom geometry(MultiPolygon, 4326)
);
CREATE INDEX IF NOT EXISTS admin_areas_geom_idx ON admin_areas USING gist (geom);
CREATE INDEX IF NOT EXISTS admin_areas_level_idx ON admin_areas (level);

CREATE TABLE IF NOT EXISTS sync_runs (id serial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, businesses int, note text);

-- ------------------------------------------------------------------ accounts
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL, name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- session tokens are stored only as SHA-256 hashes
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  user_agent text, ip text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL, role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, accepted_at timestamptz
);

-- ------------------------------------------------------------------ workspace data
CREATE TABLE IF NOT EXISTS lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lists_ws_idx ON lists (workspace_id);
CREATE TABLE IF NOT EXISTS list_items (
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE, biz_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (list_id, biz_id)
);

CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, query text NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL, format text NOT NULL, preset text NOT NULL, query text NOT NULL,
  rows int NOT NULL, credits int NOT NULL, file text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exports_ws_idx ON exports (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delta int NOT NULL, reason text NOT NULL, ref text, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_ledger_ws_idx ON credit_ledger (workspace_id);

CREATE TABLE IF NOT EXISTS suppressions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  value text NOT NULL, channel text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, value)
);

CREATE TABLE IF NOT EXISTS data_reports (
  id bigserial PRIMARY KEY, biz_id text NOT NULL, kind text NOT NULL, note text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  tran_id text NOT NULL UNIQUE, provider text NOT NULL, pack text NOT NULL,
  amount_bdt numeric(12, 2) NOT NULL, credits int NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  val_id text, card_type text, raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz
);
CREATE INDEX IF NOT EXISTS payments_ws_idx ON payments (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS site_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL, lat double precision NOT NULL, lon double precision NOT NULL, radius_km real NOT NULL, focus_cat text,
  result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_reports_ws_idx ON site_reports (workspace_id, created_at DESC);

-- ------------------------------------------------------------------ gridded population (WorldPop, loaded by `npm run pg:population`)
-- one row per populated ~100 m cell (cell centre + people); site reports sum the cells inside a circle
CREATE TABLE IF NOT EXISTS pop_grid (geog geography(Point, 4326) NOT NULL, pop real NOT NULL);
CREATE INDEX IF NOT EXISTS pop_grid_geog_idx ON pop_grid USING gist (geog);
CREATE TABLE IF NOT EXISTS pop_grid_info (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1), source text NOT NULL, year int NOT NULL, cell_m int NOT NULL,
  cells bigint NOT NULL, total bigint NOT NULL, license text NOT NULL, loaded_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ outreach (Phase 3-5)
-- server-wide secrets (unsubscribe-link signing, encryption of stored provider tokens); created once, never sent to clients
CREATE TABLE IF NOT EXISTS app_secrets (name text PRIMARY KEY, value text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

-- per-workspace sending identity and channel settings
CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_name text, sender_email text, reply_to text, postal_address text,
  daily_email_cap int NOT NULL DEFAULT 200,
  call_hours_start int NOT NULL DEFAULT 9, call_hours_end int NOT NULL DEFAULT 20,   -- local Asia/Dhaka hours
  wa_phone_number_id text, wa_waba_id text, wa_token_enc text, wa_app_secret_enc text, wa_verify_token text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_settings_wa_phone_idx ON workspace_settings (wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;

-- explicit marketing consent (WhatsApp needs it; recorded with how and when it was given)
CREATE TABLE IF NOT EXISTS consents (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  address text NOT NULL, biz_id text,
  method text NOT NULL CHECK (method IN ('inbound_keyword', 'web_form', 'call_verbal', 'written', 'other')),
  proof text, recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, revoked_reason text
);
CREATE INDEX IF NOT EXISTS consents_ws_addr_idx ON consents (workspace_id, channel, address);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled')),
  audience_list uuid REFERENCES lists(id) ON DELETE SET NULL, audience_query text,
  subject text, body text,
  wa_template text, wa_language text, wa_params jsonb,
  send_at timestamptz, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), launched_at timestamptz, finished_at timestamptz,
  recipients int NOT NULL DEFAULT 0, credits int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS campaigns_ws_idx ON campaigns (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status) WHERE status IN ('scheduled', 'sending');

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  biz_id text NOT NULL, address text NOT NULL, name text,
  merge jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped', 'unsubscribed', 'replied')),
  reason text, provider_id text, sent_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, address)
);
CREATE INDEX IF NOT EXISTS campaign_recipients_queue_idx ON campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_provider_idx ON campaign_recipients (provider_id) WHERE provider_id IS NOT NULL;

-- every outgoing email (also the test-mode outbox, where nothing leaves the server)
CREATE TABLE IF NOT EXISTS email_log (
  id bigserial PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL, to_addr text NOT NULL, subject text NOT NULL, body_text text NOT NULL,
  mode text NOT NULL, status text NOT NULL, error text, provider_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_ws_idx ON email_log (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, script text, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS call_items (
  id bigserial PRIMARY KEY,
  queue_id uuid NOT NULL REFERENCES call_queues(id) ON DELETE CASCADE,
  biz_id text NOT NULL, phone text NOT NULL, name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'callback', 'done', 'skipped')),
  outcome text, notes text, callback_at timestamptz, attempts int NOT NULL DEFAULT 0,
  locked_by uuid REFERENCES users(id) ON DELETE SET NULL, locked_at timestamptz,
  called_by uuid REFERENCES users(id) ON DELETE SET NULL, called_at timestamptz,
  UNIQUE (queue_id, biz_id)
);
CREATE INDEX IF NOT EXISTS call_items_queue_idx ON call_items (queue_id, status);

-- WhatsApp conversations (inbox)
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'whatsapp', address text NOT NULL, contact_name text, biz_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  last_inbound_at timestamptz, last_message_at timestamptz NOT NULL DEFAULT now(), unread int NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, channel, address)
);
CREATE INDEX IF NOT EXISTS conversations_ws_idx ON conversations (workspace_id, last_message_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text NOT NULL, template text, status text, provider_id text, error text,
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL, campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conversation_id, id);
CREATE INDEX IF NOT EXISTS messages_provider_idx ON messages (provider_id) WHERE provider_id IS NOT NULL;

-- "new businesses" alerts on saved filters
CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, query text NOT NULL,
  frequency text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  email boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
  watermark text NOT NULL, -- businesses first seen after this time count as new
  last_run_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS alert_runs (
  id bigserial PRIMARY KEY, alert_id uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  run_at timestamptz NOT NULL DEFAULT now(), since text NOT NULL, new_count int NOT NULL, sample jsonb NOT NULL DEFAULT '[]', seen boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS alert_runs_alert_idx ON alert_runs (alert_id, run_at DESC);

-- ------------------------------------------------------------------ own contacts (typed in or imported from Excel/CSV)
-- people and businesses the workspace brings itself; they live in a list next to directory businesses (list_items)
CREATE TABLE IF NOT EXISTS list_contacts (
  id bigserial PRIMARY KEY,
  list_id uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name text, company text, phone text, email text, area text, district text, note text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL, added_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS list_contacts_dedupe_idx ON list_contacts (list_id, coalesce(phone, ''), coalesce(email, ''));
-- extra recipients typed or imported straight into a campaign (same shape as list_contacts, without ids)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience_contacts jsonb NOT NULL DEFAULT '[]';

-- ------------------------------------------------------------------ automated voice calls (voice.ts)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_name text;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_channel_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_channel_check CHECK (channel IN ('email', 'whatsapp', 'voice'));
-- the synthesized audio played on the call (data/voice_audio/<media>.mp3); the spoken text is kept in merge._speech
ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS media text;
-- own recordings ("custom voice"): 8 kHz mono WAV made in the browser, stored as data/voice_audio/<id>.wav (id = content hash)
CREATE TABLE IF NOT EXISTS voice_clips (
  id text NOT NULL, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, seconds real NOT NULL, created_by uuid REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_clip text; -- set: this recording is played instead of the text-to-speech message
