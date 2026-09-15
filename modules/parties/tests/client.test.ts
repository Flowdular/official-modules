import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/sdk/client/i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadParties, loadPartyHistory } from '../src/client/api.ts';
import {
	bulkOutcomeCounts,
	bulkTargets,
	loadedListing,
	pageCursor,
	partySort,
	rememberNextCursor,
	resetPageCursors,
	type Listing,
} from '../src/client/state.ts';
import type { Party } from '../src/domain/types.ts';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';

afterEach(() => {
	vi.unstubAllGlobals();
	setActiveLocale('en');
});

describe('parties client contract', () => {
	it('keeps history and lifecycle translation families complete in Polish', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
		registerModuleTranslations([
			{
				moduleId: 'parties.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const namespace of ['customer', 'supplier']) {
				for (const suffix of [
					'title',
					'description',
					'new',
					'tableTitle',
					'emptyTitle',
					'emptyHint',
					'drawerSubtitle',
				]) {
					const key = `parties.${namespace}.${suffix}`;
					expect(t(key), `${locale}: ${key}`).not.toBe(key);
				}
			}
			for (const kind of ['customer', 'supplier', 'both']) {
				const key = 'parties.kind.' + kind;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const status of ['active', 'archived']) {
				const key = 'parties.status.' + status;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const action of [
				'created',
				'updated',
				'archived',
				'restored',
				'deleted',
			]) {
				const key = 'parties.history.action.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const actor of ['user', 'agent']) {
				const key = 'parties.history.actor.' + actor;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			const serviceKey = 'parties.history.actor.serviceConfiguredBy';
			expect(
				t(serviceKey, { name: 'Ada' }),
				`${locale}: ${serviceKey}`,
			).not.toBe(serviceKey);
			for (const field of [
				'name',
				'kind',
				'email',
				'phone',
				'vatId',
				'status',
			]) {
				const key = 'parties.history.field.' + field;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const key of [
				'parties.table.column.updatedAt',
				'parties.filters.status',
				'parties.filters.allStatuses',
				'parties.pagination.label',
				'parties.pagination.previous',
				'parties.pagination.next',
				'parties.pagination.size',
				'parties.selection.label',
				'parties.selection.clear',
				'parties.action.archiveSelected',
				'parties.action.restoreSelected',
				'parties.action.archiveRefused',
				'parties.action.restoreRefused',
				'parties.archiveMany.title',
				'parties.export.action',
				'parties.export.started',
				'parties.export.link',
				'parties.denied.title',
				'parties.denied.description',
			]) {
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			expect(
				t('parties.notice.archivedMany', {
					updated: 2,
					missing: 1,
					refused: 0,
				}),
			).toContain('2');
			expect(t('parties.selection.summary', { count: 3 })).toContain('3');
		}
		setActiveLocale('en');
	});

	it('loads the selected record history through the tenant-scoped API', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						entries: [],
						nextCursor: null,
					}),
					{
						status: 200,
						headers: { 'content-type': 'application/json' },
					},
				),
		);
		vi.stubGlobal('fetch', fetch);

		await expect(loadPartyHistory('party / one')).resolves.toEqual({
			entries: [],
			nextCursor: null,
		});
		expect(fetch).toHaveBeenCalledWith(
			'/api/parties/history?recordId=party%20%2F%20one&limit=100',
			{
				headers: { accept: 'application/json' },
				credentials: 'same-origin',
			},
		);
	});

	it('loads one server-paged listing and narrows nothing itself', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ items: [], page: { nextCursor: null, limit: 25 } }),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);
		vi.stubGlobal('fetch', fetch);

		await loadParties({
			sort: 'updatedAt',
			direction: 'desc',
			limit: 25,
			kind: 'supplier',
			status: 'archived',
			query: 'acme & co',
			hasVatId: true,
			cursor: 'c1.body.sig',
		});
		expect(fetch).toHaveBeenCalledWith(
			'/api/parties?sort=updatedAt&direction=desc&limit=25&kind=supplier&status=archived&q=acme+%26+co&hasVatId=true&cursor=c1.body.sig',
			{ headers: { accept: 'application/json' }, credentials: 'same-origin' },
		);
		await loadParties({
			sort: 'name',
			direction: 'asc',
			limit: 50,
			kind: '',
			status: '',
			query: '',
			hasVatId: false,
			cursor: null,
		});
		expect(fetch).toHaveBeenLastCalledWith(
			'/api/parties?sort=name&direction=asc&limit=50',
			expect.anything(),
		);
	});

	it('walks the cursor stack forward and back and resets on a new listing', () => {
		const listing: Listing = {
			pageIndex: 0,
			pageSize: 2,
			sorting: [{ key: 'name', desc: false }],
			query: '',
			status: 'active',
			hasVatId: false,
			cursors: resetPageCursors(),
		};
		expect(pageCursor(listing.cursors, 0)).toBeNull();
		expect(pageCursor(listing.cursors, 1)).toBeUndefined();

		const first = loadedListing(listing, {
			items: [],
			page: { nextCursor: 'cursor-1', limit: 2 },
		});
		expect(first.cursors).toEqual([null, 'cursor-1']);
		expect(first.selectedIds.size).toBe(0);
		const second = loadedListing(
			{ ...listing, pageIndex: 1, cursors: first.cursors },
			{ items: [], page: { nextCursor: 'cursor-2', limit: 2 } },
		);
		expect(second.cursors).toEqual([null, 'cursor-1', 'cursor-2']);
		expect(pageCursor(second.cursors, 2)).toBe('cursor-2');
		/* Going back reuses the stored cursor and drops what lay beyond. */
		expect(pageCursor(second.cursors, 1)).toBe('cursor-1');
		expect(rememberNextCursor(second.cursors, 1, 'cursor-2b')).toEqual([
			null,
			'cursor-1',
			'cursor-2b',
		]);
		expect(rememberNextCursor(second.cursors, 2, null)).toEqual([
			null,
			'cursor-1',
			'cursor-2',
		]);
		expect(resetPageCursors()).toEqual([null]);
		expect(partySort([{ key: 'updatedAt', desc: true }])).toEqual({
			sort: 'updatedAt',
			direction: 'desc',
		});
		expect(partySort([])).toEqual({ sort: 'name', direction: 'asc' });
	});

	it('targets only the selected rows in the other status and counts outcomes', () => {
		const party = (id: string, status: Party['status']): Party => ({
			id,
			tenantId: 'tenant-a',
			name: id,
			kind: 'customer',
			email: null,
			phone: null,
			vatId: null,
			status,
			createdAt: 1,
			updatedAt: 1,
		});
		const rows = [
			party('a', 'active'),
			party('b', 'archived'),
			party('c', 'active'),
		];
		const selected = new Set(['a', 'b', 'missing']);
		expect(bulkTargets(rows, selected, 'active')).toEqual(['a']);
		expect(bulkTargets(rows, selected, 'archived')).toEqual(['b']);
		expect(
			bulkOutcomeCounts([
				{ id: 'a', outcome: 'updated' },
				{ id: 'b', outcome: 'not-found' },
				{ id: 'c', outcome: 'refused', reason: 'INVALID_INPUT' },
				{ id: 'd', outcome: 'updated' },
			]),
		).toEqual({ updated: 2, missing: 1, refused: 1 });
	});
});
