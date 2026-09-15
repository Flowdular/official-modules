import type { AuthPrincipal } from '@flowdular/sdk/modules/auth';
import type { AuthRuntime } from '@flowdular/sdk/modules/auth/server';
import { AUTH_PRINCIPAL_STATE_KEY } from '@flowdular/sdk/modules/auth/server';
import type { DefinedListExport } from '@flowdular/sdk/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { EXPENSES_PERMISSIONS } from '../src/acl/permissions.ts';
import { EXPENSES_CLAIMS_EXPORT_LIST_ID } from '../src/domain/lists.ts';
import type {
	CreateExpensesClaimInput,
	ExpenseClaimSort,
	ExpenseClaimSortDirection,
	ExpenseClaimStatus,
	ExpensesClaim,
} from '../src/domain/types.ts';
import { moduleDefinition } from '../src/index.ts';
import { createExpensesRoutes } from '../src/api/endpoints.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	BULK_DECISION_COMMENTS,
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

/* Every claim the principal may read, in one bounded page, ordered like the
   spec's list scenario: expense date newest first, id as the tie-breaker. */
async function all(
	expenses: ExpensesService,
	tenantId: string,
	claimantId: string,
	status: ExpenseClaimStatus | null,
	includeApprovalQueue: boolean,
): Promise<readonly ExpensesClaim[]> {
	return (
		await expenses.page(tenantId, claimantId, includeApprovalQueue, {
			status,
			category: null,
			search: '',
			sort: 'expenseDate',
			direction: 'desc',
			limit: 200,
			after: null,
		})
	).items;
}

function principal(
	scopes: readonly string[],
	tenantId = 'tenant-a',
	accountId = 'account-a',
): AuthPrincipal {
	return {
		accountId,
		tenantId,
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
			(await all(expenses, 'tenant-a', 'account-a', null, false))[0],
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

		expect(await all(expenses, 'tenant-a', 'account-a', null, false)).toEqual(
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
			(await all(expenses, 'tenant-a', 'account-a', null, false)).map(
				(claim) => claim.title,
			),
		).toEqual(['Newer', 'Older']);
		expect(
			(await all(expenses, 'tenant-a', 'account-a', 'draft', false)).map(
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
			await all(expenses, 'tenant-a', 'manager', 'submitted', true),
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
			(await all(expenses, 'tenant-a', 'account-a', null, false)).map(
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
			await all(await runtime.service(), 'tenant-a', 'account-a', null, false),
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
			await all(await runtime.service(), 'tenant-a', 'account-a', null, false),
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
			await all(await runtime.service(), 'tenant-a', 'account-a', null, false),
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

async function listResponse(
	routes: readonly ExpenseRoute[],
	actor: AuthPrincipal,
	query: string,
	path = '/api/expenses/claims',
) {
	const response = await route(routes, path, 'GET').handler(
		context(new Request(`https://erp.example${path}${query}`), actor),
	);
	return {
		status: response.status,
		body: (await response.json()) as {
			readonly items?: readonly ExpensesClaim[];
			readonly page?: { readonly nextCursor: string | null };
			readonly error?: { readonly code: string };
		},
	};
}

/* A tampered cursor: the first character of its body segment flipped. */
function tamper(cursor: string): string {
	const [version, body, signature] = cursor.split('.');
	const first = body![0] === 'A' ? 'B' : 'A';
	return `${version}.${first}${body!.slice(1)}.${signature}`;
}

async function walk(
	routes: readonly ExpenseRoute[],
	actor: AuthPrincipal,
	sort: ExpenseClaimSort,
	direction: ExpenseClaimSortDirection,
	limit: number,
	filters = '',
): Promise<readonly string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	for (;;) {
		const page = await listResponse(
			routes,
			actor,
			`?sort=${sort}&direction=${direction}&limit=${limit}${filters}` +
				(cursor ? `&cursor=${cursor}` : ''),
		);
		expect(page.status).toBe(200);
		ids.push(...page.body.items!.map((claim) => claim.id));
		cursor = page.body.page!.nextCursor;
		if (cursor === null) return ids;
	}
}

describe('expenses.core claims page', () => {
	async function seeded() {
		const database = await expensesFixture();
		const runtime = createExpensesRuntime({
			databases: database.provider,
			purpose: 'test',
		});
		const expenses = await runtime.service();
		const claims: ExpensesClaim[] = [];
		for (let index = 0; index < 5; index += 1) {
			claims.push(
				await expenses.create(
					'tenant-a',
					'account-a',
					input({
						title: `Claim ${index}`,
						amountMinor: [500, 100, 300, 300, 200][index]!,
						expenseDate: `2026-08-0${index + 1}`,
						category: index % 2 === 0 ? 'travel' : 'meals',
					}),
					TEST_ACTOR,
				),
			);
		}
		return { runtime, expenses, claims, database };
	}

	it('pages two consecutive pages with no overlap or gap and stops on a short page', async () => {
		const { runtime, claims } = await seeded();
		const actor = principal([EXPENSES_PERMISSIONS.read]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const first = await listResponse(routes, actor, '?limit=2');
		expect(first.status).toBe(200);
		expect(first.body.items).toHaveLength(2);
		expect(first.body.page?.nextCursor).toEqual(expect.any(String));
		const second = await listResponse(
			routes,
			actor,
			`?limit=2&cursor=${first.body.page!.nextCursor}`,
		);
		expect(second.body.items).toHaveLength(2);
		expect(second.body.page?.nextCursor).toEqual(expect.any(String));
		const third = await listResponse(
			routes,
			actor,
			`?limit=2&cursor=${second.body.page!.nextCursor}`,
		);
		expect(third.body.items).toHaveLength(1);
		expect(third.body.page?.nextCursor).toBeNull();
		const seen = [
			...first.body.items!,
			...second.body.items!,
			...third.body.items!,
		].map((claim) => claim.id);
		expect(new Set(seen).size).toBe(5);
		expect(seen.sort()).toEqual(claims.map((claim) => claim.id).sort());
		/* The default order is creation time newest first. */
		expect(first.body.items![0]!.title).toBe('Claim 4');
	});

	it('answers a cursor on a full last page and none on the empty page after it', async () => {
		const { runtime, expenses } = await seeded();
		const actor = principal([EXPENSES_PERMISSIONS.read]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Sixth' }),
			TEST_ACTOR,
		);
		const ids = await walk(routes, actor, 'createdAt', 'desc', 3);
		expect(ids).toHaveLength(6);
	});

	it('walks each sort in each direction exactly as the database orders the set', async () => {
		const { runtime, claims, database } = await seeded();
		const actor = principal([EXPENSES_PERMISSIONS.read]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const columns: Record<ExpenseClaimSort, string> = {
			createdAt: 'created_at',
			amount: 'amount_minor',
			expenseDate: 'expense_date',
		};
		for (const sort of ['createdAt', 'amount', 'expenseDate'] as const) {
			for (const direction of ['asc', 'desc'] as const) {
				const order = direction.toUpperCase();
				const expected = (
					await database.runtime.transaction(
						(transaction) =>
							transaction.query<{ id: string }>({
								text: `SELECT id FROM expenses_claims WHERE tenant_id = $1
								 ORDER BY ${columns[sort]} ${order}, id ${order}`,
								parameters: ['tenant-a'],
							}),
						{ access: 'read', tenantId: 'tenant-a' },
					)
				).rows.map((row) => row.id);
				expect(expected).toHaveLength(claims.length);
				expect(
					await walk(routes, actor, sort, direction, 2),
					`${sort} ${direction}`,
				).toEqual(expected);
			}
		}
	});

	it('refuses a tampered, foreign-tenant, resorted or refiltered cursor and an unknown sort', async () => {
		const { runtime } = await seeded();
		const actor = principal([EXPENSES_PERMISSIONS.read]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const first = await listResponse(routes, actor, '?limit=2&status=draft');
		const cursor = first.body.page!.nextCursor!;

		for (const [label, query, who] of [
			['tampered', `?limit=2&status=draft&cursor=${tamper(cursor)}`, actor],
			[
				'foreign tenant',
				`?limit=2&status=draft&cursor=${cursor}`,
				principal([EXPENSES_PERMISSIONS.read], 'tenant-b'),
			],
			['resorted', `?limit=2&status=draft&sort=amount&cursor=${cursor}`, actor],
			[
				'redirected',
				`?limit=2&status=draft&direction=asc&cursor=${cursor}`,
				actor,
			],
			['refiltered', `?limit=2&cursor=${cursor}`, actor],
			['searched', `?limit=2&status=draft&q=claim&cursor=${cursor}`, actor],
		] as const) {
			const response = await listResponse(routes, who, query);
			expect(response.status, label).toBe(400);
			expect(response.body.error?.code, label).toBe('CURSOR_INVALID');
		}
		const unknownSort = await listResponse(routes, actor, '?sort=title');
		expect(unknownSort.status).toBe(400);
		expect(unknownSort.body.error?.code).toBe('INVALID_INPUT');
		const badCategory = await listResponse(routes, actor, '?category=lodging');
		expect(badCategory.status).toBe(400);
		expect(badCategory.body.error?.code).toBe('INVALID_CLAIM_CATEGORY');
	});

	it('narrows by status, category and a title search in SQL', async () => {
		const { runtime, expenses, claims } = await seeded();
		const actor = principal([EXPENSES_PERMISSIONS.read]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		await expenses.submit('tenant-a', 'account-a', claims[0]!.id, TEST_ACTOR);
		await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: '100% reimbursed' }),
			TEST_ACTOR,
		);

		expect(
			await walk(routes, actor, 'createdAt', 'desc', 10, '&status=submitted'),
		).toEqual([claims[0]!.id]);
		expect(
			await walk(routes, actor, 'createdAt', 'asc', 10, '&category=meals'),
		).toEqual([claims[1]!.id, claims[3]!.id]);
		expect(
			await walk(routes, actor, 'createdAt', 'asc', 10, '&q=CLAIM%204'),
		).toEqual([claims[4]!.id]);
		expect(
			(await walk(routes, actor, 'createdAt', 'asc', 10, '&q=100%25')).length,
		).toBe(1);
		expect(
			await walk(routes, actor, 'createdAt', 'asc', 10, '&q=%25'),
		).toHaveLength(1);
	});

	it('shows an approver their own claims and every submitted one in the tenant', async () => {
		const { runtime, expenses, claims } = await seeded();
		const other = await expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Other submitted' }),
			TEST_ACTOR,
		);
		await expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Other draft' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-b', other.id, TEST_ACTOR);
		const foreign = await expenses.create(
			'tenant-b',
			'account-c',
			input(),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-b', 'account-c', foreign.id, TEST_ACTOR);
		const approver = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.approve,
		]);
		const routes = createExpensesRoutes(authRuntime(approver), runtime);

		expect(
			[...(await walk(routes, approver, 'createdAt', 'asc', 10))].sort(),
		).toEqual([...claims.map((claim) => claim.id), other.id].sort());
		const queue = await listResponse(
			routes,
			approver,
			'?status=draft',
			'/api/expenses/claims/approval-queue',
		);
		expect(queue.body.items!.map((claim) => claim.id)).toEqual([other.id]);
	});
});

describe('expenses.core list export', () => {
	function composition(lists: DefinedListExport[] | null) {
		const registry = {
			get: <T>(id: string): T | null =>
				lists !== null && id === 'exports.lists.v1'
					? ({
							register: (
								moduleId: string,
								registered: readonly DefinedListExport[],
							) => {
								expect(moduleId).toBe('expenses.core');
								lists.push(...registered);
							},
						} as T)
					: null,
		};
		return async (provider: Awaited<ReturnType<typeof expensesTestProvider>>) =>
			createServerComposition({
				databases: provider,
				environment: { NODE_ENV: 'test' },
				auth: authRuntime(principal([])),
				dataClasses: { declare: () => undefined },
				capabilities: registry,
			} as never);
	}

	it('registers expenses.core.claims once and streams every visible row in pages', async () => {
		const provider = await expensesTestProvider();
		const runtime = createExpensesRuntime({
			databases: provider,
			purpose: 'test',
		});
		const expenses = await runtime.service();
		for (let index = 0; index < 3; index += 1) {
			await expenses.create(
				'tenant-a',
				'account-a',
				input({ title: `Row ${index}`, amountMinor: 100 + index }),
				TEST_ACTOR,
			);
		}
		const foreign = await expenses.create(
			'tenant-b',
			'account-b',
			input({ title: 'Foreign' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-b', 'account-b', foreign.id, TEST_ACTOR);
		const lists: DefinedListExport[] = [];
		const composed = await composition(lists)(provider);
		composed.start?.();
		expect(lists.map((list) => list.id)).toEqual([
			EXPENSES_CLAIMS_EXPORT_LIST_ID,
		]);
		const list = lists[0]!;
		expect(list.permission).toBe(EXPENSES_PERMISSIONS.read);
		expect(list.columns.map((column) => column.key)).toEqual([
			'title',
			'claimant',
			'amountMinor',
			'currency',
			'category',
			'expenseDate',
			'status',
			'decisionComment',
		]);

		const reader = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.approve,
		]);
		const records: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		for (;;) {
			const page = await list.page(reader, cursor, 2);
			pages += 1;
			records.push(...page.records);
			expect(page.rows).toBeLessThanOrEqual(2);
			cursor = page.nextCursor;
			if (cursor === null) break;
		}
		expect(pages).toBe(2);
		expect(records).toHaveLength(3);
		expect(records.join('')).toContain(
			'Row 2,account-a,102,EUR,travel,2026-08-20,draft,',
		);
		expect(records.join('')).not.toContain('Foreign');
		await composed.dispose?.();
	});

	it('composes without exports.core and registers nothing', async () => {
		const provider = await expensesTestProvider();
		const composed = await composition(null)(provider);
		composed.start?.();
		expect(composed.routes.length).toBeGreaterThan(0);
		await composed.dispose?.();
	});
});

describe('expenses.core bulk endpoints', () => {
	async function bulkFixture() {
		const runtime = createExpensesRuntime({
			databases: await expensesTestProvider(),
			purpose: 'test',
		});
		const expenses = await runtime.service();
		const submittedA = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'A' }),
			TEST_ACTOR,
		);
		const submittedB = await expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'B' }),
			TEST_ACTOR,
		);
		const draft = await expenses.create(
			'tenant-a',
			'account-a',
			input({ title: 'Draft' }),
			TEST_ACTOR,
		);
		const otherDraft = await expenses.create(
			'tenant-a',
			'account-b',
			input({ title: 'Other draft' }),
			TEST_ACTOR,
		);
		const foreign = await expenses.create(
			'tenant-b',
			'account-c',
			input({ title: 'Foreign' }),
			TEST_ACTOR,
		);
		await expenses.submit('tenant-a', 'account-a', submittedA.id, TEST_ACTOR);
		await expenses.submit('tenant-a', 'account-b', submittedB.id, TEST_ACTOR);
		await expenses.submit('tenant-b', 'account-c', foreign.id, TEST_ACTOR);
		return {
			runtime,
			expenses,
			submittedA,
			submittedB,
			draft,
			otherDraft,
			foreign,
		};
	}

	async function post(
		routes: readonly ExpenseRoute[],
		actor: AuthPrincipal,
		path: string,
		body: unknown,
		csrf?: string,
	) {
		const response = await route(routes, path, 'POST').handler(
			context(mutationRequest(path, body, csrf), actor),
		);
		return {
			status: response.status,
			body: (await response.json()) as {
				readonly outcomes?: readonly {
					id: string;
					outcome: string;
					reason?: string;
				}[];
				readonly error?: { readonly code: string };
			},
		};
	}

	it('bounds the ids and refuses a bad CSRF token before any row changes', async () => {
		const { runtime, expenses, submittedA } = await bulkFixture();
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.approve,
		]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);
		const path = '/api/expenses/claims/approve-many';

		for (const [label, body] of [
			['empty', { claimIds: [] }],
			['not an array', { claimIds: submittedA.id }],
			[
				'too many',
				{ claimIds: Array.from({ length: 101 }, (_, index) => `id-${index}`) },
			],
			['repeated', { claimIds: [submittedA.id, submittedA.id] }],
			['blank id', { claimIds: [''] }],
		] as const) {
			const response = await post(routes, actor, path, body);
			expect(response.status, label).toBe(400);
			expect(response.body.error?.code, label).toBe('INVALID_INPUT');
		}
		const csrf = await post(
			routes,
			actor,
			path,
			{ claimIds: [submittedA.id] },
			'wrong-token',
		);
		expect(csrf.status).toBe(403);
		expect(csrf.body.error?.code).toBe('CSRF_REJECTED');
		expect(await expenses.countAwaitingApproval('tenant-a')).toBe(2);
	});

	it('decides per id with a missing, a foreign-tenant and an undecidable id counted, and one history version per row', async () => {
		const { runtime, expenses, submittedA, submittedB, draft, foreign } =
			await bulkFixture();
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.approve,
		]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const approved = await post(
			routes,
			actor,
			'/api/expenses/claims/approve-many',
			{
				claimIds: [
					submittedA.id,
					'missing',
					foreign.id,
					draft.id,
					submittedB.id,
				],
				comment: 'Quarter close',
			},
		);
		expect(approved.status).toBe(200);
		expect(approved.body.outcomes).toEqual([
			{ id: submittedA.id, outcome: 'updated' },
			{ id: 'missing', outcome: 'not-found' },
			{ id: foreign.id, outcome: 'not-found' },
			{ id: draft.id, outcome: 'refused', reason: 'CLAIM_NOT_SUBMITTED' },
			{ id: submittedB.id, outcome: 'updated' },
		]);
		for (const id of [submittedA.id, submittedB.id]) {
			const history = await expenses.history('tenant-a', 'account-a', true, {
				recordId: id,
				limit: 5,
				cursor: null,
			});
			expect(history.entries[0]).toMatchObject({
				action: 'approved',
				changes: {
					status: { from: 'submitted', to: 'approved' },
					decisionComment: { from: null, to: 'Quarter close' },
				},
			});
		}
		expect(
			(
				await expenses.history('tenant-b', 'account-c', true, {
					recordId: foreign.id,
					limit: 5,
					cursor: null,
				})
			).entries[0]?.action,
		).toBe('submitted');
		expect(await expenses.countAwaitingApproval('tenant-a')).toBe(0);
	});

	it('records the default bulk comment when a rejection carries none', async () => {
		const { runtime, expenses, submittedA } = await bulkFixture();
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.approve,
		]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const rejected = await post(
			routes,
			actor,
			'/api/expenses/claims/reject-many',
			{
				claimIds: [submittedA.id],
				comment: '   ',
			},
		);
		expect(rejected.status).toBe(200);
		expect(rejected.body.outcomes).toEqual([
			{ id: submittedA.id, outcome: 'updated' },
		]);
		expect(
			await all(expenses, 'tenant-a', 'account-a', 'rejected', false),
		).toMatchObject([
			{ id: submittedA.id, decisionComment: BULK_DECISION_COMMENTS.rejected },
		]);
	});

	it('submits the claimant own drafts per id and refuses the rest', async () => {
		const { runtime, expenses, draft, otherDraft, submittedA, foreign } =
			await bulkFixture();
		const actor = principal([
			EXPENSES_PERMISSIONS.read,
			EXPENSES_PERMISSIONS.manage,
		]);
		const routes = createExpensesRoutes(authRuntime(actor), runtime);

		const submitted = await post(
			routes,
			actor,
			'/api/expenses/claims/submit-many',
			{
				claimIds: [
					draft.id,
					otherDraft.id,
					submittedA.id,
					foreign.id,
					'missing',
				],
			},
		);
		expect(submitted.status).toBe(200);
		expect(submitted.body.outcomes).toEqual([
			{ id: draft.id, outcome: 'updated' },
			{ id: otherDraft.id, outcome: 'refused', reason: 'CLAIM_NOT_OWNED' },
			{ id: submittedA.id, outcome: 'refused', reason: 'CLAIM_NOT_DRAFT' },
			{ id: foreign.id, outcome: 'not-found' },
			{ id: 'missing', outcome: 'not-found' },
		]);
		expect(await expenses.countAwaitingApproval('tenant-a')).toBe(3);
		expect(
			(
				await expenses.history('tenant-a', 'account-a', false, {
					recordId: draft.id,
					limit: 5,
					cursor: null,
				})
			).entries[0]?.action,
		).toBe('submitted');
	});
});
