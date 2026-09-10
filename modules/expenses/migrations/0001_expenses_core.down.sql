DROP POLICY IF EXISTS expenses_claims_tenant_policy ON expenses_claims;
DROP INDEX IF EXISTS expenses_claims_tenant_status_date_idx;
DROP INDEX IF EXISTS expenses_claims_tenant_claimant_status_date_idx;
DROP INDEX IF EXISTS expenses_claims_tenant_claimant_date_idx;
DROP TABLE IF EXISTS expenses_claims;
