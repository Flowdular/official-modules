export const EXPENSE_CLAIM_CATEGORIES = [
	'travel',
	'meals',
	'equipment',
	'other',
] as const;

export const EXPENSE_CLAIM_STATUSES = [
	'draft',
	'submitted',
	'approved',
	'rejected',
] as const;

export type ExpenseClaimCategory = (typeof EXPENSE_CLAIM_CATEGORIES)[number];
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];
export type ExpenseClaimDecision = 'approved' | 'rejected';

/* What a history version records once a claim exists. */
export type ExpenseClaimHistoryAction =
	| 'updated'
	| 'submitted'
	| 'deleted'
	| ExpenseClaimDecision;

export interface ExpensesClaim {
	readonly id: string;
	readonly tenantId: string;
	readonly claimantId: string;
	readonly title: string;
	readonly name: string;
	readonly amountMinor: number;
	readonly currency: string;
	readonly category: ExpenseClaimCategory;
	readonly expenseDate: string;
	readonly note: string | null;
	/** Raw authoring template. `note` is its one-pass resolved claim snapshot. */
	readonly noteTemplate: string | null;
	readonly status: ExpenseClaimStatus;
	readonly decisionComment: string | null;
	readonly createdAt: number;
}

export interface CreateExpensesClaimInput {
	readonly title: string;
	readonly amountMinor: number;
	readonly currency: string;
	readonly category: ExpenseClaimCategory;
	readonly expenseDate: string;
	readonly note: string | null;
}

export type UpdateExpensesClaimInput = CreateExpensesClaimInput;

export const EXPENSE_CLAIM_SORTS = [
	'createdAt',
	'amount',
	'expenseDate',
] as const;
export type ExpenseClaimSort = (typeof EXPENSE_CLAIM_SORTS)[number];
export type ExpenseClaimSortDirection = 'asc' | 'desc';

export const EXPENSE_CLAIM_LIMITS = {
	/** Ids one bulk claim action may name. */
	bulk: 100,
	/** Characters of a title search term. */
	search: 120,
	page: 200,
	defaultPage: 50,
} as const;

/** What one id in a bulk action came to: the single route's answer per row. */
export interface ExpenseClaimBulkOutcome {
	readonly id: string;
	readonly outcome: 'updated' | 'not-found' | 'refused';
	/** The stable service code behind a refusal. */
	readonly reason?: string;
}
