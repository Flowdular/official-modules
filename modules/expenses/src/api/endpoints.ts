import { randomBytes } from 'node:crypto';
import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	optionalString,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
	requiredInteger,
	requiredString,
} from '@flowdular/sdk/server';
import { parseHistoryRequest } from '@flowdular/sdk/kernel';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import {
	actorFromContext,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/sdk/modules/auth/server';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import {
	EXPENSE_CLAIM_CATEGORIES,
	EXPENSE_CLAIM_LIMITS,
	EXPENSE_CLAIM_SORTS,
	EXPENSE_CLAIM_STATUSES,
	type CreateExpensesClaimInput,
	type ExpenseClaimCategory,
	type ExpenseClaimSort,
	type ExpenseClaimStatus,
} from '../domain/types.ts';
import type { ExpensesRuntime } from '../server/runtime.ts';
import {
	readClaimsPage,
	type ClaimsListing,
	type ClaimsReader,
} from '../services/claims-listing.ts';
import { ExpensesServiceError } from '../services/expenses-service.ts';

function failure(error: unknown): Response {
	if (error instanceof ExpensesServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The expenses operation failed.');
}

function validationFailure(error: unknown, code: string): Response {
	if (error instanceof HttpProblem && error.code === 'INVALID_INPUT') {
		return jsonResponse(
			{ error: { code, message: error.message } },
			error.status,
		);
	}
	return failure(error);
}

function invalid(message: string): HttpProblem {
	return new HttpProblem('INVALID_INPUT', message, 400);
}

function claimInput(value: Record<string, unknown>): CreateExpensesClaimInput {
	const rawCategory = requiredString(value, 'category', { max: 16 });
	if (!(EXPENSE_CLAIM_CATEGORIES as readonly string[]).includes(rawCategory)) {
		throw new HttpProblem(
			'INVALID_CLAIM_INPUT',
			'category must be travel, meals, equipment, or other.',
			400,
		);
	}
	return {
		title: requiredString(value, 'title', { max: 160 }),
		amountMinor: requiredInteger(value, 'amountMinor', { min: 0 }),
		currency: requiredString(value, 'currency', { min: 3, max: 3 }),
		category: rawCategory as ExpenseClaimCategory,
		expenseDate: requiredString(value, 'expenseDate', { min: 10, max: 10 }),
		note: optionalString(value, 'note', 2_000),
	};
}

function statusFilter(url: URL): ExpenseClaimStatus | null {
	const status = url.searchParams.get('status');
	if (status === null || status === '') return null;
	if (!(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(status)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_STATUS',
			'status must be draft, submitted, approved, or rejected.',
		);
	}
	return status as ExpenseClaimStatus;
}

function categoryFilter(url: URL): ExpenseClaimCategory | null {
	const category = url.searchParams.get('category');
	if (category === null || category === '') return null;
	if (!(EXPENSE_CLAIM_CATEGORIES as readonly string[]).includes(category)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_CATEGORY',
			'category must be travel, meals, equipment, or other.',
		);
	}
	return category as ExpenseClaimCategory;
}

function claimsListing(url: URL): ClaimsListing {
	const sort = url.searchParams.get('sort') ?? 'createdAt';
	if (!(EXPENSE_CLAIM_SORTS as readonly string[]).includes(sort)) {
		throw invalid(`sort must be one of ${EXPENSE_CLAIM_SORTS.join(', ')}.`);
	}
	const direction = url.searchParams.get('direction') ?? 'desc';
	if (direction !== 'asc' && direction !== 'desc') {
		throw invalid('direction must be asc or desc.');
	}
	const search = url.searchParams.get('q') ?? '';
	if (search.length > EXPENSE_CLAIM_LIMITS.search) {
		throw invalid(
			`q must contain at most ${EXPENSE_CLAIM_LIMITS.search} characters.`,
		);
	}
	return {
		status: statusFilter(url),
		category: categoryFilter(url),
		search,
		sort: sort as ExpenseClaimSort,
		direction,
	};
}

/* One outcome answers one row, so an id is named once; the count and each id
   are bounded like the single route's. */
function claimIds(value: Record<string, unknown>): readonly string[] {
	const raw = value.claimIds;
	if (!Array.isArray(raw)) throw invalid('claimIds must be an array.');
	if (raw.length < 1 || raw.length > EXPENSE_CLAIM_LIMITS.bulk) {
		throw invalid(
			`claimIds must name between 1 and ${EXPENSE_CLAIM_LIMITS.bulk} claims.`,
		);
	}
	const ids = raw.map((entry) =>
		requiredString({ claimId: entry }, 'claimId', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw invalid('claimIds must not repeat an id.');
	}
	return ids;
}

/* A blank comment is absent: the service records the bulk default for it. */
function bulkComment(value: Record<string, unknown>): string | null {
	const raw = value.comment;
	if (typeof raw === 'string' && raw.trim() === '') return null;
	return optionalString(value, 'comment', 2_000);
}

function decisionComment(value: Record<string, unknown>): string {
	try {
		return requiredString(value, 'comment', { max: 2_000 });
	} catch (error) {
		if (error instanceof HttpProblem && error.code === 'INVALID_INPUT') {
			throw new HttpProblem(
				'INVALID_DECISION_COMMENT',
				error.message,
				error.status,
			);
		}
		throw error;
	}
}

export function createExpensesRoutes(
	auth: AuthRuntime,
	runtime: ExpensesRuntime,
) {
	/* Module-owned and never stored: a cursor names a position in one
	   tenant's own list, so a restart invalidating one costs a client the
	   first page. */
	const cursorSecret = randomBytes(32);

	const listPage = async (
		request: Request,
		reader: ClaimsReader,
		listing: (url: URL) => ClaimsListing,
	): Promise<Response> => {
		try {
			const url = new URL(request.url);
			const page = readPageQuery(url, {
				maxLimit: EXPENSE_CLAIM_LIMITS.page,
				defaultLimit: EXPENSE_CLAIM_LIMITS.defaultPage,
			});
			const result = await readClaimsPage(
				await runtime.service(),
				cursorSecret,
				reader,
				listing(url),
				page.limit,
				page.cursor,
			);
			return pageResponse({
				items: result.items,
				limit: page.limit,
				nextCursor: result.nextCursor,
			});
		} catch (error) {
			return failure(error);
		}
	};

	const list = defineEndpoint({
		id: 'expenses.claims.list',
		path: '/api/expenses/claims',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) =>
			listPage(octane.request, principalFromContext(octane)!, claimsListing),
	});

	const countAwaitingApproval = defineEndpoint({
		id: 'expenses.claims.awaiting-approval-count',
		path: '/api/expenses/claims/awaiting-approval-count',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.approve },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) =>
			jsonResponse({
				count: await (
					await runtime.service()
				).countAwaitingApproval(principalFromContext(octane)!.tenantId),
			}),
	});

	/* The same page as the list, with the status held at submitted. */
	const approvalQueue = defineEndpoint({
		id: 'expenses.claims.approval-queue',
		path: '/api/expenses/claims/approval-queue',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.approve },
		resolveIdentity: endpointIdentityFromContext,
		handler: ({ octane }) =>
			listPage(octane.request, principalFromContext(octane)!, (url) => ({
				...claimsListing(url),
				status: 'submitted',
			})),
	});

	const create = defineEndpoint({
		id: 'expenses.claims.create',
		path: '/api/expenses/claims',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				const claim = await service.create(
					principal.tenantId,
					principal.accountId,
					claimInput(value),
					actorFromContext(octane)!,
				);
				return jsonResponse({ claim }, 201);
			} catch (error) {
				return validationFailure(error, 'INVALID_CLAIM_INPUT');
			}
		},
	});

	const update = defineEndpoint({
		id: 'expenses.claims.update',
		path: '/api/expenses/claims/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				const claim = await service.update(
					principal.tenantId,
					principal.accountId,
					requiredString(value, 'claimId', { max: 128 }),
					claimInput(value),
					actorFromContext(octane)!,
				);
				return jsonResponse({ claim });
			} catch (error) {
				return validationFailure(error, 'INVALID_CLAIM_INPUT');
			}
		},
	});

	const submit = defineEndpoint({
		id: 'expenses.claims.submit',
		path: '/api/expenses/claims/submit',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				const claim = await service.submit(
					principal.tenantId,
					principal.accountId,
					requiredString(value, 'claimId', { max: 128 }),
					actorFromContext(octane)!,
				);
				return jsonResponse({ claim });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const submitMany = defineEndpoint({
		id: 'expenses.claims.submit-many',
		path: '/api/expenses/claims/submit-many',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				const outcomes = await service.submitMany(
					principal.tenantId,
					principal.accountId,
					claimIds(value),
					actorFromContext(octane)!,
				);
				return jsonResponse({ outcomes });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const remove = defineEndpoint({
		id: 'expenses.claims.delete',
		path: '/api/expenses/claims/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				const value = await readJsonObject(octane.request);
				await service.delete(
					principal.tenantId,
					principal.accountId,
					requiredString(value, 'claimId', { max: 128 }),
					actorFromContext(octane)!,
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});

	const decide = (
		decision: 'approved' | 'rejected',
		path: string,
		id: string,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: {
				kind: 'permission',
				permission: EXPENSES_PERMISSIONS.approve,
			},
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const service = await runtime.service();
					const value = await readJsonObject(octane.request);
					const claim = await service.decide(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'claimId', { max: 128 }),
						decision,
						decisionComment(value),
						actorFromContext(octane)!,
					);
					return jsonResponse({ claim });
				} catch (error) {
					return failure(error);
				}
			},
		});

	/* The sibling of the single decision route: same permission, same CSRF
	   check, one outcome per id, and an optional comment. */
	const decideMany = (
		decision: 'approved' | 'rejected',
		path: string,
		id: string,
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: {
				kind: 'permission',
				permission: EXPENSES_PERMISSIONS.approve,
			},
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const service = await runtime.service();
					const value = await readJsonObject(octane.request);
					const outcomes = await service.decideMany(
						principalFromContext(octane)!.tenantId,
						claimIds(value),
						decision,
						bulkComment(value),
						actorFromContext(octane)!,
					);
					return jsonResponse({ outcomes });
				} catch (error) {
					return failure(error);
				}
			},
		});

	const history = defineEndpoint({
		id: 'expenses.claims.history',
		path: '/api/expenses/claims/history',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const request = parseHistoryRequest(
				new URL(octane.request.url).searchParams,
			);
			if (!request) {
				return jsonResponse(
					{
						error: {
							code: 'INVALID_INPUT',
							message: 'recordId is required.',
						},
					},
					400,
				);
			}
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				return jsonResponse(
					await service.history(
						principal.tenantId,
						principal.accountId,
						principal.scopes.includes(EXPENSES_PERMISSIONS.approve),
						request,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});

	const approve = decide(
		'approved',
		'/api/expenses/claims/approve',
		'expenses.claims.approve',
	);
	const reject = decide(
		'rejected',
		'/api/expenses/claims/reject',
		'expenses.claims.reject',
	);
	const approveMany = decideMany(
		'approved',
		'/api/expenses/claims/approve-many',
		'expenses.claims.approve-many',
	);
	const rejectMany = decideMany(
		'rejected',
		'/api/expenses/claims/reject-many',
		'expenses.claims.reject-many',
	);

	return [
		list.serverRoute,
		approvalQueue.serverRoute,
		countAwaitingApproval.serverRoute,
		create.serverRoute,
		update.serverRoute,
		submit.serverRoute,
		submitMany.serverRoute,
		remove.serverRoute,
		approve.serverRoute,
		reject.serverRoute,
		approveMany.serverRoute,
		rejectMany.serverRoute,
		history.serverRoute,
	] as const;
}

export const endpoints = [
	'expenses.claims.list',
	'expenses.claims.approval-queue',
	'expenses.claims.awaiting-approval-count',
	'expenses.claims.create',
	'expenses.claims.update',
	'expenses.claims.submit',
	'expenses.claims.submit-many',
	'expenses.claims.delete',
	'expenses.claims.approve',
	'expenses.claims.reject',
	'expenses.claims.approve-many',
	'expenses.claims.reject-many',
	'expenses.claims.history',
] as const;
