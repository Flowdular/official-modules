import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/module-auth/server';
import { createExpensesRoutes, createExpensesRuntime } from './server/index.ts';

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
	return {
		routes: createExpensesRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
