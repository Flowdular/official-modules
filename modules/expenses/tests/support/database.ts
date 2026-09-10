import type { DatabaseHandle, DatabaseProvider } from '@flowdular/database';
import { createTestDatabaseProvider } from '@flowdular/database-testing';
import {
	DatabaseExpensesRepository,
	migrateExpensesDatabase,
} from '../../src/services/database-repository.ts';

const TENANT_TABLES = ['expenses_claims', 'expenses_claims_history'];

export interface ExpensesTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabaseExpensesRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closeExpensesTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every expenses table emptied. */
export async function expensesTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'expenses.core',
			purpose: 'migration',
		});
		try {
			await migrateExpensesDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'expenses.core',
		purpose: 'migration',
	});
	try {
		await migration.database.execute({
			text: `TRUNCATE ${TENANT_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
		});
	} finally {
		await migration.release();
	}
	return provider;
}

/** An empty expenses database with a tenant-scoped runtime handle. */
export async function createExpensesTestDatabase(): Promise<ExpensesTestDatabase> {
	const provider = await expensesTestProvider();
	const lease = await provider.acquire({
		namespace: 'expenses.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabaseExpensesRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closeExpensesTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
