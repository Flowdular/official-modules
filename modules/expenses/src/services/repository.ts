import type {
	Actor,
	HistoryPage,
	HistoryQuery,
	RecordChanges,
} from '@flowdular/sdk/kernel';
import type {
	ExpenseClaimCategory,
	ExpenseClaimHistoryAction,
	ExpenseClaimSort,
	ExpenseClaimSortDirection,
	ExpenseClaimStatus,
	ExpensesClaim,
} from '../domain/types.ts';

/** The last row of the previous page: its sort value and its id. */
export interface ExpenseClaimKeyset {
	readonly sortValue: string | number;
	readonly id: string;
}

/**
 * One page of the claims a principal may read: their own, and every submitted
 * claim of the tenant when they hold the approval permission. Filters narrow
 * that set in SQL; the order is (sort column, id) in one direction.
 */
export interface ExpenseClaimPageQuery {
	readonly tenantId: string;
	readonly claimantId: string;
	readonly includeApprovalQueue: boolean;
	readonly status: ExpenseClaimStatus | null;
	readonly category: ExpenseClaimCategory | null;
	/** A substring of the title; null narrows nothing. */
	readonly search: string | null;
	readonly sort: ExpenseClaimSort;
	readonly direction: ExpenseClaimSortDirection;
	readonly limit: number;
	readonly after: ExpenseClaimKeyset | null;
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
	page(query: ExpenseClaimPageQuery): Promise<readonly ExpensesClaim[]>;
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
