import { randomUUID } from 'node:crypto';
import { resolveTemplate, validateTemplate } from '@flowdular/sdk/contracts';
import {
	normalizeActor,
	type Actor,
	type DataClassExportSink,
	type DataClassExportSummary,
	type HistoryPage,
	type HistoryRequest,
} from '@flowdular/sdk/kernel';
import {
	EXPENSE_CLAIM_CATEGORIES,
	EXPENSE_CLAIM_LIMITS,
	EXPENSE_CLAIM_SORTS,
	EXPENSE_CLAIM_STATUSES,
	type CreateExpensesClaimInput,
	type ExpenseClaimBulkOutcome,
	type ExpenseClaimCategory,
	type ExpenseClaimDecision,
	type ExpenseClaimSort,
	type ExpenseClaimSortDirection,
	type ExpenseClaimStatus,
	type ExpensesClaim,
	type UpdateExpensesClaimInput,
} from '../domain/types.ts';
import { EXPENSE_NOTE_VARIABLES } from '../domain/variables.ts';
import type {
	ExpenseClaimKeyset,
	ExpensesExportCursor,
	ExpensesRepository,
} from './repository.ts';

/** Rows one export query holds, so a long history costs bounded memory. */
export const EXPORT_PAGE = 500;

/** The comment a bulk decision records when the reviewer left it blank. */
export const BULK_DECISION_COMMENTS: Readonly<
	Record<ExpenseClaimDecision, string>
> = {
	approved: 'Approved in bulk review.',
	rejected: 'Rejected in bulk review.',
};

/** The filters, order and window of one claims page, before the keyset. */
export interface ExpenseClaimPageInput {
	readonly status: ExpenseClaimStatus | null;
	readonly category: ExpenseClaimCategory | null;
	readonly search: string;
	readonly sort: ExpenseClaimSort;
	readonly direction: ExpenseClaimSortDirection;
	readonly limit: number;
	readonly after: ExpenseClaimKeyset | null;
}

export interface ExpenseClaimPage {
	readonly items: readonly ExpensesClaim[];
	/** The keyset of the last row when the page was full; null otherwise. */
	readonly next: ExpenseClaimKeyset | null;
}

/** The keyset value a claim contributes under one sort. */
export function claimSortValue(
	claim: ExpensesClaim,
	sort: ExpenseClaimSort,
): string | number {
	switch (sort) {
		case 'amount':
			return claim.amountMinor;
		case 'expenseDate':
			return claim.expenseDate;
		default:
			return claim.createdAt;
	}
}

export class ExpensesServiceError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
	) {
		super(message);
		this.name = 'ExpensesServiceError';
	}
}

function bounded(
	value: string,
	field: string,
	min: number,
	max: number,
	code = 'INVALID_CLAIM_INPUT',
): string {
	const normalized = value.trim();
	if (normalized.length < min || normalized.length > max) {
		throw new ExpensesServiceError(
			code,
			`${field} must contain between ${min} and ${max} characters.`,
		);
	}
	return normalized;
}

function identifier(value: string, field: string): string {
	return bounded(value, field, 1, 128, 'INVALID_INPUT');
}

function amount(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'amountMinor must be a non-negative integer.',
		);
	}
	return value;
}

function currency(value: string): string {
	const normalized = bounded(value, 'currency', 3, 3).toUpperCase();
	if (!/^[A-Z]{3}$/.test(normalized)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'currency must be a three-letter code.',
		);
	}
	return normalized;
}

function category(value: ExpenseClaimCategory): ExpenseClaimCategory {
	if (!(EXPENSE_CLAIM_CATEGORIES as readonly string[]).includes(value)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'category must be travel, meals, equipment, or other.',
		);
	}
	return value;
}

function expenseDate(value: string): string {
	const normalized = bounded(value, 'expenseDate', 10, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'expenseDate must use YYYY-MM-DD.',
		);
	}
	const parsed = new Date(`${normalized}T00:00:00.000Z`);
	if (
		Number.isNaN(parsed.getTime()) ||
		parsed.toISOString().slice(0, 10) !== normalized
	) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_INPUT',
			'expenseDate must be a valid calendar date.',
		);
	}
	return normalized;
}

function optionalNote(value: string | null): string | null {
	return value === null ? null : bounded(value, 'note', 1, 2_000);
}

function draftInput(
	input: CreateExpensesClaimInput | UpdateExpensesClaimInput,
): CreateExpensesClaimInput & { readonly noteTemplate: string | null } {
	const normalized = {
		title: bounded(input.title, 'title', 1, 160),
		amountMinor: amount(input.amountMinor),
		currency: currency(input.currency),
		category: category(input.category),
		expenseDate: expenseDate(input.expenseDate),
		note: optionalNote(input.note),
	};
	if (normalized.note === null) return { ...normalized, noteTemplate: null };
	const report = validateTemplate(normalized.note, EXPENSE_NOTE_VARIABLES);
	if (report.unknown.length > 0) {
		throw new ExpensesServiceError(
			'UNKNOWN_TEMPLATE_VARIABLE',
			`Unknown template variable: ${report.unknown.join(', ')}.`,
		);
	}
	return {
		...normalized,
		noteTemplate: normalized.note,
		note: resolveTemplate(normalized.note, {
			'expense.title': normalized.title,
			'expense.amount': (normalized.amountMinor / 100).toFixed(2),
			'expense.currency': normalized.currency,
			'expense.category': normalized.category,
			'expense.date': normalized.expenseDate,
		}),
	};
}

/* Pages are ordered by record time then id, so the first row is the oldest
   and the last row of each page is the next cursor. */
async function exportPaged<T extends { readonly id: string }>(
	page: (after: ExpensesExportCursor | null) => Promise<readonly T[]>,
	pageSize: number,
	sink: DataClassExportSink,
	at: (item: T) => number,
	row: (item: T) => Record<string, unknown>,
): Promise<DataClassExportSummary> {
	let cursor: ExpensesExportCursor | null = null;
	let rows = 0;
	let from: Date | null = null;
	let to: Date | null = null;
	for (;;) {
		const items = await page(cursor);
		for (const item of items) {
			await sink.write(row(item));
			rows += 1;
			from ??= new Date(at(item));
			to = new Date(at(item));
		}
		if (items.length < pageSize) break;
		const last = items[items.length - 1]!;
		cursor = { at: at(last), id: last.id };
	}
	return { rows, from, to };
}

function trustedActor(actor: Actor): Actor {
	const normalized = normalizeActor(actor);
	if (!normalized) {
		throw new ExpensesServiceError(
			'INVALID_ACTOR',
			'actor must carry a kind, an id, and a label.',
		);
	}
	return normalized;
}

export class ExpensesService {
	constructor(private readonly repository: ExpensesRepository) {}

	async page(
		tenantId: string,
		claimantId: string,
		includeApprovalQueue: boolean,
		input: ExpenseClaimPageInput,
	): Promise<ExpenseClaimPage> {
		if (
			input.status !== null &&
			!(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(input.status)
		) {
			throw new ExpensesServiceError(
				'INVALID_CLAIM_STATUS',
				'status must be draft, submitted, approved, or rejected.',
			);
		}
		if (
			input.category !== null &&
			!(EXPENSE_CLAIM_CATEGORIES as readonly string[]).includes(input.category)
		) {
			throw new ExpensesServiceError(
				'INVALID_CLAIM_CATEGORY',
				'category must be travel, meals, equipment, or other.',
			);
		}
		if (!(EXPENSE_CLAIM_SORTS as readonly string[]).includes(input.sort)) {
			throw new ExpensesServiceError(
				'INVALID_INPUT',
				`sort must be one of ${EXPENSE_CLAIM_SORTS.join(', ')}.`,
			);
		}
		if (input.direction !== 'asc' && input.direction !== 'desc') {
			throw new ExpensesServiceError(
				'INVALID_INPUT',
				'direction must be asc or desc.',
			);
		}
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > EXPENSE_CLAIM_LIMITS.page
		) {
			throw new ExpensesServiceError(
				'INVALID_INPUT',
				`limit must be an integer between 1 and ${EXPENSE_CLAIM_LIMITS.page}.`,
			);
		}
		const search = input.search.trim();
		if (search.length > EXPENSE_CLAIM_LIMITS.search) {
			throw new ExpensesServiceError(
				'INVALID_INPUT',
				`q must contain at most ${EXPENSE_CLAIM_LIMITS.search} characters.`,
			);
		}
		const items = await this.repository.page({
			tenantId: identifier(tenantId, 'tenantId'),
			claimantId: identifier(claimantId, 'claimantId'),
			includeApprovalQueue,
			status: input.status,
			category: input.category,
			search: search === '' ? null : search,
			sort: input.sort,
			direction: input.direction,
			limit: input.limit,
			after: input.after,
		});
		const last = items[items.length - 1];
		return {
			items,
			/* A full page may still be the last one; the client stops when the
			   cursor stops, which costs one empty page at most. */
			next:
				last && items.length === input.limit
					? { sortValue: claimSortValue(last, input.sort), id: last.id }
					: null,
		};
	}

	async create(
		tenantId: string,
		claimantId: string,
		input: CreateExpensesClaimInput,
		actor: Actor,
	): Promise<ExpensesClaim> {
		const normalized = draftInput(input);
		return await this.repository.create(
			{
				id: randomUUID(),
				tenantId: identifier(tenantId, 'tenantId'),
				claimantId: identifier(claimantId, 'claimantId'),
				...normalized,
				name: normalized.title,
				status: 'draft',
				decisionComment: null,
				createdAt: Date.now(),
			},
			trustedActor(actor),
		);
	}

	async update(
		tenantId: string,
		claimantId: string,
		claimId: string,
		input: UpdateExpensesClaimInput,
		actor: Actor,
	): Promise<ExpensesClaim> {
		const current = await this.ownedDraft(tenantId, claimantId, claimId);
		const normalized = draftInput(input);
		return await this.repository.update(
			{ ...current, ...normalized, name: normalized.title },
			'updated',
			trustedActor(actor),
		);
	}

	async submit(
		tenantId: string,
		claimantId: string,
		claimId: string,
		actor: Actor,
	): Promise<ExpensesClaim> {
		const current = await this.ownedDraft(tenantId, claimantId, claimId);
		return await this.repository.update(
			{ ...current, status: 'submitted' },
			'submitted',
			trustedActor(actor),
		);
	}

	async delete(
		tenantId: string,
		claimantId: string,
		claimId: string,
		actor: Actor,
	): Promise<void> {
		const current = await this.ownedDraft(tenantId, claimantId, claimId);
		if (
			!(await this.repository.delete(
				current.tenantId,
				current.id,
				trustedActor(actor),
			))
		) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_FOUND',
				'The expense claim was not found.',
				404,
			);
		}
	}

	async decide(
		tenantId: string,
		claimId: string,
		decision: ExpenseClaimDecision,
		comment: string,
		actor: Actor,
	): Promise<ExpensesClaim> {
		const current = await this.claim(tenantId, claimId);
		if (current.status !== 'submitted') {
			throw new ExpensesServiceError(
				'CLAIM_NOT_SUBMITTED',
				'Only a submitted claim can be approved or rejected.',
				409,
			);
		}
		return await this.repository.update(
			{
				...current,
				status: decision,
				decisionComment: bounded(
					comment,
					'decisionComment',
					1,
					2_000,
					'INVALID_DECISION_COMMENT',
				),
			},
			decision,
			trustedActor(actor),
		);
	}

	/* Each id runs the single decision path, so every row keeps its own history
	   version and a refused or missing id costs no other row. A blank comment
	   records the bulk default, because a decision never stores an empty one. */
	decideMany(
		tenantId: string,
		claimIds: readonly string[],
		decision: ExpenseClaimDecision,
		comment: string | null,
		actor: Actor,
	): Promise<readonly ExpenseClaimBulkOutcome[]> {
		const recorded =
			comment === null || comment.trim() === ''
				? BULK_DECISION_COMMENTS[decision]
				: comment;
		return this.each(claimIds, (claimId) =>
			this.decide(tenantId, claimId, decision, recorded, actor),
		);
	}

	submitMany(
		tenantId: string,
		claimantId: string,
		claimIds: readonly string[],
		actor: Actor,
	): Promise<readonly ExpenseClaimBulkOutcome[]> {
		return this.each(claimIds, (claimId) =>
			this.submit(tenantId, claimantId, claimId, actor),
		);
	}

	/* A claim nobody may read has no readable history: without the approval
	   permission only the claimant's own claims answer. */
	async history(
		tenantId: string,
		claimantId: string,
		includeApprovalQueue: boolean,
		request: HistoryRequest,
	): Promise<HistoryPage> {
		const claim = await this.claim(tenantId, request.recordId);
		if (
			!includeApprovalQueue &&
			claim.claimantId !== identifier(claimantId, 'claimantId')
		) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_FOUND',
				'The expense claim was not found.',
				404,
			);
		}
		return await this.repository.history({
			tenantId: identifier(tenantId, 'tenantId'),
			recordId: identifier(request.recordId, 'recordId'),
			limit: request.limit,
			cursor: request.cursor,
		});
	}

	async countAwaitingApproval(tenantId: string): Promise<number> {
		return await this.repository.countAwaitingApproval(
			identifier(tenantId, 'tenantId'),
		);
	}

	async exportClaims(
		tenantId: string,
		sink: DataClassExportSink,
		pageSize = EXPORT_PAGE,
	): Promise<DataClassExportSummary> {
		const owner = identifier(tenantId, 'tenantId');
		return await exportPaged(
			(after) => this.repository.listForExport(owner, after, pageSize),
			pageSize,
			sink,
			(claim) => claim.createdAt,
			(claim) => ({
				id: claim.id,
				claimantId: claim.claimantId,
				title: claim.title,
				amountMinor: claim.amountMinor,
				currency: claim.currency,
				category: claim.category,
				expenseDate: claim.expenseDate,
				note: claim.note,
				noteTemplate: claim.noteTemplate,
				status: claim.status,
				decisionComment: claim.decisionComment,
				createdAt: new Date(claim.createdAt).toISOString(),
			}),
		);
	}

	async exportHistory(
		tenantId: string,
		sink: DataClassExportSink,
		pageSize = EXPORT_PAGE,
	): Promise<DataClassExportSummary> {
		const owner = identifier(tenantId, 'tenantId');
		return await exportPaged(
			(after) => this.repository.listHistoryForExport(owner, after, pageSize),
			pageSize,
			sink,
			(entry) => entry.occurredAt,
			(entry) => ({
				id: entry.id,
				recordId: entry.recordId,
				version: entry.version,
				action: entry.action,
				actorKind: entry.actorKind,
				actorId: entry.actorId,
				actorLabel: entry.actorLabel,
				runId: entry.runId,
				changes: entry.changes,
				occurredAt: new Date(entry.occurredAt).toISOString(),
			}),
		);
	}

	private async each(
		claimIds: readonly string[],
		write: (claimId: string) => Promise<unknown>,
	): Promise<readonly ExpenseClaimBulkOutcome[]> {
		if (claimIds.length < 1 || claimIds.length > EXPENSE_CLAIM_LIMITS.bulk) {
			throw new ExpensesServiceError(
				'INVALID_INPUT',
				`claimIds must name between 1 and ${EXPENSE_CLAIM_LIMITS.bulk} claims.`,
			);
		}
		const outcomes: ExpenseClaimBulkOutcome[] = [];
		for (const id of claimIds) {
			try {
				await write(id);
				outcomes.push({ id, outcome: 'updated' });
			} catch (error) {
				if (!(error instanceof ExpensesServiceError)) throw error;
				outcomes.push(
					error.code === 'CLAIM_NOT_FOUND'
						? { id, outcome: 'not-found' }
						: { id, outcome: 'refused', reason: error.code },
				);
			}
		}
		return outcomes;
	}

	private async claim(
		tenantId: string,
		claimId: string,
	): Promise<ExpensesClaim> {
		const record = await this.repository.find(
			identifier(tenantId, 'tenantId'),
			identifier(claimId, 'claimId'),
		);
		if (!record) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_FOUND',
				'The expense claim was not found.',
				404,
			);
		}
		return record;
	}

	private async ownedDraft(
		tenantId: string,
		claimantId: string,
		claimId: string,
	): Promise<ExpensesClaim> {
		const record = await this.claim(tenantId, claimId);
		if (record.claimantId !== identifier(claimantId, 'claimantId')) {
			throw new ExpensesServiceError(
				'CLAIM_NOT_OWNED',
				'Only the claimant can change, submit, or delete this claim.',
				403,
			);
		}
		if (record.status !== 'draft') {
			throw new ExpensesServiceError(
				'CLAIM_NOT_DRAFT',
				'Only a draft claim can be changed, submitted, or deleted.',
				409,
			);
		}
		return record;
	}
}
