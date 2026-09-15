ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0;
UPDATE catalog_items SET updated_at = created_at WHERE updated_at = 0;
ALTER TABLE catalog_items ALTER COLUMN updated_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS catalog_items_tenant_name_idx
  ON catalog_items (tenant_id, lower(name), id);
CREATE INDEX IF NOT EXISTS catalog_items_tenant_updated_idx
  ON catalog_items (tenant_id, updated_at, id);
