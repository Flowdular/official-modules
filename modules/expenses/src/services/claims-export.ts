import { randomBytes } from 'node:crypto';
import {
	defineListExport,
	type DefinedListExport,
} from '@flowdular/sdk/server';
import { EXPENSES_PERMISSIONS } from '../acl/permissions.ts';
import { EXPENSES_CLAIMS_EXPORT_LIST_ID } from '../domain/lists.ts';
import type { ExpensesClaim } from '../domain/types.ts';
import type { ExpensesRuntime } from '../server/runtime.ts';
import { DEFAULT_CLAIMS_LISTING, readClaimsPage } from './claims-listing.ts';

/**
 * The claims list as a CSV export. Every page is the list route's own page
 * under the principal the job was started by, so a file never carries a row
 * the screen would not have shown: a claimant's own claims, plus the tenant's
 * submitted ones for an approver. The walk is keyed on creation time and id,
 * both immutable, so a claim decided mid-walk keeps its place.
 */
export function createClaimsListExport(
	runtime: ExpensesRuntime,
): DefinedListExport {
	/* The export's cursor is its own: it only ever comes back to this page. */
	const secret = randomBytes(32);
	return defineListExport<ExpensesClaim>({
		id: EXPENSES_CLAIMS_EXPORT_LIST_ID,
		label: 'Expense claims',
		permission: EXPENSES_PERMISSIONS.read,
		columns: [
			{ key: 'title', header: 'Title', value: (row) => row.title },
			{ key: 'claimant', header: 'Claimant', value: (row) => row.claimantId },
			{
				key: 'amountMinor',
				header: 'Amount (minor units)',
				value: (row) => row.amountMinor,
			},
			{ key: 'currency', header: 'Currency', value: (row) => row.currency },
			{ key: 'category', header: 'Category', value: (row) => row.category },
			{
				key: 'expenseDate',
				header: 'Expense date',
				value: (row) => row.expenseDate,
			},
			{ key: 'status', header: 'Status', value: (row) => row.status },
			{
				key: 'decisionComment',
				header: 'Decision comment',
				value: (row) => row.decisionComment,
			},
		],
		page: async (principal, cursor, limit) => {
			const page = await readClaimsPage(
				await runtime.service(),
				secret,
				principal,
				DEFAULT_CLAIMS_LISTING,
				limit,
				cursor,
			);
			return { rows: page.items, nextCursor: page.nextCursor };
		},
	});
}
