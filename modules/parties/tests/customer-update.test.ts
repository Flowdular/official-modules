import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AgentHarness,
	type AgentExecutionRequest,
	type AgentToolContext,
} from '@flowdular/sdk/harness/runtime';
import { validateToolInput, validateToolOutput } from '@flowdular/sdk/harness';
import type { DatabaseProvider } from '@flowdular/sdk/database';
import { partiesAgentTools } from '../src/agent/tools.ts';
import {
	createPartiesRuntime,
	type PartiesRuntime,
} from '../src/server/runtime.ts';
import type { Party } from '../src/domain/types.ts';
import {
	closePartiesTestDatabases,
	partiesTestProvider,
} from './support/database.ts';

let database: DatabaseProvider;
let runtime: PartiesRuntime;
let original: Party;
const owner = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
const actor = {
	kind: 'agent',
	id: 'customer-agent',
	label: 'Customer agent',
	runId: 'run-update',
} as const;
const context = (
	key = 'customer-update-key',
	tenantId = 'tenant-a',
): AgentToolContext => ({
	actor,
	runId: actor.runId,
	tenantId,
	requestedBy: owner.id,
	idempotencyKey: key,
	permissions: new Set(['parties.records.manage']),
	signal: new AbortController().signal,
});
const tool = () =>
	partiesAgentTools(runtime).find(
		(entry) => entry.id === 'parties.customer.update',
	)!;
const history = async () =>
	(
		await (
			await runtime.service()
		).history('tenant-a', { recordId: original.id, limit: 100, cursor: null })
	).entries;
beforeEach(async () => {
	database = await partiesTestProvider();
	runtime = createPartiesRuntime({ databases: database, purpose: 'test' });
	original = await (
		await runtime.service()
	).create(
		'tenant-a',
		{
			name: 'Original customer',
			kind: 'customer',
			email: 'old@example.com',
			phone: '123',
			vatId: 'PL123',
		},
		owner,
	);
});
afterEach(async () => {
	await runtime.dispose();
});
afterAll(closePartiesTestDatabases);

describe('customer update tool', () => {
	it('updates only supplied fields, clears explicit nulls and records the run actor', async () => {
		const updated = await tool().execute(
			{ id: original.id, email: 'NEW@EXAMPLE.COM', phone: null },
			context(),
		);
		expect(updated).toEqual({
			...original,
			email: 'new@example.com',
			phone: null,
		});
		validateToolOutput(tool().outputSchema, updated);
		expect((await history())[0]).toMatchObject({
			action: 'updated',
			actor,
			changes: {
				email: { from: original.email, to: 'new@example.com' },
				phone: { from: '123', to: null },
			},
		});
		expect(await history()).toHaveLength(2);
	});
	it('replays the original result after restart and later changes without reverting them', async () => {
		const patch = { id: original.id, name: 'Changed customer' };
		const first = await tool().execute(patch, context());
		await (
			await runtime.service()
		).update('tenant-a', { ...original, name: 'Later manual edit' }, owner);
		await runtime.dispose();
		runtime = createPartiesRuntime({ databases: database, purpose: 'test' });
		expect(await tool().execute(patch, context())).toEqual(first);
		expect(
			(await (await runtime.service()).get('tenant-a', original.id))?.name,
		).toBe('Later manual edit');
		expect(await history()).toHaveLength(3);
		await expect(
			tool().execute({ ...patch, name: 'Different input' }, context()),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });
	});
	it('retains replay evidence after deletion and refuses reuse across operations or target records', async () => {
		const patch = { id: original.id, phone: '456' };
		const first = await tool().execute(patch, context());
		await expect(
			partiesAgentTools(runtime)[2]!.execute(
				{ name: 'Different create', kind: 'customer' },
				context(),
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });
		await expect(
			tool().execute({ ...patch, id: 'other-record' }, context()),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });
		await (await runtime.service()).archive('tenant-a', original.id, owner);
		await (await runtime.service()).delete('tenant-a', original.id, owner);
		expect(await tool().execute(patch, context())).toEqual(first);
		expect(
			await (await runtime.service()).get('tenant-a', original.id),
		).toBeNull();
		expect(await history()).toHaveLength(4);
	});
	it('serializes duplicate and independent partial updates', async () => {
		const patch = { id: original.id, name: 'Changed customer' };
		const results = await Promise.all([
			tool().execute(patch, context()),
			tool().execute(patch, context()),
		]);
		expect(results[0]).toEqual(results[1]);
		await Promise.all([
			tool().execute(
				{ id: original.id, phone: '456' },
				context('customer-phone-key'),
			),
			tool().execute(
				{ id: original.id, email: 'new@example.com' },
				context('customer-email-key'),
			),
		]);
		expect(
			await (await runtime.service()).get('tenant-a', original.id),
		).toMatchObject({
			name: 'Changed customer',
			phone: '456',
			email: 'new@example.com',
		});
		expect(await history()).toHaveLength(4);
	});
	it('refuses cross-tenant records, missing keys and aborted requests without writes', async () => {
		const patch = { id: original.id, name: 'Forbidden update' };
		await expect(
			tool().execute(patch, context('customer-update-key', 'tenant-b')),
		).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
		const { idempotencyKey: _key, ...withoutKey } = context();
		await expect(tool().execute(patch, withoutKey)).rejects.toMatchObject({
			code: 'TOOL_IDEMPOTENCY_KEY_REQUIRED',
		});
		await expect(
			tool().execute(patch, { ...context(), signal: AbortSignal.abort() }),
		).rejects.toBeDefined();
		expect(
			await (await runtime.service()).get('tenant-a', original.id),
		).toEqual(original);
		expect(await history()).toHaveLength(1);
	});
	it('validates empty patches, field types, limits and forbidden input authority', async () => {
		for (const patch of [
			{},
			{ name: '' },
			{ name: 'x'.repeat(161) },
			{ kind: 'invalid' },
			{ email: 'invalid' },
			{ email: 12 },
			{ phone: 'x'.repeat(41) },
			{ vatId: 'PL-123' },
			{ name: null },
		]) {
			await expect(
				tool().execute({ id: original.id, ...patch }, context()),
			).rejects.toBeDefined();
		}
		for (const field of ['tenantId', 'status', 'createdAt']) {
			expect(() =>
				validateToolInput(tool().inputSchema, {
					id: original.id,
					name: 'Invalid',
					[field]: 'forged',
				}),
			).toThrow();
		}
		expect(await history()).toHaveLength(1);
	});
	it('rolls back both the update and history when ledger insertion fails', async () => {
		const lease = await database.acquire({
			namespace: 'parties.core',
			purpose: 'migration',
		});
		await lease.database.execute({
			text: `CREATE FUNCTION fail_update_ledger() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END; $$ LANGUAGE plpgsql;
		CREATE TRIGGER fail_update_ledger BEFORE INSERT ON parties_idempotency_ledger FOR EACH ROW EXECUTE FUNCTION fail_update_ledger();`,
		});
		try {
			await expect(
				tool().execute({ id: original.id, name: 'Must roll back' }, context()),
			).rejects.toThrow();
			expect(
				await (await runtime.service()).get('tenant-a', original.id),
			).toEqual(original);
			expect(await history()).toHaveLength(1);
		} finally {
			await lease.database.execute({
				text: 'DROP TRIGGER fail_update_ledger ON parties_idempotency_ledger; DROP FUNCTION fail_update_ledger();',
			});
			await lease.release();
		}
	});
	it('requires explicit grants and live permission, then replays a full harness run once', async () => {
		const id = tool().id;
		const request: AgentExecutionRequest = {
			runId: 'run-update-harness',
			tenantId: 'tenant-a',
			requestedBy: owner.id,
			requestedActor: owner,
			trigger: 'playground',
			input: 'Update customer phone',
			permissionSnapshot: ['parties.records.manage'],
			toolGrants: [id],
			definition: {
				id: actor.id,
				name: actor.label,
				revision: 1,
				instructions: 'Update only the requested phone.',
				provider: 'test-provider',
				model: 'test-model',
				allowedTools: [id],
				maxSteps: 2,
				timeoutMs: 1000,
				temperature: 0,
			},
		};
		const provider = {
			id: 'test-provider',
			execute: async (
				ctx: Parameters<
					import('@flowdular/sdk/harness/runtime').AgentProvider['execute']
				>[0],
			) => {
				await ctx.invokeTool(id, { id: original.id, phone: '789' });
				return {
					output: 'Updated',
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					finishReason: 'stop' as const,
				};
			},
		};
		let live: readonly string[] = [];
		const harness = new AgentHarness({
			providers: [provider],
			tools: partiesAgentTools(runtime),
			authorizeToolAccess: () => live,
		});
		await expect(harness.execute(request)).rejects.toMatchObject({
			code: 'TOOL_NOT_GRANTED',
		});
		live = ['parties.records.manage'];
		await expect(
			harness.execute({ ...request, toolGrants: [] }),
		).rejects.toMatchObject({ code: 'TOOL_NOT_GRANTED' });
		await expect(
			harness.execute({ ...request, permissionSnapshot: [] }),
		).rejects.toMatchObject({ code: 'TOOL_NOT_GRANTED' });
		expect(await history()).toHaveLength(1);
		await harness.execute(request);
		await harness.execute(request);
		expect(
			(await (await runtime.service()).get('tenant-a', original.id))?.phone,
		).toBe('789');
		expect(await history()).toHaveLength(2);
	});
});
