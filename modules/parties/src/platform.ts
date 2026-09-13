import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import { platformVariableRegistry } from '@flowdular/sdk/kernel';
import { registerPartyVariableSource } from './domain/variables.ts';
import { partiesDataClasses } from './services/data-classes.ts';
import {
	createPartiesRuntime,
	createPartyRoutes,
	partiesAgentTools,
} from './server/index.ts';

export function createServerComposition(
	context: PlatformServerContext,
): PlatformServerComposition {
	const runtime = createPartiesRuntime({
		databases: context.databases,
		purpose:
			context.environment.NODE_ENV === 'test'
				? 'test'
				: context.environment.NODE_ENV === 'production'
					? 'runtime'
					: 'preview',
	});
	context.dataClasses.declare(partiesDataClasses(() => runtime.service()));
	const tools = partiesAgentTools(runtime);
	context.agentTools.register(tools);
	registerPartyVariableSource(
		platformVariableRegistry(context.capabilities),
		tools,
	);
	return {
		routes: createPartyRoutes(context.auth, runtime),
		dispose: () => runtime.dispose(),
	};
}
