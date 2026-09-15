import type {
	CreateExpensesClaimInput,
	ExpenseClaimBulkOutcome,
	ExpenseClaimDecision,
	ExpenseClaimSort,
	ExpenseClaimSortDirection,
	ExpensesClaim,
} from '../domain/types.ts';
import { t } from '@flowdular/sdk/client/i18n';
import type { HistoryPage } from '@flowdular/sdk/kernel';
import type {
	ExpenseCategoryFilter,
	ExpenseStatusFilter,
} from './expense-claims.ts';

interface ErrorEnvelope {
	readonly error?: { readonly message?: string };
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new Error(value.error?.message ?? t('expenses.error.request'));
	}
	return value;
}

export interface ClaimListRequest {
	readonly sort: ExpenseClaimSort;
	readonly direction: ExpenseClaimSortDirection;
	readonly limit: number;
	readonly status: ExpenseStatusFilter;
	readonly category: ExpenseCategoryFilter;
	/** A substring of the title; '' narrows nothing. */
	readonly query: string;
	/** The cursor that opens this page; null asks for the first one. */
	readonly cursor: string | null;
}

export interface ClaimListPage {
	readonly items: readonly ExpensesClaim[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** One server-sorted, server-narrowed, server-paged listing; the screen narrows nothing. */
export async function loadExpensesClaims(
	request: ClaimListRequest,
): Promise<ClaimListPage> {
	const parameters = new URLSearchParams({
		sort: request.sort,
		direction: request.direction,
		limit: String(request.limit),
	});
	if (request.status !== 'all') parameters.set('status', request.status);
	if (request.category !== 'all') parameters.set('category', request.category);
	if (request.query !== '') parameters.set('q', request.query);
	if (request.cursor !== null) parameters.set('cursor', request.cursor);
	const response = await fetch(
		'/api/expenses/claims?' + parameters.toString(),
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<ClaimListPage>(response);
}

export async function loadAwaitingApprovalCount(): Promise<number> {
	const response = await fetch('/api/expenses/claims/awaiting-approval-count', {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return (await payload<{ readonly count: number }>(response)).count;
}

export async function loadExpenseClaimHistory(
	recordId: string,
): Promise<HistoryPage> {
	const response = await fetch(
		`/api/expenses/claims/history?recordId=${encodeURIComponent(recordId)}&limit=100`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<HistoryPage>(response);
}

async function post<T>(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<T> {
	const response = await fetch(path, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-csrf-token': csrfToken,
		},
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	return payload<T>(response);
}

async function mutateClaim(
	path: string,
	body: unknown,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return (await post<{ readonly claim: ExpensesClaim }>(path, body, csrfToken))
		.claim;
}

export function createExpensesClaim(
	input: CreateExpensesClaimInput,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim('/api/expenses/claims', input, csrfToken);
}

export function submitExpensesClaim(
	claimId: string,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim('/api/expenses/claims/submit', { claimId }, csrfToken);
}

export async function deleteExpensesClaim(
	claimId: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: true }>(
		'/api/expenses/claims/delete',
		{ claimId },
		csrfToken,
	);
}

export function decideExpensesClaim(
	claimId: string,
	decision: ExpenseClaimDecision,
	comment: string,
	csrfToken: string,
): Promise<ExpensesClaim> {
	return mutateClaim(
		`/api/expenses/claims/${decision === 'approved' ? 'approve' : 'reject'}`,
		{ claimId, comment },
		csrfToken,
	);
}

type OutcomesResponse = {
	readonly outcomes: readonly ExpenseClaimBulkOutcome[];
};

/* The selected rows, one outcome per id; a blank comment leaves the default
   bulk review comment to the server. */
export async function decideExpensesClaimsMany(
	claimIds: readonly string[],
	decision: ExpenseClaimDecision,
	comment: string,
	csrfToken: string,
): Promise<readonly ExpenseClaimBulkOutcome[]> {
	const trimmed = comment.trim();
	return (
		await post<OutcomesResponse>(
			`/api/expenses/claims/${decision === 'approved' ? 'approve-many' : 'reject-many'}`,
			trimmed === '' ? { claimIds } : { claimIds, comment: trimmed },
			csrfToken,
		)
	).outcomes;
}

export async function submitExpensesClaimsMany(
	claimIds: readonly string[],
	csrfToken: string,
): Promise<readonly ExpenseClaimBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/expenses/claims/submit-many',
			{ claimIds },
			csrfToken,
		)
	).outcomes;
}
