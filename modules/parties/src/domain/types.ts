export type PartyKind = 'customer' | 'supplier' | 'both';

export type PartyStatus = 'active' | 'archived';

export interface Party {
	readonly id: string;
	readonly tenantId: string;
	readonly name: string;
	readonly kind: PartyKind;
	readonly email: string | null;
	readonly phone: string | null;
	readonly vatId: string | null;
	readonly status: PartyStatus;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface CreatePartyInput {
	readonly name: string;
	readonly kind: PartyKind;
	readonly email?: string | null;
	readonly phone?: string | null;
	readonly vatId?: string | null;
}

export interface UpdatePartyInput extends CreatePartyInput {
	readonly id: string;
}

/** Omitted fields stay unchanged; null clears optional contact fields. */
export interface PatchPartyInput extends Partial<CreatePartyInput> {
	readonly id: string;
}

export const PARTY_LIST_SORTS = ['name', 'updatedAt'] as const;
export type PartyListSort = (typeof PARTY_LIST_SORTS)[number];

/** The order and the filters of one listing; a page cursor is bound to them. */
export interface PartyListQuery {
	readonly sort: PartyListSort;
	readonly direction: 'asc' | 'desc';
	/** customer or supplier also match a party of kind both. */
	readonly kind: PartyKind | null;
	readonly status: PartyStatus | null;
	/** Matched anywhere in the name, email, phone or VAT id; '' narrows nothing. */
	readonly search: string;
	readonly hasVatId: boolean;
}

/** Keyset of the last row a page answered: its sort value and its id. */
export interface PartyListKeyset {
	readonly sortValue: string | number;
	readonly id: string;
}

export interface PartyListPage {
	readonly parties: readonly Party[];
	readonly next: PartyListKeyset | null;
}

export interface PartyBulkOutcome {
	readonly id: string;
	readonly outcome: 'updated' | 'not-found' | 'refused';
	readonly reason?: string;
}
