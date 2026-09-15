-- The claims list pages by keyset over (sort column, id) under one tenant, and
-- an approver's page joins their own claims with every submitted one, so each
-- sort key gets a tenant-first index that carries the id as its tie-breaker.
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_created_idx
  ON expenses_claims (tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_amount_idx
  ON expenses_claims (tenant_id, amount_minor, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_expense_date_idx
  ON expenses_claims (tenant_id, expense_date, id);
