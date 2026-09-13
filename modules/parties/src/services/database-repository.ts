import { randomUUID } from 'node:crypto';
import type {
	DatabaseHandle,
	DatabaseTransaction,
} from '@flowdular/sdk/database';
import {
	appendRecordHistory,
	queryRecordHistory,
	runDatabaseMigrations,
} from '@flowdular/sdk/database';
import {
	diffFields,
	type Actor,
	type HistoryPage,
	type HistoryQuery,
	type TrackedFields,
} from '@flowdular/sdk/kernel';
import type {
	Party,
	PatchPartyInput,
	UpdatePartyInput,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ExportCursor,
	PartyHistoryExportRow,
	PartyRepository,
} from './repository.ts';
import {
	canonicalDigest,
	TargetIdempotencyCorruptionError,
	TargetIdempotencyConflictError,
	type TargetIdempotencyEntry,
	type TargetIdempotencyRequest,
} from './target-idempotency.ts';

const HISTORY_TABLE = 'parties_history_v2';

const COLUMNS = `id, tenant_id, name, kind, email, phone, vat_id, status, created_at`;

/* Queries stay explicit. Party data never passes through a SQL rewriter, and
   values always use the adapter's parameter channel. */
const LIST = `SELECT ${COLUMNS} FROM parties WHERE tenant_id = $1
		 ORDER BY lower(name), id`;

const FIND = `SELECT ${COLUMNS} FROM parties WHERE tenant_id = $1 AND id = $2`;

const INSERT = `INSERT INTO parties
		 (id, tenant_id, name, kind, email, phone, vat_id, status, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

const UPDATE = `UPDATE parties
		 SET name = $1, kind = $2, email = $3, phone = $4, vat_id = $5
		 WHERE tenant_id = $6 AND id = $7
		 RETURNING ${COLUMNS}`;

const SET_STATUS = `UPDATE parties SET status = $1 WHERE tenant_id = $2 AND id = $3
		 RETURNING ${COLUMNS}`;

const DELETE = 'DELETE FROM parties WHERE tenant_id = $1 AND id = $2';

/* Export pages walk (time, id) so a page boundary never repeats or skips a
   row while the workspace keeps writing. */
const LIST_FOR_EXPORT = `SELECT ${COLUMNS} FROM parties
		 WHERE tenant_id = $1
		   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
		 ORDER BY created_at, id
		 LIMIT $4`;

const LIST_HISTORY_FOR_EXPORT = `SELECT id, record_id, version, action, actor_kind,
		   actor_id, actor_label, run_id, configured_by_json, changes_json, occurred_at
		 FROM ${HISTORY_TABLE}
		 WHERE tenant_id = $1
		   AND ($2::bigint IS NULL OR (occurred_at, id) > ($2::bigint, $3::text))
		 ORDER BY occurred_at, id
		 LIMIT $4`;

const FIND_IDEMPOTENCY = `SELECT operation_id, input_digest, result_json, result_digest
		 FROM parties_idempotency_ledger
		 WHERE tenant_id = $1 AND idempotency_key = $2`;

const RECORD_IDEMPOTENCY = `INSERT INTO parties_idempotency_ledger
		 (id, tenant_id, idempotency_key, operation_id, input_digest,
		  outcome, result_json, result_digest, created_at)
		 VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8)`;

interface PartyRow {
	id: string;
	tenant_id: string;
	name: string;
	kind: Party['kind'];
	email: string | null;
	phone: string | null;
	vat_id: string | null;
	status: Party['status'];
	created_at: number | bigint | string;
}

interface IdempotencyRow {
	operation_id: string;
	input_digest: string;
	result_json: string;
	result_digest: string;
}

interface HistoryExportRow {
	id: string;
	record_id: string;
	version: number | bigint | string;
	action: string;
	actor_kind: string;
	actor_id: string;
	actor_label: string;
	run_id: string | null;
	configured_by_json: string | null;
	changes_json: string;
	occurred_at: number | bigint | string;
}

/* PostgreSQL returns BIGINT as a string, so every numeric read is normalized
   before it reaches the domain. */
function integer(value: PartyRow['created_at']): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error('The parties database returned an invalid timestamp.');
	}
	return normalized;
}

function fromRow(row: PartyRow): Party {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		name: row.name,
		kind: row.kind,
		email: row.email,
		phone: row.phone,
		vatId: row.vat_id,
		status: row.status,
		createdAt: integer(row.created_at),
	};
}

/* The fields a history version reports on. Identity, tenancy, and creation
   time are not changeable and are never part of a diff. */
function tracked(party: Party): TrackedFields {
	return {
		name: party.name,
		kind: party.kind,
		email: party.email,
		phone: party.phone,
		vatId: party.vatId,
		status: party.status,
	};
}

export async function migratePartiesDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'parties.core', databaseMigrations);
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabasePartyRepository implements PartyRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	async list(tenantId: string): Promise<readonly Party[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<PartyRow>({
					text: LIST,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async create(party: Party, actor: Actor): Promise<Party> {
		await this.readyPromise;
		return this.database.transaction(
			(transaction) => this.#insert(transaction, party, actor),
			{ access: 'write', tenantId: party.tenantId },
		);
	}

	async createIdempotent(
		party: Party,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<Party> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const existing = await this.#idempotencyEntry(
					transaction,
					party.tenantId,
					idempotency.key,
				);
				if (existing) {
					if (
						existing.operationId !== idempotency.operationId ||
						existing.inputDigest !== idempotency.inputDigest
					) {
						throw new TargetIdempotencyConflictError();
					}
					return this.#result(existing, party.tenantId);
				}

				const created = await this.#insert(transaction, party, actor);
				await transaction.execute({
					text: RECORD_IDEMPOTENCY,
					parameters: [
						randomUUID(),
						party.tenantId,
						idempotency.key,
						idempotency.operationId,
						idempotency.inputDigest,
						JSON.stringify(created),
						canonicalDigest(created),
						Date.now(),
					],
				});
				return created;
			},
			{ access: 'write', tenantId: party.tenantId },
		);
	}

	async update(
		tenantId: string,
		input: UpdatePartyInput,
		actor: Actor,
	): Promise<Party | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, tenantId, input.id);
				if (!before) return null;
				const result = await transaction.query<PartyRow>({
					text: UPDATE,
					parameters: [
						input.name,
						input.kind,
						input.email ?? null,
						input.phone ?? null,
						input.vatId ?? null,
						tenantId,
						input.id,
					],
				});
				const row = result.rows[0];
				if (!row) return null;
				const after = fromRow(row);
				const changes = diffFields(tracked(before), tracked(after));
				if (Object.keys(changes).length > 0) {
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId,
						recordId: after.id,
						action: 'updated',
						actor,
						changes,
						occurredAt: Date.now(),
					});
				}
				return after;
			},
			{ access: 'write', tenantId },
		);
	}

	async updateIdempotent(
		tenantId: string,
		input: PatchPartyInput,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<Party | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const existing = await this.#idempotencyEntry(
					transaction,
					tenantId,
					idempotency.key,
				);
				if (existing) {
					if (
						existing.operationId !== idempotency.operationId ||
						existing.inputDigest !== idempotency.inputDigest
					)
						throw new TargetIdempotencyConflictError();
					return this.#result(existing, tenantId);
				}
				const locked = await transaction.query<PartyRow>({
					text: FIND + ' FOR UPDATE',
					parameters: [tenantId, input.id],
				});
				if (!locked.rows[0]) return null;
				const before = fromRow(locked.rows[0]);
				const changes = Object.fromEntries(
					Object.entries(input).filter(([, value]) => value !== undefined),
				);
				const next = { ...before, ...changes } as Party;
				const result = await transaction.query<PartyRow>({
					text: UPDATE,
					parameters: [
						next.name,
						next.kind,
						next.email,
						next.phone,
						next.vatId,
						tenantId,
						input.id,
					],
				});
				const after = fromRow(result.rows[0]!);
				const diff = diffFields(tracked(before), tracked(after));
				if (Object.keys(diff).length)
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId,
						recordId: after.id,
						action: 'updated',
						actor,
						changes: diff,
						occurredAt: Date.now(),
					});
				await transaction.execute({
					text: RECORD_IDEMPOTENCY,
					parameters: [
						randomUUID(),
						tenantId,
						idempotency.key,
						idempotency.operationId,
						idempotency.inputDigest,
						JSON.stringify(after),
						canonicalDigest(after),
						Date.now(),
					],
				});
				return after;
			},
			{ access: 'write', tenantId },
		);
	}

	async setStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Promise<Party | null> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, tenantId, id);
				if (!before) return null;
				const result = await transaction.query<PartyRow>({
					text: SET_STATUS,
					parameters: [status, tenantId, id],
				});
				const row = result.rows[0];
				if (!row) return null;
				const after = fromRow(row);
				if (before.status !== after.status) {
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId,
						recordId: id,
						action: status === 'archived' ? 'archived' : 'restored',
						actor,
						changes: diffFields(tracked(before), tracked(after)),
						occurredAt: Date.now(),
					});
				}
				return after;
			},
			{ access: 'write', tenantId },
		);
	}

	async delete(tenantId: string, id: string, actor: Actor): Promise<boolean> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#find(transaction, tenantId, id);
				if (!before) return false;
				await appendRecordHistory(transaction, HISTORY_TABLE, {
					tenantId,
					recordId: id,
					action: 'deleted',
					actor,
					changes: diffFields(tracked(before), {
						name: null,
						kind: null,
						email: null,
						phone: null,
						vatId: null,
						status: null,
					}),
					occurredAt: Date.now(),
				});
				const result = await transaction.execute({
					text: DELETE,
					parameters: [tenantId, id],
				});
				return result.affectedRows === 1;
			},
			{ access: 'write', tenantId },
		);
	}

	async history(query: HistoryQuery): Promise<HistoryPage> {
		await this.readyPromise;
		return this.database.transaction(
			(transaction) => queryRecordHistory(transaction, HISTORY_TABLE, query),
			{ access: 'read', tenantId: query.tenantId },
		);
	}

	async listForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly Party[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<PartyRow>({
					text: LIST_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async listHistoryForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly PartyHistoryExportRow[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<HistoryExportRow>({
					text: LIST_HISTORY_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map((row) => ({
			id: row.id,
			recordId: row.record_id,
			version: integer(row.version),
			action: row.action,
			actorKind: row.actor_kind,
			actorId: row.actor_id,
			actorLabel: row.actor_label,
			runId: row.run_id,
			configuredByJson: row.configured_by_json,
			changesJson: row.changes_json,
			occurredAt: integer(row.occurred_at),
		}));
	}

	async #find(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
	): Promise<Party | null> {
		const result = await transaction.query<PartyRow>({
			text: FIND,
			parameters: [tenantId, id],
		});
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async #insert(
		transaction: DatabaseTransaction,
		party: Party,
		actor: Actor,
	): Promise<Party> {
		await transaction.execute({
			text: INSERT,
			parameters: [
				party.id,
				party.tenantId,
				party.name,
				party.kind,
				party.email,
				party.phone,
				party.vatId,
				party.status,
				party.createdAt,
			],
		});
		await appendRecordHistory(transaction, HISTORY_TABLE, {
			tenantId: party.tenantId,
			recordId: party.id,
			action: 'created',
			actor,
			changes: diffFields(null, tracked(party)),
			occurredAt: party.createdAt,
		});
		return party;
	}

	async #idempotencyEntry(
		transaction: DatabaseTransaction,
		tenantId: string,
		key: string,
	): Promise<TargetIdempotencyEntry | null> {
		// Serialize replay checks across create/update, including an absent key.
		await transaction.query({
			text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
			parameters: [JSON.stringify(['parties.core.idempotency', tenantId, key])],
		});
		const result = await transaction.query<IdempotencyRow>({
			text: FIND_IDEMPOTENCY,
			parameters: [tenantId, key],
		});
		const row = result.rows[0];
		return row
			? {
					operationId: row.operation_id,
					inputDigest: row.input_digest,
					resultJson: row.result_json,
					resultDigest: row.result_digest,
				}
			: null;
	}

	#result(entry: TargetIdempotencyEntry, tenantId: string): Party {
		let result: Party;
		try {
			result = JSON.parse(entry.resultJson) as Party;
		} catch {
			throw new TargetIdempotencyCorruptionError();
		}
		if (
			result.tenantId !== tenantId ||
			canonicalDigest(result) !== entry.resultDigest
		) {
			throw new TargetIdempotencyCorruptionError();
		}
		return result;
	}
}
