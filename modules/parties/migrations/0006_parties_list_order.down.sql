DROP INDEX IF EXISTS parties_tenant_updated_at_idx;
DROP INDEX IF EXISTS parties_tenant_lower_name_idx;
ALTER TABLE parties DROP COLUMN IF EXISTS updated_at;
