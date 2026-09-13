import type { DataClassDeclaration } from '@flowdular/sdk/kernel';
import type { ExpensesService } from './expenses-service.ts';

/** The class ids are `expenses.core.claims` and `expenses.core.claims-history`. */
export const EXPENSES_DATA_CLASS_KEYS = {
	claims: 'claims',
	history: 'claims-history',
} as const;

/**
 * What this module holds, for the workspace's data class catalogue. Claims and
 * their revision trail are accounting records: neither carries a retention
 * period, a sweep or an erasure, because a claim leaves only when its claimant
 * deletes the draft and the trail of that deletion stays. The service arrives
 * as a thunk because declaring happens while the platform composes, before
 * anything has opened a database.
 */
export function expensesDataClasses(
	service: () => Promise<ExpensesService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: EXPENSES_DATA_CLASS_KEYS.claims,
			label: 'Expense claims',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportClaims(tenantId, sink),
		},
		{
			key: EXPENSES_DATA_CLASS_KEYS.history,
			label: 'Expense claim history',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportHistory(tenantId, sink),
		},
	];
}
