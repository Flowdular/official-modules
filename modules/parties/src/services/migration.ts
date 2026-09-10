import type { DatabaseMigration } from '@flowdular/database';
import { postgresTenantTableState } from '@flowdular/database';

/* Every constant mirrors its migrations/<id>.up.sql file byte for byte;
   tests/migrations.test.ts fails on drift. */

export const PARTIES_MIGRATION_001 = `CREATE TABLE IF NOT EXISTS parties (
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
`;

export const PARTIES_MIGRATION_002_VAT_ID_COLUMN = `ALTER TABLE parties ADD COLUMN IF NOT EXISTS vat_id TEXT
  CHECK (
    vat_id IS NULL OR (
      length(vat_id) BETWEEN 1 AND 20
      AND vat_id ~ '^[0-9A-Za-z]+$'
    )
  );
`;

export const PARTIES_MIGRATION_003_HISTORY = `CREATE TABLE IF NOT EXISTS parties_history (
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
CREATE UNIQUE INDEX IF NOT EXISTS parties_history_tenant_record_version_idx
  ON parties_history (tenant_id, record_id, version DESC);
ALTER TABLE parties_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties_history FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_history_tenant_policy ON parties_history
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const PARTIES_MIGRATION_004_HISTORY_SERVICE_ACTORS = `CREATE TABLE IF NOT EXISTS parties_history_v2 (
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
`;

export const PARTIES_MIGRATION_005_IDEMPOTENCY_LEDGER = `CREATE TABLE IF NOT EXISTS parties_idempotency_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 3 AND 160),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 71),
  outcome TEXT NOT NULL CHECK (outcome = 'succeeded'),
  result_json TEXT NOT NULL CHECK (result_json::jsonb IS NOT NULL),
  result_digest TEXT NOT NULL CHECK (length(result_digest) = 71),
  created_at BIGINT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS parties_idempotency_ledger_tenant_operation_idx
  ON parties_idempotency_ledger (tenant_id, operation_id, created_at, id);
ALTER TABLE parties_idempotency_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties_idempotency_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_idempotency_ledger_tenant_policy ON parties_idempotency_ledger
  USING (tenant_id = current_setting('coreloom.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('coreloom.tenant_id', true));
`;

export const databaseMigrations: readonly DatabaseMigration[] = [
	{
		id: '0001_parties_core',
		sql: { postgresql: PARTIES_MIGRATION_001 },
		inspectExisting: (database) =>
			postgresTenantTableState(database, 'parties', 'parties_tenant_policy', [
				() => database.schema.hasIndex('parties_tenant_name_idx'),
			]),
	},
	{
		id: '0002_parties_vat_id',
		sql: { postgresql: PARTIES_MIGRATION_002_VAT_ID_COLUMN },
		inspectExisting: async (database) =>
			(await database.schema.hasColumn('parties', 'vat_id'))
				? 'complete'
				: 'absent',
	},
	{
		id: '0003_parties_history',
		sql: { postgresql: PARTIES_MIGRATION_003_HISTORY },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'parties_history',
				'parties_history_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'parties_history_tenant_record_version_idx',
						),
				],
			),
	},
	{
		id: '0004_parties_history_service_actors',
		sql: { postgresql: PARTIES_MIGRATION_004_HISTORY_SERVICE_ACTORS },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'parties_history_v2',
				'parties_history_v2_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'parties_history_v2_tenant_record_version_idx',
						),
				],
			),
	},
	{
		id: '0005_parties_idempotency_ledger',
		sql: { postgresql: PARTIES_MIGRATION_005_IDEMPOTENCY_LEDGER },
		inspectExisting: (database) =>
			postgresTenantTableState(
				database,
				'parties_idempotency_ledger',
				'parties_idempotency_ledger_tenant_policy',
				[
					() =>
						database.schema.hasIndex(
							'parties_idempotency_ledger_tenant_operation_idx',
						),
				],
			),
	},
];
