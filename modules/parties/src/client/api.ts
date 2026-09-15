import type {
	CreatePartyInput,
	Party,
	PartyBulkOutcome,
	PartyKind,
	PartyListSort,
	PartyStatus,
	UpdatePartyInput,
} from '../domain/types.ts';
import { t } from '@flowdular/sdk/client/i18n';
import type { HistoryPage } from '@flowdular/sdk/kernel';

interface ErrorEnvelope {
	readonly error?: { readonly code?: string; readonly message?: string };
}

export class ApiError extends Error {
	readonly status: number;
	/** Stable server code; '' when the response carried none. */
	readonly code: string;

	constructor(status: number, message: string, code = '') {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

async function payload<T>(response: Response): Promise<T> {
	const value = (await response.json()) as T & ErrorEnvelope;
	if (!response.ok) {
		throw new ApiError(
			response.status,
			value.error?.message ?? t('parties.error.request'),
			value.error?.code ?? '',
		);
	}
	return value;
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

export interface PartyListRequest {
	readonly sort: PartyListSort;
	readonly direction: 'asc' | 'desc';
	readonly limit: number;
	readonly kind: PartyKind | '';
	readonly status: PartyStatus | '';
	/** Matched in the name, contact and VAT id; '' narrows nothing. */
	readonly query: string;
	readonly hasVatId: boolean;
	/** The cursor that opens this page; null asks for the first one. */
	readonly cursor: string | null;
}

export interface PartyListPage {
	readonly items: readonly Party[];
	readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

/** One server-sorted, server-narrowed, server-paged listing; the screen narrows nothing. */
export async function loadParties(
	request: PartyListRequest,
): Promise<PartyListPage> {
	const parameters = new URLSearchParams({
		sort: request.sort,
		direction: request.direction,
		limit: String(request.limit),
	});
	if (request.kind !== '') parameters.set('kind', request.kind);
	if (request.status !== '') parameters.set('status', request.status);
	if (request.query !== '') parameters.set('q', request.query);
	if (request.hasVatId) parameters.set('hasVatId', 'true');
	if (request.cursor !== null) parameters.set('cursor', request.cursor);
	const response = await fetch('/api/parties?' + parameters.toString(), {
		headers: { accept: 'application/json' },
		credentials: 'same-origin',
	});
	return payload<PartyListPage>(response);
}

export async function createParty(
	input: CreatePartyInput,
	csrfToken: string,
): Promise<Party> {
	return (
		await post<{ readonly party: Party }>('/api/parties', input, csrfToken)
	).party;
}

export async function updateParty(
	input: UpdatePartyInput,
	csrfToken: string,
): Promise<Party> {
	return (
		await post<{ readonly party: Party }>(
			'/api/parties/update',
			input,
			csrfToken,
		)
	).party;
}

async function partyAction(
	action: 'archive' | 'restore',
	id: string,
	csrfToken: string,
): Promise<Party> {
	return (
		await post<{ readonly party: Party }>(
			'/api/parties/' + action,
			{ id },
			csrfToken,
		)
	).party;
}

export function archiveParty(id: string, csrfToken: string): Promise<Party> {
	return partyAction('archive', id, csrfToken);
}

export function restoreParty(id: string, csrfToken: string): Promise<Party> {
	return partyAction('restore', id, csrfToken);
}

type OutcomesResponse = { readonly outcomes: readonly PartyBulkOutcome[] };

/* The selected rows, one outcome per id. */
export async function archiveParties(
	ids: readonly string[],
	csrfToken: string,
): Promise<readonly PartyBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/parties/archive-many',
			{ ids },
			csrfToken,
		)
	).outcomes;
}

export async function restoreParties(
	ids: readonly string[],
	csrfToken: string,
): Promise<readonly PartyBulkOutcome[]> {
	return (
		await post<OutcomesResponse>(
			'/api/parties/restore-many',
			{ ids },
			csrfToken,
		)
	).outcomes;
}

export async function deleteParty(
	id: string,
	csrfToken: string,
): Promise<void> {
	await post<{ readonly deleted: true }>(
		'/api/parties/delete',
		{ id },
		csrfToken,
	);
}

/* exports.core owns the job, its file and the screen that hands it over; the
   party screens only start one. */
export async function startListExport(
	list: string,
	csrfToken: string,
): Promise<void> {
	await post<unknown>('/api/exports/start', { list }, csrfToken);
}

export async function loadPartyHistory(recordId: string): Promise<HistoryPage> {
	const response = await fetch(
		`/api/parties/history?recordId=${encodeURIComponent(recordId)}&limit=100`,
		{
			headers: { accept: 'application/json' },
			credentials: 'same-origin',
		},
	);
	return payload<HistoryPage>(response);
}
