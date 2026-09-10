import { validateToolInput, validateToolOutput } from '@flowdular/sdk/harness';
import type { AgentToolContext } from '@flowdular/sdk/harness/runtime';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { partiesAgentTools } from '../src/agent/tools.ts';
import type { Party } from '../src/domain/types.ts';
import {
	createPartiesRuntime,
	type PartiesRuntime,
} from '../src/server/runtime.ts';
import {
	agentActor,
	createPlatformVariableRegistry,
} from '@flowdular/sdk/kernel';
import { PARTY_PERMISSIONS } from '../src/acl/permissions.ts';
import { registerPartyVariableSource } from '../src/domain/variables.ts';
import {
	closePartiesTestDatabases,
	partiesTestProvider,
} from './support/database.ts';

/* execute never reads context.permissions: RBAC is enforced by the harness
   before it calls the tool, and that path is proven in modules/agents. These
   tests cover what the tool itself owns: tenant from context, reused service
   validation, and bounded output. */
function toolContext(
	tenantId: string,
	overrides: Partial<AgentToolContext> = {},
): AgentToolContext {
	return {
		runId: 'run-1',
		tenantId,
		requestedBy: 'account-1',
		idempotencyKey: 'direct-tool-call-1',
		permissions: new Set<string>(),
		signal: new AbortController().signal,
		...overrides,
	};
}

const runtimes = new Set<PartiesRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
});

afterAll(closePartiesTestDatabases);

async function partiesRuntime(): Promise<PartiesRuntime> {
	const runtime = createPartiesRuntime({
		databases: await partiesTestProvider(),
		purpose: 'test',
	});
	runtimes.add(runtime);
	return runtime;
}

const tools = async () => partiesAgentTools(await partiesRuntime());

describe('parties agent tools', () => {
	it('registers the four party tools with the right permissions', async () => {
		expect(
			(await tools()).map((tool) => ({
				id: tool.id,
				permissions: tool.requiredPermissions,
				version: tool.contractVersion,
				risk: tool.risk,
				idempotency: tool.idempotency,
				idempotencyProtection: tool.idempotencyProtection,
				cancellation: tool.cancellation,
				hasInput: tool.inputSchema !== undefined,
				hasOutput: tool.outputSchema !== undefined,
			})),
		).toEqual([
			{
				id: 'parties.customer.list',
				permissions: ['parties.records.read'],
				version: 1,
				risk: 'read',
				idempotency: 'required',
				idempotencyProtection: undefined,
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
			{
				id: 'parties.customer.get',
				permissions: ['parties.records.read'],
				version: 1,
				risk: 'read',
				idempotency: 'required',
				idempotencyProtection: undefined,
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
			{
				id: 'parties.customer.create',
				permissions: ['parties.records.manage'],
				version: 1,
				risk: 'workspace-write',
				idempotency: 'required',
				idempotencyProtection: 'target-ledger',
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
			{
				id: 'parties.customer.update',
				permissions: ['parties.records.manage'],
				version: 1,
				risk: 'workspace-write',
				idempotency: 'required',
				idempotencyProtection: 'target-ledger',
				cancellation: 'cooperative',
				hasInput: true,
				hasOutput: true,
			},
		]);
	});

	it('cooperates with cancellation before reading or writing', async () => {
		const controller = new AbortController();
		controller.abort('workflow-cancelled');
		const [list, , create] = await tools();
		await expect(
			list!.execute({}, toolContext('tenant-a', { signal: controller.signal })),
		).rejects.toBeDefined();
		await expect(
			create!.execute(
				{ name: 'Acme', kind: 'customer' },
				toolContext('tenant-a', { signal: controller.signal }),
			),
		).rejects.toBeDefined();
	});

	it('refuses a mutating call without a durable idempotency key', async () => {
		const create = (await tools())[2]!;
		const { idempotencyKey: _ignored, ...withoutKey } = toolContext('tenant-a');
		await expect(
			create.execute(
				{ name: 'Acme', kind: 'customer' },
				withoutKey as AgentToolContext,
			),
		).rejects.toMatchObject({ code: 'TOOL_IDEMPOTENCY_KEY_REQUIRED' });
	});

	it('validates workflow action input and output against the published schemas', async () => {
		const [list, , create] = await tools();
		expect(() =>
			validateToolInput(create!.inputSchema, {
				name: 'Acme',
				kind: 'customer',
				tenantId: 'tenant-b',
			}),
		).toThrowError(/tenantId/);
		const listed = await list!.execute({}, toolContext('tenant-a'));
		expect(() => validateToolOutput(list!.outputSchema, listed)).not.toThrow();
		const created = await create!.execute(
			{ name: 'Schema customer', kind: 'customer' },
			toolContext('tenant-a'),
		);
		expect(() =>
			validateToolOutput(create!.outputSchema, created),
		).not.toThrow();
	});

	it('creates under the run tenant and ignores a tenant named in the input', async () => {
		const runtime = await partiesRuntime();
		const [, , create] = partiesAgentTools(runtime);
		const created = (await create!.execute(
			{ name: 'Acme', kind: 'customer', tenantId: 'tenant-b' },
			toolContext('tenant-a'),
		)) as Party;
		expect(created.tenantId).toBe('tenant-a');
		await expect(
			(await runtime.service()).list('tenant-a'),
		).resolves.toHaveLength(1);
		await expect(
			(await runtime.service()).list('tenant-b'),
		).resolves.toHaveLength(0);
	});

	it('preserves a workflow service actor and its configuring user in history', async () => {
		const runtime = await partiesRuntime();
		const [, , create] = partiesAgentTools(runtime);
		const actor = {
			kind: 'service',
			id: 'workflow:daily-party-sync',
			label: 'Daily party sync',
			configuredBy: {
				kind: 'user',
				id: 'account-owner',
				label: 'Workspace owner',
			},
		} as const;
		const created = (await create!.execute(
			{ name: 'Workflow customer', kind: 'customer' },
			toolContext('tenant-a', {
				actor,
				idempotencyKey: 'workflow-run:node:attempt-1',
			}),
		)) as Party;

		expect(
			(
				await (
					await runtime.service()
				).history('tenant-a', {
					recordId: created.id,
					limit: 10,
					cursor: null,
				})
			).entries[0]?.actor,
		).toEqual(actor);
		await expect((await runtime.service()).list('tenant-b')).resolves.toEqual(
			[],
		);
	});

	it('reuses the service validation so a tool cannot persist an invalid VAT id', async () => {
		const [, , create] = await tools();
		await expect(
			create!.execute(
				{ name: 'Acme', kind: 'customer', vatId: 'PL-123' },
				toolContext('tenant-a'),
			),
		).rejects.toMatchObject({ code: 'INVALID_VAT_ID' });
	});

	it('bounds list output at the page cap', async () => {
		const runtime = await partiesRuntime();
		const [list] = partiesAgentTools(runtime);
		const context = toolContext('tenant-a');
		const service = await runtime.service();
		for (let index = 0; index < 205; index += 1) {
			await service.create(
				'tenant-a',
				{
					name: `Party ${String(index).padStart(3, '0')}`,
					kind: 'customer',
				},
				agentActor(context),
			);
		}
		const rows = (await list!.execute(
			{},
			toolContext('tenant-a'),
		)) as readonly Party[];
		expect(rows).toHaveLength(200);
	});

	it('filters the list by status and free-text query', async () => {
		const runtime = await partiesRuntime();
		const [list] = partiesAgentTools(runtime);
		const context = toolContext('tenant-a');
		await (
			await runtime.service()
		).create(
			'tenant-a',
			{
				name: 'Acme',
				kind: 'customer',
				email: 'billing@acme.example',
				vatId: 'PL123',
			},
			agentActor(context),
		);
		await (
			await runtime.service()
		).create(
			'tenant-a',
			{ name: 'Beta', kind: 'supplier' },
			agentActor(context),
		);

		const byName = (await list!.execute(
			{ query: 'beta' },
			toolContext('tenant-a'),
		)) as readonly Party[];
		expect(byName.map((party) => party.name)).toEqual(['Beta']);

		const byVat = (await list!.execute(
			{ query: 'pl123' },
			toolContext('tenant-a'),
		)) as readonly Party[];
		expect(byVat.map((party) => party.name)).toEqual(['Acme']);

		const archived = (await list!.execute(
			{ status: 'archived' },
			toolContext('tenant-a'),
		)) as readonly Party[];
		expect(archived).toHaveLength(0);
	});

	it('gets a party by id in the run tenant and returns null when absent', async () => {
		const runtime = await partiesRuntime();
		const [, get, create] = partiesAgentTools(runtime);
		const created = (await create!.execute(
			{ name: 'Acme', kind: 'customer' },
			toolContext('tenant-a'),
		)) as Party;

		expect(
			(
				(await get!.execute(
					{ id: created.id },
					toolContext('tenant-a'),
				)) as Party
			).name,
		).toBe('Acme');
		expect(
			await get!.execute({ id: created.id }, toolContext('tenant-b')),
		).toBeNull();
		expect(
			await get!.execute({ id: 'missing' }, toolContext('tenant-a')),
		).toBeNull();
	});

	it('resolves party variables only in the trusted tenant and scope', async () => {
		const runtime = await partiesRuntime();
		const registered = partiesAgentTools(runtime);
		const create = registered[2]!;
		const created = (await create.execute(
			{ name: 'Tenant A party', kind: 'customer', email: 'a@example.test' },
			toolContext('tenant-a'),
		)) as Party;
		const registry = createPlatformVariableRegistry();
		registerPartyVariableSource(registry, registered);
		const request = (tenantId: string, scopes: readonly string[]) => ({
			tenantId,
			actor: {
				kind: 'user' as const,
				id: 'account-1',
				label: 'Account 1',
			},
			permissionSnapshot: scopes,
			signal: new AbortController().signal,
			bindings: { partyId: created.id },
		});

		await expect(
			registry.resolve(
				'{{ party.name }} <{{ party.email }}>',
				request('tenant-a', [PARTY_PERMISSIONS.read]),
			),
		).resolves.toBe('Tenant A party <a@example.test>');
		await expect(
			registry.resolve(
				'{{ party.name }}',
				request('tenant-b', [PARTY_PERMISSIONS.read]),
			),
		).rejects.toMatchObject({ code: 'VARIABLE_VALUE_UNAVAILABLE' });
		await expect(
			registry.resolve('{{ party.name }}', request('tenant-a', [])),
		).rejects.toMatchObject({ code: 'FORBIDDEN_TEMPLATE_VARIABLE' });
	});
});
