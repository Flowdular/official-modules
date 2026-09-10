import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import { platformVariableRegistry } from '@flowdular/sdk/kernel';
import { registerPartyVariableSource } from './domain/variables.ts';
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
