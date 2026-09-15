import {
	defineListExport,
	type DefinedListExport,
} from '@flowdular/sdk/server';
import { PARTY_PERMISSIONS } from '../acl/permissions.ts';
import type { PartyListing } from '../api/listing.ts';
import { PARTY_EXPORT_LIST_ID } from '../domain/lists.ts';
import type { Party } from '../domain/types.ts';
import { DEFAULT_PARTY_LIST_QUERY } from './parties-service.ts';

/**
 * The workspace's parties as a CSV export. It walks the list endpoint's own
 * page, in its default order and under the tenant of the principal the job was
 * started by, behind the permission the party screens need themselves.
 */
export function createPartyListExport(
	listing: PartyListing,
): DefinedListExport {
	return defineListExport<Party>({
		id: PARTY_EXPORT_LIST_ID,
		label: 'Parties',
		permission: PARTY_PERMISSIONS.read,
		columns: [
			{ key: 'name', header: 'Name', value: (row) => row.name },
			{ key: 'kind', header: 'Kind', value: (row) => row.kind },
			{ key: 'vatId', header: 'VAT ID', value: (row) => row.vatId },
			{
				key: 'contact',
				header: 'Contact',
				value: (row) => [row.email, row.phone].filter(Boolean).join(', '),
			},
			{ key: 'status', header: 'Status', value: (row) => row.status },
		],
		page: async (principal, cursor, limit) => {
			const page = await listing.page(
				principal.tenantId,
				DEFAULT_PARTY_LIST_QUERY,
				cursor,
				limit,
			);
			return { rows: page.items, nextCursor: page.nextCursor };
		},
	});
}
