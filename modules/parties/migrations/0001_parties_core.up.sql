CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS parties_tenant_name_idx
  ON parties (tenant_id, name, id);
ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_tenant_policy ON parties
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
