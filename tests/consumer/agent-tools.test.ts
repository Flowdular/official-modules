import { createPlatformToolRegistry, userActor } from '@flowdular/kernel';
import {
	AgentHarness,
	LocalSimulationProvider,
	type AgentExecutionEvent,
	type AgentExecutionRequest,
	type AgentProvider,
	type AgentTool,
} from '@flowdular/harness';
import {
	catalogAgentTools,
	createCatalogRuntime,
} from '@flowdular/module-catalog/server';
import {
	createPartiesRuntime,
	partiesAgentTools,
} from '@flowdular/module-parties/server';
import { createPgliteTestProvider } from '@flowdular/database-testing';
import type { DatabaseProvider } from '@flowdular/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const NO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as const;

function request(
	overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
	return {
		runId: 'run-1',
		tenantId: 'tenant-a',
		requestedBy: 'account-a',
		requestedActor: userActor({
			accountId: 'account-a',
			displayName: 'Ada',
			email: 'ada@example.com',
		}),
		trigger: 'playground',
		input: 'Register the new customer.',
		definition: {
			id: 'agent-1',
			name: 'Operations agent',
			revision: 1,
			instructions: 'Use the granted tools to maintain master data.',
			provider: 'caller',
			model: 'deterministic-v1',
			allowedTools: ['parties.customer.create'],
			maxSteps: 4,
			timeoutMs: 2_000,
			temperature: 0,
		},
		permissionSnapshot: ['parties.records.manage'],
		toolGrants: ['parties.customer.create'],
		...overrides,
	};
}

/* A provider that invokes the create tool once and reports whether the call
   was denied, so a run completes with its tool events either way. */
function caller(input: Record<string, unknown>): AgentProvider {
	return {
		id: 'caller',
		execute: async (context) => {
			try {
				const created = await context.invokeTool(
					'parties.customer.create',
					input,
				);
				return {
					output: JSON.stringify(created),
					usage: NO_USAGE,
					finishReason: 'stop',
				};
			} catch {
				return { output: 'denied', usage: NO_USAGE, finishReason: 'stop' };
			}
		},
	};
}

let databases: DatabaseProvider;

/* parties.core and catalog.core keep their own namespaces in one embedded
   PostgreSQL, so the tools under test reach the same kind of platform-owned
   provider a deployment hands them. Starting one costs seconds, so the suite
   starts a single provider and each case writes under its own tenant. */
beforeAll(() => {
	databases = createPgliteTestProvider();
});

afterAll(async () => {
	await databases.dispose();
});

describe('platform agent tools through the harness', () => {
	it('surfaces every registered module tool id in harness.tools()', async () => {
		const registry = createPlatformToolRegistry<AgentTool>();
		registry.register(
			partiesAgentTools(createPartiesRuntime({ databases, purpose: 'test' })),
		);
		registry.register(
			catalogAgentTools(createCatalogRuntime({ databases, purpose: 'test' })),
		);
		const harness = new AgentHarness({
			providers: [new LocalSimulationProvider()],
			tools: await registry.list(),
		});
		expect(harness.tools()).toEqual([
			'catalog.item.create',
			'catalog.item.list',
			'parties.customer.create',
			'parties.customer.get',
			'parties.customer.list',
			'parties.customer.update',
		]);
	});

	it('creates once and replays a mutating module tool without a duplicate', async () => {
		const runtime = createPartiesRuntime({ databases, purpose: 'test' });
		const provider = caller({ name: 'Acme', kind: 'customer' });
		const harness = new AgentHarness({
			providers: [provider],
			tools: partiesAgentTools(runtime),
			authorizeToolAccess: () => ['parties.records.manage'],
		});
		const events: AgentExecutionEvent[] = [];
		const result = await harness.execute(request(), {
			provider,
			onEvent: (event) => events.push(event),
		});
		const replay = await harness.execute(request(), { provider });

		await expect(
			(await runtime.service()).list('tenant-a'),
		).resolves.toHaveLength(1);
		await expect(
			(await runtime.service()).list('tenant-b'),
		).resolves.toHaveLength(0);
		expect(JSON.parse(result.output)).toMatchObject({
			name: 'Acme',
			kind: 'customer',
		});
		expect(replay.output).toBe(result.output);
		expect(events.some((event) => event.type === 'tool.completed')).toBe(true);
		expect(events.some((event) => event.type === 'tool.denied')).toBe(false);
	});

	it('denies the tool and writes nothing when the run lacks the manage scope', async () => {
		const runtime = createPartiesRuntime({ databases, purpose: 'test' });
		const provider = caller({ name: 'Acme', kind: 'customer' });
		const harness = new AgentHarness({
			providers: [provider],
			tools: partiesAgentTools(runtime),
			authorizeToolAccess: () => ['parties.records.read'],
		});
		const events: AgentExecutionEvent[] = [];
		const result = await harness.execute(
			request({
				tenantId: 'tenant-denied',
				permissionSnapshot: ['parties.records.read'],
			}),
			{ provider, onEvent: (event) => events.push(event) },
		);

		expect(result.output).toBe('denied');
		expect(
			events.some(
				(event) =>
					event.type === 'tool.denied' &&
					event.metadata?.reason === 'TOOL_NOT_GRANTED',
			),
		).toBe(true);
		expect(events.some((event) => event.type === 'tool.started')).toBe(false);
		await expect(
			(await runtime.service()).list('tenant-denied'),
		).resolves.toHaveLength(0);
	});
});
