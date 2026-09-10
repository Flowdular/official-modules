import { defineApiAgentTool } from '@flowdular/sdk/harness/tool-adapters';
import {
	AgentHarnessError,
	type AgentTool,
	type AgentToolContext,
} from '@flowdular/sdk/harness/runtime';
import { agentActor, type Actor } from '@flowdular/sdk/kernel';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type { PartyKind, PatchPartyInput } from '../domain/types.ts';
import type { PartiesRuntime } from '../server/runtime.ts';
import { PartyServiceError } from '../services/parties-service.ts';

const MAX_TOOL_ROWS = 200;
const CREATE_OPERATION = 'parties.customer.create@1';

const PARTY_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'id',
		'tenantId',
		'name',
		'kind',
		'email',
		'phone',
		'vatId',
		'status',
		'createdAt',
	],
	properties: {
		id: { type: 'string' },
		tenantId: { type: 'string' },
		name: { type: 'string' },
		kind: { type: 'string', enum: ['customer', 'supplier', 'both'] },
		email: { type: ['string', 'null'] },
		phone: { type: ['string', 'null'] },
		vatId: { type: ['string', 'null'] },
		status: { type: 'string', enum: ['active', 'archived'] },
		createdAt: { type: 'integer' },
	},
} as const;

function actionActor(context: AgentToolContext): Actor {
	return context.actor ?? agentActor(context);
}

function text(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function normalized(value: unknown): string {
	return typeof value === 'string'
		? value.trim().toLocaleLowerCase('en-US')
		: '';
}

function idempotencyKey(context: AgentToolContext): string {
	if (!context.idempotencyKey) {
		throw new AgentHarnessError(
			'TOOL_IDEMPOTENCY_KEY_REQUIRED',
			'The party mutation tool requires a durable idempotency key.',
		);
	}
	return context.idempotencyKey;
}

/* Tools call the party service and take the tenant and the actor from the run
   context, never from input; the service revalidates so a tool cannot bypass
   the endpoint's rules, every write is attributed to the run that made it, and
   list output is capped so one call cannot flood the run window. */
export function partiesAgentTools(
	runtime: PartiesRuntime,
): readonly AgentTool[] {
	return [
		defineApiAgentTool({
			id: 'parties.customer.list',
			endpointId: 'parties.records.list',
			contractVersion: 1,
			description:
				'List customers and suppliers of the active tenant, optionally filtered by status or a free-text query.',
			requiredPermissions: [PARTY_PERMISSIONS.read],
			risk: 'read',
			idempotency: 'required',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					status: { type: 'string', enum: ['active', 'archived'] },
					query: { type: 'string', maxLength: 120 },
				},
			},
			outputSchema: { type: 'array', items: PARTY_OUTPUT_SCHEMA },
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const value = (input ?? {}) as Record<string, unknown>;
				const status = text(value.status);
				const query = normalized(value.query);
				return (await (await runtime.service()).list(context.tenantId))
					.filter(
						(party) =>
							(status === null || party.status === status) &&
							(query === '' ||
								party.name.toLocaleLowerCase('en-US').includes(query) ||
								(party.email ?? '')
									.toLocaleLowerCase('en-US')
									.includes(query) ||
								(party.vatId ?? '').toLocaleLowerCase('en-US').includes(query)),
					)
					.slice(0, MAX_TOOL_ROWS);
			},
		}),
		defineApiAgentTool({
			id: 'parties.customer.get',
			endpointId: 'parties.records.list',
			contractVersion: 1,
			description: 'Fetch a single party of the active tenant by identifier.',
			requiredPermissions: [PARTY_PERMISSIONS.read],
			risk: 'read',
			idempotency: 'required',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['id'],
				properties: { id: { type: 'string', maxLength: 128 } },
			},
			outputSchema: { ...PARTY_OUTPUT_SCHEMA, type: ['object', 'null'] },
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const value = (input ?? {}) as Record<string, unknown>;
				return (await runtime.service()).get(
					context.tenantId,
					String(value.id ?? ''),
				);
			},
		}),
		defineApiAgentTool({
			id: 'parties.customer.create',
			endpointId: 'parties.records.create',
			contractVersion: 1,
			description: 'Create a customer or supplier owned by the active tenant.',
			requiredPermissions: [PARTY_PERMISSIONS.manage],
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'kind'],
				properties: {
					name: { type: 'string', maxLength: 160 },
					kind: { type: 'string', enum: ['customer', 'supplier', 'both'] },
					email: { type: 'string', maxLength: 254 },
					phone: { type: 'string', maxLength: 40 },
					vatId: { type: 'string', maxLength: 20 },
				},
			},
			outputSchema: PARTY_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const value = (input ?? {}) as Record<string, unknown>;
				try {
					return (await runtime.service()).createIdempotent(
						context.tenantId,
						{
							name: String(value.name ?? ''),
							kind: value.kind as PartyKind,
							email: text(value.email),
							phone: text(value.phone),
							vatId: text(value.vatId),
						},
						actionActor(context),
						{
							key: idempotencyKey(context),
							operationId: CREATE_OPERATION,
						},
					);
				} catch (error) {
					if (
						error instanceof PartyServiceError &&
						error.code === 'PARTY_IDEMPOTENCY_CONFLICT'
					) {
						throw new AgentHarnessError(error.code, error.message);
					}
					throw error;
				}
			},
		}),
		defineApiAgentTool({
			id: 'parties.customer.update',
			endpointId: 'parties.records.update',
			contractVersion: 1,
			description:
				'Update a customer or supplier by id. Supply only fields to change. Omitted fields are preserved; null or an empty string clears email, phone or vatId. Does not change lifecycle status.',
			requiredPermissions: [PARTY_PERMISSIONS.manage],
			risk: 'workspace-write',
			idempotency: 'required',
			idempotencyProtection: 'target-ledger',
			cancellation: 'cooperative',
			inputSchema: {
				type: 'object',
				additionalProperties: false,
				required: ['id'],
				properties: {
					id: { type: 'string', minLength: 1, maxLength: 128 },
					name: { type: 'string', minLength: 2, maxLength: 160 },
					kind: { type: 'string', enum: ['customer', 'supplier', 'both'] },
					email: { type: ['string', 'null'], maxLength: 254 },
					phone: { type: ['string', 'null'], maxLength: 40 },
					vatId: { type: ['string', 'null'], maxLength: 20 },
				},
			},
			outputSchema: PARTY_OUTPUT_SCHEMA,
			execute: async (input, context) => {
				context.signal.throwIfAborted();
				const key = idempotencyKey(context);
				const service = await runtime.service();
				context.signal.throwIfAborted();
				try {
					return await service.updateIdempotent(
						context.tenantId,
						(input ?? {}) as PatchPartyInput,
						actionActor(context),
						{ key, operationId: 'parties.customer.update@1' },
					);
				} catch (error) {
					if (error instanceof PartyServiceError)
						throw new AgentHarnessError(error.code, error.message);
					throw error;
				}
			},
		}),
	];
}
