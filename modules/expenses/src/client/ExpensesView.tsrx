import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	ConfirmDialog,
	Drawer,
	Filters,
	FormField,
	Icon,
	Kpi,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	Tag,
	ToastHost,
	toasts,
	type TableAction,
	type TableBulkAction,
	type TableColumn,
	type TableSort,
} from '@flowdular/sdk/ui';
import { activeLocale, t } from '@flowdular/sdk/client';
import { useValue } from 'segment-state';
import type {
	ExpenseClaimBulkOutcome,
	ExpenseClaimCategory,
	ExpenseClaimDecision,
	ExpensesClaim,
} from '../domain/types.ts';
import {
	createExpensesClaim,
	decideExpensesClaim,
	decideExpensesClaimsMany,
	deleteExpensesClaim,
	loadAwaitingApprovalCount,
	loadExpenseClaimHistory,
	loadExpensesClaims,
	submitExpensesClaim,
	submitExpensesClaimsMany,
} from './api.ts';
import {
	amountToMinorUnits,
	expenseStatusTone,
	formatExpenseAmount,
	showsExpenseActionColumn,
	type ExpenseCategoryFilter,
	type ExpenseStatusFilter,
} from './expense-claims.ts';
import {
	bulkOutcomeCounts,
	claimSort,
	createExpensesClientState,
	createExpensesDashboardState,
	DEFAULT_CLAIM_SORTING,
	decidableTargets,
	loadedListing,
	pageCursor,
	resetPageCursors,
	searchPending,
	submittableTargets,
	type ClaimListing,
	type ExpenseBulkAction,
} from './state.ts';
import { ExpenseClaimForm } from './ExpenseClaimForm.tsrx';
import { ExpenseDecisionForm } from './ExpenseDecisionForm.tsrx';
import { ExpenseHistoryDrawer } from './ExpenseHistoryDrawer.tsrx';

export interface ExpensesViewProps {
	readonly csrfToken: string;
	readonly canRead: boolean;
	readonly canManage: boolean;
	readonly canApprove: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];
const SEARCH_DEBOUNCE_MS = 300;

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function columns(withActions: boolean): readonly TableColumn<ExpensesClaim>[] {
	return [
		{
			key: 'claim',
			header: t('expenses.table.claim'),
			width: withActions ? '20%' : '24%',
			cell: (claim) => <span class="ui-cell">
				<b>{claim.title}</b>
				<small class="ui-mono">{claim.id}</small>
			</span>,
		},
		{
			key: 'expenseDate',
			header: t('expenses.table.expenseDate'),
			width: withActions ? '11%' : '12%',
			value: (claim) => claim.expenseDate,
			cell: (claim) => <span class="ui-mono">{claim.expenseDate}</span>,
		},
		{
			key: 'category',
			header: t('expenses.table.category'),
			width: withActions ? '10%' : '11%',
			cell: (claim) => t('expenses.category.' + claim.category),
		},
		{
			key: 'amount',
			header: t('expenses.table.amount'),
			width: withActions ? '10%' : '11%',
			numeric: true,
			value: (claim) => claim.amountMinor,
			cell: (claim) => formatExpenseAmount(claim.amountMinor, claim.currency),
		},
		{
			key: 'status',
			header: t('expenses.table.status'),
			width: withActions ? '10%' : '11%',
			cell: (claim) =>
				<Tag tone={expenseStatusTone(claim.status)} dot>{t(
					'expenses.status.' + claim.status,
				)}</Tag>,
		},
		{
			key: 'decisionComment',
			header: t('expenses.table.decisionComment'),
			width: withActions ? '15%' : '17%',
			cell: (claim) => claim.decisionComment
				? claim.decisionComment
				: <span class="ui-cell__muted">{t(
						'expenses.table.noDecisionComment',
					)}</span>,
		},
		{
			key: 'createdAt',
			header: t('expenses.table.created'),
			width: withActions ? '12%' : '14%',
			value: (claim) => claim.createdAt,
			cell: (claim) => <span
				class="ui-mono"
			>{new Intl.DateTimeFormat(activeLocale(), {
				dateStyle: 'medium',
			}).format(claim.createdAt)}</span>,
		},
	];
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

export function ExpensesView(props: ExpensesViewProps) @{
	const viewState = useMemo(() => createExpensesClientState(), []);
	/* Answers arrive in any order; only the latest request may write the page. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [claims] = useValue(viewState.state.claims);
	const [statusFilter, setStatusFilter] = useValue(
		viewState.state.statusFilter,
	);
	const [categoryFilter, setCategoryFilter] = useValue(
		viewState.state.categoryFilter,
	);
	const [query, setQuery] = useValue(viewState.state.query);
	const [appliedQuery] = useValue(viewState.state.appliedQuery);
	const [sorting, setSorting] = useValue(viewState.state.sorting);
	const [pageIndex] = useValue(viewState.state.pageIndex);
	const [pageSize, setPageSize] = useValue(viewState.state.pageSize);
	const [cursors] = useValue(viewState.state.cursors);
	const [nextCursor] = useValue(viewState.state.nextCursor);
	const [filtersOpen, setFiltersOpen] = useValue(viewState.state.filtersOpen);
	const [selectedIds, setSelectedIds] = useValue(viewState.state.selectedIds);
	const [bulkAction, setBulkAction] = useValue(viewState.state.bulkAction);
	const [bulkComment, setBulkComment] = useValue(viewState.state.bulkComment);
	const [status, setStatus] = useValue(viewState.state.status);
	const [error, setError] = useValue(viewState.state.error);
	const [formOpen, setFormOpen] = useValue(viewState.state.formOpen);
	const [formSession, setFormSession] = useValue(viewState.state.formSession);
	const [formError, setFormError] = useValue(viewState.state.formError);
	const [decisionOpen, setDecisionOpen] = useValue(
		viewState.state.decisionOpen,
	);
	const [decisionSession, setDecisionSession] = useValue(
		viewState.state.decisionSession,
	);
	const [decisionClaim, setDecisionClaim] = useValue(
		viewState.state.decisionClaim,
	);
	const [decision, setDecision] = useValue(viewState.state.decision);
	const [decisionError, setDecisionError] = useValue(
		viewState.state.decisionError,
	);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		viewState.state.deleteConfirmOpen,
	);
	const [deleteClaim, setDeleteClaim] = useValue(viewState.state.deleteClaim);
	const [historyOpen, setHistoryOpen] = useValue(viewState.state.historyOpen);
	const [historyClaim, setHistoryClaim] = useValue(
		viewState.state.historyClaim,
	);
	const [historyEntries] = useValue(viewState.state.historyEntries);
	const [historyLoading, setHistoryLoading] = useValue(
		viewState.state.historyLoading,
	);
	const [historyError, setHistoryError] = useValue(
		viewState.state.historyError,
	);

	const term = query.trim();
	const hasMore = nextCursor !== null;
	const filtered =
		appliedQuery !== '' || statusFilter !== 'all' || categoryFilter !== 'all';
	const decidable =
		props.canApprove ? decidableTargets(claims, selectedIds) : [];
	const submittable =
		props.canManage ? submittableTargets(claims, selectedIds) : [];
	const bulkTargets =
		bulkAction === 'submit' ? submittable : decidable;
	const listing = (): ClaimListing => ({
		pageIndex,
		pageSize,
		sorting,
		query: appliedQuery,
		status: statusFilter,
		category: categoryFilter,
		cursors,
	});
	/* The search timer fires after later renders; it reads the listing those
   renders left here rather than the one the keystroke saw. */
	const latest = useMemo(() => ({ listing: listing() }), []);
	latest.listing = listing();
	/* A changed order, filter or page size is a new listing, whose cursors
   name positions in the old one. */
	const firstPage = (changes: Partial<ClaimListing>): ClaimListing => ({
		...listing(),
		...changes,
		pageIndex: 0,
		cursors: resetPageCursors(),
	});

	/* The server sorts, narrows and cuts the page; the listing travels as an
   argument because the click that changes it and the load it starts happen
   in one render, where the state hooks still read the old values. */
	const load = async (next: ClaimListing) => {
		const cursor = pageCursor(next.cursors, next.pageIndex);
		if (cursor === undefined) return;
		const sequence = requests.sequence + 1;
		requests.sequence = sequence;
		setStatus('loading');
		setError('');
		try {
			const { sort, direction } = claimSort(next.sorting);
			const page = await loadExpensesClaims({
				sort,
				direction,
				limit: next.pageSize,
				status: next.status,
				category: next.category,
				query: next.query,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			const loaded = loadedListing(next, page);
			viewState.store.act((transaction) => {
				transaction.set(viewState.state.claims, loaded.claims);
				transaction.set(viewState.state.appliedQuery, loaded.appliedQuery);
				transaction.set(viewState.state.pageIndex, loaded.pageIndex);
				transaction.set(viewState.state.cursors, loaded.cursors);
				transaction.set(viewState.state.nextCursor, loaded.nextCursor);
				transaction.set(viewState.state.selectedIds, loaded.selectedIds);
				transaction.set(viewState.state.status, 'idle');
			}, 'expenses/loaded');
		} catch (loadError) {
			if (sequence !== requests.sequence) return;
			viewState.store.act((transaction) => {
				transaction.set(viewState.state.claims, []);
				transaction.set(viewState.state.selectedIds, new Set());
				transaction.set(viewState.state.status, 'idle');
			}, 'expenses/load-failed');
			setError(message(loadError, t('expenses.error.load')));
		}
	};

	const refresh = () => load(firstPage({}));

	useEffect(() => {
		if (props.canRead) void refresh();
	}, [props.canRead]);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen: one listing per pause in the typing. */
	useEffect(() => {
		if (!props.canRead || !searchPending(query, appliedQuery)) return;
		const timer = setTimeout(
			() => void load({
				...latest.listing,
				query: term,
				pageIndex: 0,
				cursors: resetPageCursors(),
			}),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [query]);

	const openPage = (index: number) => {
		if (index !== pageIndex) void load({ ...listing(), pageIndex: index });
	};

	const changeSorting = (sorts: readonly TableSort[]) => {
		const next =
			sorts.length === 0 ? DEFAULT_CLAIM_SORTING : sorts;
		setSorting(next);
		void load(firstPage({ sorting: next }));
	};

	const changeStatusFilter = (value: string) => {
		const next = value as ExpenseStatusFilter;
		setStatusFilter(next);
		void load(firstPage({ status: next }));
	};

	const changeCategoryFilter = (value: string) => {
		const next = value as ExpenseCategoryFilter;
		setCategoryFilter(next);
		void load(firstPage({ category: next }));
	};

	const changePageSize = (size: number) => {
		setPageSize(size);
		void load(firstPage({ pageSize: size }));
	};

	const openCreate = () => {
		setFormError('');
		setFormOpen(true);
	};

	const closeCreate = () => {
		setFormError('');
		setFormOpen(false);
	};

	const createClaim = async (event: SubmitEvent) => {
		event.preventDefault();
		const form = new FormData(event.currentTarget as HTMLFormElement);
		const amountMinor = amountToMinorUnits(formValue(form, 'amount'));
		if (amountMinor === null) {
			setFormError(t('expenses.error.amount'));
			return;
		}
		setStatus('submitting');
		setFormError('');
		try {
			await createExpensesClaim(
				{
					title: formValue(form, 'title'),
					amountMinor,
					currency: formValue(form, 'currency').toUpperCase(),
					category: formValue(form, 'category') as ExpenseClaimCategory,
					expenseDate: formValue(form, 'expenseDate'),
					note: formValue(form, 'note').trim() || null,
				},
				props.csrfToken,
			);
			setFormSession((current) => current + 1);
			setFormOpen(false);
			await refresh();
		} catch (createError) {
			setFormError(message(createError, t('expenses.error.create')));
			setStatus('idle');
		}
	};

	const submitDraft = async (claimId: string) => {
		setStatus('submitting');
		setError('');
		try {
			await submitExpensesClaim(claimId, props.csrfToken);
			await load(listing());
		} catch (submitError) {
			setError(message(submitError, t('expenses.error.submit')));
			setStatus('idle');
		}
	};

	const requestDelete = (claim: ExpensesClaim) => {
		setDeleteClaim(claim);
		setDeleteConfirmOpen(true);
	};

	const closeDelete = () => {
		setDeleteConfirmOpen(false);
		setDeleteClaim(null);
	};

	const deleteDraft = async () => {
		if (!deleteClaim) return;
		setStatus('deleting');
		setError('');
		try {
			await deleteExpensesClaim(deleteClaim.id, props.csrfToken);
			closeDelete();
			await load(listing());
		} catch (deleteError) {
			setError(message(deleteError, t('expenses.error.delete')));
			setStatus('idle');
		}
	};

	const openDecision = (
		claim: ExpensesClaim,
		nextDecision: ExpenseClaimDecision,
	) => {
		setDecisionClaim(claim);
		setDecision(nextDecision);
		setDecisionError('');
		setDecisionSession((current) => current + 1);
		setDecisionOpen(true);
	};

	const closeDecision = () => {
		setDecisionError('');
		setDecisionOpen(false);
		setDecisionClaim(null);
	};

	const openHistory = async (claim: ExpensesClaim) => {
		setHistoryClaim(claim);
		setHistoryOpen(true);
		setHistoryLoading(true);
		setHistoryError('');
		viewState.store.act(
			(transaction) => transaction.set(viewState.state.historyEntries, []),
			'expenses/history-loading',
		);
		try {
			const page = await loadExpenseClaimHistory(claim.id);
			viewState.store.act(
				(transaction) => transaction.set(
					viewState.state.historyEntries,
					page.entries,
				),
				'expenses/history-loaded',
			);
		} catch (historyFailure) {
			setHistoryError(message(historyFailure, t('expenses.error.history')));
		} finally {
			setHistoryLoading(false);
		}
	};

	const decideClaim = async (event: SubmitEvent) => {
		event.preventDefault();
		if (!decisionClaim) return;
		const form = new FormData(event.currentTarget as HTMLFormElement);
		setStatus('deciding');
		setDecisionError('');
		try {
			await decideExpensesClaim(
				decisionClaim.id,
				decision,
				formValue(form, 'comment'),
				props.csrfToken,
			);
			closeDecision();
			await load(listing());
		} catch (decisionFailure) {
			setDecisionError(message(decisionFailure, t('expenses.error.decision')));
			setStatus('idle');
		}
	};

	const openBulk = (action: ExpenseBulkAction) => {
		setBulkComment('');
		setBulkAction(action);
	};

	const closeBulk = () => setBulkAction(null);

	/* Every bulk action goes the same way: the selected ids on screen, one
   outcome per id, then the listing is read again and the counts are told.
   A refused or missing id is a count, never a failure of the call. */
	const applyBulk = async () => {
		const action = bulkAction;
		const ids = bulkTargets;
		if (action === null || ids.length === 0) return;
		closeBulk();
		setStatus('submitting');
		setError('');
		try {
			let outcomes: readonly ExpenseClaimBulkOutcome[];
			if (action === 'submit') {
				outcomes = await submitExpensesClaimsMany(ids, props.csrfToken);
			} else {
				outcomes = await decideExpensesClaimsMany(
					ids,
					action,
					bulkComment,
					props.csrfToken,
				);
			}
			await load(listing());
			toasts.success(
				t(
					action === 'submit'
						? 'expenses.notice.submittedMany'
						: action === 'approved'
							? 'expenses.notice.approvedMany'
							: 'expenses.notice.rejectedMany',
					bulkOutcomeCounts(outcomes),
				),
			);
		} catch (bulkError) {
			setError(message(bulkError, t('expenses.error.bulk')));
			setStatus('idle');
		}
	};

	/* Keep the action column whenever this principal can perform an action.
   Filtering to decided records must not resize every data column. */
	const showActionColumn = showsExpenseActionColumn(
		props.canManage,
		props.canApprove,
	);
	const showSelection = showActionColumn;
	const claimActions = (claim: ExpensesClaim): readonly TableAction[] => {
		if (claim.status === 'draft' && props.canManage) {
			return [
				{
					id: 'submit',
					label: t('expenses.action.submit'),
					icon: 'play',
					disabled: status !== 'idle',
					onSelect: () => void submitDraft(claim.id),
				},
				{
					id: 'delete',
					label: t('expenses.action.delete'),
					icon: 'x',
					tone: 'danger',
					disabled: status !== 'idle',
					onSelect: () => requestDelete(claim),
				},
			];
		}
		if (claim.status === 'submitted' && props.canApprove) {
			return [
				{
					id: 'approve',
					label: t('expenses.action.approve'),
					icon: 'check',
					disabled: status !== 'idle',
					onSelect: () => openDecision(claim, 'approved'),
				},
				{
					id: 'reject',
					label: t('expenses.action.reject'),
					icon: 'x',
					tone: 'danger',
					disabled: status !== 'idle',
					onSelect: () => openDecision(claim, 'rejected'),
				},
			];
		}
		return [];
	};

	const bulkActions: TableBulkAction[] = [];
	if (props.canApprove) {
		bulkActions.push(
			{
				id: 'approve-selected',
				label: t('expenses.action.approveSelected'),
				icon: 'check',
				disabled: decidable.length === 0 || status !== 'idle',
				reason: decidable.length === 0
					? t('expenses.action.bulkDecisionRefused')
					: undefined,
				onSelect: () => openBulk('approved'),
			},
			{
				id: 'reject-selected',
				label: t('expenses.action.rejectSelected'),
				icon: 'x',
				tone: 'danger',
				disabled: decidable.length === 0 || status !== 'idle',
				reason: decidable.length === 0
					? t('expenses.action.bulkDecisionRefused')
					: undefined,
				onSelect: () => openBulk('rejected'),
			},
		);
	}
	if (props.canManage) {
		bulkActions.push({
			id: 'submit-selected',
			label: t('expenses.action.submitSelected'),
			icon: 'play',
			disabled: submittable.length === 0 || status !== 'idle',
			reason: submittable.length === 0
				? t('expenses.action.bulkSubmitRefused')
				: undefined,
			onSelect: () => openBulk('submit'),
		});
	}

	<div class="ui-view">
		<PageHeader
			eyebrow={t('expenses.page.eyebrow')}
			title={t('expenses.page.title')}
			description={t('expenses.page.description')}
		>
			@if (props.canRead) {
				<Button size="sm" onClick={() => void refresh()}>
					<Icon name="refresh" size={14} />
					{t('expenses.action.refresh')}
				</Button>
			}
			@if (props.canManage) {
				<Button size="sm" variant="primary" onClick={openCreate}>
					<Icon name="plus" size={14} />
					{t('expenses.action.new')}
				</Button>
			}
		</PageHeader>
		@if (!props.canRead) {
			<Alert tone="warning">{t('expenses.denied')}</Alert>
		} @else {
			<>
				@if (error && !formOpen && !decisionOpen) {
					<Alert>{error}</Alert>
				}
				<TableCard
					title={t('expenses.table.title')}
					count={t('expenses.table.count', { count: claims.length })}
					search={<SearchField
						value={query}
						placeholder={t('expenses.search.placeholder')}
						label={t('expenses.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={(statusFilter === 'all' ? 0 : 1) +
							(categoryFilter === 'all' ? 0 : 1)}
						label={t('expenses.filters.label')}
					>
						<Select
							id="expenses-status-filter"
							label={t('expenses.filters.status')}
							value={statusFilter}
							disabled={status !== 'idle'}
							options={[
								{ value: 'all', label: t('expenses.filters.all') },
								{ value: 'draft', label: t('expenses.status.draft') },
								{ value: 'submitted', label: t('expenses.status.submitted') },
								{ value: 'approved', label: t('expenses.status.approved') },
								{ value: 'rejected', label: t('expenses.status.rejected') },
							]}
							onChange={changeStatusFilter}
						/>
						<Select
							id="expenses-category-filter"
							label={t('expenses.filters.category')}
							value={categoryFilter}
							disabled={status !== 'idle'}
							options={[
								{ value: 'all', label: t('expenses.filters.allCategories') },
								{ value: 'travel', label: t('expenses.category.travel') },
								{ value: 'meals', label: t('expenses.category.meals') },
								{ value: 'equipment', label: t('expenses.category.equipment') },
								{ value: 'other', label: t('expenses.category.other') },
							]}
							onChange={changeCategoryFilter}
						/>
					</Filters>}
					caption={t('expenses.table.caption')}
					mode="server"
					columns={columns(showActionColumn)}
					rows={claims}
					rowKey={(claim) => claim.id}
					sorting
					sortingState={sorting}
					onSortingChange={changeSorting}
					pagination={{
						pageIndex,
						pageSize,
						onPageChange: openPage,
						hasMore,
					}}
					after={<Pagination
						pageIndex={pageIndex}
						pageSize={pageSize}
						hasMore={hasMore}
						pageSizes={PAGE_SIZES}
						onPageChange={openPage}
						onPageSizeChange={changePageSize}
						label={t('expenses.pagination.label')}
						previousLabel={t('expenses.pagination.previous')}
						nextLabel={t('expenses.pagination.next')}
						pageSizeLabel={t('expenses.pagination.size')}
						summary={(page) => t('expenses.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' ? 'loading' : 'idle'}
					loadingLabel={t('expenses.table.loading')}
					filtered={filtered}
					empty={{
						icon: 'file-text',
						title: t('expenses.table.emptyTitle'),
						hint: props.canManage
							? t('expenses.table.emptyManage')
							: t('expenses.table.emptyRead'),
					}}
					emptyFiltered={{
						icon: 'file-text',
						title: t('expenses.table.emptyFilteredTitle'),
						hint: t('expenses.table.emptyFilteredHint'),
					}}
					selection={showSelection
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('expenses.selection.label'),
								rowLabel: (claim) => t('expenses.selection.rowLabel', {
									name: claim.title,
								}),
								selectable: (claim) =>
									props.canApprove && claim.status === 'submitted' ||
										props.canManage && claim.status === 'draft',
								clearLabel: t('expenses.selection.clear'),
							}
						: undefined}
					bulkActions={showSelection ? bulkActions : undefined}
					selectionSummary={(count) => t('expenses.selection.summary', {
						count,
					})}
					actionsLabel={t('expenses.table.actions')}
					actionsWidth="280px"
					actions={showActionColumn ? claimActions : undefined}
					onSelect={(claim) => void openHistory(claim)}
				/>
				<Drawer
					open={formOpen}
					title={t('expenses.drawer.newTitle')}
					subtitle={t('expenses.drawer.newSubtitle')}
					width="lg"
					onClose={closeCreate}
				>
					<ExpenseClaimForm
						key={'expense-form-' + formSession}
						busy={status === 'submitting'}
						error={formError}
						onCancel={closeCreate}
						onSubmit={(event) => void createClaim(event)}
					/>
				</Drawer>
				<Drawer
					open={decisionOpen && decisionClaim !== null}
					title={decision === 'approved'
						? t('expenses.drawer.approveTitle')
						: t('expenses.drawer.rejectTitle')}
					subtitle={t('expenses.drawer.decisionSubtitle')}
					onClose={closeDecision}
				>
					@if (decisionClaim) {
						<ExpenseDecisionForm
							key={'expense-decision-' + decisionSession}
							claim={decisionClaim}
							decision={decision}
							busy={status === 'deciding'}
							error={decisionError}
							onCancel={closeDecision}
							onSubmit={(event) => void decideClaim(event)}
						/>
					}
				</Drawer>
				<ExpenseHistoryDrawer
					open={historyOpen}
					claim={historyClaim}
					entries={historyEntries}
					loading={historyLoading}
					error={historyError}
					onClose={() => {
						setHistoryOpen(false);
						setHistoryClaim(null);
					}}
				/>
				<ConfirmDialog
					open={deleteConfirmOpen && deleteClaim !== null}
					title={t('expenses.delete.title')}
					confirmLabel={t('expenses.delete.confirm')}
					cancelLabel={t('expenses.action.cancel')}
					busy={status === 'deleting'}
					tone="danger"
					onConfirm={() => void deleteDraft()}
					onCancel={closeDelete}
				>{t('expenses.delete.description', {
					name: deleteClaim?.title ?? '',
				})}</ConfirmDialog>
				<ConfirmDialog
					open={bulkAction !== null}
					title={bulkAction === 'submit'
						? t('expenses.bulk.submitTitle')
						: bulkAction === 'approved'
							? t('expenses.bulk.approveTitle')
							: t('expenses.bulk.rejectTitle')}
					confirmLabel={bulkAction === 'submit'
						? t('expenses.action.submitSelected')
						: bulkAction === 'approved'
							? t('expenses.action.approveSelected')
							: t('expenses.action.rejectSelected')}
					cancelLabel={t('expenses.action.cancel')}
					tone={bulkAction === 'rejected' ? 'danger' : 'primary'}
					busy={status === 'submitting'}
					onConfirm={() => void applyBulk()}
					onCancel={closeBulk}
				>
					<p>
						{bulkAction === 'submit'
							? t('expenses.bulk.submitDescription', {
									count: bulkTargets.length,
								})
							: t('expenses.bulk.decisionDescription', {
									count: bulkTargets.length,
								})}
					</p>
					@if (bulkAction !== null && bulkAction !== 'submit') {
						<FormField
							label={t('expenses.bulk.comment')}
							help={t('expenses.bulk.commentHelp')}
						>
							<textarea
								class="ui-textarea"
								name="comment"
								maxLength={2000}
								value={bulkComment}
								onInput={(event) => setBulkComment(event.currentTarget.value)}
							></textarea>
						</FormField>
					}
				</ConfirmDialog>
				<ToastHost
					label={t('expenses.common.messages')}
					closeLabel={t('expenses.action.close')}
				/>
			</>
		}
	</div>
}

export function ExpensesDashboardWidget() @{
	const widgetState = useMemo(() => createExpensesDashboardState(), []);
	const [count, setCount] = useValue(widgetState.state.count);
	const [status, setStatus] = useValue(widgetState.state.status);
	const [error, setError] = useValue(widgetState.state.error);

	useEffect(() => {
		setStatus('loading');
		setError('');
		void loadAwaitingApprovalCount().then(setCount).catch(
			(loadError) => setError(
				loadError instanceof Error
					? loadError.message
					: t('expenses.widget.error'),
			),
		).finally(() => setStatus('idle'));
	}, []);

	<Kpi
		label={t('expenses.widget.label')}
		value={status === 'loading'
			? '…'
			: error
				? t('expenses.widget.unavailable')
				: new Intl.NumberFormat(activeLocale()).format(count)}
		note={error || t('expenses.widget.note')}
		href="/expenses"
		linkLabel={t('expenses.widget.link')}
	/>
}
