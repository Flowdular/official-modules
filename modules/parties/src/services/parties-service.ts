import { randomUUID } from 'node:crypto';
import {
	normalizeActor,
	type Actor,
	type HistoryPage,
	type HistoryRequest,
} from '@flowdular/kernel';
import type {
	CreatePartyInput,
	Party,
	PartyKind,
	PatchPartyInput,
	UpdatePartyInput,
} from '../domain/types.ts';
import type { PartyRepository } from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyConflictError,
} from './target-idempotency.ts';

export interface PartyIdempotencyRequest {
	readonly key: string;
	readonly operationId: string;
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

	async list(tenantId: string): Promise<readonly Party[]> {
		return await this.repository.list(bounded(tenantId, 'tenantId', 1, 128));
	}

	async get(tenantId: string, id: string): Promise<Party | null> {
		const trustedId = bounded(id, 'id', 1, 128);
		return (
			(await this.list(tenantId)).find((party) => party.id === trustedId) ??
			null
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
		return {
			id: randomUUID(),
			tenantId: bounded(tenantId, 'tenantId', 1, 128),
			name: bounded(input.name, 'name', 2, 160),
			kind: partyKind(input.kind),
			email: emailAddress(input.email),
			phone: optional(input.phone, 'phone', 40),
			vatId: vatIdentifier(input.vatId),
			status: 'active',
			createdAt: Date.now(),
		};
	}
}
