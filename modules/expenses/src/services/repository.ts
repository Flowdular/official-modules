import type { Actor, HistoryPage, HistoryQuery } from '@flowdular/sdk/kernel';
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
}
