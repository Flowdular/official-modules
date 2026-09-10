CREATE TABLE IF NOT EXISTS expenses_claims_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 32),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'agent')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  actor_label TEXT NOT NULL CHECK (length(actor_label) BETWEEN 1 AND 160),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 128),
  changes_json TEXT NOT NULL,
  occurred_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_claims_history_tenant_record_version_idx
  ON expenses_claims_history (tenant_id, record_id, version DESC);
ALTER TABLE expenses_claims_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses_claims_history FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_claims_history_tenant_policy ON expenses_claims_history
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
