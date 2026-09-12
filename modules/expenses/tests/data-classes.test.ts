import { createDataClassRegistry } from '@flowdular/sdk/kernel';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { CreateExpensesClaimInput } from '../src/domain/types.ts';
import { expensesDataClasses } from '../src/services/data-classes.ts';
import { ExpensesService } from '../src/services/expenses-service.ts';
import {
	closeExpensesTestDatabases,
	createExpensesTestDatabase,
	type ExpensesTestDatabase,
} from './support/database.ts';

const ACTOR = { kind: 'user', id: 'account-a', label: 'Employee' } as const;

const input = (
	overrides: Partial<CreateExpensesClaimInput> = {},
): CreateExpensesClaimInput => ({
	title: 'Train to customer site',
	amountMinor: 12_500,
	currency: 'EUR',
	category: 'travel',
	expenseDate: '2026-08-20',
	note: null,
	...overrides,
});

const databases = new Set<ExpensesTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeExpensesTestDatabases);

async function service(): Promise<ExpensesService> {
	const database = await createExpensesTestDatabase();
	databases.add(database);
	return new ExpensesService(database.repository);
}

function collect() {
	const rows: Record<string, unknown>[] = [];
	return {
		rows,
		sink: {
			write: async (row: Record<string, unknown>) => void rows.push(row),
		},
	};
}

describe('expenses data classes', () => {
	it('declares one exportable class per owned table', () => {
		const registry = createDataClassRegistry();
		registry.declare(
			'expenses.core',
			expensesDataClasses(() => Promise.reject(new Error('unused'))),
		);
		registry.seal();

		const entry = registry
			.list()
			.find((module) => module.moduleId === 'expenses.core');
		expect(entry?.classes.map((declared) => declared.key)).toEqual([
			'claims',
			'claims-history',
		]);
		for (const declared of entry?.classes ?? []) {
			expect(declared.exportable).toBe(true);
			expect(declared.export).toBeTypeOf('function');
			expect(declared.excludedReason).toBeUndefined();
			expect(declared.defaultRetentionDays).toBeNull();
			expect(declared.sweep).toBeUndefined();
			expect(declared.erase).toBeUndefined();
		}
	});

	it('exports every claim and history row of one tenant and none of another', async () => {
		const expenses = await service();
		const [claims, history] = expensesDataClasses(() =>
			Promise.resolve(expenses),
		);
		const first = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'First' }),
			ACTOR,
		);
		await expenses.update(
			'tenant-a',
			'account-a',
			first.id,
			input({ title: 'First changed' }),
			ACTOR,
		);
		const second = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Second' }),
			ACTOR,
		);
		await expenses.create(
			'tenant-b',
			'account-b',
			input({ title: 'Foreign' }),
			ACTOR,
		);

		const claimRows = collect();
		const claimSummary = await claims!.export!({
			tenantId: 'tenant-a',
			sink: claimRows.sink,
		});
		expect(claimRows.rows.map((row) => row.title)).toEqual([
			'First changed',
			'Second',
		]);
		expect(claimRows.rows[0]).toMatchObject({
			id: first.id,
			claimantId: 'account-a',
			currency: 'EUR',
			status: 'draft',
			createdAt: new Date(first.createdAt).toISOString(),
		});
		expect(claimSummary.rows).toBe(2);
		expect(claimSummary.from).toEqual(new Date(first.createdAt));
		expect(claimSummary.to).toEqual(new Date(second.createdAt));

		const historyRows = collect();
		const historySummary = await history!.export!({
			tenantId: 'tenant-a',
			sink: historyRows.sink,
		});
		expect(historyRows.rows.map((row) => [row.recordId, row.action])).toEqual([
			[first.id, 'created'],
			[first.id, 'updated'],
			[second.id, 'created'],
		]);
		expect(historyRows.rows[1]).toMatchObject({
			version: 2,
			actorKind: 'user',
			actorId: 'account-a',
			changes: { title: { from: 'First', to: 'First changed' } },
		});
		expect(historySummary.rows).toBe(3);
		expect(historySummary.from).toBeInstanceOf(Date);
		expect(historySummary.to).toBeInstanceOf(Date);
	});

	it('pages through more rows than one export page holds', async () => {
		const expenses = await service();
		for (let index = 0; index < 5; index += 1) {
			await expenses.create(
				'tenant-a',
				'account-a',
				input({ title: `Claim ${index}` }),
				ACTOR,
			);
		}
		const claimRows = collect();
		const summary = await expenses.exportClaims('tenant-a', claimRows.sink, 2);
		expect(summary.rows).toBe(5);
		expect(new Set(claimRows.rows.map((row) => row.id)).size).toBe(5);

		const historyRows = collect();
		expect(
			(await expenses.exportHistory('tenant-a', historyRows.sink, 2)).rows,
		).toBe(5);
		expect(new Set(historyRows.rows.map((row) => row.id)).size).toBe(5);
	});

	it('reports an empty tenant without writing a row', async () => {
		const expenses = await service();
		for (const declared of expensesDataClasses(() =>
			Promise.resolve(expenses),
		)) {
			const { rows, sink } = collect();
			const summary = await declared.export!({
				tenantId: 'tenant-empty',
				sink,
			});
			expect(rows).toEqual([]);
			expect(summary).toEqual({ rows: 0, from: null, to: null });
		}
	});
});
