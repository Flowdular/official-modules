import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { PartiesService } from '../services/parties-service.ts';
import {
	DatabasePartyRepository,
	migratePartiesDatabase,
} from '../services/database-repository.ts';

export interface PartiesRuntimeOptions {
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}

export interface PartiesRuntime {
	service(): Promise<PartiesService>;
	dispose(): Promise<void>;
}

export function createPartiesRuntime(
	options: PartiesRuntimeOptions,
): PartiesRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<PartiesService> | undefined;

	const initialize = async (): Promise<PartiesService> => {
		/* Migrations take their own short lease: the runtime role is tenant
		   scoped and may not run schema operations. */
		const migrationLease = await options.databases.acquire({
			namespace: 'parties.core',
			purpose: 'migration',
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [
					DATABASE_CAPABILITY_IDS.MIGRATION_LOCK,
					DATABASE_CAPABILITY_IDS.SCHEMA_INTROSPECTION,
					DATABASE_CAPABILITY_IDS.TRANSACTIONAL_DDL,
				],
			},
		});
		try {
			await migratePartiesDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'parties.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return new PartiesService(new DatabasePartyRepository(lease.database));
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Parties runtime is disposed.'));
			}
			servicePromise ??= initialize();
			return servicePromise;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!runtimeLeasePromise) {
				await servicePromise?.catch(() => undefined);
			}
			if (!runtimeLeasePromise) return;
			const lease = await runtimeLeasePromise;
			await lease.release();
			runtimeLeasePromise = undefined;
			servicePromise = undefined;
		},
	};
}
