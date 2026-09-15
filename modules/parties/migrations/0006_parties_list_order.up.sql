ALTER TABLE parties ADD COLUMN IF NOT EXISTS updated_at BIGINT;
-- The backfill runs as the migrator, which forced row security keeps out of
-- every row without a tenant setting; lift the flag for the statement only.
ALTER TABLE parties NO FORCE ROW LEVEL SECURITY;
UPDATE parties SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
ALTER TABLE parties ALTER COLUMN updated_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS parties_tenant_lower_name_idx
  ON parties (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS parties_tenant_updated_at_idx
  ON parties (tenant_id, updated_at, id);
