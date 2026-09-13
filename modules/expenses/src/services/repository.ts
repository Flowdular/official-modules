import type {
	Actor,
	HistoryPage,
	HistoryQuery,
	RecordChanges,
} from '@flowdular/sdk/kernel';
import type {
	ExpenseClaimHistoryAction,
	ExpenseClaimStatus,
	ExpensesClaim,
} from '../domain/types.ts';

export interface ExpenseClaimListQuery {
	readonly tenantId: string;
	readonly claimantId: string;
	readonly status: ExpenseClaimStatus | null;
	readonly includeApprovalQueue: boolean;
}

/** The last row of the previous export page: its record time and its id. */
export interface ExpensesExportCursor {
	readonly at: number;
	readonly id: string;
}

/** One history version as the workspace export writes it. */
export interface ExpenseClaimHistoryExport {
	readonly id: string;
	readonly recordId: string;
	readonly version: number;
	readonly action: string;
	readonly actorKind: string;
	readonly actorId: string;
	readonly actorLabel: string;
	readonly runId: string | null;
	readonly changes: RecordChanges;
	readonly occurredAt: number;
}

/** The database-agnostic business port. No driver type crosses it. */
export interface ExpensesRepository {
	list(query: ExpenseClaimListQuery): Promise<readonly ExpensesClaim[]>;
	find(tenantId: string, id: string): Promise<ExpensesClaim | null>;
	create(record: ExpensesClaim, actor: Actor): Promise<ExpensesClaim>;
	update(
		record: ExpensesClaim,
		action: ExpenseClaimHistoryAction,
		actor: Actor,
	): Promise<ExpensesClaim>;
	delete(tenantId: string, id: string, actor: Actor): Promise<boolean>;
	countAwaitingApproval(tenantId: string): Promise<number>;
	history(query: HistoryQuery): Promise<HistoryPage>;
	listForExport(
		tenantId: string,
		after: ExpensesExportCursor | null,
		limit: number,
	): Promise<readonly ExpensesClaim[]>;
	listHistoryForExport(
		tenantId: string,
		after: ExpensesExportCursor | null,
		limit: number,
	): Promise<readonly ExpenseClaimHistoryExport[]>;
}
