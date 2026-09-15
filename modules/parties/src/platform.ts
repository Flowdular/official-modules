import type {
	PlatformServerComposition,
	PlatformServerContext,
} from '@flowdular/sdk/modules/auth/server';
import {
	EXPORT_LISTS_CAPABILITY,
	type ExportLists,
} from '@flowdular/sdk/modules/exports';
import { platformVariableRegistry } from '@flowdular/sdk/kernel';
import { createPartyListing } from './api/listing.ts';
import { registerPartyVariableSource } from './domain/variables.ts';
import { partiesDataClasses } from './services/data-classes.ts';
import { createPartyListExport } from './services/list-export.ts';
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
	const listing = createPartyListing(runtime);
	/* exports.core is optional, and an optional requirement does not order its
	   provider first, so its registry may not exist yet while this module
	   composes. It is asked for here and again at start, which runs after
	   exports.core composed; without exports.core both attempts answer nothing. */
	let registered = false;
	const registerLists = (): void => {
		if (registered) return;
		const lists = context.capabilities.get<ExportLists>(
			EXPORT_LISTS_CAPABILITY,
		);
		if (!lists) return;
		registered = true;
		lists.register('parties.core', [createPartyListExport(listing)]);
	};
	registerLists();
	return {
		routes: createPartyRoutes(context.auth, runtime, listing),
		start: () => registerLists(),
		dispose: () => runtime.dispose(),
	};
}
