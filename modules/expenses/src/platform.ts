import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import {
	EXPORT_LISTS_CAPABILITY,
	type ExportLists,
} from '@flowdular/sdk/modules/exports';
import { createExpensesRoutes, createExpensesRuntime } from './server/index.ts';
import { createClaimsListExport } from './services/claims-export.ts';
import { expensesDataClasses } from './services/data-classes.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createExpensesRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	context.dataClasses.declare(expensesDataClasses(() => runtime.service()));
	/* exports.core is an optional requirement, so its registry may not exist
	   yet while this module composes; it is asked for here and again at start,
	   and registered exactly once. Without exports.core both answer nothing. */
	let registered = false;
	const registerLists = (): void => {
		if (registered) return;
		const lists = context.capabilities.get<ExportLists>(
			EXPORT_LISTS_CAPABILITY,
		);
		if (!lists) return;
		registered = true;
		lists.register('expenses.core', [createClaimsListExport(runtime)]);
	};
	registerLists();
	return {
		routes: createExpensesRoutes(context.auth, runtime),
		start: () => registerLists(),
		dispose: () => runtime.dispose(),
	};
}
