import { cell, createStore } from 'segment-state';
import type { HistoryEntry } from '@flowdular/sdk/kernel';
import type { TableSort } from '@flowdular/sdk/ui';
import type {
	ExpenseClaimBulkOutcome,
	ExpenseClaimDecision,
	ExpenseClaimSort,
	ExpenseClaimSortDirection,
	ExpensesClaim,
} from '../domain/types.ts';
import type { ClaimListPage } from './api.ts';
import type {
	ExpenseCategoryFilter,
	ExpenseStatusFilter,
} from './expense-claims.ts';

export const DEFAULT_CLAIM_SORTING: readonly TableSort[] = [
	{ key: 'createdAt', desc: true },
];

/** What the bulk bar can do; the dialog it opens is named by this. */
export type ExpenseBulkAction = ExpenseClaimDecision | 'submit';

/**
 * The cursor that opened each page the reader has visited: page 0 has none,
 * and page n holds the cursor page n - 1 answered. Going back reuses the stored
 * cursor; a page past the stack cannot be opened.
 */
export type PageCursors = readonly (string | null)[];

/** One listing as the server answers it: the page, its order and its filters. */
export interface ClaimListing {
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly sorting: readonly TableSort[];
	readonly query: string;
	readonly status: ExpenseStatusFilter;
	readonly category: ExpenseCategoryFilter;
	readonly cursors: PageCursors;
}

export function createExpensesClientState() {
	const store = createStore({
		claims: cell<readonly ExpensesClaim[]>([]),
		statusFilter: cell<ExpenseStatusFilter>('all'),
		categoryFilter: cell<ExpenseCategoryFilter>('all'),
		query: '',
		/** The term the rows on screen answer; typing moves `query` ahead of it. */
		appliedQuery: '',
		sorting: cell<readonly TableSort[]>(DEFAULT_CLAIM_SORTING),
		pageIndex: 0,
		pageSize: 25,
		cursors: cell<PageCursors>([null]),
		nextCursor: cell<string | null>(null),
		filtersOpen: false,
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		bulkAction: cell<ExpenseBulkAction | null>(null),
		bulkComment: '',
		formOpen: false,
		formSession: 0,
		formError: '',
		decisionOpen: false,
		decisionSession: 0,
		decisionClaim: cell<ExpensesClaim | null>(null),
		decision: cell<ExpenseClaimDecision>('approved'),
		decisionError: '',
		deleteConfirmOpen: false,
		deleteClaim: cell<ExpensesClaim | null>(null),
		historyOpen: false,
		historyClaim: cell<ExpensesClaim | null>(null),
		historyEntries: cell<readonly HistoryEntry[]>([]),
		historyLoading: false,
		historyError: '',
		status: cell<'idle' | 'loading' | 'submitting' | 'deciding' | 'deleting'>(
			'idle',
		),
		error: '',
	});
	return { store, state: store.state };
}

export function createExpensesDashboardState() {
	const store = createStore({
		count: 0,
		status: cell<'idle' | 'loading'>('idle'),
		error: '',
	});
	return { store, state: store.state };
}

/** The server's sort key and direction behind the table's sorting state. */
export function claimSort(sorts: readonly TableSort[]): {
	readonly sort: ExpenseClaimSort;
	readonly direction: ExpenseClaimSortDirection;
} {
	const first = sorts[0] ?? DEFAULT_CLAIM_SORTING[0]!;
	return {
		sort:
			first.key === 'amount' || first.key === 'expenseDate'
				? first.key
				: 'createdAt',
		direction: first.desc ? 'desc' : 'asc',
	};
}

/** The cursor that opens `pageIndex`, or undefined when the reader never reached it. */
export function pageCursor(
	cursors: PageCursors,
	pageIndex: number,
): string | null | undefined {
	return pageIndex < cursors.length ? cursors[pageIndex] : undefined;
}

/**
 * Records what the page at `pageIndex` answered: the cursor of the page after
 * it, or nothing when it was the last. Pages beyond the next one are dropped,
 * since the set may have changed under them.
 */
export function rememberNextCursor(
	cursors: PageCursors,
	pageIndex: number,
	nextCursor: string | null,
): PageCursors {
	const kept = cursors.slice(0, pageIndex + 1);
	return nextCursor === null ? kept : [...kept, nextCursor];
}

export function resetPageCursors(): PageCursors {
	return [null];
}

/**
 * What a loaded page writes to the screen. The selection is emptied with every
 * listing, because a selected id names a row the reader saw on the page that
 * is being replaced.
 */
export function loadedListing(
	next: ClaimListing,
	page: ClaimListPage,
): {
	readonly claims: readonly ExpensesClaim[];
	readonly appliedQuery: string;
	readonly pageIndex: number;
	readonly cursors: PageCursors;
	readonly nextCursor: string | null;
	readonly selectedIds: ReadonlySet<string>;
} {
	return {
		claims: page.items,
		appliedQuery: next.query,
		pageIndex: next.pageIndex,
		cursors: rememberNextCursor(
			next.cursors,
			next.pageIndex,
			page.page.nextCursor,
		),
		nextCursor: page.page.nextCursor,
		selectedIds: new Set(),
	};
}

/** The selected rows on screen a decision may name: submitted claims only. */
export function decidableTargets(
	claims: readonly ExpensesClaim[],
	selected: ReadonlySet<string>,
): readonly string[] {
	return claims
		.filter((claim) => selected.has(claim.id) && claim.status === 'submitted')
		.map((claim) => claim.id);
}

/** The selected rows on screen a submission may name: drafts only. */
export function submittableTargets(
	claims: readonly ExpensesClaim[],
	selected: ReadonlySet<string>,
): readonly string[] {
	return claims
		.filter((claim) => selected.has(claim.id) && claim.status === 'draft')
		.map((claim) => claim.id);
}

/** How many ids each outcome covered, for the toast after a bulk action. */
export function bulkOutcomeCounts(
	outcomes: readonly ExpenseClaimBulkOutcome[],
): {
	readonly updated: number;
	readonly missing: number;
	readonly refused: number;
} {
	let updated = 0;
	let missing = 0;
	let refused = 0;
	for (const entry of outcomes) {
		if (entry.outcome === 'updated') updated += 1;
		else if (entry.outcome === 'not-found') missing += 1;
		else refused += 1;
	}
	return { updated, missing, refused };
}

export function searchPending(query: string, applied: string): boolean {
	return query.trim() !== applied;
}
