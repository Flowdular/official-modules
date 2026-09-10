import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	optionalString,
	problemResponse,
	readJsonObject,
	requiredInteger,
	requiredString,
} from '@flowdular/server';
import { parseHistoryRequest } from '@flowdular/kernel';
import type { AuthRuntime } from '@flowdular/module-auth/server';
import {
	actorFromContext,
	endpointIdentityFromContext,
	principalFromContext,
	sessionMutationDenial,
} from '@flowdular/module-auth/server';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import {
	EXPENSE_CLAIM_CATEGORIES,
	EXPENSE_CLAIM_STATUSES,
	type CreateExpensesClaimInput,
	type ExpenseClaimCategory,
	type ExpenseClaimStatus,
} from '../domain/types.ts';
import type { ExpensesRuntime } from '../server/runtime.ts';
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

function statusFromRequest(request: Request): ExpenseClaimStatus | null {
	const status = new URL(request.url).searchParams.get('status');
	if (status === null || status === '') return null;
	if (!(EXPENSE_CLAIM_STATUSES as readonly string[]).includes(status)) {
		throw new ExpensesServiceError(
			'INVALID_CLAIM_STATUS',
			'status must be draft, submitted, approved, or rejected.',
		);
	}
	return status as ExpenseClaimStatus;
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
	const list = defineEndpoint({
		id: 'expenses.claims.list',
		path: '/api/expenses/claims',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const service = await runtime.service();
				const principal = principalFromContext(octane)!;
				return jsonResponse({
					claims: await service.list(
						principal.tenantId,
						principal.accountId,
						statusFromRequest(octane.request),
						principal.scopes.includes(EXPENSES_PERMISSIONS.approve),
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
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

	const approvalQueue = defineEndpoint({
		id: 'expenses.claims.approval-queue',
		path: '/api/expenses/claims/approval-queue',
		methods: ['GET'],
		access: { kind: 'permission', permission: EXPENSES_PERMISSIONS.approve },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const service = await runtime.service();
			const principal = principalFromContext(octane)!;
			return jsonResponse({
				claims: await service.list(
					principal.tenantId,
					principal.accountId,
					'submitted',
					true,
				),
			});
		},
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

	return [
		list.serverRoute,
		approvalQueue.serverRoute,
		countAwaitingApproval.serverRoute,
		create.serverRoute,
		update.serverRoute,
		submit.serverRoute,
		remove.serverRoute,
		approve.serverRoute,
		reject.serverRoute,
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
	'expenses.claims.delete',
	'expenses.claims.approve',
	'expenses.claims.reject',
	'expenses.claims.history',
] as const;
