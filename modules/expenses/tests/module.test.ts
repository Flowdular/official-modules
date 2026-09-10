import type { AuthPrincipal } from '@flowdular/sdk/modules/auth';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import { AUTH_PRINCIPAL_STATE_KEY } from '@flowdular/sdk/modules/auth/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { EXPENSES_PERMISSIONS } from '../src/acl/permissions.ts';
import type { CreateExpensesClaimInput } from '../src/domain/types.ts';
import { moduleDefinition } from '../src/index.ts';
import { createExpensesRoutes } from '../src/api/endpoints.ts';
import {
	ExpensesService,
	ExpensesServiceError,
} from '../src/services/expenses-service.ts';
import { createExpensesRuntime } from '../src/server/runtime.ts';
import {
	closeExpensesTestDatabases,
	createExpensesTestDatabase,
	expensesTestProvider,
	type ExpensesTestDatabase,
} from './support/database.ts';

type ExpenseRoute = ReturnType<typeof createExpensesRoutes>[number];
type ExpenseRouteContext = Parameters<ExpenseRoute['handler']>[0];
const TEST_ACTOR = {
	kind: 'user',
	id: 'account-a',
	label: 'Employee',
} as const;

const input = (
	overrides: Partial<CreateExpensesClaimInput> = {},
): CreateExpensesClaimInput => ({
	title: 'Train to customer site',
	amountMinor: 12_500,
	currency: 'eur',
	category: 'travel',
	expenseDate: '2026-08-20',
	note: 'Return ticket',
	...overrides,
});

const databases = new Set<ExpensesTestDatabase>();

afterEach(async () => {
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closeExpensesTestDatabases);

async function expensesFixture(): Promise<ExpensesTestDatabase> {
	const database = await createExpensesTestDatabase();
	databases.add(database);
	return database;
}

async function service(): Promise<ExpensesService> {
	return new ExpensesService((await expensesFixture()).repository);
}

async function errorFrom(action: () => unknown): Promise<ExpensesServiceError> {
	try {
		await action();
	} catch (error) {
		expect(error).toBeInstanceOf(ExpensesServiceError);
		return error as ExpensesServiceError;
	}
	throw new Error('Expected an ExpensesServiceError.');
}

function principal(scopes: readonly string[]): AuthPrincipal {
	return {
		accountId: 'account-a',
		tenantId: 'tenant-a',
		email: 'employee@example.test',
		displayName: 'Employee',
		role: 'member',
		scopes,
		tenants: [],
	};
}

function authRuntime(actor: AuthPrincipal): AuthRuntime {
	const session = {
		principal: actor,
		csrfToken: 'csrf-token',
		expiresAt: Date.now() + 60_000,
		sessionId: 'session-id',
		passwordChangeRequired: false,
	};
	return {
		cookie: { name: 'test-session', secure: false, maxAgeSeconds: 3_600 },
		authorizeAgentToolAccess: () => [],
		service: () => ({
			resolveSession: (token: string) => (token === 'token' ? session : null),
		}),
	} as unknown as AuthRuntime;
}

/* auth.core resolves the browser session in its middleware and publishes it in
   context state; sessionMutationDenial reads it from there. The key is not yet
   exported from @flowdular/sdk/modules/auth/server, so this double mirrors it. */
const AUTH_SESSION_STATE_KEY = 'flowdular.auth.session';

function context(request: Request, actor?: AuthPrincipal) {
	const state = new Map<string, unknown>();
	if (actor) {
		state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
		state.set(AUTH_SESSION_STATE_KEY, {
			principal: actor,
			csrfToken: 'csrf-token',
			expiresAt: Date.now() + 60_000,
			sessionId: 'session-id',
			passwordChangeRequired: false,
		});
	}
	return {
		request,
		url: new URL(request.url),
		state,
	} as unknown as ExpenseRouteContext;
}

function mutationRequest(path: string, body: unknown, csrf = 'csrf-token') {
	return new Request(`https://erp.example${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: 'https://erp.example',
			cookie: 'test-session=token',
			'x-csrf-token': csrf,
		},
		body: JSON.stringify(body),
	});
}

function route(
	routes: readonly ExpenseRoute[],
	path: string,
	method: string,
): ExpenseRoute {
	const found = routes.find(
		(entry) => entry.path === path && entry.methods.includes(method),
	);
	if (!found) throw new Error(`Missing ${method} ${path}.`);
	return found;
}

describe('expenses.core service', () => {
	it('exports its validated identity and permissions', async () => {
		expect(moduleDefinition.manifest.id).toBe('expenses.core');
		expect(moduleDefinition.permissions).toEqual([
			'expenses.claims.read',
			'expenses.claims.manage',
			'expenses.claims.approve',
		]);
	});

	it('creates tenant-owned drafts with unique server identities', async () => {
		const expenses = await service();
		const first = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const second = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);

		expect(first).toMatchObject({
			tenantId: 'tenant-a',
			claimantId: 'account-a',
			title: 'Train to customer site',
			amountMinor: 12_500,
			currency: 'EUR',
			category: 'travel',
			expenseDate: '2026-08-20',
			note: 'Return ticket',
			status: 'draft',
			decisionComment: null,
		});
		expect(first.id).not.toBe(second.id);
	});

	it('resolves a linked note once while retaining the raw template', async () => {
		const expenses = await service();
		const claim = await expenses.create(
			'tenant-a',
			'account-a',
			input({ note: 'Receipt for {{ expense.title }} on {{ expense.date }}.' }),
			TEST_ACTOR,
		);
		expect(claim.noteTemplate).toBe(
			'Receipt for {{ expense.title }} on {{ expense.date }}.',
		);
		expect(claim.note).toBe(
			'Receipt for Train to customer site on 2026-08-20.',
		);
		expect(
			(await expenses.list('tenant-a', 'account-a', null, false))[0],
		).toMatchObject({
			noteTemplate: 'Receipt for {{ expense.title }} on {{ expense.date }}.',
			note: 'Receipt for Train to customer site on 2026-08-20.',
		});
	});

	it('rejects unknown linked-note variables before persisting the claim', async () => {
		const expenses = await service();
		expect(
			(
				await errorFrom(() =>
					expenses.create(
						'tenant-a',
						'account-a',
						input({ note: '{{ party.name }}' }),
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('UNKNOWN_TEMPLATE_VARIABLE');
	});

	it('isolates employee lists and direct actions by tenant', async () => {
		const expenses = await service();
		const foreign = await expenses.create(
			'tenant-b',
			'account-b',
			input(),
			TEST_ACTOR,
		);

		expect(await expenses.list('tenant-a', 'account-a', null, false)).toEqual(
			[],
		);
		expect(
			(
				await errorFrom(() =>
					expenses.submit('tenant-a', 'account-b', foreign.id, TEST_ACTOR),
				)
			).code,
		).toBe('CLAIM_NOT_FOUND');
	});

	it('filters employee claims by status and orders newest expense first', async () => {
		const expenses = await service();
		const older = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Older', expenseDate: '2026-08-01' }),
			TEST_ACTOR,
		);
		await expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Another employee', expenseDate: '2026-08-31' }),
			TEST_ACTOR,
		);
		const newer = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Newer', expenseDate: '2026-08-20' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', older.id, TEST_ACTOR);

		expect(
			(await expenses.list('tenant-a', 'account-a', null, false)).map(
				(claim) => claim.title,
			),
		).toEqual(['Newer', 'Older']);
		expect(
			(await expenses.list('tenant-a', 'account-a', 'draft', false)).map(
				(claim) => claim.id,
			),
		).toEqual([newer.id]);
	});

	it('shows approvers every submitted claim and counts only the active tenant', async () => {
		const expenses = await service();
		const first = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const second = await expenses.create(
			'tenant-a',
			'account-b',
			input(),
			TEST_ACTOR,
		);
		const foreign = await expenses.create(
			'tenant-b',
			'account-c',
			input(),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', first.id, TEST_ACTOR);
		await expenses.submit('tenant-a', 'account-b', second.id, TEST_ACTOR);
		await expenses.submit('tenant-b', 'account-c', foreign.id, TEST_ACTOR);

		expect(
			await expenses.list('tenant-a', 'manager', 'submitted', true),
		).toHaveLength(2);
		expect(await expenses.countAwaitingApproval('tenant-a')).toBe(2);
	});

	it('allows only the claimant to update and submit a draft', async () => {
		const expenses = await service();
		const claim = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);

		expect(
			(
				await errorFrom(() =>
					expenses.update(
						'tenant-a',
						'account-b',
						claim.id,
						input({ title: 'Changed' }),
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('CLAIM_NOT_OWNED');

		const changed = await expenses.update(
			'tenant-a',
			'account-a',
			claim.id,
			input({ title: 'Changed', note: null }),
			TEST_ACTOR,
		);
		expect(changed).toMatchObject({ title: 'Changed', note: null });
		expect(
			(await expenses.submit('tenant-a', 'account-a', claim.id, TEST_ACTOR))
				.status,
		).toBe('submitted');
		expect(
			(
				await errorFrom(() =>
					expenses.update(
						'tenant-a',
						'account-a',
						claim.id,
						input(),
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('CLAIM_NOT_DRAFT');
	});

	it('deletes only the claimant own draft and retains its audit history', async () => {
		const { repository } = await expensesFixture();
		const expenses = new ExpensesService(repository);
		const draft = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const submitted = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Submitted' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', submitted.id, TEST_ACTOR);
		const approved = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Approved' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', approved.id, TEST_ACTOR);
		await expenses.decide(
			'tenant-a',
			approved.id,
			'approved',
			'Within policy',
			TEST_ACTOR,
		);
		const rejected = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Rejected' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', rejected.id, TEST_ACTOR);
		await expenses.decide(
			'tenant-a',
			rejected.id,
			'rejected',
			'Missing receipt',
			TEST_ACTOR,
		);

		expect(
			(
				await errorFrom(() =>
					expenses.delete('tenant-a', 'account-b', draft.id, TEST_ACTOR),
				)
			).code,
		).toBe('CLAIM_NOT_OWNED');
		expect(
			(
				await errorFrom(() =>
					expenses.delete('tenant-b', 'account-a', draft.id, TEST_ACTOR),
				)
			).code,
		).toBe('CLAIM_NOT_FOUND');
		expect(
			(
				await errorFrom(() =>
					expenses.delete('tenant-a', 'account-a', submitted.id, TEST_ACTOR),
				)
			).code,
		).toBe('CLAIM_NOT_DRAFT');
		for (const decided of [approved, rejected]) {
			expect(
				(
					await errorFrom(() =>
						expenses.delete('tenant-a', 'account-a', decided.id, TEST_ACTOR),
					)
				).code,
			).toBe('CLAIM_NOT_DRAFT');
		}

		await expenses.delete('tenant-a', 'account-a', draft.id, TEST_ACTOR);
		expect(
			(await expenses.list('tenant-a', 'account-a', null, false)).map(
				(claim) => claim.id,
			),
		).toEqual(expect.arrayContaining([submitted.id, approved.id, rejected.id]));
		const history = await repository.history({
			tenantId: 'tenant-a',
			recordId: draft.id,
			limit: 20,
			cursor: null,
		});
		expect(history.entries[0]).toMatchObject({
			action: 'deleted',
			actor: TEST_ACTOR,
		});
	});

	it('approves or rejects submitted claims with a required comment', async () => {
		const expenses = await service();
		const approved = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const rejected = await expenses.create(
			'tenant-a',
			'account-b',
			input(),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', approved.id, TEST_ACTOR);
		await expenses.submit('tenant-a', 'account-b', rejected.id, TEST_ACTOR);

		expect(
			await expenses.decide(
				'tenant-a',
				approved.id,
				'approved',
				'Within policy',
				TEST_ACTOR,
			),
		).toMatchObject({
			status: 'approved',
			decisionComment: 'Within policy',
		});
		expect(
			await expenses.decide(
				'tenant-a',
				rejected.id,
				'rejected',
				'Receipt missing',
				TEST_ACTOR,
			),
		).toMatchObject({
			status: 'rejected',
			decisionComment: 'Receipt missing',
		});
		expect(await expenses.countAwaitingApproval('tenant-a')).toBe(0);
		expect(
			(
				await errorFrom(() =>
					expenses.decide(
						'tenant-a',
						approved.id,
						'rejected',
						'Again',
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('CLAIM_NOT_SUBMITTED');
	});

	it.each([
		['blank title', input({ title: '' })],
		['oversized title', input({ title: 'x'.repeat(161) })],
		['negative amount', input({ amountMinor: -1 })],
		['fractional amount', input({ amountMinor: 1.5 })],
		['invalid currency', input({ currency: 'EU1' })],
		['short currency', input({ currency: 'EU' })],
		[
			'invalid category',
			input({ category: 'lodging' as CreateExpensesClaimInput['category'] }),
		],
		['invalid date', input({ expenseDate: '2026-02-30' })],
		['oversized note', input({ note: 'x'.repeat(2_001) })],
	])('rejects %s with INVALID_CLAIM_INPUT', async (_label, invalid) => {
		const expenses = await service();
		expect(
			(
				await errorFrom(() =>
					expenses.create(
						'tenant-a',
						'account-a',
						invalid as CreateExpensesClaimInput,
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('INVALID_CLAIM_INPUT');
	});

	it('requires a bounded decision comment', async () => {
		const expenses = await service();
		const blank = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		const oversized = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', blank.id, TEST_ACTOR);
		await expenses.submit('tenant-a', 'account-a', oversized.id, TEST_ACTOR);

		expect(
			(
				await errorFrom(() =>
					expenses.decide('tenant-a', blank.id, 'approved', '', TEST_ACTOR),
				)
			).code,
		).toBe('INVALID_DECISION_COMMENT');
		expect(
			(
				await errorFrom(() =>
					expenses.decide(
						'tenant-a',
						oversized.id,
						'rejected',
						'x'.repeat(2_001),
						TEST_ACTOR,
					),
				)
			).code,
		).toBe('INVALID_DECISION_COMMENT');
	});

	it('records claim revisions with actors and hides them from other claimants', async () => {
		const expenses = await service();
		const claim = await expenses.create(
			'tenant-a',
			'account-a',
			input(),
			TEST_ACTOR,
		);
		await expenses.update(
			'tenant-a',
			'account-a',
			claim.id,
			input({ title: 'Train ticket', note: null }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', claim.id, TEST_ACTOR);
		await expenses.decide('tenant-a', claim.id, 'approved', 'Within policy', {
			kind: 'agent',
			id: 'approval-agent',
			label: 'Expense approver',
			runId: 'run-1',
		});

		const history = await expenses.history('tenant-a', 'account-a', false, {
			recordId: claim.id,
			limit: 20,
			cursor: null,
		});
		expect(history.entries.map((entry) => entry.action)).toEqual([
			'approved',
			'submitted',
			'updated',
			'created',
		]);
		expect(history.entries[0]?.actor).toEqual({
			kind: 'agent',
			id: 'approval-agent',
			label: 'Expense approver',
			runId: 'run-1',
		});
		expect(history.entries[0]?.changes).toEqual({
			status: { from: 'submitted', to: 'approved' },
			decisionComment: { from: null, to: 'Within policy' },
		});
		expect(
			(
				await errorFrom(() =>
					expenses.history('tenant-a', 'account-b', false, {
						recordId: claim.id,
						limit: 20,
						cursor: null,
					}),
				)
			).code,
		).toBe('CLAIM_NOT_FOUND');
		expect(
			(
				await errorFrom(() =>
					expenses.history('tenant-b', 'account-a', true, {
						recordId: claim.id,
						limit: 20,
						cursor: null,
					}),
				)
			).code,
		).toBe('CLAIM_NOT_FOUND');
	});
});

describe('expenses.core PostgreSQL tenant boundary', () => {
	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await expensesFixture();

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO expenses_claims
							 (id, tenant_id, claimant_id, title, amount_minor, currency,
							  category, expense_date, note, note_template, status,
							  decision_comment, created_at)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
						parameters: [
							'forged',
							'tenant-b',
							'account-a',
							'Forged',
							1,
							'EUR',
							'travel',
							'2026-08-20',
							null,
							null,
							'draft',
							null,
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await expensesFixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});
});

describe('expenses.core endpoints', () => {
	it('returns 401 for every endpoint without a principal', async () => {
		const routes = createExpensesRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			createExpensesRuntime({
				databases: await expensesTestProvider(),
				purpose: 'test',
			}),
		);
		for (const endpoint of routes) {
			const method = endpoint.methods.includes('GET') ? 'GET' : 'POST';
			const response = await endpoint.handler(
				context(
					new Request(`https://erp.example${endpoint.path}`, {
						method,
						...(method === 'POST'
							? {
									headers: { 'content-type': 'application/json' },
									body: '{}',
								}
							: {}),
					}),
				),
			);
			expect(response.status, `${method} ${endpoint.path}`).toBe(401);
			expect(await response.json()).toMatchObject({
				error: { code: 'UNAUTHENTICATED' },
			});
		}
	});

	it('returns 403 for every endpoint without its permission', async () => {
		const actor = principal([]);
		const routes = createExpensesRoutes(
			{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
			createExpensesRuntime({
				databases: await expensesTestProvider(),
				purpose: 'test',
			}),
		);
		for (const endpoint of routes) {
			const method = endpoint.methods.includes('GET') ? 'GET' : 'POST';
			const response = await endpoint.handler(
				context(
					new Request(`https://erp.example${endpoint.path}`, {
						method,
						...(method === 'POST'
							? {
									headers: { 'content-type': 'application/json' },
									body: '{}',
								}
							: {}),
					}),
					actor,
				),
			);
			expect(response.status, `${method} ${endpoint.path}`).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: 'FORBIDDEN' },
			});
		}
	});

	it('derives claim ownership from the authenticated principal', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({
			databases: await expensesTestProvider(),
			purpose: 'test',
		});
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const response = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', {
					...input(),
					tenantId: 'tenant-b',
					claimantId: 'account-b',
				}),
				actor,
			),
		);

		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			claim: {
				tenantId: 'tenant-a',
				claimantId: 'account-a',
				status: 'draft',
			},
		});
	});

	it('rejects a mutation with a bad CSRF token before writing', async () => {
		const actor = principal([EXPENSES_PERMISSIONS.manage]);
		const runtime = createExpensesRuntime({
			databases: await expensesTestProvider(),
			purpose: 'test',
		});
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const response = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', input(), 'wrong-token'),
				actor,
			),
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
		expect(
			await (
				await runtime.service()
			).list('tenant-a', 'account-a', null, false),
		).toEqual([]);
	});

	it('deletes an owned draft through the guarded endpoint', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({
			databases: await expensesTestProvider(),
			purpose: 'test',
		});
		const claim = await (
			await runtime.service()
		).create('tenant-a', 'account-a', input(), TEST_ACTOR);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const badCsrf = await route(
			routes,
			'/api/expenses/claims/delete',
			'POST',
		).handler(
			context(
				mutationRequest(
					'/api/expenses/claims/delete',
					{ claimId: claim.id },
					'wrong-token',
				),
				actor,
			),
		);
		expect(badCsrf.status).toBe(403);
		expect(
			await (
				await runtime.service()
			).list('tenant-a', 'account-a', null, false),
		).toHaveLength(1);

		const response = await route(
			routes,
			'/api/expenses/claims/delete',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims/delete', { claimId: claim.id }),
				actor,
			),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deleted: true });
		expect(
			await (
				await runtime.service()
			).list('tenant-a', 'account-a', null, false),
		).toEqual([]);
	});

	it('returns stable errors for invalid claim input and status filters', async () => {
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const runtime = createExpensesRuntime({
			databases: await expensesTestProvider(),
			purpose: 'test',
		});
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const createResponse = await route(
			routes,
			'/api/expenses/claims',
			'POST',
		).handler(
			context(
				mutationRequest('/api/expenses/claims', {
					...input(),
					note: 42,
				}),
				actor,
			),
		);
		const listResponse = await route(
			routes,
			'/api/expenses/claims',
			'GET',
		).handler(
			context(
				new Request('https://erp.example/api/expenses/claims?status=paid'),
				actor,
			),
		);

		expect(createResponse.status).toBe(400);
		expect(await createResponse.json()).toMatchObject({
			error: { code: 'INVALID_CLAIM_INPUT' },
		});
		expect(listResponse.status).toBe(400);
		expect(await listResponse.json()).toMatchObject({
			error: { code: 'INVALID_CLAIM_STATUS' },
		});
	});
});
