import {
	defineEndpoint,
	HttpProblem,
	jsonResponse,
	optionalString,
	pageResponse,
	problemResponse,
	readJsonObject,
	readPageQuery,
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
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type {
	CreatePartyInput,
	PartyKind,
	UpdatePartyInput,
} from '../domain/types.ts';
import {
	PARTY_BULK_LIMIT,
	PARTY_PAGE_MAX_LIMIT,
	PartyServiceError,
} from '../services/parties-service.ts';
import type { PartiesRuntime } from '../server/runtime.ts';
import {
	createPartyListing,
	PARTY_PAGE_LIMIT,
	partyListQuery,
	type PartyListing,
} from './listing.ts';

/* A hundred ids of 128 characters with their JSON around them. */
const BULK_BODY_BYTES = 32 * 1_024;

function failure(error: unknown): Response {
	if (error instanceof PartyServiceError) {
		return jsonResponse(
			{ error: { code: error.code, message: error.message } },
			error.status,
		);
	}
	return problemResponse(error, 'The party operation failed.');
}

function partyInput(value: Record<string, unknown>): CreatePartyInput {
	const kind = requiredString(value, 'kind');
	if (kind !== 'customer' && kind !== 'supplier' && kind !== 'both') {
		throw new HttpProblem(
			'INVALID_PARTY_KIND',
			'kind must be customer, supplier, or both.',
			400,
		);
	}
	return {
		name: requiredString(value, 'name', { min: 2, max: 160 }),
		kind: kind as PartyKind,
		email: optionalString(value, 'email', 254),
		phone: optionalString(value, 'phone', 40),
		vatId: optionalString(value, 'vatId', 20),
	};
}

function partyIds(value: Record<string, unknown>): readonly string[] {
	const raw = value.ids;
	if (!Array.isArray(raw)) {
		throw new HttpProblem('INVALID_INPUT', 'ids must be an array.', 400);
	}
	if (raw.length < 1 || raw.length > PARTY_BULK_LIMIT) {
		throw new HttpProblem(
			'INVALID_INPUT',
			`ids must name between 1 and ${PARTY_BULK_LIMIT} parties.`,
			400,
		);
	}
	const ids = raw.map((entry) =>
		requiredString({ id: entry }, 'id', { max: 128 }),
	);
	if (new Set(ids).size !== ids.length) {
		throw new HttpProblem('INVALID_INPUT', 'ids must not repeat an id.', 400);
	}
	return ids;
}

export function createPartyRoutes(
	auth: AuthRuntime,
	runtime: PartiesRuntime,
	listing: PartyListing = createPartyListing(runtime),
) {
	const list = defineEndpoint({
		id: 'parties.records.list',
		path: '/api/parties',
		methods: ['GET'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.read },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			try {
				const url = new URL(octane.request.url);
				const page = readPageQuery(url, {
					maxLimit: PARTY_PAGE_MAX_LIMIT,
					defaultLimit: PARTY_PAGE_LIMIT,
				});
				const result = await listing.page(
					principalFromContext(octane)!.tenantId,
					partyListQuery(url),
					page.cursor,
					page.limit,
				);
				return pageResponse({
					items: result.items,
					limit: page.limit,
					nextCursor: result.nextCursor,
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const create = defineEndpoint({
		id: 'parties.records.create',
		path: '/api/parties',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request);
				const input = partyInput(value);
				return jsonResponse(
					{
						party: await service.create(
							principalFromContext(octane)!.tenantId,
							input,
							actorFromContext(octane)!,
						),
					},
					201,
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	const update = defineEndpoint({
		id: 'parties.records.update',
		path: '/api/parties/update',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request);
				const input: UpdatePartyInput = {
					id: requiredString(value, 'id', { max: 128 }),
					...partyInput(value),
				};
				return jsonResponse({
					party: await service.update(
						principalFromContext(octane)!.tenantId,
						input,
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const archive = defineEndpoint({
		id: 'parties.records.archive',
		path: '/api/parties/archive',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse({
					party: await service.archive(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'id', { max: 128 }),
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	const restore = defineEndpoint({
		id: 'parties.records.restore',
		path: '/api/parties/restore',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request, 4 * 1_024);
				return jsonResponse({
					party: await service.restore(
						principalFromContext(octane)!.tenantId,
						requiredString(value, 'id', { max: 128 }),
						actorFromContext(octane)!,
					),
				});
			} catch (error) {
				return failure(error);
			}
		},
	});
	/* Each bulk route is the sibling of its single-row route: same permission,
	   same session check, one outcome per id through the same service path. */
	const statusMany = (
		id: string,
		path: string,
		action: 'archiveMany' | 'restoreMany',
	) =>
		defineEndpoint({
			id,
			path,
			methods: ['POST'],
			access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
			resolveIdentity: endpointIdentityFromContext,
			handler: async ({ octane }) => {
				const denial = sessionMutationDenial(octane, auth);
				if (denial) return denial;
				try {
					const service = await runtime.service();
					const value = await readJsonObject(octane.request, BULK_BODY_BYTES);
					return jsonResponse({
						outcomes: await service[action](
							principalFromContext(octane)!.tenantId,
							partyIds(value),
							actorFromContext(octane)!,
						),
					});
				} catch (error) {
					return failure(error);
				}
			},
		});
	const archiveMany = statusMany(
		'parties.records.archive-many',
		'/api/parties/archive-many',
		'archiveMany',
	);
	const restoreMany = statusMany(
		'parties.records.restore-many',
		'/api/parties/restore-many',
		'restoreMany',
	);
	const remove = defineEndpoint({
		id: 'parties.records.delete',
		path: '/api/parties/delete',
		methods: ['POST'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.manage },
		resolveIdentity: endpointIdentityFromContext,
		handler: async ({ octane }) => {
			const denial = sessionMutationDenial(octane, auth);
			if (denial) return denial;
			try {
				const service = await runtime.service();
				const value = await readJsonObject(octane.request, 4 * 1_024);
				await service.delete(
					principalFromContext(octane)!.tenantId,
					requiredString(value, 'id', { max: 128 }),
					actorFromContext(octane)!,
				);
				return jsonResponse({ deleted: true });
			} catch (error) {
				return failure(error);
			}
		},
	});
	const history = defineEndpoint({
		id: 'parties.records.history',
		path: '/api/parties/history',
		methods: ['GET'],
		access: { kind: 'permission', permission: PARTY_PERMISSIONS.read },
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
				return jsonResponse(
					await service.history(
						principalFromContext(octane)!.tenantId,
						request,
					),
				);
			} catch (error) {
				return failure(error);
			}
		},
	});
	return [
		list.serverRoute,
		create.serverRoute,
		update.serverRoute,
		archive.serverRoute,
		restore.serverRoute,
		archiveMany.serverRoute,
		restoreMany.serverRoute,
		remove.serverRoute,
		history.serverRoute,
	] as const;
}

export const endpoints = [
	'parties.records.list',
	'parties.records.create',
	'parties.records.update',
	'parties.records.archive',
	'parties.records.restore',
	'parties.records.archive-many',
	'parties.records.restore-many',
	'parties.records.delete',
	'parties.records.history',
] as const;
