import { createHash, randomBytes } from 'node:crypto';
import { decodeCursor, encodeCursor, HttpProblem } from '@flowdular/sdk/server';
import {
	PARTY_LIST_SORTS,
	type Party,
	type PartyKind,
	type PartyListKeyset,
	type PartyListQuery,
	type PartyListSort,
} from '../domain/types.ts';
import type { PartiesRuntime } from '../server/runtime.ts';
import { PARTY_SEARCH_LENGTH } from '../services/parties-service.ts';

/** The default page of the party screens. */
export const PARTY_PAGE_LIMIT = 50;

export interface PartyListPageView {
	readonly items: readonly Party[];
	readonly nextCursor: string | null;
}

/**
 * One page of the party list under a signed cursor. The list endpoint and the
 * list export share it, so both walk the same order, the same keyset and the
 * same tenant predicate with one secret.
 */
export interface PartyListing {
	page(
		tenantId: string,
		query: PartyListQuery,
		cursor: string | null,
		limit: number,
	): Promise<PartyListPageView>;
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function cursorInvalid(): HttpProblem {
	return new HttpProblem(
		'CURSOR_INVALID',
		'The page cursor is not valid.',
		400,
	);
}

/** The order and the filters of a list request, validated at the boundary. */
export function partyListQuery(url: URL): PartyListQuery {
	const sort = url.searchParams.get('sort') ?? 'name';
	if (!(PARTY_LIST_SORTS as readonly string[]).includes(sort)) {
		throw invalid(`sort must be one of ${PARTY_LIST_SORTS.join(', ')}.`);
	}
	const direction = url.searchParams.get('direction') ?? 'asc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw invalid('direction must be asc or desc.');
	}
	const kind = url.searchParams.get('kind') ?? '';
	if (
		kind !== '' &&
		kind !== 'customer' &&
		kind !== 'supplier' &&
		kind !== 'both'
	) {
		throw invalid('kind must be customer, supplier, or both.');
	}
	const status = url.searchParams.get('status') ?? '';
	if (status !== '' && status !== 'active' && status !== 'archived') {
		throw invalid('status must be active or archived.');
	}
	const search = url.searchParams.get('q') ?? '';
	if (search.length > PARTY_SEARCH_LENGTH) {
		throw invalid(`q must contain at most ${PARTY_SEARCH_LENGTH} characters.`);
	}
	const hasVatId = url.searchParams.get('hasVatId') ?? '';
	if (hasVatId !== '' && hasVatId !== 'true' && hasVatId !== 'false') {
		throw invalid('hasVatId must be true or false.');
	}
	return {
		sort: sort as PartyListSort,
		direction,
		kind: kind === '' ? null : (kind as PartyKind),
		status: status === '' ? null : status,
		search: search.trim(),
		hasVatId: hasVatId === 'true',
	};
}

/* The filters travel as a digest: a full-length term beside the keyset would
   push the signed cursor toward its length bound. */
function filtersDigest(query: PartyListQuery): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				query.kind ?? '',
				query.status ?? '',
				query.search,
				query.hasVatId,
			]),
		)
		.digest('hex')
		.slice(0, 32);
}

/* The cursor names the position and the listing it belongs to: the workspace,
   the sort, the direction and the filters. Presented with any of them changed
   it would splice two listings, so it is refused rather than reused. */
function cursorPayload(
	tenantId: string,
	query: PartyListQuery,
	keyset: PartyListKeyset,
): Record<string, string | number> {
	return {
		t: tenantId,
		s: query.sort,
		d: query.direction,
		f: filtersDigest(query),
		v: keyset.sortValue,
		id: keyset.id,
	};
}

function keysetFromCursor(
	cursor: string,
	secret: Uint8Array,
	tenantId: string,
	query: PartyListQuery,
): PartyListKeyset {
	const payload = decodeCursor(cursor, secret);
	const expected = cursorPayload(tenantId, query, { sortValue: '', id: '' });
	for (const key of ['t', 's', 'd', 'f'] as const) {
		if (payload[key] !== expected[key]) throw cursorInvalid();
	}
	const sortValue = payload.v;
	const id = payload.id;
	if (typeof id !== 'string' || id === '') throw cursorInvalid();
	if (query.sort === 'name') {
		if (typeof sortValue !== 'string') throw cursorInvalid();
	} else if (
		typeof sortValue !== 'number' ||
		!Number.isSafeInteger(sortValue)
	) {
		throw cursorInvalid();
	}
	return { sortValue, id };
}

export function createPartyListing(runtime: PartiesRuntime): PartyListing {
	/* Module-owned and never stored: a cursor names a position in one
	   workspace's own list, so a restart invalidating one costs a client the
	   first page. */
	const secret = randomBytes(32);
	return {
		async page(tenantId, query, cursor, limit) {
			const after = cursor
				? keysetFromCursor(cursor, secret, tenantId, query)
				: null;
			const result = await (
				await runtime.service()
			).list(tenantId, { ...query, limit, after });
			return {
				items: result.parties,
				nextCursor: result.next
					? encodeCursor(cursorPayload(tenantId, query, result.next), secret)
					: null,
			};
		},
	};
}
