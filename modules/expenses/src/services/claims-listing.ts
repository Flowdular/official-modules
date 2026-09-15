import { createHash } from 'node:crypto';
import { decodeCursor, encodeCursor, HttpProblem } from '@flowdular/sdk/server';
import type {
	ExpenseClaimCategory,
	ExpenseClaimSort,
	ExpenseClaimSortDirection,
	ExpenseClaimStatus,
	ExpensesClaim,
} from '../domain/types.ts';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import type { ExpensesService } from './expenses-service.ts';
import type { ExpenseClaimKeyset } from './repository.ts';

/** The filters and order of one claims listing, as the query names them. */
export interface ClaimsListing {
	readonly status: ExpenseClaimStatus | null;
	readonly category: ExpenseClaimCategory | null;
	readonly search: string;
	readonly sort: ExpenseClaimSort;
	readonly direction: ExpenseClaimSortDirection;
}

export const DEFAULT_CLAIMS_LISTING: ClaimsListing = {
	status: null,
	category: null,
	search: '',
	sort: 'createdAt',
	direction: 'desc',
};

/** Who is reading: the tenant, the claimant and what they may see. */
export interface ClaimsReader {
	readonly accountId: string;
	readonly tenantId: string;
	readonly scopes: readonly string[];
}

export interface ClaimsPage {
	readonly items: readonly ExpensesClaim[];
	readonly nextCursor: string | null;
}

function cursorInvalid(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

/* The filters travel as a digest: a search term beside a status and a
   category would push the signed cursor toward its length bound. */
function filtersDigest(listing: ClaimsListing): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				listing.status ?? '',
				listing.category ?? '',
				listing.search.trim(),
			]),
		)
		.digest('hex')
		.slice(0, 32);
}

/* The cursor names the position and the listing it belongs to: the tenant,
   the sort, the direction and the filters. A cursor presented with any of them
   changed would splice two listings, so it is refused rather than reused. */
function cursorPayload(
	tenantId: string,
	listing: ClaimsListing,
	keyset: ExpenseClaimKeyset,
): Record<string, string | number> {
	return {
		t: tenantId,
		s: listing.sort,
		d: listing.direction,
		f: filtersDigest(listing),
		v: keyset.sortValue,
		id: keyset.id,
	};
}

export function keysetFromCursor(
	cursor: string,
	secret: Uint8Array,
	tenantId: string,
	listing: ClaimsListing,
): ExpenseClaimKeyset {
	const payload = decodeCursor(cursor, secret);
	const expected = cursorPayload(tenantId, listing, { sortValue: '', id: '' });
	for (const key of ['t', 's', 'd', 'f'] as const) {
		if (payload[key] !== expected[key]) throw cursorInvalid();
	}
	const sortValue = payload.v;
	const id = payload.id;
	if (typeof id !== 'string' || id === '') throw cursorInvalid();
	if (listing.sort === 'expenseDate') {
		if (typeof sortValue !== 'string') throw cursorInvalid();
	} else if (
		typeof sortValue !== 'number' ||
		!Number.isSafeInteger(sortValue)
	) {
		throw cursorInvalid();
	}
	return { sortValue, id };
}

/**
 * One page of the claims the reader may see, under the listing and the cursor
 * it presented. The list route and the list export both read through here, so
 * a file and a screen answer the same rows in the same order.
 */
export async function readClaimsPage(
	service: ExpensesService,
	secret: Uint8Array,
	reader: ClaimsReader,
	listing: ClaimsListing,
	limit: number,
	cursor: string | null,
): Promise<ClaimsPage> {
	const page = await service.page(
		reader.tenantId,
		reader.accountId,
		reader.scopes.includes(EXPENSES_PERMISSIONS.approve),
		{
			...listing,
			limit,
			after:
				cursor === null
					? null
					: keysetFromCursor(cursor, secret, reader.tenantId, listing),
		},
	);
	return {
		items: page.items,
		nextCursor: page.next
			? encodeCursor(cursorPayload(reader.tenantId, listing, page.next), secret)
			: null,
	};
}
