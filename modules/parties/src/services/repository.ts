import type { Actor, HistoryPage, HistoryQuery } from '@flowdular/sdk/kernel';
import type {
	Party,
	PatchPartyInput,
	UpdatePartyInput,
} from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

/** Keyset position of the last row read: its record time and id. */
export interface ExportCursor {
	readonly at: number;
	readonly id: string;
}

export interface PartyHistoryExportRow {
	readonly id: string;
	readonly recordId: string;
	readonly version: number;
	readonly action: string;
	readonly actorKind: string;
	readonly actorId: string;
	readonly actorLabel: string;
	readonly runId: string | null;
	readonly configuredByJson: string | null;
	readonly changesJson: string;
	readonly occurredAt: number;
}

/** The database-agnostic business port. No driver type crosses it. */
export interface PartyRepository {
	list(tenantId: string): Promise<readonly Party[]>;
	create(party: Party, actor: Actor): Promise<Party>;
	createIdempotent(
		party: Party,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<Party>;
	update(
		tenantId: string,
		input: UpdatePartyInput,
		actor: Actor,
	): Promise<Party | null>;
	updateIdempotent(
		tenantId: string,
		input: PatchPartyInput,
		actor: Actor,
		idempotency: TargetIdempotencyRequest,
	): Promise<Party | null>;
	setStatus(
		tenantId: string,
		id: string,
		status: Party['status'],
		actor: Actor,
	): Promise<Party | null>;
	delete(tenantId: string, id: string, actor: Actor): Promise<boolean>;
	history(query: HistoryQuery): Promise<HistoryPage>;
	listForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly Party[]>;
	listHistoryForExport(
		tenantId: string,
		after: ExportCursor | null,
		limit: number,
	): Promise<readonly PartyHistoryExportRow[]>;
}
