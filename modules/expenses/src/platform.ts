import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import { createExpensesRoutes, createExpensesRuntime } from './server/index.ts';
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
	return {
		routes: createExpensesRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
