import { describe, expect, it } from 'vitest';
import {
	registerModuleTranslations,
	setActiveLocale,
	t,
} from '@flowdular/sdk/client/i18n';
import translationsEn from '../translations/en.json';
import translationsPl from '../translations/pl.json';
import {
	amountToMinorUnits,
	expenseCategoryLabel,
	expenseStatusLabel,
	expenseStatusTone,
	formatExpenseAmount,
	showsExpenseActionColumn,
} from '../src/client/expense-claims.ts';
import {
	bulkOutcomeCounts,
	claimSort,
	DEFAULT_CLAIM_SORTING,
	decidableTargets,
	loadedListing,
	pageCursor,
	rememberNextCursor,
	resetPageCursors,
	searchPending,
	submittableTargets,
} from '../src/client/state.ts';
import type { ExpensesClaim } from '../src/domain/types.ts';
import { EXPENSE_NOTE_VARIABLES } from '../src/domain/variables.ts';

describe('expense claim client helpers', () => {
	it('ships the same translation keys in English and Polish', () => {
		expect(Object.keys(translationsPl).sort()).toEqual(
			Object.keys(translationsEn).sort(),
		);
	});

	it('translates the variable picker and every note variable label', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const key of [
				'expenses.template.insert',
				'expenses.template.available',
				'expenses.template.empty',
				'expenses.template.sample.title',
				...EXPENSE_NOTE_VARIABLES.map(
					(variable) => 'expenses.variables.' + variable.key + '.label',
				),
			]) {
				expect(t(key)).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it('translates every dynamic status and category label', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		setActiveLocale('pl');
		expect(expenseCategoryLabel('equipment')).toBe('Wyposażenie');
		expect(expenseStatusLabel('submitted')).toBe('Wysłane');
		expect(t('expenses.status.draft')).toBe('Wersja robocza');
		expect(t('expenses.status.approved')).toBe('Zatwierdzone');
		expect(t('expenses.status.rejected')).toBe('Odrzucone');
		expect(t('expenses.category.travel')).toBe('Podróż');
		expect(t('expenses.category.meals')).toBe('Posiłki');
		expect(t('expenses.category.other')).toBe('Inne');
		setActiveLocale('en');
	});

	it('translates every value written to claim history', () => {
		registerModuleTranslations([
			{
				moduleId: 'expenses.core',
				translations: { en: translationsEn, pl: translationsPl },
			},
		]);
		for (const locale of ['en', 'pl']) {
			setActiveLocale(locale);
			for (const action of [
				'created',
				'updated',
				'submitted',
				'deleted',
				'approved',
				'rejected',
			]) {
				const key = 'expenses.history.action.' + action;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			for (const actor of ['user', 'agent']) {
				const key = 'expenses.history.actor.' + actor;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
			const serviceKey = 'expenses.history.actor.serviceConfiguredBy';
			expect(
				t(serviceKey, { name: 'Ada' }),
				`${locale}: ${serviceKey}`,
			).not.toBe(serviceKey);
			for (const field of [
				'title',
				'amountMinor',
				'currency',
				'category',
				'expenseDate',
				'note',
				'noteTemplate',
				'status',
				'decisionComment',
			]) {
				const key = 'expenses.history.field.' + field;
				expect(t(key), `${locale}: ${key}`).not.toBe(key);
			}
		}
		setActiveLocale('en');
	});

	it.each([
		['0', 0],
		['1', 100],
		['12.5', 1_250],
		['12.50', 1_250],
		[' 19.99 ', 1_999],
	])('converts %s to minor units', (value, expected) => {
		expect(amountToMinorUnits(value)).toBe(expected);
	});

	it.each(['', '-1', '1.001', 'value', '1,50'])(
		'rejects invalid amount %s',
		(value) => {
			expect(amountToMinorUnits(value)).toBeNull();
		},
	);

	it('formats amount, category, and status display values', () => {
		expect(formatExpenseAmount(1_250, 'EUR')).toMatch(/12[.,]50/);
		expect(expenseCategoryLabel('equipment')).toBe('Equipment');
		expect(expenseStatusLabel('submitted')).toBe('Submitted');
		expect(expenseStatusTone('submitted')).toBe('warning');
		expect(expenseStatusTone('approved')).toBe('success');
		expect(expenseStatusTone('rejected')).toBe('danger');
		expect(expenseStatusTone('draft')).toBe('neutral');
	});

	it('keeps the action column stable for every action-capable principal', () => {
		expect(showsExpenseActionColumn(false, false)).toBe(false);
		expect(showsExpenseActionColumn(true, false)).toBe(true);
		expect(showsExpenseActionColumn(false, true)).toBe(true);
		expect(showsExpenseActionColumn(true, true)).toBe(true);
	});
});

describe('expense claims listing state', () => {
	it('walks the cursor stack forward, back and resets it on a new listing', () => {
		let cursors = resetPageCursors();
		expect(pageCursor(cursors, 0)).toBeNull();
		expect(pageCursor(cursors, 1)).toBeUndefined();
		cursors = rememberNextCursor(cursors, 0, 'c1');
		expect(pageCursor(cursors, 1)).toBe('c1');
		cursors = rememberNextCursor(cursors, 1, 'c2');
		expect(cursors).toEqual([null, 'c1', 'c2']);
		/* Going back re-reads page 0 and drops what lay beyond page 1. */
		cursors = rememberNextCursor(cursors, 0, 'c1b');
		expect(cursors).toEqual([null, 'c1b']);
		cursors = rememberNextCursor(cursors, 1, null);
		expect(cursors).toEqual([null, 'c1b']);
		expect(pageCursor(cursors, 2)).toBeUndefined();
		expect(resetPageCursors()).toEqual([null]);
	});

	it('maps the table sorting to the server sort and direction', () => {
		expect(claimSort([])).toEqual({ sort: 'createdAt', direction: 'desc' });
		expect(claimSort([{ key: 'amount', desc: false }])).toEqual({
			sort: 'amount',
			direction: 'asc',
		});
		expect(claimSort([{ key: 'expenseDate', desc: true }])).toEqual({
			sort: 'expenseDate',
			direction: 'desc',
		});
		expect(claimSort([{ key: 'claim', desc: false }]).sort).toBe('createdAt');
	});

	it('empties the selection with every loaded listing and keeps the page cursors', () => {
		const loaded = loadedListing(
			{
				pageIndex: 1,
				pageSize: 25,
				sorting: DEFAULT_CLAIM_SORTING,
				query: 'train',
				status: 'all',
				category: 'all',
				cursors: [null, 'c1'],
			},
			{ items: [], page: { nextCursor: 'c2', limit: 25 } },
		);
		expect(loaded.cursors).toEqual([null, 'c1', 'c2']);
		expect(loaded.appliedQuery).toBe('train');
		expect(loaded.selectedIds.size).toBe(0);
		expect(searchPending(' train ', 'train')).toBe(false);
		expect(searchPending('trai', 'train')).toBe(true);
	});

	it('names only decidable or submittable selected rows and counts outcomes', () => {
		const claim = (
			id: string,
			status: ExpensesClaim['status'],
		): ExpensesClaim => ({
			id,
			tenantId: 't',
			claimantId: 'a',
			title: id,
			name: id,
			amountMinor: 1,
			currency: 'EUR',
			category: 'travel',
			expenseDate: '2026-08-20',
			note: null,
			noteTemplate: null,
			status,
			decisionComment: null,
			createdAt: 1,
		});
		const claims = [
			claim('s1', 'submitted'),
			claim('d1', 'draft'),
			claim('a1', 'approved'),
			claim('s2', 'submitted'),
		];
		const selected = new Set(['s1', 'd1', 'a1', 'gone']);
		expect(decidableTargets(claims, selected)).toEqual(['s1']);
		expect(submittableTargets(claims, selected)).toEqual(['d1']);
		expect(
			bulkOutcomeCounts([
				{ id: 's1', outcome: 'updated' },
				{ id: 'gone', outcome: 'not-found' },
				{ id: 'a1', outcome: 'refused', reason: 'CLAIM_NOT_SUBMITTED' },
				{ id: 's2', outcome: 'updated' },
			]),
		).toEqual({ updated: 2, missing: 1, refused: 1 });
	});
});
