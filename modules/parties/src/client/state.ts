import { cell, createStore } from 'segment-state';
import type { HistoryEntry } from '@flowdular/sdk/kernel';
import type { TableSort } from '@flowdular/sdk/ui';
import type {
	Party,
	PartyBulkOutcome,
	PartyListSort,
	PartyStatus,
} from '../domain/types.ts';
import type { PartyListPage } from './api.ts';

export type PartiesStatus =
	| 'idle'
	| 'loading'
	| 'submitting'
	| 'denied'
	| 'error';

export type PartyStatusFilter = '' | PartyStatus;

export const DEFAULT_PARTY_SORTING: readonly TableSort[] = [
	{ key: 'name', desc: false },
];

/**
 * The cursor that opened each page the reader has visited: page 0 has none,
 * and page n holds the cursor page n - 1 answered. Going back reuses the stored
 * cursor; a page past the stack cannot be opened.
 */
export type PageCursors = readonly (string | null)[];

/** One listing as the server answers it: the page, its order and its filters. */
export interface Listing {
	readonly pageIndex: number;
	readonly pageSize: number;
	readonly sorting: readonly TableSort[];
	readonly query: string;
	readonly status: PartyStatusFilter;
	readonly hasVatId: boolean;
	readonly cursors: PageCursors;
}

export function createPartiesClientState() {
	const store = createStore({
		parties: cell<readonly Party[]>([]),
		query: '',
		/** The term the rows on screen answer; typing moves `query` ahead of it. */
		appliedQuery: '',
		hasVatId: false,
		/** Archived rows are hidden until the reader asks for them. */
		statusFilter: cell<PartyStatusFilter>('active'),
		sorting: cell<readonly TableSort[]>(DEFAULT_PARTY_SORTING),
		pageIndex: 0,
		pageSize: 50,
		cursors: cell<PageCursors>([null]),
		nextCursor: cell<string | null>(null),
		filtersOpen: false,
		selectedIds: cell<ReadonlySet<string>>(new Set()),
		confirmArchiveMany: false,
		formOpen: false,
		deleteConfirmOpen: false,
		editingParty: cell<Party | null>(null),
		historyOpen: false,
		historyParty: cell<Party | null>(null),
		historyEntries: cell<readonly HistoryEntry[]>([]),
		historyLoading: false,
		historyError: '',
		status: cell<PartiesStatus>('idle'),
		error: '',
		formSession: 0,
		exportStarted: false,
	});
	return { store, state: store.state };
}

/** The server's sort key and direction behind the table's sorting state. */
export function partySort(sorts: readonly TableSort[]): {
	readonly sort: PartyListSort;
	readonly direction: 'asc' | 'desc';
} {
	const first = sorts[0] ?? DEFAULT_PARTY_SORTING[0]!;
	return {
		sort: first.key === 'updatedAt' ? 'updatedAt' : 'name',
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
 * listing, on a page, sort or filter change as much as on a refresh, because a
 * selected id names a row the reader saw on the page that is being replaced.
 */
export function loadedListing(
	next: Listing,
	page: PartyListPage,
): {
	readonly parties: readonly Party[];
	readonly appliedQuery: string;
	readonly pageIndex: number;
	readonly cursors: PageCursors;
	readonly nextCursor: string | null;
	readonly selectedIds: ReadonlySet<string>;
} {
	return {
		parties: page.items,
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

/** The selected rows on screen a lifecycle action may change: only those in the other status. */
export function bulkTargets(
	parties: readonly Party[],
	selected: ReadonlySet<string>,
	status: PartyStatus,
): readonly string[] {
	return parties
		.filter((party) => selected.has(party.id) && party.status === status)
		.map((party) => party.id);
}

/** How many ids each outcome covered, for the toast after a bulk action. */
export function bulkOutcomeCounts(outcomes: readonly PartyBulkOutcome[]): {
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
