import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type DataClassExportSink,
	type DataClassExportSummary,
	type HistoryPage,
	type HistoryRequest,
} from '@flowdular/sdk/kernel';
import {
	PARTY_LIST_SORTS,
	type CreatePartyInput,
	type Party,
	type PartyBulkOutcome,
	type PartyKind,
	type PartyListKeyset,
	type PartyListPage,
	type PartyListQuery,
	type PatchPartyInput,
	type UpdatePartyInput,
} from '../domain/types.ts';
import type { ExportCursor, PartyRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyConflictError,
} from './target-idempotency.ts';

export interface PartyIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
}

/** Rows one export read fetches; every class pages at this size. */
export const PARTY_EXPORT_PAGE = 200;

/** The most rows one list read answers, and the most ids one bulk action names. */
export const PARTY_PAGE_MAX_LIMIT = 200;
export const PARTY_BULK_LIMIT = 100;
export const PARTY_SEARCH_LENGTH = 120;

export const DEFAULT_PARTY_LIST_QUERY: PartyListQuery = {
	sort: 'name',
	direction: 'asc',
	kind: null,
	status: null,
	search: '',
	hasVatId: false,
};

export interface PartyListInput extends PartyListQuery {
	readonly limit: number;
	readonly after: PartyListKeyset | null;
}

/** Walks every row of one tenant in (time, id) order and writes each to the sink. */
async function exportPaged<T extends { readonly id: string }>(
	read: (after: ExportCursor | null) => Promise<readonly T[]>,
	at: (record: T) => number,
	sink: DataClassExportSink,
	toRow: (record: T) => Record<string, unknown>,
): Promise<DataClassExportSummary> {
	let cursor: ExportCursor | null = null;
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const page = await read(cursor);
		for (const record of page) {
			await sink.write(toRow(record));
			rows += 1;
			from ??= new Date(at(record));
			to = new Date(at(record));
		}
		if (page.length < PARTY_EXPORT_PAGE) break;
		const last = page[page.length - 1]!;
		cursor = { at: at(last), id: last.id };
	}
	return { rows, from, to };
}

export class PartyServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'PartyServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function optional(
	value: string | null | undefined,
	field: string,
	max: number,
) {
	if (value === undefined || value === null || value.trim() === '') return null;
	return bounded(value, field, 1, max);
}

function partyKind(value: PartyKind): PartyKind {
	if (value !== 'customer' && value !== 'supplier' && value !== 'both') {
		throw new PartyServiceError(
			'INVALID_PARTY_KIND',
			'kind must be customer, supplier, or both.',
		);
	}
	return value;
}

function emailAddress(value: string | null | undefined): string | null {
	const email = optional(value, 'email', 254);
	if (email && !email.includes('@')) {
		throw new PartyServiceError('INVALID_EMAIL', 'email must be valid.');
	}
	return email?.toLowerCase() ?? null;
}

function vatIdentifier(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.trim() === '') return null;
	const normalized = value.trim();
	if (normalized.length > 20 || !/^[A-Za-z0-9]+$/.test(normalized)) {
		throw new PartyServiceError(
			'INVALID_VAT_ID',
			'vatId must contain only letters and digits and be at most 20 characters.',
		);
	}
	return normalized;
}

function listQuery(input: PartyListQuery): PartyListQuery {
	if (!PARTY_LIST_SORTS.includes(input.sort)) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			`sort must be one of ${PARTY_LIST_SORTS.join(', ')}.`,
		);
	}
	if (input.direction !== 'asc' && input.direction !== 'desc') {
		throw new PartyServiceError(
			'INVALID_INPUT',
			'direction must be asc or desc.',
		);
	}
	if (
		input.status !== null &&
		input.status !== 'active' &&
		input.status !== 'archived'
	) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			'status must be active or archived.',
		);
	}
	const search = input.search.trim();
	if (search.length > PARTY_SEARCH_LENGTH) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			`search must contain at most ${PARTY_SEARCH_LENGTH} characters.`,
		);
	}
	return {
		sort: input.sort,
		direction: input.direction,
		kind: input.kind === null ? null : partyKind(input.kind),
		status: input.status,
		search,
		hasVatId: input.hasVatId === true,
	};
}

function trustedActor(actor: Actor): Actor {
	const normalized = normalizeActor(actor);
	if (!normalized) {
		throw new PartyServiceError(
			'INVALID_ACTOR',
			'actor must carry a kind, an id, and a label.',
		);
	}
	return normalized;
}

function patchInput(input: PatchPartyInput): PatchPartyInput {
	const fields = ['name', 'kind', 'email', 'phone', 'vatId'] as const;
	if (
		typeof input.id !== 'string' ||
		!fields.some((key) => input[key] !== undefined)
	) {
		throw new PartyServiceError(
			'INVALID_INPUT',
			'Supply a party id and at least one field to update.',
		);
	}
	for (const key of fields) {
		const value = input[key];
		if (value === undefined) continue;
		if (value === null && ['email', 'phone', 'vatId'].includes(key)) continue;
		if (typeof value !== 'string' || value.includes('\u0000')) {
			throw new PartyServiceError(
				'INVALID_INPUT',
				`${key} has an invalid value.`,
			);
		}
	}
	return {
		id: bounded(input.id, 'id', 1, 128),
		...(input.name !== undefined
			? { name: bounded(input.name, 'name', 2, 160) }
			: {}),
		...(input.kind !== undefined ? { kind: partyKind(input.kind) } : {}),
		...(input.email !== undefined ? { email: emailAddress(input.email) } : {}),
		...(input.phone !== undefined
			? { phone: optional(input.phone, 'phone', 40) }
			: {}),
		...(input.vatId !== undefined ? { vatId: vatIdentifier(input.vatId) } : {}),
	};
}

export class PartiesService {
	constructor(private readonly repository: PartyRepository) {}

	/* One keyset page in the order the query names. The keyset comes from the
	   previous page's answer; the endpoint binds it to the query in its cursor. */
	async list(tenantId: string, input: PartyListInput): Promise<PartyListPage> {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > PARTY_PAGE_MAX_LIMIT
		) {
			throw new PartyServiceError(
				'INVALID_INPUT',
				`limit must be an integer between 1 and ${PARTY_PAGE_MAX_LIMIT}.`,
			);
		}
		return await this.repository.list(
			bounded(tenantId, 'tenantId', 1, 128),
			listQuery(input),
			input.after,
			input.limit,
		);
	}

	async get(tenantId: string, id: string): Promise<Party | null> {
		return await this.repository.find(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
		);
	}

	async create(
		tenantId: string,
		input: CreatePartyInput,
		actor: Actor,
	): Promise<Party> {
		return await this.repository.create(
			this.newParty(tenantId, input),
			trustedActor(actor),
		);
	}

	async createIdempotent(
		tenantId: string,
		input: CreatePartyInput,
		actor: Actor,
		idempotency: PartyIdempotencyRequest,
	): Promise<Party> {
		const party = this.newParty(tenantId, input);
		try {
			return await this.repository.createIdempotent(
				party,
				trustedActor(actor),
				{
					key: bounded(idempotency.key, 'idempotencyKey', 8, 128),
					operationId: bounded(idempotency.operationId, 'operationId', 3, 160),
					inputDigest: canonicalDigest({
						name: party.name,
						kind: party.kind,
						email: party.email,
						phone: party.phone,
						vatId: party.vatId,
					}),
				},
			);
		} catch (error) {
			if (error instanceof TargetIdempotencyConflictError) {
				throw new PartyServiceError(error.code, error.message, 409);
			}
			throw error;
		}
	}

	async update(
		tenantId: string,
		input: UpdatePartyInput,
		actor: Actor,
	): Promise<Party> {
		const party = await this.repository.update(
			bounded(tenantId, 'tenantId', 1, 128),
			{
				id: bounded(input.id, 'id', 1, 128),
				name: bounded(input.name, 'name', 2, 160),
				kind: partyKind(input.kind),
				email: emailAddress(input.email),
				phone: optional(input.phone, 'phone', 40),
				vatId: vatIdentifier(input.vatId),
			},
			trustedActor(actor),
		);
		if (!party) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		return party;
	}

	async updateIdempotent(
		tenantId: string,
		input: PatchPartyInput,
		actor: Actor,
		idempotency: PartyIdempotencyRequest,
	): Promise<Party> {
		const patch = patchInput(input);
		try {
			const party = await this.repository.updateIdempotent(
				bounded(tenantId, 'tenantId', 1, 128),
				patch,
				trustedActor(actor),
				{
					key: bounded(idempotency.key, 'idempotencyKey', 8, 128),
					operationId: bounded(idempotency.operationId, 'operationId', 3, 160),
					inputDigest: canonicalDigest(patch),
				},
			);
			if (!party)
				throw new PartyServiceError(
					'PARTY_NOT_FOUND',
					'The party was not found in the active tenant.',
					404,
				);
			return party;
		} catch (error) {
			if (error instanceof TargetIdempotencyConflictError)
				throw new PartyServiceError(error.code, error.message, 409);
			throw error;
		}
	}

	async archive(tenantId: string, id: string, actor: Actor): Promise<Party> {
		return await this.changeStatus(tenantId, id, 'archived', actor);
	}

	async restore(tenantId: string, id: string, actor: Actor): Promise<Party> {
		return await this.changeStatus(tenantId, id, 'active', actor);
	}

	/* The bulk actions take the single-row path once per id, so every row keeps
	   its own history entry and its own refusal, and a missing or foreign id
	   costs nobody else. */
	archiveMany(
		tenantId: string,
		ids: readonly string[],
		actor: Actor,
	): Promise<readonly PartyBulkOutcome[]> {
		return this.each(ids, (id) => this.archive(tenantId, id, actor));
	}

	restoreMany(
		tenantId: string,
		ids: readonly string[],
		actor: Actor,
	): Promise<readonly PartyBulkOutcome[]> {
		return this.each(ids, (id) => this.restore(tenantId, id, actor));
	}

	async delete(tenantId: string, id: string, actor: Actor): Promise<void> {
		const trustedTenantId = bounded(tenantId, 'tenantId', 1, 128);
		const trustedId = bounded(id, 'id', 1, 128);
		const existing = await this.get(trustedTenantId, trustedId);
		if (!existing) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		if (existing.status !== 'archived') {
			throw new PartyServiceError(
				'PARTY_NOT_ARCHIVED',
				'Archive the party before deleting it permanently.',
				409,
			);
		}
		if (
			!(await this.repository.delete(
				trustedTenantId,
				trustedId,
				trustedActor(actor),
			))
		) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
	}

	async history(
		tenantId: string,
		request: HistoryRequest,
	): Promise<HistoryPage> {
		return await this.repository.history({
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			recordId: bounded(request.recordId, 'recordId', 1, 128),
			limit: request.limit,
			cursor: request.cursor,
		});
	}

	exportParties(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		return exportPaged(
			(after) =>
				this.repository.listForExport(tenant, after, PARTY_EXPORT_PAGE),
			(party) => party.createdAt,
			sink,
			(party) => ({
				id: party.id,
				name: party.name,
				kind: party.kind,
				email: party.email,
				phone: party.phone,
				vatId: party.vatId,
				status: party.status,
				createdAt: new Date(party.createdAt).toISOString(),
			}),
		);
	}

	exportHistory(
		tenantId: string,
		sink: DataClassExportSink,
	): Promise<DataClassExportSummary> {
		const tenant = bounded(tenantId, 'tenantId', 1, 128);
		return exportPaged(
			(after) =>
				this.repository.listHistoryForExport(tenant, after, PARTY_EXPORT_PAGE),
			(entry) => entry.occurredAt,
			sink,
			(entry) => ({
				id: entry.id,
				recordId: entry.recordId,
				version: entry.version,
				action: entry.action,
				actorKind: entry.actorKind,
				actorId: entry.actorId,
				actorLabel: entry.actorLabel,
				runId: entry.runId,
				configuredBy: entry.configuredByJson,
				changes: entry.changesJson,
				occurredAt: new Date(entry.occurredAt).toISOString(),
			}),
		);
	}

	private async each(
		ids: readonly string[],
		write: (id: string) => Promise<unknown>,
	): Promise<readonly PartyBulkOutcome[]> {
		if (ids.length < 1 || ids.length > PARTY_BULK_LIMIT) {
			throw new PartyServiceError(
				'INVALID_INPUT',
				`ids must name between 1 and ${PARTY_BULK_LIMIT} parties.`,
			);
		}
		const outcomes: PartyBulkOutcome[] = [];
		for (const id of ids) {
			try {
				await write(id);
				outcomes.push({ id, outcome: 'updated' });
			} catch (error) {
				if (!(error instanceof PartyServiceError)) throw error;
				outcomes.push(
					error.code === 'PARTY_NOT_FOUND'
						? { id, outcome: 'not-found' }
						: { id, outcome: 'refused', reason: error.code },
				);
			}
		}
		return outcomes;
	}

	private async changeStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Promise<Party> {
		const party = await this.repository.setStatus(
			bounded(tenantId, 'tenantId', 1, 128),
			bounded(id, 'id', 1, 128),
			status,
			trustedActor(actor),
		);
		if (!party) {
			throw new PartyServiceError(
				'PARTY_NOT_FOUND',
				'The party was not found in the active tenant.',
				404,
			);
		}
		return party;
	}

	private newParty(tenantId: string, input: CreatePartyInput): Party {
		const now = Date.now();
		return {
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			name: bounded(input.name, 'name', 2, 160),
			kind: partyKind(input.kind),
			email: emailAddress(input.email),
			phone: optional(input.phone, 'phone', 40),
			vatId: vatIdentifier(input.vatId),
			status: 'active',
			createdAt: now,
			updatedAt: now,
		};
	}
}
