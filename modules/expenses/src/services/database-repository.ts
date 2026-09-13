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
	type RecordChanges,
	type TrackedFields,
} from '@flowdular/sdk/kernel';
import type {
	ExpenseClaimHistoryAction,
	ExpensesClaim,
} from '../domain/types.ts';
import { databaseMigrations } from './migration.ts';
import type {
	ExpenseClaimHistoryExport,
	ExpenseClaimListQuery,
	ExpensesExportCursor,
	ExpensesRepository,
} from './repository.ts';

const HISTORY_TABLE = 'expenses_claims_history';

interface ExpensesClaimRow {
	id: string;
	tenant_id: string;
	claimant_id: string;
	title: string;
	amount_minor: number | bigint | string;
	currency: string;
	category: ExpensesClaim['category'];
	expense_date: string;
	note: string | null;
	note_template: string | null;
	status: ExpensesClaim['status'];
	decision_comment: string | null;
	created_at: number | bigint | string;
}

interface ExpensesHistoryRow {
	id: string;
	record_id: string;
	version: number | bigint | string;
	action: string;
	actor_kind: string;
	actor_id: string;
	actor_label: string;
	run_id: string | null;
	changes_json: string;
	occurred_at: number | bigint | string;
}

/* PostgreSQL returns BIGINT as a string. Every integer read crosses this
   instead of trusting the driver's representation. */
function integer(value: number | bigint | string, field: string): number {
	const normalized = Number(value);
	if (!Number.isSafeInteger(normalized)) {
		throw new Error(`The expenses database returned an invalid ${field}.`);
	}
	return normalized;
}

function fromRow(row: ExpensesClaimRow): ExpensesClaim {
	return {
		id: row.id,
		tenantId: row.tenant_id,
		claimantId: row.claimant_id,
		title: row.title,
		name: row.title,
		amountMinor: integer(row.amount_minor, 'amount'),
		currency: row.currency,
		category: row.category,
		expenseDate: row.expense_date,
		note: row.note,
		noteTemplate: row.note_template ?? row.note,
		status: row.status,
		decisionComment: row.decision_comment,
		createdAt: integer(row.created_at, 'timestamp'),
	};
}

/* The fields a history version reports on. The decision comment is part of the
   claim and is recorded; identity, tenancy, claimant, and creation time cannot
   change and are never part of a diff. */
function tracked(claim: ExpensesClaim): TrackedFields {
	return {
		title: claim.title,
		amountMinor: claim.amountMinor,
		currency: claim.currency,
		category: claim.category,
		expenseDate: claim.expenseDate,
		note: claim.note,
		noteTemplate: claim.noteTemplate,
		status: claim.status,
		decisionComment: claim.decisionComment,
	};
}

const CLAIM_COLUMNS = `id, tenant_id, claimant_id, title, amount_minor, currency,
	 category, expense_date, note, note_template, status, decision_comment, created_at`;

/* SQL stays explicit. Nothing here is rewritten between placeholder styles, and
   every value travels in the adapter's parameter channel. */
const LIST_BY_STATUS_FOR_TENANT = `SELECT ${CLAIM_COLUMNS} FROM expenses_claims
	 WHERE tenant_id = $1 AND status = $2
	 ORDER BY expense_date DESC, id`;

const LIST_BY_CLAIMANT_AND_STATUS = `SELECT ${CLAIM_COLUMNS} FROM expenses_claims
	 WHERE tenant_id = $1 AND claimant_id = $2 AND status = $3
	 ORDER BY expense_date DESC, id`;

const LIST_BY_CLAIMANT = `SELECT ${CLAIM_COLUMNS} FROM expenses_claims
	 WHERE tenant_id = $1 AND claimant_id = $2
	 ORDER BY expense_date DESC, id`;

const FIND = `SELECT ${CLAIM_COLUMNS} FROM expenses_claims
	 WHERE tenant_id = $1 AND id = $2`;

const INSERT = `INSERT INTO expenses_claims
	 (id, tenant_id, claimant_id, title, amount_minor, currency,
	  category, expense_date, note, note_template, status, decision_comment, created_at)
	 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

const UPDATE = `UPDATE expenses_claims SET title = $1, amount_minor = $2, currency = $3,
	 category = $4, expense_date = $5, note = $6, note_template = $7, status = $8,
	 decision_comment = $9 WHERE tenant_id = $10 AND id = $11`;

const DELETE = 'DELETE FROM expenses_claims WHERE tenant_id = $1 AND id = $2';

const COUNT_AWAITING_APPROVAL = `SELECT COUNT(*) AS count FROM expenses_claims
	 WHERE tenant_id = $1 AND status = 'submitted'`;

const LIST_FOR_EXPORT = `SELECT ${CLAIM_COLUMNS} FROM expenses_claims
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (created_at, id) > ($2::bigint, $3::text))
	 ORDER BY created_at, id
	 LIMIT $4`;

const LIST_HISTORY_FOR_EXPORT = `SELECT id, record_id, version, action, actor_kind,
	 actor_id, actor_label, run_id, changes_json, occurred_at
	 FROM expenses_claims_history
	 WHERE tenant_id = $1
	   AND ($2::bigint IS NULL OR (occurred_at, id) > ($2::bigint, $3::text))
	 ORDER BY occurred_at, id
	 LIMIT $4`;

function historyFromRow(row: ExpensesHistoryRow): ExpenseClaimHistoryExport {
	return {
		id: row.id,
		recordId: row.record_id,
		version: integer(row.version, 'version'),
		action: row.action,
		actorKind: row.actor_kind,
		actorId: row.actor_id,
		actorLabel: row.actor_label,
		runId: row.run_id,
		changes: JSON.parse(row.changes_json) as RecordChanges,
		occurredAt: integer(row.occurred_at, 'timestamp'),
	};
}

export async function migrateExpensesDatabase(
	database: DatabaseHandle,
): Promise<void> {
	await runDatabaseMigrations(database, 'expenses.core', databaseMigrations);
}

/** A repository over a platform-owned PostgreSQL handle. */
export class DatabaseExpensesRepository implements ExpensesRepository {
	constructor(
		private readonly database: DatabaseHandle,
		private readonly readyPromise: Promise<void> = Promise.resolve(),
	) {}

	async list(query: ExpenseClaimListQuery): Promise<readonly ExpensesClaim[]> {
		await this.readyPromise;
		const statement =
			query.includeApprovalQueue && query.status === 'submitted'
				? {
						text: LIST_BY_STATUS_FOR_TENANT,
						parameters: [query.tenantId, query.status],
					}
				: query.status !== null
					? {
							text: LIST_BY_CLAIMANT_AND_STATUS,
							parameters: [query.tenantId, query.claimantId, query.status],
						}
					: {
							text: LIST_BY_CLAIMANT,
							parameters: [query.tenantId, query.claimantId],
						};
		const result = await this.database.transaction(
			(transaction) => transaction.query<ExpensesClaimRow>(statement),
			{ access: 'read', tenantId: query.tenantId },
		);
		return result.rows.map(fromRow);
	}

	async find(tenantId: string, id: string): Promise<ExpensesClaim | null> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ExpensesClaimRow>({
					text: FIND,
					parameters: [tenantId, id],
				}),
			{ access: 'read', tenantId },
		);
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}

	async create(record: ExpensesClaim, actor: Actor): Promise<ExpensesClaim> {
		await this.readyPromise;
		/* The claim and its history version commit together, or the trail could
		   disagree with the record it describes. */
		await this.database.transaction(
			async (transaction) => {
				await transaction.execute({
					text: INSERT,
					parameters: [
						record.id,
						record.tenantId,
						record.claimantId,
						record.title,
						record.amountMinor,
						record.currency,
						record.category,
						record.expenseDate,
						record.note,
						record.noteTemplate,
						record.status,
						record.decisionComment,
						record.createdAt,
					],
				});
				await appendRecordHistory(transaction, HISTORY_TABLE, {
					tenantId: record.tenantId,
					recordId: record.id,
					action: 'created',
					actor,
					changes: diffFields(null, tracked(record)),
					occurredAt: record.createdAt,
				});
			},
			{ access: 'write', tenantId: record.tenantId },
		);
		return record;
	}

	async update(
		record: ExpensesClaim,
		action: ExpenseClaimHistoryAction,
		actor: Actor,
	): Promise<ExpensesClaim> {
		await this.readyPromise;
		await this.database.transaction(
			async (transaction) => {
				const before = await this.#findIn(
					transaction,
					record.tenantId,
					record.id,
				);
				await transaction.execute({
					text: UPDATE,
					parameters: [
						record.title,
						record.amountMinor,
						record.currency,
						record.category,
						record.expenseDate,
						record.note,
						record.noteTemplate,
						record.status,
						record.decisionComment,
						record.tenantId,
						record.id,
					],
				});
				const changes = before
					? diffFields(tracked(before), tracked(record))
					: {};
				if (Object.keys(changes).length > 0) {
					await appendRecordHistory(transaction, HISTORY_TABLE, {
						tenantId: record.tenantId,
						recordId: record.id,
						action,
						actor,
						changes,
						occurredAt: Date.now(),
					});
				}
			},
			{ access: 'write', tenantId: record.tenantId },
		);
		return record;
	}

	async delete(tenantId: string, id: string, actor: Actor): Promise<boolean> {
		await this.readyPromise;
		return this.database.transaction(
			async (transaction) => {
				const before = await this.#findIn(transaction, tenantId, id);
				if (!before) return false;
				await appendRecordHistory(transaction, HISTORY_TABLE, {
					tenantId,
					recordId: id,
					action: 'deleted',
					actor,
					changes: diffFields(tracked(before), {
						title: null,
						amountMinor: null,
						currency: null,
						category: null,
						expenseDate: null,
						note: null,
						noteTemplate: null,
						status: null,
						decisionComment: null,
					}),
					occurredAt: Date.now(),
				});
				await transaction.execute({
					text: DELETE,
					parameters: [tenantId, id],
				});
				return true;
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

	async countAwaitingApproval(tenantId: string): Promise<number> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<{ count: number | bigint | string }>({
					text: COUNT_AWAITING_APPROVAL,
					parameters: [tenantId],
				}),
			{ access: 'read', tenantId },
		);
		return integer(result.rows[0]?.count ?? 0, 'count');
	}

	async listForExport(
		tenantId: string,
		after: ExpensesExportCursor | null,
		limit: number,
	): Promise<readonly ExpensesClaim[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ExpensesClaimRow>({
					text: LIST_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(fromRow);
	}

	async listHistoryForExport(
		tenantId: string,
		after: ExpensesExportCursor | null,
		limit: number,
	): Promise<readonly ExpenseClaimHistoryExport[]> {
		await this.readyPromise;
		const result = await this.database.transaction(
			(transaction) =>
				transaction.query<ExpensesHistoryRow>({
					text: LIST_HISTORY_FOR_EXPORT,
					parameters: [tenantId, after?.at ?? null, after?.id ?? null, limit],
				}),
			{ access: 'read', tenantId },
		);
		return result.rows.map(historyFromRow);
	}

	async #findIn(
		transaction: DatabaseTransaction,
		tenantId: string,
		id: string,
	): Promise<ExpensesClaim | null> {
		const result = await transaction.query<ExpensesClaimRow>({
			text: FIND,
			parameters: [tenantId, id],
		});
		const row = result.rows[0];
		return row ? fromRow(row) : null;
	}
}
