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
	EXPENSE_CLAIM_STATUSES,
	type CreateExpensesClaimInput,
	type ExpenseClaimCategory,
	type ExpenseClaimDecision,
	type ExpenseClaimStatus,
	type ExpensesClaim,
	type UpdateExpensesClaimInput,
} from '../domain/types.ts';
import { EXPENSE_NOTE_VARIABLES } from '../domain/variables.ts';
import type { ExpensesExportCursor, ExpensesRepository } from './repository.ts';

/** Rows one export query holds, so a long history costs bounded memory. */
export const EXPORT_PAGE = 500;

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

	async list(
		tenantId: string,
		claimantId: string,
		status: ExpenseClaimStatus | null,
		includeApprovalQueue: boolean,
	): Promise<readonly ExpensesClaim[]> {
		if (
			status !== null &&
			!(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(status)
		) {
			throw new ExpensesServiceError(
				'INVALID_CLAIM_STATUS',
				'status must be draft, submitted, approved, or rejected.',
			);
		}
		return await this.repository.list({
			tenantId: identifier(tenantId, 'tenantId'),
			claimantId: identifier(claimantId, 'claimantId'),
			status,
			includeApprovalQueue,
		});
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
