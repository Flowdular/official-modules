import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const EXPENSES_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS expenses_claims (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  claimant_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  category TEXT NOT NULL CHECK (category IN ('travel', 'meals', 'equipment', 'other')),
  expense_date TEXT NOT NULL CHECK (length(expense_date) = 10),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  decision_comment TEXT CHECK (decision_comment IS NULL OR length(decision_comment) BETWEEN 1 AND 2000),
  created_at BIGINT NOT NULL,
  CHECK (
    (status IN ('draft', 'submitted') AND decision_comment IS NULL) OR
    (status IN ('approved', 'rejected') AND decision_comment IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_claimant_date_idx
  ON expenses_claims (tenant_id, claimant_id, expense_date DESC, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_claimant_status_date_idx
  ON expenses_claims (tenant_id, claimant_id, status, expense_date DESC, id);
CREATE INDEX IF NOT EXISTS expenses_claims_tenant_status_date_idx
  ON expenses_claims (tenant_id, status, expense_date DESC, id);
ALTER TABLE expenses_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_claims_tenant_policy ON expenses_claims
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const EXPENSES_MIGRATION_002_HISTORY = `CREATE TABLE IF NOT EXISTS expenses_claims_history (
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
`;

export const EXPENSES_MIGRATION_003_NOTE_TEMPLATE = `ALTER TABLE expenses_claims
  ADD COLUMN IF NOT EXISTS note_template TEXT CHECK (note_template IS NULL OR length(note_template) BETWEEN 1 AND 2000);
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_expenses_core',
		sql: { postgresql: EXPENSES_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'expenses_claims',
				'expenses_claims_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'expenses_claims_tenant_claimant_date_idx',
						),
					() =>
						database.schema.hasIndex(
							'expenses_claims_tenant_claimant_status_date_idx',
						),
					() =>
						database.schema.hasIndex('expenses_claims_tenant_status_date_idx'),
				],
			),
	},
	{
		id: '0002_expenses_history',
		sql: { postgresql: EXPENSES_MIGRATION_002_HISTORY },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'expenses_claims_history',
				'expenses_claims_history_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'expenses_claims_history_tenant_record_version_idx',
						),
				],
			),
	},
	{
		id: '0003_expenses_note_template',
		sql: { postgresql: EXPENSES_MIGRATION_003_NOTE_TEMPLATE },
		inspectExisting: async (database) =>
			(await database.schema.hasColumn('expenses_claims', 'note_template'))
				? 'complete'
				: 'absent',
	},
];
