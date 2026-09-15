import {
	AUTH_PRINCIPAL_STATE_KEY,
	type AuthRuntime,
} from '@flowdular/sdk/modules/auth/server';
import { createExportListRegistry } from '@flowdular/sdk/modules/exports/server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PARTY_PERMISSIONS } from '../src/acl/permissions.ts';
import { createPartyRoutes } from '../src/api/endpoints.ts';
import { createPartyListing } from '../src/api/listing.ts';
import { PARTY_EXPORT_LIST_ID } from '../src/domain/lists.ts';
import type { DatabaseProvider } from '@flowdular/sdk/database';
import type { Party, PartyBulkOutcome } from '../src/domain/types.ts';
import { createServerComposition } from '../src/platform.ts';
import {
	createPartiesRuntime,
	type PartiesRuntime,
} from '../src/server/runtime.ts';
import { createPartyListExport } from '../src/services/list-export.ts';
import {
	closePartiesTestDatabases,
	listAll,
	partiesTestProvider,
} from './support/database.ts';

const ORIGIN = 'https://erp.example';
const CSRF_TOKEN = 'parties-test-csrf';
const ACTOR = { kind: 'user', id: 'account-1', label: 'Owner' } as const;
const AUTH_SESSION_STATE_KEY = 'flowdular.auth.session';

const runtimes = new Set<PartiesRuntime>();

afterEach(async () => {
	await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
	runtimes.clear();
});

afterAll(closePartiesTestDatabases);

/* partiesTestProvider empties every table, so a test takes the provider once
   and reads through it afterwards. */
async function partiesRuntime(): Promise<{
	readonly runtime: PartiesRuntime;
	readonly provider: DatabaseProvider;
}> {
	const provider = await partiesTestProvider();
	const runtime = createPartiesRuntime({
		databases: provider,
		purpose: 'test',
	});
	runtimes.add(runtime);
	return { runtime, provider };
}

async function query<Row extends object>(
	provider: DatabaseProvider,
	text: string,
	parameters: readonly string[] = [],
): Promise<readonly Row[]> {
	const lease = await provider.acquire({
		namespace: 'parties.core',
		purpose: 'test',
	});
	try {
		return (
			await lease.database.transaction(
				(transaction) => transaction.query<Row>({ text, parameters }),
				{ access: 'read', tenantId: 'tenant-a' },
			)
		).rows;
	} finally {
		await lease.release();
	}
}

function sqlOrder(
	provider: DatabaseProvider,
	orderBy: string,
): Promise<readonly string[]> {
	return query<{ id: string }>(
		provider,
		`SELECT id FROM parties WHERE tenant_id = $1 ORDER BY ${orderBy}`,
		['tenant-a'],
	).then((rows) => rows.map((row) => row.id));
}

function principal(scopes: readonly string[], tenantId = 'tenant-a') {
	return {
		accountId: 'account-1',
		tenantId,
		email: 'owner@example.com',
		displayName: 'Owner',
		role: 'owner',
		scopes,
		tenants: [{ tenantId, name: 'Tenant', slug: 'tenant', role: 'owner' }],
	};
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

function context(request: Request, actor: ReturnType<typeof principal>) {
	const state = new Map<string, unknown>();
	state.set(AUTH_PRINCIPAL_STATE_KEY, actor);
	state.set(AUTH_SESSION_STATE_KEY, {
		principal: actor,
		csrfToken: CSRF_TOKEN,
		expiresAt: Date.now() + 60_000,
		sessionId: 'session-id',
		passwordChangeRequired: false,
	});
	return { request, params: {}, url: new URL(request.url), state };
}

interface ListBody {
	items: readonly Party[];
	page: { nextCursor: string | null; limit: number };
	error?: { code: string };
}

async function listFixture() {
	const { runtime, provider } = await partiesRuntime();
	const routes = createPartyRoutes(testAuthRuntime(), runtime);
	const list = routes.find(
		(route) => route.path === '/api/parties' && route.methods.includes('GET'),
	)!;
	const get = async (query: Record<string, string>, tenantId = 'tenant-a') => {
		const response = await list.handler(
			context(
				new Request(`${ORIGIN}/api/parties?${new URLSearchParams(query)}`),
				principal([PARTY_PERMISSIONS.read], tenantId),
			),
		);
		return {
			status: response.status,
			body: (await response.json()) as ListBody,
		};
	};
	const post = async (path: string, body: unknown, tenantId = 'tenant-a') => {
		const route = routes.find(
			(candidate) =>
				candidate.path === path && candidate.methods.includes('POST'),
		)!;
		const response = await route.handler(
			context(
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
				principal([PARTY_PERMISSIONS.manage], tenantId),
			),
		);
		return {
			status: response.status,
			body: (await response.json()) as {
				outcomes?: readonly PartyBulkOutcome[];
				error?: { code: string };
			},
		};
	};
	return { provider, service: await runtime.service(), get, post };
}

const NAMES = ['delta', 'Alpha', 'charlie', 'Bravo', 'echo', 'Foxtrot', 'golf'];

async function seed(
	service: Awaited<ReturnType<typeof listFixture>>['service'],
) {
	const created: Party[] = [];
	for (const name of NAMES) {
		created.push(
			await service.create('tenant-a', { name, kind: 'customer' }, ACTOR),
		);
	}
	await service.create(
		'tenant-b',
		{ name: 'Aardvark', kind: 'supplier' },
		ACTOR,
	);
	return created;
}

/* Tampering flips the first character of one cursor segment. */
function flip(cursor: string, segment: number): string {
	const parts = cursor.split('.');
	const target = parts[segment]!;
	parts[segment] = (target[0] === 'A' ? 'B' : 'A') + target.slice(1);
	return parts.join('.');
}

describe('parties list', () => {
	it('pages the tenant in lower-cased name order without overlap or gap', async () => {
		const { provider, service, get } = await listFixture();
		await seed(service);

		const first = await get({ limit: '3' });
		expect(first.status).toBe(200);
		expect(first.body.items.map((party) => party.name)).toEqual([
			'Alpha',
			'Bravo',
			'charlie',
		]);
		expect(first.body.page.limit).toBe(3);
		expect(first.body.page.nextCursor).not.toBeNull();

		const second = await get({
			limit: '3',
			cursor: first.body.page.nextCursor!,
		});
		expect(second.body.items.map((party) => party.name)).toEqual([
			'delta',
			'echo',
			'Foxtrot',
		]);
		expect(second.body.page.nextCursor).not.toBeNull();

		const third = await get({
			limit: '3',
			cursor: second.body.page.nextCursor!,
		});
		expect(third.body.items.map((party) => party.name)).toEqual(['golf']);
		expect(third.body.page.nextCursor).toBeNull();

		const walked = [
			...first.body.items,
			...second.body.items,
			...third.body.items,
		];
		expect(walked.map((party) => party.id)).toEqual(
			await sqlOrder(provider, 'lower(name), id'),
		);
		expect(walked).toEqual(await listAll(service, 'tenant-a'));

		/* A full page with nothing behind it carries no cursor. */
		const exact = await get({ limit: '7' });
		expect(exact.body.items).toHaveLength(7);
		expect(exact.body.page.nextCursor).toBeNull();
		expect((await get({})).body.page.limit).toBe(50);
	});

	it('orders by the last update in either direction and pages by it', async () => {
		const { provider, service, get } = await listFixture();
		const created = await seed(service);
		await service.update(
			'tenant-a',
			{ id: created[3]!.id, name: 'Bravo renamed', kind: 'customer' },
			ACTOR,
		);

		const newest = await get({
			sort: 'updatedAt',
			direction: 'desc',
			limit: '4',
		});
		expect(newest.body.items[0]?.name).toBe('Bravo renamed');
		const rest = await get({
			sort: 'updatedAt',
			direction: 'desc',
			limit: '4',
			cursor: newest.body.page.nextCursor!,
		});
		expect(rest.body.page.nextCursor).toBeNull();
		expect(
			[...newest.body.items, ...rest.body.items].map((party) => party.id),
		).toEqual(await sqlOrder(provider, 'updated_at DESC, id DESC'));

		const oldest = await get({
			sort: 'updatedAt',
			direction: 'asc',
			limit: '10',
		});
		expect(oldest.body.items.map((party) => party.id)).toEqual(
			await sqlOrder(provider, 'updated_at ASC, id ASC'),
		);
		const byNameDesc = await get({ direction: 'desc', limit: '10' });
		expect(byNameDesc.body.items.map((party) => party.id)).toEqual(
			await sqlOrder(provider, 'lower(name) DESC, id DESC'),
		);
	});

	it('pushes the kind, status, VAT and search filters into the read', async () => {
		const { service, get } = await listFixture();
		const acme = await service.create(
			'tenant-a',
			{ name: 'Acme', kind: 'both', phone: '+48 600 100 200', vatId: 'PL123' },
			ACTOR,
		);
		await service.create(
			'tenant-a',
			{ name: 'Beta', kind: 'supplier', email: 'hello@beta.example' },
			ACTOR,
		);
		await service.archive('tenant-a', acme.id, ACTOR);

		const names = async (query: Record<string, string>) =>
			(await get(query)).body.items.map((party) => party.name);
		expect(await names({ kind: 'customer' })).toEqual(['Acme']);
		expect(await names({ kind: 'supplier' })).toEqual(['Acme', 'Beta']);
		expect(await names({ status: 'active' })).toEqual(['Beta']);
		expect(await names({ q: '600 100' })).toEqual(['Acme']);
		expect(await names({ q: 'BETA.example' })).toEqual(['Beta']);
		expect(await names({ q: '_' })).toEqual([]);
		expect(await names({ hasVatId: 'true' })).toEqual(['Acme']);
	});

	it('refuses a tampered, foreign, refiltered or resorted cursor and bad input', async () => {
		const { service, get } = await listFixture();
		await seed(service);
		const cursor = (await get({ limit: '2' })).body.page.nextCursor!;

		for (const segment of [0, 1, 2]) {
			const tampered = await get({ limit: '2', cursor: flip(cursor, segment) });
			expect(tampered.status, `segment ${segment}`).toBe(400);
			expect(tampered.body.error?.code).toBe('CURSOR_INVALID');
		}
		const refused = [
			await get({ limit: '2', cursor }, 'tenant-b'),
			await get({ limit: '2', cursor, status: 'archived' }),
			await get({ limit: '2', cursor, q: 'a' }),
			await get({ limit: '2', cursor, sort: 'updatedAt' }),
			await get({ limit: '2', cursor, direction: 'desc' }),
		];
		for (const response of refused) {
			expect(response.status).toBe(400);
			expect(response.body.error?.code).toBe('CURSOR_INVALID');
		}
		/* The same cursor still opens the page it was issued for. */
		expect((await get({ limit: '2', cursor })).status).toBe(200);

		for (const query of [
			{ sort: 'email' },
			{ direction: 'up' },
			{ kind: 'partner' },
			{ status: 'deleted' },
			{ hasVatId: 'yes' },
			{ limit: '0' },
			{ limit: '201' },
			{ q: 'x'.repeat(121) },
		]) {
			const response = await get(query);
			expect(response.status, JSON.stringify(query)).toBe(400);
			expect(response.body.error?.code).toBe('INVALID_INPUT');
		}
	});
});

describe('parties list export', () => {
	it('registers parties.core.records and streams the tenant page by page', async () => {
		const { runtime } = await partiesRuntime();
		const service = await runtime.service();
		await seed(service);
		const registry = createExportListRegistry();
		registry.register('parties.core', [
			createPartyListExport(createPartyListing(runtime)),
		]);
		registry.seal();

		expect(registry.list().map((entry) => entry.id)).toEqual([
			PARTY_EXPORT_LIST_ID,
		]);
		const definition = registry.find(PARTY_EXPORT_LIST_ID)!.definition;
		expect(definition.permission).toBe(PARTY_PERMISSIONS.read);
		expect(definition.columns.map((column) => column.key)).toEqual([
			'name',
			'kind',
			'vatId',
			'contact',
			'status',
		]);
		expect(definition.header).toContain('Name');

		const requester = principal([PARTY_PERMISSIONS.read]);
		const first = await definition.page(requester, null, 4);
		expect(first.rows).toBe(4);
		expect(first.records[0]).toContain('Alpha');
		expect(first.nextCursor).not.toBeNull();
		const second = await definition.page(requester, first.nextCursor, 4);
		expect(second.rows).toBe(3);
		expect(second.nextCursor).toBeNull();
		expect(second.records.join('')).not.toContain('Aardvark');

		const foreign = await definition.page(
			principal([PARTY_PERMISSIONS.read], 'tenant-b'),
			null,
			4,
		);
		expect(foreign.rows).toBe(1);
		expect(foreign.records[0]).toContain('Aardvark');
	});

	it('registers the list through exports.lists.v1 at composition or at start', async () => {
		for (const late of [false, true]) {
			const registry = createExportListRegistry();
			let started = false;
			const composition = createServerComposition({
				environment: { NODE_ENV: 'test' },
				auth: testAuthRuntime(),
				databases: await partiesTestProvider(),
				dataClasses: { declare: () => undefined },
				agentTools: { register: () => undefined },
				capabilities: {
					register: () => undefined,
					has: () => false,
					get: (id: string) =>
						id === 'exports.lists.v1' && (started || !late) ? registry : null,
				},
			} as never);
			expect(registry.list().length).toBe(late ? 0 : 1);
			started = true;
			await composition.start?.();
			await composition.start?.();
			expect(registry.list().map((entry) => entry.id)).toEqual([
				PARTY_EXPORT_LIST_ID,
			]);
			await composition.dispose?.();
		}
	});
});

describe('parties bulk lifecycle', () => {
	it('bounds the id list before any write', async () => {
		const { post } = await listFixture();
		for (const body of [
			{},
			{ ids: 'a' },
			{ ids: [] },
			{ ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) },
			{ ids: ['a', 'a'] },
			{ ids: ['a', 7] },
			{ ids: [''] },
		]) {
			const response = await post('/api/parties/archive-many', body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect(response.body.error?.code).toBe('INVALID_INPUT');
		}
	});

	it('archives and reactivates each id on its own, one outcome per id', async () => {
		const { provider, service, post } = await listFixture();
		const alpha = await service.create(
			'tenant-a',
			{ name: 'Alpha', kind: 'customer' },
			ACTOR,
		);
		const beta = await service.create(
			'tenant-a',
			{ name: 'Beta', kind: 'customer' },
			ACTOR,
		);
		const foreign = await service.create(
			'tenant-b',
			{ name: 'Gamma', kind: 'customer' },
			ACTOR,
		);

		const archived = await post('/api/parties/archive-many', {
			ids: [alpha.id, 'missing', foreign.id, beta.id],
		});
		expect(archived.status).toBe(200);
		expect(archived.body.outcomes).toEqual([
			{ id: alpha.id, outcome: 'updated' },
			{ id: 'missing', outcome: 'not-found' },
			{ id: foreign.id, outcome: 'not-found' },
			{ id: beta.id, outcome: 'updated' },
		]);
		expect((await service.get('tenant-b', foreign.id))?.status).toBe('active');
		for (const party of [alpha, beta]) {
			expect((await service.get('tenant-a', party.id))?.status).toBe(
				'archived',
			);
			expect(
				(
					await service.history('tenant-a', {
						recordId: party.id,
						limit: 10,
						cursor: null,
					})
				).entries.map((entry) => entry.action),
			).toEqual(['archived', 'created']);
		}

		const restored = await post('/api/parties/restore-many', {
			ids: [beta.id, 'missing'],
		});
		expect(restored.body.outcomes).toEqual([
			{ id: beta.id, outcome: 'updated' },
			{ id: 'missing', outcome: 'not-found' },
		]);
		expect((await service.get('tenant-a', beta.id))?.status).toBe('active');
		expect((await service.get('tenant-a', alpha.id))?.status).toBe('archived');

		/* The interactive routes never touch the idempotency ledger. */
		const ledger = await query<{ count: string | number }>(
			provider,
			'SELECT count(*) AS count FROM parties_idempotency_ledger',
		);
		expect(Number(ledger[0]?.count)).toBe(0);
		expect(
			await query<{ id: string }>(
				provider,
				'SELECT id FROM parties_history_v2',
			),
		).toHaveLength(5);
	});
});
