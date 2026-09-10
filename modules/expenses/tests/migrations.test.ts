import { readdirSync, readFileSync } from 'node:fs';
import type {
	DatabaseAdapterLease,
	DatabaseProvider,
} from '@flowdular/sdk/database';
import {
	DATABASE_MIGRATION_LEDGER,
	databaseMigrationStatus,
	runDatabaseMigrations,
} from '@flowdular/sdk/database';
import { createTestDatabaseProvider } from '@flowdular/sdk/database-testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseMigrations } from '../src/services/migration.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);

const MODULE_TABLES = 'expenses_claims, expenses_claims_history';

let provider: DatabaseProvider;
let lease: DatabaseAdapterLease;

beforeAll(async () => {
	provider = createTestDatabaseProvider();
	lease = await provider.acquire({
		namespace: 'expenses.core',
		purpose: 'migration',
	});
});

/* Every case states its own starting point, so the shared cluster goes back to
   an unmigrated, unrecorded schema first. */
beforeEach(async () => {
	await lease.database.execute({
		text: `DROP TABLE IF EXISTS ${MODULE_TABLES} CASCADE`,
	});
	if (await lease.database.schema.hasTable(DATABASE_MIGRATION_LEDGER)) {
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'expenses.core'`,
		});
	}
});

afterAll(async () => {
	await lease?.release();
	await provider?.dispose();
});

function apply() {
	return runDatabaseMigrations(
		lease.database,
		'expenses.core',
		databaseMigrations,
	);
}

function status() {
	return databaseMigrationStatus(
		lease.database,
		'expenses.core',
		databaseMigrations,
	);
}

describe('expenses migrations', () => {
	it('mirrors every PostgreSQL up file byte for byte', () => {
		const files = readdirSync(migrationDirectory)
			.filter((name) => name.endsWith('.up.sql'))
			.sort();

		expect(
			databaseMigrations.map((migration) => `${migration.id}.up.sql`),
		).toEqual(files);
		for (const migration of databaseMigrations) {
			expect(migration.sql.postgresql).toBe(
				readFileSync(
					new URL(`${migration.id}.up.sql`, migrationDirectory),
					'utf8',
				),
			);
			/* PostgreSQL and nothing else. A stray dialect key would ship SQL no
			   deployment runs and no test covers. */
			expect(Object.keys(migration.sql)).toEqual(['postgresql']);
		}
	});

	/* A tenant table without forced row security would let the runtime role read
	   another tenant, which is exactly what the adapter contract promises not to
	   allow. The note-template migration only adds a column. */
	it('declares forced PostgreSQL row security for every tenant table', () => {
		for (const migration of databaseMigrations) {
			const sql = migration.sql.postgresql ?? '';
			if (!sql.includes('CREATE TABLE')) continue;
			expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
			expect(sql).toContain('FORCE ROW LEVEL SECURITY');
			expect(sql).toContain("current_setting('coreloom.tenant_id', true)");
			expect(sql).toContain('WITH CHECK');
		}
	});

	it('applies every migration on a fresh database', async () => {
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'applied'),
		);
	});

	it('adopts a schema that predates the ledger without changing its rows', async () => {
		await apply();
		await lease.database.transaction(
			(transaction) =>
				transaction.execute({
					text: `INSERT INTO expenses_claims
				 (id, tenant_id, claimant_id, title, amount_minor, currency, category,
				  expense_date, note, note_template, status, decision_comment, created_at)
				 VALUES ('claim-1', 'tenant-a', 'account-a', 'Train', 4200, 'EUR', 'travel',
				  '2026-08-20', NULL, NULL, 'draft', NULL, 1)`,
				}),
			{ tenantId: 'tenant-a', access: 'write' },
		);
		await lease.database.execute({
			text: `DELETE FROM ${DATABASE_MIGRATION_LEDGER} WHERE namespace = 'expenses.core'`,
		});

		expect((await status()).map((entry) => entry.state)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'adopted'),
		);
		expect(
			(
				await lease.database.transaction(
					(transaction) =>
						transaction.query<{ title: string }>({
							text: 'SELECT title FROM expenses_claims',
						}),
					{ tenantId: 'tenant-a', access: 'read' },
				)
			).rows,
		).toEqual([{ title: 'Train' }]);
	});

	it('runs clean on a second migration pass', async () => {
		await apply();

		expect((await apply()).map((entry) => entry.action)).toEqual(
			databaseMigrations.map(() => 'unchanged'),
		);
	});
});
