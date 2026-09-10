import type { Actor, HistoryPage, HistoryQuery } from '@flowdular/kernel';
import type {
	Party,
	PatchPartyInput,
	UpdatePartyInput,
} from '../domain/types.ts';
import type { TargetIdempotencyRequest } from './target-idempotency.ts';

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
}
