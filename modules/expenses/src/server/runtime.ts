import type {
	DatabaseAdapterLease,
	DatabaseProvider,
	DatabaseProviderRequest,
} from '@flowdular/database';
import {
	DATABASE_CAPABILITY_IDS,
	DATABASE_DIALECT_IDS,
} from '@flowdular/database';
import { ExpensesService } from '../services/expenses-service.ts';
import {
	DatabaseExpensesRepository,
	migrateExpensesDatabase,
} from '../services/database-repository.ts';

export interface ExpensesRuntimeOptions {
	readonly databases: DatabaseProvider;
	readonly purpose: Exclude<DatabaseProviderRequest['purpose'], 'migration'>;
}

export interface ExpensesRuntime {
	service(): Promise<ExpensesService>;
	dispose(): Promise<void>;
}

export function createExpensesRuntime(
	options: ExpensesRuntimeOptions,
): ExpensesRuntime {
	let disposed = false;
	let runtimeLeasePromise: Promise<DatabaseAdapterLease> | undefined;
	let servicePromise: Promise<ExpensesService> | undefined;

	const initialize = async (): Promise<ExpensesService> => {
		/* Migrations take their own short lease: the runtime role is tenant
		   scoped and may not run schema operations. */
		const migrationLease = await options.databases.acquire({
			namespace: 'expenses.core',
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
			await migrateExpensesDatabase(migrationLease.database);
		} finally {
			await migrationLease.release();
		}
		runtimeLeasePromise = options.databases.acquire({
			namespace: 'expenses.core',
			purpose: options.purpose,
			requirements: {
				dialectIds: [DATABASE_DIALECT_IDS.postgresql],
				capabilities: [DATABASE_CAPABILITY_IDS.TRANSACTIONS],
			},
		});
		const lease = await runtimeLeasePromise;
		return new ExpensesService(new DatabaseExpensesRepository(lease.database));
	};

	return {
		service: () => {
			if (disposed) {
				return Promise.reject(new Error('Expenses runtime is disposed.'));
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
