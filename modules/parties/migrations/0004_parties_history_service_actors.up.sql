CREATE TABLE IF NOT EXISTS parties_history_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent', 'service')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  configured_by_json TEXT CHECK (configured_by_json IS NULL OR configured_by_json::jsonb IS NOT NULL),
  changes_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL,
  CHECK (
    (actor_kind = 'agent' AND run_id IS NOT NULL)
    OR (actor_kind IN ('user', 'service') AND run_id IS NULL)
  ),
  CHECK (
    (actor_kind = 'service' AND configured_by_json IS NOT NULL)
    OR (actor_kind IN ('user', 'agent') AND configured_by_json IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS parties_history_v2_tenant_record_version_idx
  ON parties_history_v2 (tenant_id, record_id, version DESC);
INSERT INTO parties_history_v2
  (id, tenant_id, record_id, version, action, actor_kind, actor_id,
   actor_label, run_id, configured_by_json, changes_json, occurred_at)
SELECT id, tenant_id, record_id, version, action, actor_kind, actor_id,
       actor_label, run_id, NULL, changes_json, occurred_at
FROM parties_history
ON CONFLICT DO NOTHING;
ALTER TABLE parties_history_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties_history_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_history_v2_tenant_policy ON parties_history_v2
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
