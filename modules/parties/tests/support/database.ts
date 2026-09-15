import type { DatabaseHandle, DatabaseProvider } from '@flowdular/sdk/database';
import { createTestDatabaseProvider } from '@flowdular/sdk/database-testing';
import type { Party } from '../../src/domain/types.ts';
import {
	DatabasePartyRepository,
	migratePartiesDatabase,
} from '../../src/services/database-repository.ts';
import {
	DEFAULT_PARTY_LIST_QUERY,
	PARTY_PAGE_MAX_LIMIT,
	type PartiesService,
} from '../../src/services/parties-service.ts';

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

/** Every party of one tenant in the default order, walked page by page. */
export async function listAll(
	service: PartiesService,
	tenantId: string,
): Promise<readonly Party[]> {
	const parties: Party[] = [];
	let after = null;
	for (;;) {
		const page = await service.list(tenantId, {
			...DEFAULT_PARTY_LIST_QUERY,
			limit: PARTY_PAGE_MAX_LIMIT,
			after,
		});
		parties.push(...page.parties);
		if (!page.next) return parties;
		after = page.next;
	}
}
