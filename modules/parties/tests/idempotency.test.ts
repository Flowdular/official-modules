import type {
	DatabaseProvider,
	DatabaseSession,
} from '@flowdular/sdk/database';
import type { AgentToolContext } from '@flowdular/sdk/harness/runtime';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { partiesAgentTools } from '../src/agent/tools.ts';
import type { Party } from '../src/domain/types.ts';
import {
	createPartiesRuntime,
	type PartiesRuntime,
} from '../src/server/runtime.ts';
import {
	closePartiesTestDatabases,
	partiesTestProvider,
} from './support/database.ts';

const runtimes = new Set<PartiesRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
});

afterAll(closePartiesTestDatabases);

function runtimeOn(databases: DatabaseProvider): PartiesRuntime {
	const runtime = createPartiesRuntime({ databases, purpose: 'test' });
	runtimes.add(runtime);
	return runtime;
}

/* Ledger evidence is read through the tenant-scoped runtime role, the same
   boundary a replay crosses. */
async function ledgerEvidence(
	databases: DatabaseProvider,
	tenantId: string,
): Promise<Record<string, unknown> | undefined> {
	const lease = await databases.acquire({
		namespace: 'parties.core',
		purpose: 'test',
	});
	try {
		const result = await lease.database.transaction(
			(transaction) =>
				transaction.query<Record<string, unknown>>({
					text: `SELECT tenant_id, idempotency_key, operation_id, input_digest,
						 outcome, result_digest
						 FROM parties_idempotency_ledger`,
				}),
			{ access: 'read', tenantId },
		);
		return result.rows[0];
	} finally {
		await lease.release();
	}
}

async function migrator<T>(
	databases: DatabaseProvider,
	work: (database: DatabaseSession) => Promise<T>,
): Promise<T> {
	const lease = await databases.acquire({
		namespace: 'parties.core',
		purpose: 'migration',
	});
	try {
		return await lease.database.transaction(work, {
			tenantId: 'tenant-a',
			access: 'write',
		});
	} finally {
		await lease.release();
	}
}

async function tableCount(
	databases: DatabaseProvider,
	table: string,
): Promise<number> {
	return migrator(databases, async (database) =>
		Number(
			(
				await database.query<{ count: string }>({
					text: `SELECT count(*) AS count FROM ${table}`,
				})
			).rows[0]!.count,
		),
	);
}

function context(key: string, tenantId = 'tenant-a'): AgentToolContext {
	return {
		runId: 'run-1',
		tenantId,
		requestedBy: 'account-1',
		idempotencyKey: key,
		actor: {
			kind: 'agent',
			id: 'customer-agent',
			label: 'Customer agent',
			runId: 'run-1',
		},
		permissions: new Set(['parties.records.manage']),
		signal: new AbortController().signal,
	};
}

const input = {
	name: 'Acme GmbH',
	kind: 'customer' as const,
	email: 'billing@acme.example',
	vatId: 'DE123456789',
};

describe('party target idempotency', () => {
	it('returns the first result after restart and refuses key reuse for another input or operation', async () => {
		const databases = await partiesTestProvider();
		const firstRuntime = runtimeOn(databases);
		const create = partiesAgentTools(firstRuntime)[2]!;
		const first = (await create.execute(
			{ ...input, name: '  Acme GmbH  ', email: 'BILLING@ACME.EXAMPLE' },
			context('party-create-key-1'),
		)) as Party;
		await firstRuntime.dispose();

		const recoveredRuntime = runtimeOn(databases);
		const recoveredCreate = partiesAgentTools(recoveredRuntime)[2]!;
		const replay = (await recoveredCreate.execute(
			input,
			context('party-create-key-1'),
		)) as Party;
		expect(replay).toEqual(first);
		await expect(
			(await recoveredRuntime.service()).list('tenant-a'),
		).resolves.toEqual([first]);
		expect(
			(
				await (
					await recoveredRuntime.service()
				).history('tenant-a', {
					recordId: first.id,
					limit: 10,
					cursor: null,
				})
			).entries,
		).toHaveLength(1);

		await expect(
			recoveredCreate.execute(
				{ ...input, name: 'Different customer' },
				context('party-create-key-1'),
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });
		await expect(
			(await recoveredRuntime.service()).createIdempotent(
				'tenant-a',
				input,
				context('party-create-key-1').actor!,
				{
					key: 'party-create-key-1',
					operationId: 'parties.customer.create@2',
				},
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_CONFLICT' });

		const tenantB = (await recoveredCreate.execute(
			input,
			context('party-create-key-1', 'tenant-b'),
		)) as Party;
		expect(tenantB.tenantId).toBe('tenant-b');
		await expect(
			(await recoveredRuntime.service()).list('tenant-b'),
		).resolves.toHaveLength(1);
	});

	it('keeps the ledger after deletion without adding history on replay', async () => {
		const databases = await partiesTestProvider();
		const runtime = runtimeOn(databases);
		const create = partiesAgentTools(runtime)[2]!;
		const created = (await create.execute(
			input,
			context('party-delete-key-1'),
		)) as Party;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		await (await runtime.service()).archive('tenant-a', created.id, actor);
		await (await runtime.service()).delete('tenant-a', created.id, actor);
		await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
			[],
		);

		expect(await create.execute(input, context('party-delete-key-1'))).toEqual(
			created,
		);
		await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
			[],
		);
		expect(
			(
				await (
					await runtime.service()
				).history('tenant-a', {
					recordId: created.id,
					limit: 10,
					cursor: null,
				})
			).entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'created']);

		const evidence = (await ledgerEvidence(databases, 'tenant-a'))!;
		expect(evidence).toMatchObject({
			tenant_id: 'tenant-a',
			idempotency_key: 'party-delete-key-1',
			operation_id: 'parties.customer.create@1',
			outcome: 'succeeded',
		});
		expect(evidence.input_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(evidence.result_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(JSON.stringify(evidence)).not.toContain('Acme GmbH');
		expect(JSON.stringify(evidence)).not.toContain('billing@acme.example');
	});

	it('rolls back the party and history if the ledger cannot commit', async () => {
		const databases = await partiesTestProvider();
		await migrator(databases, (database) =>
			database.execute({
				text: `CREATE FUNCTION fail_parties_ledger() RETURNS trigger AS $$
				BEGIN
				  RAISE EXCEPTION 'forced ledger failure';
				END;
				$$ LANGUAGE plpgsql;
				CREATE TRIGGER fail_parties_ledger
				BEFORE INSERT ON parties_idempotency_ledger
				FOR EACH ROW EXECUTE FUNCTION fail_parties_ledger();`,
			}),
		);
		try {
			const runtime = runtimeOn(databases);
			await expect(
				partiesAgentTools(runtime)[2]!.execute(
					input,
					context('party-rollback-key-1'),
				),
			).rejects.toThrow();
			await expect((await runtime.service()).list('tenant-a')).resolves.toEqual(
				[],
			);

			expect(await tableCount(databases, 'parties')).toBe(0);
			expect(await tableCount(databases, 'parties_history_v2')).toBe(0);
			expect(await tableCount(databases, 'parties_idempotency_ledger')).toBe(0);
		} finally {
			await migrator(databases, (database) =>
				database.execute({
					text: `DROP TRIGGER IF EXISTS fail_parties_ledger ON parties_idempotency_ledger;
					DROP FUNCTION IF EXISTS fail_parties_ledger();`,
				}),
			);
		}
	});

	it('fails closed on a corrupted replay result without recreating the party', async () => {
		const databases = await partiesTestProvider();
		const first = runtimeOn(databases);
		const create = partiesAgentTools(first)[2]!;
		const created = (await create.execute(
			input,
			context('party-corrupt-key-1'),
		)) as Party;
		const actor = { kind: 'user', id: 'owner-1', label: 'Owner' } as const;
		await (await first.service()).archive('tenant-a', created.id, actor);
		await (await first.service()).delete('tenant-a', created.id, actor);
		await first.dispose();

		await migrator(databases, (database) =>
			database.execute({
				text: `UPDATE parties_idempotency_ledger SET result_json = $1
					 WHERE tenant_id = $2 AND idempotency_key = $3`,
				parameters: [
					JSON.stringify({ ...created, name: 'Tampered' }),
					'tenant-a',
					'party-corrupt-key-1',
				],
			}),
		);

		const recovered = runtimeOn(databases);
		await expect(
			partiesAgentTools(recovered)[2]!.execute(
				input,
				context('party-corrupt-key-1'),
			),
		).rejects.toMatchObject({ code: 'PARTY_IDEMPOTENCY_LEDGER_CORRUPT' });
		await expect((await recovered.service()).list('tenant-a')).resolves.toEqual(
			[],
		);
		expect(
			await partiesAgentTools(recovered)[2]!.execute(
				input,
				context('party-corrupt-key-1', 'tenant-b'),
			),
		).toMatchObject({ tenantId: 'tenant-b' });
	});
});
