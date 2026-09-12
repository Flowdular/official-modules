import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDataClassRegistry } from '@flowdular/sdk/kernel';
import { partiesDataClasses } from '../src/services/data-classes.ts';
import {
	PARTY_EXPORT_PAGE,
	PartiesService,
} from '../src/services/parties-service.ts';
import {
	closePartiesTestDatabases,
	createPartiesTestDatabase,
	type PartiesTestDatabase,
} from './support/database.ts';

const ACTOR = { kind: 'user', id: 'account-1', label: 'Owner' } as const;

let database: PartiesTestDatabase;
let service: PartiesService;

beforeEach(async () => {
	database = await createPartiesTestDatabase();
	service = new PartiesService(database.repository);
});

afterEach(async () => {
	await database.dispose();
});

afterAll(closePartiesTestDatabases);

function declarations() {
	return partiesDataClasses(() => Promise.resolve(service));
}

function declared(key: string) {
	const declaration = declarations().find((entry) => entry.key === key);
	if (!declaration) throw new Error(`No data class ${key}.`);
	return declaration;
}

async function exportRows(key: string, tenantId: string) {
	const rows: Record<string, unknown>[] = [];
	const summary = await declared(key).export!({
		tenantId,
		sink: { write: async (row) => void rows.push(row) },
	});
	return { rows, summary };
}

function createParty(tenantId: string, name: string) {
	return service.create(tenantId, { name, kind: 'customer' }, ACTOR);
}

describe('parties data classes', () => {
	it('declares one class per owned table that the registry accepts', () => {
		const registry = createDataClassRegistry();
		registry.declare('parties.core', declarations());
		registry.seal();

		const entry = registry
			.list()
			.find((module) => module.moduleId === 'parties.core');
		const classes = entry?.classes ?? [];
		expect(classes.map((declaration) => declaration.key)).toEqual([
			'parties',
			'history',
			'idempotency-ledger',
		]);
		for (const declaration of classes) {
			expect(declaration.defaultRetentionDays).toBeNull();
			expect(declaration.sweep).toBeUndefined();
			expect(declaration.erase).toBeUndefined();
		}
		for (const key of ['parties', 'history']) {
			expect(declared(key).exportable).toBe(true);
			expect(declared(key).export).toBeTypeOf('function');
		}
		const ledger = declared('idempotency-ledger');
		expect(ledger.exportable).toBe(false);
		expect(ledger.export).toBeUndefined();
		expect(ledger.excludedReason).toMatch(/parties\.core\.parties/);
	});

	it('exports every party of one tenant and none of another', async () => {
		const first = await createParty('tenant-a', 'Alpha');
		const second = await createParty('tenant-a', 'Beta');
		await service.archive('tenant-a', second.id, ACTOR);
		await createParty('tenant-b', 'Gamma');

		const { rows, summary } = await exportRows('parties', 'tenant-a');

		const byName = [...rows].sort((a, b) =>
			String(a.name).localeCompare(String(b.name)),
		);
		expect(byName.map((row) => [row.name, row.status])).toEqual([
			['Alpha', 'active'],
			['Beta', 'archived'],
		]);
		expect(byName[0]).toMatchObject({
			id: first.id,
			kind: 'customer',
			createdAt: new Date(first.createdAt).toISOString(),
		});
		expect(rows.every((row) => !('tenantId' in row))).toBe(true);
		expect(summary.rows).toBe(2);
		expect(summary.from).toEqual(new Date(first.createdAt));
		expect(summary.to).toEqual(new Date(second.createdAt));
	});

	it('exports the history trail of one tenant, deleted parties included', async () => {
		const party = await createParty('tenant-a', 'Alpha');
		await service.archive('tenant-a', party.id, ACTOR);
		await service.delete('tenant-a', party.id, ACTOR);
		await createParty('tenant-b', 'Gamma');

		const { rows, summary } = await exportRows('history', 'tenant-a');

		const byVersion = [...rows].sort(
			(a, b) => Number(a.version) - Number(b.version),
		);
		expect(
			byVersion.map((row) => [row.recordId, row.version, row.action]),
		).toEqual([
			[party.id, 1, 'created'],
			[party.id, 2, 'archived'],
			[party.id, 3, 'deleted'],
		]);
		expect(byVersion[0]).toMatchObject({
			actorKind: 'user',
			actorId: ACTOR.id,
			actorLabel: ACTOR.label,
			runId: null,
			configuredBy: null,
		});
		expect(JSON.parse(byVersion[0]!.changes as string)).toMatchObject({
			name: { from: null, to: 'Alpha' },
		});
		expect(summary.rows).toBe(3);
		expect(summary.from).toBeInstanceOf(Date);
		expect(summary.to).toBeInstanceOf(Date);
	});

	it('pages past one export page without repeating or skipping a row', async () => {
		const created = await Promise.all(
			Array.from({ length: PARTY_EXPORT_PAGE + 3 }, (_value, index) =>
				createParty('tenant-a', `Party ${String(index).padStart(3, '0')}`),
			),
		);

		const { rows, summary } = await exportRows('parties', 'tenant-a');

		expect(summary.rows).toBe(created.length);
		expect(new Set(rows.map((row) => row.id)).size).toBe(created.length);
		expect(new Set(rows.map((row) => row.id))).toEqual(
			new Set(created.map((party) => party.id)),
		);
	});

	it('reports an empty tenant without writing a row', async () => {
		await createParty('tenant-b', 'Gamma');

		for (const key of ['parties', 'history']) {
			const { rows, summary } = await exportRows(key, 'tenant-empty');
			expect(rows).toEqual([]);
			expect(summary).toEqual({ rows: 0, from: null, to: null });
		}
	});
});
