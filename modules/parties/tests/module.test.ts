import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@flowdular/module-auth/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PARTY_PERMISSIONS } from '../src/acl/permissions.ts';
import { createPartyRoutes } from '../src/api/endpoints.ts';
import { filterParties } from '../src/client/party-list.ts';
import { moduleDefinition } from '../src/index.ts';
import {
	createPartiesRuntime,
	type PartiesRuntime,
} from '../src/server/runtime.ts';
import {
	PartiesService,
	PartyServiceError,
} from '../src/services/parties-service.ts';
import {
	closePartiesTestDatabases,
	createPartiesTestDatabase,
	partiesTestProvider,
	type PartiesTestDatabase,
} from './support/database.ts';

const ORIGIN = 'https://erp.example';
const CSRF_TOKEN = 'parties-test-csrf';
const TEST_ACTOR = { kind: 'user', id: 'account-1', label: 'Owner' } as const;

const databases = new Set<PartiesTestDatabase>();
const runtimes = new Set<PartiesRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
	await Promise.all([...databases].map((database) => database.dispose()));
	databases.clear();
});

afterAll(closePartiesTestDatabases);

async function partiesFixture(): Promise<PartiesTestDatabase> {
	const database = await createPartiesTestDatabase();
	databases.add(database);
	return database;
}

async function partiesService(): Promise<PartiesService> {
	return new PartiesService((await partiesFixture()).repository);
}

async function partiesRuntime(): Promise<PartiesRuntime> {
	const runtime = createPartiesRuntime({
		databases: await partiesTestProvider(),
		purpose: 'test',
	});
	runtimes.add(runtime);
	return runtime;
}

function testContext(request: Request) {
	return {
		request,
		params: {},
		url: new URL(request.url),
		state: new Map<string, unknown>(),
	};
}

function principal(scopes: readonly string[], tenantId = 'tenant-a') {
	return {
		accountId: 'account-1',
		tenantId,
		email: 'owner@example.com',
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [
			{
				tenantId,
				name: 'Tenant',
				slug: 'tenant',
				role: 'owner',
			},
		],
	};
}

/* auth.core resolves the browser session in its middleware and publishes it in
   context state; sessionMutationDenial reads it from there. The key is not yet
   exported from @flowdular/module-auth/server, so this double mirrors it. */
const AUTH_SESSION_STATE_KEY = 'flowdular.auth.session';

function signIn(
	context: { state: Map<string, unknown> },
	actor: ReturnType<typeof principal>,
): void {
	context.state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
	context.state.set(AUTH_SESSION_STATE_KEY, {
		principal: actor,
		csrfToken: CSRF_TOKEN,
		expiresAt: Date.now() + 60_000,
		sessionId: 'session-id',
		passwordChangeRequired: false,
	});
}

function authenticatedContext(
	path: string,
	body: Readonly<Record<string, unknown>>,
	tenantId = 'tenant-a',
) {
	const context = testContext(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				cookie: 'parties_test_session=session-token',
				origin: ORIGIN,
				'x-csrf-token': CSRF_TOKEN,
			},
			body: JSON.stringify(body),
		}),
	);
	signIn(context, principal([PARTY_PERMISSIONS.manage], tenantId));
	return context;
}

function testAuthRuntime(): AuthRuntime {
	return {
		cookie: { name: 'parties_test_session' },
		authorizeAgentToolAccess: () => [],
		service: () => ({
			resolveSession: () => ({ csrfToken: CSRF_TOKEN }),
		}),
	} as unknown as AuthRuntime;
}

async function serviceError(action: () => unknown): Promise<PartyServiceError> {
	try {
		await action();
	} catch (error) {
		if (error instanceof PartyServiceError) return error;
		throw error;
	}
	throw new Error('Expected a PartyServiceError.');
}

describe('parties.core', () => {
	it('exports its validated identity', async () => {
		expect(moduleDefinition.manifest.id).toBe('parties.core');
	});

	it('isolates party lists by trusted tenant id', async () => {
		const service = await partiesService();
		await service.create(
			'tenant-a',
			{ name: 'Acme', kind: 'customer' },
			TEST_ACTOR,
		);
		await service.create(
			'tenant-b',
			{ name: 'Beta', kind: 'supplier' },
			TEST_ACTOR,
		);

		expect((await service.list('tenant-a')).map((party) => party.name)).toEqual(
			['Acme'],
		);
		expect((await service.list('tenant-b')).map((party) => party.name)).toEqual(
			['Beta'],
		);
	});

	it('stores optional VAT identifiers on create and update', async () => {
		const service = await partiesService();
		const created = await service.create(
			'tenant-a',
			{
				name: 'Acme',
				kind: 'customer',
				vatId: '  PL123ABC456  ',
			},
			TEST_ACTOR,
		);
		expect(created.vatId).toBe('PL123ABC456');

		const updated = await service.update(
			'tenant-a',
			{
				id: created.id,
				name: 'Acme updated',
				kind: 'both',
				email: 'SALES@EXAMPLE.COM',
				phone: '123456789',
				vatId: '',
			},
			TEST_ACTOR,
		);
		expect(updated).toMatchObject({
			id: created.id,
			name: 'Acme updated',
			kind: 'both',
			email: 'sales@example.com',
			phone: '123456789',
			vatId: null,
			status: 'active',
			createdAt: created.createdAt,
		});
		expect(await service.list('tenant-a')).toEqual([updated]);
	});

	/* PostgreSQL hands BIGINT back as a string; an unnormalized read would
	   surface the creation timestamp as text. */
	it('reads the creation timestamp back as a number', async () => {
		const service = await partiesService();
		const created = await service.create(
			'tenant-a',
			{ name: 'Acme', kind: 'customer' },
			TEST_ACTOR,
		);

		const listed = (await service.list('tenant-a'))[0];
		expect(typeof listed?.createdAt).toBe('number');
		expect(listed?.createdAt).toBe(created.createdAt);
	});

	it('filters parties by text and VAT identifier presence', async () => {
		const service = await partiesService();
		await service.create(
			'tenant-a',
			{
				name: 'Acme',
				kind: 'customer',
				email: 'billing@acme.example',
				vatId: 'PL123ABC',
			},
			TEST_ACTOR,
		);
		await service.create(
			'tenant-a',
			{
				name: 'Beta',
				kind: 'supplier',
				email: 'contact@beta.example',
			},
			TEST_ACTOR,
		);
		await service.create(
			'tenant-a',
			{
				name: 'Shared',
				kind: 'both',
			},
			TEST_ACTOR,
		);
		const parties = await service.list('tenant-a');

		expect(
			filterParties(parties, 'beta', false).map((party) => party.name),
		).toEqual(['Beta']);
		expect(
			filterParties(parties, 'billing', false).map((party) => party.name),
		).toEqual(['Acme']);
		expect(
			filterParties(parties, 'pl123', false).map((party) => party.name),
		).toEqual(['Acme']);
		expect(filterParties(parties, '', true).map((party) => party.name)).toEqual(
			['Acme'],
		);
		expect(filterParties(parties, 'beta', true)).toEqual([]);
		expect(
			filterParties(parties, '', false, 'customer').map((party) => party.name),
		).toEqual(['Acme', 'Shared']);
		expect(
			filterParties(parties, '', false, 'supplier').map((party) => party.name),
		).toEqual(['Beta', 'Shared']);
	});

	it.each(['PL-123', 'A'.repeat(21)])(
		'rejects invalid VAT identifier %s with a stable code',
		async (vatId) => {
			const service = await partiesService();
			const error = await serviceError(() =>
				service.create(
					'tenant-a',
					{
						name: 'Acme',
						kind: 'customer',
						vatId,
					},
					TEST_ACTOR,
				),
			);
			expect(error).toMatchObject({ code: 'INVALID_VAT_ID', status: 400 });
		},
	);

	it('does not update a party through another tenant', async () => {
		const service = await partiesService();
		const party = await service.create(
			'tenant-b',
			{
				name: 'Beta',
				kind: 'supplier',
				vatId: 'GB123',
			},
			TEST_ACTOR,
		);
		const error = await serviceError(() =>
			service.update(
				'tenant-a',
				{
					id: party.id,
					name: 'Changed',
					kind: 'both',
					vatId: 'PL999',
				},
				TEST_ACTOR,
			),
		);
		expect(error).toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
		expect(await service.list('tenant-b')).toMatchObject([
			{ id: party.id, name: 'Beta', vatId: 'GB123' },
		]);
	});

	it('archives, restores, and permanently deletes only archived records', async () => {
		const service = await partiesService();
		const party = await service.create(
			'tenant-a',
			{ name: 'Acme', kind: 'customer' },
			TEST_ACTOR,
		);

		const activeDelete = await serviceError(() =>
			service.delete('tenant-a', party.id, TEST_ACTOR),
		);
		expect(activeDelete).toMatchObject({
			code: 'PARTY_NOT_ARCHIVED',
			status: 409,
		});

		expect(
			(await service.archive('tenant-a', party.id, TEST_ACTOR)).status,
		).toBe('archived');
		expect(
			(await service.restore('tenant-a', party.id, TEST_ACTOR)).status,
		).toBe('active');
		await service.archive('tenant-a', party.id, TEST_ACTOR);
		await service.delete('tenant-a', party.id, TEST_ACTOR);

		expect(await service.list('tenant-a')).toEqual([]);
		expect(
			(
				await service.history('tenant-a', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
			).entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'restored', 'archived', 'created']);
	});

	it('keeps lifecycle mutations and history isolated by tenant and actor', async () => {
		const service = await partiesService();
		const party = await service.create(
			'tenant-b',
			{ name: 'Beta', kind: 'supplier' },
			TEST_ACTOR,
		);
		const agent = {
			kind: 'agent',
			id: 'agent-1',
			label: 'Supplier curator',
			runId: 'run-1',
		} as const;

		const error = await serviceError(() =>
			service.archive('tenant-a', party.id, agent),
		);
		expect(error).toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
		expect((await service.list('tenant-b'))[0]?.status).toBe('active');

		await service.archive('tenant-b', party.id, agent);
		expect(
			(
				await service.history('tenant-a', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
			).entries,
		).toEqual([]);
		expect(
			(
				await service.history('tenant-b', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
			).entries[0]?.actor,
		).toEqual(agent);
	});

	it('round-trips a service actor with its configuring user', async () => {
		const service = await partiesService();
		const actor = {
			kind: 'service',
			id: 'workflow:party-sync',
			label: 'Party sync',
			configuredBy: {
				kind: 'user',
				id: 'account-1',
				label: 'Owner',
			},
		} as const;
		const party = await service.create(
			'tenant-a',
			{ name: 'Workflow party', kind: 'customer' },
			actor,
		);

		expect(
			(
				await service.history('tenant-a', {
					recordId: party.id,
					limit: 10,
					cursor: null,
				})
			).entries[0]?.actor,
		).toEqual(actor);
	});

	/* Forced row-level security is the last boundary under the tenant predicate:
	   the runtime role must not be able to write a row it does not own. */
	it('refuses a write that forced row security assigns to another tenant', async () => {
		const database = await partiesFixture();

		await expect(
			database.runtime.transaction(
				(transaction) =>
					transaction.execute({
						text: `INSERT INTO parties
							 (id, tenant_id, name, kind, email, phone, vat_id, status, created_at)
							 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
						parameters: [
							'forged',
							'tenant-b',
							'Forged',
							'customer',
							null,
							null,
							null,
							'active',
							Date.now(),
						],
					}),
				{ access: 'write', tenantId: 'tenant-a' },
			),
		).rejects.toBeDefined();
	});

	it('refuses any runtime statement without a tenant context', async () => {
		const database = await partiesFixture();

		await expect(
			database.runtime.transaction(async () => undefined, { access: 'read' }),
		).rejects.toMatchObject({ code: 'TENANT_CONTEXT_REQUIRED' });
	});

	it('returns VAT identifiers from create and update endpoints', async () => {
		const runtime = await partiesRuntime();
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const createdResponse = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Acme',
				kind: 'customer',
				vatId: 'PL123',
			}),
		);
		expect(createdResponse.status).toBe(201);
		const createdBody = (await createdResponse.json()) as {
			party: { id: string; vatId: string | null };
		};
		expect(createdBody.party.vatId).toBe('PL123');

		const update = routes.find(
			(route) =>
				route.path === '/api/parties/update' && route.methods.includes('POST'),
		)!;
		const updatedResponse = await update.handler(
			authenticatedContext('/api/parties/update', {
				id: createdBody.party.id,
				name: 'Acme',
				kind: 'both',
				vatId: 'PL456',
			}),
		);
		expect(updatedResponse.status).toBe(200);
		expect(await updatedResponse.json()).toMatchObject({
			party: { id: createdBody.party.id, vatId: 'PL456' },
		});
	});

	it('rejects invalid VAT characters at the HTTP boundary', async () => {
		const runtime = await partiesRuntime();
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const response = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Acme',
				kind: 'customer',
				vatId: 'PL-123',
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_VAT_ID' },
		});
	});

	it('applies the full lifecycle through tenant-scoped guarded endpoints', async () => {
		const runtime = await partiesRuntime();
		const routes = createPartyRoutes(testAuthRuntime(), runtime);
		const create = routes.find(
			(route) =>
				route.path === '/api/parties' && route.methods.includes('POST'),
		)!;
		const created = await create.handler(
			authenticatedContext('/api/parties', {
				name: 'Lifecycle party',
				kind: 'both',
			}),
		);
		const party = ((await created.json()) as { party: { id: string } }).party;

		const endpoint = (path: string) =>
			routes.find(
				(route) => route.path === path && route.methods.includes('POST'),
			)!;
		const foreignArchive = await endpoint('/api/parties/archive').handler(
			authenticatedContext(
				'/api/parties/archive',
				{ id: party.id },
				'tenant-b',
			),
		);
		expect(foreignArchive.status).toBe(404);

		const activeDelete = await endpoint('/api/parties/delete').handler(
			authenticatedContext('/api/parties/delete', { id: party.id }),
		);
		expect(activeDelete.status).toBe(409);
		expect(await activeDelete.json()).toMatchObject({
			error: { code: 'PARTY_NOT_ARCHIVED' },
		});

		for (const action of ['archive', 'restore', 'archive'] as const) {
			const response = await endpoint(`/api/parties/${action}`).handler(
				authenticatedContext(`/api/parties/${action}`, { id: party.id }),
			);
			expect(response.status, action).toBe(200);
		}
		const removed = await endpoint('/api/parties/delete').handler(
			authenticatedContext('/api/parties/delete', { id: party.id }),
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ deleted: true });
		await expect(
			(await runtime.service()).get('tenant-a', party.id),
		).resolves.toBeNull();
		expect(
			(
				await (
					await runtime.service()
				).history('tenant-a', {
					recordId: party.id,
					limit: 20,
					cursor: null,
				})
			).entries.map((entry) => entry.action),
		).toEqual(['deleted', 'archived', 'restored', 'archived', 'created']);
	});

	it.each([
		['list', '/api/parties', 'GET'],
		['create', '/api/parties', 'POST'],
		['update', '/api/parties/update', 'POST'],
		['archive', '/api/parties/archive', 'POST'],
		['restore', '/api/parties/restore', 'POST'],
		['delete', '/api/parties/delete', 'POST'],
		['history', '/api/parties/history', 'GET'],
	] as const)(
		'denies unauthenticated %s requests',
		async (_name, path, method) => {
			const routes = createPartyRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				await partiesRuntime(),
			);
			const route = routes.find(
				(candidate) =>
					candidate.path === path && candidate.methods.includes(method),
			)!;
			const response = await route.handler(
				testContext(new Request(`${ORIGIN}${path}`, { method })),
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({
				error: { code: 'UNAUTHENTICATED' },
			});
		},
	);

	it.each([
		['list', '/api/parties', 'GET'],
		['create', '/api/parties', 'POST'],
		['update', '/api/parties/update', 'POST'],
		['archive', '/api/parties/archive', 'POST'],
		['restore', '/api/parties/restore', 'POST'],
		['delete', '/api/parties/delete', 'POST'],
		['history', '/api/parties/history', 'GET'],
	] as const)(
		'denies unauthorized %s requests',
		async (_name, path, method) => {
			const routes = createPartyRoutes(
				{ authorizeAgentToolAccess: () => [] } as unknown as AuthRuntime,
				await partiesRuntime(),
			);
			const route = routes.find(
				(candidate) =>
					candidate.path === path && candidate.methods.includes(method),
			)!;
			const context = testContext(new Request(`${ORIGIN}${path}`, { method }));
			signIn(context, principal([]));
			const response = await route.handler(context);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: 'FORBIDDEN' },
			});
		},
	);

	it.each([
		['archive', '/api/parties/archive'],
		['restore', '/api/parties/restore'],
		['delete', '/api/parties/delete'],
	] as const)('requires CSRF protection for %s', async (_name, path) => {
		const routes = createPartyRoutes(testAuthRuntime(), await partiesRuntime());
		const route = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes('POST'),
		)!;
		const context = testContext(
			new Request(`${ORIGIN}${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie: 'parties_test_session=session-token',
					origin: ORIGIN,
				},
				body: JSON.stringify({ id: 'party-1' }),
			}),
		);
		signIn(context, principal([PARTY_PERMISSIONS.manage]));
		const response = await route.handler(context);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: 'CSRF_REJECTED' },
		});
	});
});
