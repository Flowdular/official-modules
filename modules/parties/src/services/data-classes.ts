import type { DataClassDeclaration } from '@flowdular/sdk/kernel';
import type { PartiesService } from './parties-service.ts';

/** Class ids are `parties.core.<key>`. */
export const PARTIES_DATA_CLASS_KEYS = {
	parties: 'parties',
	history: 'history',
	ledger: 'idempotency-ledger',
} as const;

/*
 * No class carries a retention period or a sweep: a row leaves only when a
 * person deletes the party, and the trail then keeps the deletion. The
 * history class covers parties_history_v2 and the frozen parties_history it
 * superseded; migration 0004 copied every legacy row into v2, so reading v2
 * exports both. The ledger is durable replay evidence and stays out of the
 * export.
 */
export function partiesDataClasses(
	service: () => Promise<PartiesService>,
): readonly DataClassDeclaration[] {
	return [
		{
			key: PARTIES_DATA_CLASS_KEYS.parties,
			label: 'Customers and suppliers',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportParties(tenantId, sink),
		},
		{
			key: PARTIES_DATA_CLASS_KEYS.history,
			label: 'Party change history',
			defaultRetentionDays: null,
			exportable: true,
			export: async ({ tenantId, sink }) =>
				(await service()).exportHistory(tenantId, sink),
		},
		{
			key: PARTIES_DATA_CLASS_KEYS.ledger,
			label: 'Party idempotency ledger',
			defaultRetentionDays: null,
			exportable: false,
			excludedReason:
				'Operational replay ledger of mutating tools and workflow actions; the parties it points at are exported by parties.core.parties.',
		},
	];
}
