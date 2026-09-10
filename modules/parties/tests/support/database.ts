import type { DatabaseHandle, DatabaseProvider } from '@flowdular/sdk/database';
import { createTestDatabaseProvider } from '@flowdular/sdk/database-testing';
import {
	DatabasePartyRepository,
	migratePartiesDatabase,
} from '../../src/services/database-repository.ts';

const TENANT_TABLES = [
	'parties',
	'parties_history',
	'parties_history_v2',
	'parties_idempotency_ledger',
];

export interface PartiesTestDatabase {
	readonly provider: DatabaseProvider;
	readonly runtime: DatabaseHandle;
	readonly repository: DatabasePartyRepository;
	dispose(): Promise<void>;
}

/* Booting an embedded PostgreSQL costs about two seconds, so a test file shares
   one migrated cluster and every fixture starts from truncated tables instead.
   Call closePartiesTestDatabases() from the file's afterAll. */
let shared: Promise<DatabaseProvider> | undefined;

/** The file's migrated provider, with every parties table emptied. */
export async function partiesTestProvider(): Promise<DatabaseProvider> {
	shared ??= (async () => {
		const provider = createTestDatabaseProvider();
		const lease = await provider.acquire({
			namespace: 'parties.core',
			purpose: 'migration',
		});
		try {
			await migratePartiesDatabase(lease.database);
		} finally {
			await lease.release();
		}
		return provider;
	})();
	const provider = await shared;
	const migration = await provider.acquire({
		namespace: 'parties.core',
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

/** An empty parties database with a tenant-scoped runtime handle. */
export async function createPartiesTestDatabase(): Promise<PartiesTestDatabase> {
	const provider = await partiesTestProvider();
	const lease = await provider.acquire({
		namespace: 'parties.core',
		purpose: 'test',
	});
	return {
		provider,
		runtime: lease.database,
		repository: new DatabasePartyRepository(lease.database),
		dispose: () => lease.release(),
	};
}

export async function closePartiesTestDatabases(): Promise<void> {
	const provider = shared;
	shared = undefined;
	if (provider) await (await provider).dispose();
}
