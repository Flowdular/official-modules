import { useEffect, useMemo } from 'octane';
import {
	Alert,
	Button,
	CellCode,
	CellMuted,
	CellStack,
	CellTag,
	CellText,
	CellTime,
	ConfirmDialog,
	Drawer,
	EmptyState,
	Filters,
	Icon,
	Kpi,
	PageHeader,
	Pagination,
	SearchField,
	Select,
	TableCard,
	ToastHost,
	toasts,
	type TableColumn,
	type TableSort,
} from '@flowdular/sdk/ui';
import { activeLocale, t } from '@flowdular/sdk/client';
import { useValue } from 'segment-state';
import type { Party, PartyBulkOutcome, PartyKind } from '../domain/types.ts';
import { PARTY_EXPORT_LIST_ID } from '../domain/lists.ts';
import {
	ApiError,
	archiveParties,
	archiveParty,
	createParty,
	deleteParty,
	loadPartyHistory,
	loadParties,
	restoreParties,
	restoreParty,
	startListExport,
	updateParty,
} from './api.ts';
import {
	bulkOutcomeCounts,
	bulkTargets,
	createPartiesClientState,
	DEFAULT_PARTY_SORTING,
	loadedListing,
	pageCursor,
	partySort,
	resetPageCursors,
	searchPending,
	type Listing,
	type PartyStatusFilter,
} from './state.ts';
import { PartyForm } from './PartyForm.tsrx';
import { PartyHistoryDrawer } from './PartyHistoryDrawer.tsrx';

export interface PartiesViewProps {
	readonly csrfToken: string;
	readonly canManage: boolean;
	/** Whether the principal may start an export job; exports.core owns it. */
	readonly canExport: boolean;
	readonly kind: 'customer' | 'supplier';
}

const PAGE_SIZES = [25, 50, 100];
const SEARCH_DEBOUNCE_MS = 300;
/** The most active parties the dashboard counts before it says "more". */
const WIDGET_COUNT_LIMIT = 200;

function formValue(form: FormData, key: string): string {
	const value = form.get(key);
	return typeof value === 'string' ? value : '';
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function kindLabel(kind: PartyKind): string {
	return t('parties.kind.' + kind);
}

/* Column keys double as the server's sort keys; only the two the server
   orders by declare a value, so only they get a sortable header. */
function columns(): readonly TableColumn<Party>[] {
	return [
		{
			key: 'name',
			header: t('parties.table.column.party'),
			width: 'auto',
			value: (party) => party.name,
			cell: (party) =>
				<CellStack
					primary={party.name}
					secondary={party.email ?? party.phone ??
						<CellMuted>{t('parties.table.noContact')}</CellMuted>}
				/>,
		},
		{
			key: 'kind',
			header: t('parties.table.column.kind'),
			width: '140px',
			priority: 2,
			cell: (party) => <CellText value={kindLabel(party.kind)} />,
		},
		{
			key: 'vatId',
			header: t('parties.table.column.vatId'),
			width: '170px',
			priority: 2,
			cell: (party) => party.vatId === null
				? <CellMuted>{t('parties.table.notSet')}</CellMuted>
				: <CellCode value={party.vatId} />,
		},
		{
			key: 'status',
			header: t('parties.table.column.status'),
			width: '130px',
			cell: (party) =>
				<CellTag
					tone={party.status === 'active' ? 'success' : 'neutral'}
					dot
					label={t('parties.status.' + party.status)}
				/>,
		},
		{
			key: 'updatedAt',
			header: t('parties.table.column.updatedAt'),
			width: '170px',
			priority: 2,
			value: (party) => party.updatedAt,
			cell: (party) => <CellTime value={party.updatedAt} />,
		},
	];
}

export function PartiesView(props: PartiesViewProps) @{
	const partiesState = useMemo(() => createPartiesClientState(), []);
	/* Answers arrive in any order; only the latest request may write the page. */
	const requests = useMemo(() => ({ sequence: 0 }), []);
	const [parties] = useValue(partiesState.state.parties);
	const [status, setStatus] = useValue(partiesState.state.status);
	const [error, setError] = useValue(partiesState.state.error);
	const [query, setQuery] = useValue(partiesState.state.query);
	const [appliedQuery] = useValue(partiesState.state.appliedQuery);
	const [hasVatId, setHasVatId] = useValue(partiesState.state.hasVatId);
	const [statusFilter, setStatusFilter] = useValue(
		partiesState.state.statusFilter,
	);
	const [sorting, setSorting] = useValue(partiesState.state.sorting);
	const [pageIndex] = useValue(partiesState.state.pageIndex);
	const [pageSize, setPageSize] = useValue(partiesState.state.pageSize);
	const [cursors] = useValue(partiesState.state.cursors);
	const [nextCursor] = useValue(partiesState.state.nextCursor);
	const [filtersOpen, setFiltersOpen] = useValue(
		partiesState.state.filtersOpen,
	);
	const [selectedIds, setSelectedIds] = useValue(
		partiesState.state.selectedIds,
	);
	const [confirmArchiveMany, setConfirmArchiveMany] = useValue(
		partiesState.state.confirmArchiveMany,
	);
	const [formOpen, setFormOpen] = useValue(partiesState.state.formOpen);
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useValue(
		partiesState.state.deleteConfirmOpen,
	);
	const [editingParty, setEditingParty] = useValue(
		partiesState.state.editingParty,
	);
	const [historyOpen, setHistoryOpen] = useValue(
		partiesState.state.historyOpen,
	);
	const [historyParty, setHistoryParty] = useValue(
		partiesState.state.historyParty,
	);
	const [historyEntries] = useValue(partiesState.state.historyEntries);
	const [historyLoading, setHistoryLoading] = useValue(
		partiesState.state.historyLoading,
	);
	const [historyError, setHistoryError] = useValue(
		partiesState.state.historyError,
	);
	const [formSession, setFormSession] = useValue(
		partiesState.state.formSession,
	);
	const [exportStarted, setExportStarted] = useValue(
		partiesState.state.exportStarted,
	);
	const namespace = 'parties.' + props.kind;
	const term = query.trim();
	const hasMore = nextCursor !== null;
	const archiveTargets = bulkTargets(parties, selectedIds, 'active');
	const restoreTargets = bulkTargets(parties, selectedIds, 'archived');
	const filtersActive =
		appliedQuery !== '' || statusFilter !== 'active' || hasVatId;
	const listing = (): Listing => ({
		pageIndex,
		pageSize,
		sorting,
		query: appliedQuery,
		status: statusFilter,
		hasVatId,
		cursors,
	});
	/* The search timer fires after later renders; it reads the listing those
   renders left here rather than the one the keystroke saw. */
	const latest = useMemo(() => ({ listing: listing() }), []);
	latest.listing = listing();
	/* A changed order, filter or page size is a new listing, whose cursors
   name positions in the old one. */
	const firstPage = (changes: Partial<Listing>): Listing => ({
		...listing(),
		...changes,
		pageIndex: 0,
		cursors: resetPageCursors(),
	});

	const failLoad = (loadError: unknown) => {
		setError(message(loadError, t('parties.error.load')));
		setStatus(
			loadError instanceof ApiError && loadError.status === 403
				? 'denied'
				: 'error',
		);
	};

	/* The server sorts, narrows and cuts the page; the listing travels as an
   argument because the click that changes it and the load it starts happen
   in one render, where the state hooks still read the old values. */
	const load = async (next: Listing) => {
		const cursor = pageCursor(next.cursors, next.pageIndex);
		if (cursor === undefined) return;
		const sequence = requests.sequence + 1;
		requests.sequence = sequence;
		setStatus('loading');
		setError('');
		try {
			const { sort, direction } = partySort(next.sorting);
			const page = await loadParties({
				sort,
				direction,
				limit: next.pageSize,
				kind: props.kind,
				status: next.status,
				query: next.query,
				hasVatId: next.hasVatId,
				cursor,
			});
			if (sequence !== requests.sequence) return;
			const loaded = loadedListing(next, page);
			partiesState.store.act((transaction) => {
				transaction.set(partiesState.state.parties, loaded.parties);
				transaction.set(partiesState.state.appliedQuery, loaded.appliedQuery);
				transaction.set(partiesState.state.pageIndex, loaded.pageIndex);
				transaction.set(partiesState.state.cursors, loaded.cursors);
				transaction.set(partiesState.state.nextCursor, loaded.nextCursor);
				transaction.set(partiesState.state.selectedIds, loaded.selectedIds);
				transaction.set(partiesState.state.status, 'idle');
			}, 'parties/loaded');
		} catch (loadError) {
			if (sequence === requests.sequence) failLoad(loadError);
		}
	};

	const refresh = () => {
		setExportStarted(false);
		void load(firstPage({}));
	};

	const openPage = (index: number) => {
		if (index !== pageIndex) void load({ ...listing(), pageIndex: index });
	};

	const changeSorting = (sorts: readonly TableSort[]) => {
		const next =
			sorts.length === 0 ? DEFAULT_PARTY_SORTING : sorts;
		setSorting(next);
		void load(firstPage({ sorting: next }));
	};

	const changeStatusFilter = (value: string) => {
		const next: PartyStatusFilter =
			value === 'active' || value === 'archived' ? value : '';
		setStatusFilter(next);
		void load(firstPage({ status: next }));
	};

	const changeHasVatId = (next: boolean) => {
		setHasVatId(next);
		void load(firstPage({ hasVatId: next }));
	};

	const changePageSize = (size: number) => {
		setPageSize(size);
		void load(firstPage({ pageSize: size }));
	};

	useEffect(() => {
		refresh();
	}, []);

	/* The term is the server's filter, so typing it starts a new listing rather
   than narrowing the page on screen: one listing per pause in the typing. */
	useEffect(() => {
		if (!searchPending(query, appliedQuery)) return;
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

	const openForm = (party: Party | null) => {
		setEditingParty(party);
		setError('');
		setFormSession((current) => current + 1);
		setFormOpen(true);
	};

	const closeForm = () => {
		setFormOpen(false);
		setEditingParty(null);
		setError('');
	};

	/* The server ordered the page, so a changed row keeps its place until the
   next read; under a status filter it may no longer belong here at all. */
	const replace = async (party: Party) => {
		partiesState.store.act(
			(transaction) => transaction.set(
				partiesState.state.parties,
				parties.map((current) => current.id === party.id ? party : current),
			),
			'parties/lifecycle',
		);
		setEditingParty(party);
		if (statusFilter !== '' && party.status !== statusFilter) {
			await load(listing());
		}
	};

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		const element = event.currentTarget as HTMLFormElement;
		const form = new FormData(element);
		setStatus('submitting');
		setError('');
		try {
			const input = {
				name: formValue(form, 'name'),
				kind: formValue(form, 'kind') as PartyKind,
				email: formValue(form, 'email'),
				phone: formValue(form, 'phone'),
				vatId: formValue(form, 'vatId'),
			};
			if (editingParty) {
				const party = await updateParty(
					{ id: editingParty.id, ...input },
					props.csrfToken,
				);
				closeForm();
				setStatus('idle');
				await replace(party);
			} else {
				await createParty(input, props.csrfToken);
				closeForm();
				/* The new row belongs wherever the order puts it. */
				await load(firstPage({}));
			}
		} catch (saveError) {
			setError(
				message(
					saveError,
					t(editingParty ? 'parties.error.update' : 'parties.error.create'),
				),
			);
			setStatus('idle');
		}
	};

	const changeStatus = async (action: 'archive' | 'restore') => {
		if (!editingParty) return;
		setStatus('submitting');
		setError('');
		try {
			const party =
				action === 'archive'
					? await archiveParty(editingParty.id, props.csrfToken)
					: await restoreParty(editingParty.id, props.csrfToken);
			setStatus('idle');
			await replace(party);
		} catch (lifecycleError) {
			setError(message(lifecycleError, t('parties.error.lifecycle')));
			setStatus('idle');
		}
	};

	const remove = async () => {
		if (!editingParty) return;
		setStatus('submitting');
		setError('');
		try {
			await deleteParty(editingParty.id, props.csrfToken);
			setDeleteConfirmOpen(false);
			closeForm();
			await load(listing());
		} catch (deleteError) {
			setError(message(deleteError, t('parties.error.delete')));
			setStatus('idle');
		}
	};

	/* Both bulk actions go the same way: the qualifying selected ids on
   screen, one outcome per id, then the listing is read again and the
   counts are told. A refused or missing id is a count, never a failure. */
	const applyMany = async (
		ids: readonly string[],
		run: (ids: readonly string[]) => Promise<readonly PartyBulkOutcome[]>,
		done: string,
		fallback: string,
	) => {
		if (ids.length === 0) return;
		setStatus('submitting');
		setError('');
		try {
			const outcomes = await run(ids);
			await load(listing());
			toasts.success(t(done, bulkOutcomeCounts(outcomes)));
		} catch (bulkError) {
			setError(message(bulkError, t(fallback)));
			setStatus('idle');
		}
	};

	const archiveMany = () => {
		setConfirmArchiveMany(false);
		void applyMany(
			archiveTargets,
			(ids) => archiveParties(ids, props.csrfToken),
			'parties.notice.archivedMany',
			'parties.error.archiveMany',
		);
	};

	const restoreMany = () => void applyMany(
		restoreTargets,
		(ids) => restoreParties(ids, props.csrfToken),
		'parties.notice.restoredMany',
		'parties.error.restoreMany',
	);

	/* exports.core answers as soon as the job is recorded, not when the file is
   written, so the screen reports that it started and points at the screen
   that hands it over. */
	const startExport = async () => {
		setStatus('submitting');
		setError('');
		try {
			await startListExport(PARTY_EXPORT_LIST_ID, props.csrfToken);
			setExportStarted(true);
			setStatus('idle');
		} catch (exportError) {
			setError(message(exportError, t('parties.export.error')));
			setStatus('idle');
		}
	};

	const openHistory = async (party: Party) => {
		setHistoryParty(party);
		setHistoryOpen(true);
		setHistoryLoading(true);
		setHistoryError('');
		partiesState.store.act(
			(transaction) => transaction.set(partiesState.state.historyEntries, []),
			'parties/history-loading',
		);
		try {
			const page = await loadPartyHistory(party.id);
			partiesState.store.act(
				(transaction) => transaction.set(
					partiesState.state.historyEntries,
					page.entries,
				),
				'parties/history-loaded',
			);
		} catch (historyFailure) {
			setHistoryError(message(historyFailure, t('parties.error.history')));
		} finally {
			setHistoryLoading(false);
		}
	};

	<div class="ui-view">
		<PageHeader
			eyebrow={t('parties.page.eyebrow')}
			title={t(namespace + '.title')}
			description={t(namespace + '.description')}
		>
			<Button size="sm" onClick={refresh}>
				<Icon name="refresh" size={14} />
				{t('parties.action.refresh')}
			</Button>
			@if (props.canExport) {
				<Button
					size="sm"
					disabled={status === 'denied' || status === 'submitting'}
					onClick={() => void startExport()}
				>
					<Icon name="download" size={14} />
					{t('parties.export.action')}
				</Button>
			}
			@if (props.canManage) {
				<Button
					size="sm"
					variant="primary"
					disabled={status === 'denied'}
					onClick={() => openForm(null)}
				>
					<Icon name="plus" size={14} />
					{t(namespace + '.new')}
				</Button>
			}
		</PageHeader>
		@if (status === 'denied') {
			<section class="ui-card">
				<EmptyState icon="shield" title={t('parties.denied.title')}>{t(
					'parties.denied.description',
				)}</EmptyState>
			</section>
		} @else {
			<>
				@if (error && !formOpen) {
					<Alert>{error}</Alert>
				}
				@if (exportStarted) {
					<Alert tone="info">
						{t('parties.export.started')}
						{' '}
						<a href="/exports">{t('parties.export.link')}</a>
					</Alert>
				}
				<TableCard
					title={t(namespace + '.tableTitle')}
					search={<SearchField
						value={query}
						placeholder={t('parties.search.placeholder')}
						label={t('parties.search.label')}
						onInput={setQuery}
					/>}
					filters={<Filters
						open={filtersOpen}
						onToggle={() => setFiltersOpen(!filtersOpen)}
						activeCount={(hasVatId ? 1 : 0) +
							(statusFilter === 'active' ? 0 : 1)}
						label={t('parties.filters.label')}
					>
						<Select
							id={'parties-status-filter-' + props.kind}
							label={t('parties.filters.status')}
							value={statusFilter}
							options={[
								{ value: '', label: t('parties.filters.allStatuses') },
								{ value: 'active', label: t('parties.status.active') },
								{ value: 'archived', label: t('parties.status.archived') },
							]}
							onChange={changeStatusFilter}
						/>
						<label class="ui-checkbox">
							<input
								type="checkbox"
								checked={hasVatId}
								onChange={(event: Event) => changeHasVatId(
									(event.currentTarget as HTMLInputElement).checked,
								)}
							/>
							<span>{t('parties.filters.hasVatId')}</span>
						</label>
					</Filters>}
					caption={t(namespace + '.tableTitle')}
					mode="server"
					columns={columns()}
					rows={parties}
					rowKey={(party) => party.id}
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
						label={t('parties.pagination.label')}
						previousLabel={t('parties.pagination.previous')}
						nextLabel={t('parties.pagination.next')}
						pageSizeLabel={t('parties.pagination.size')}
						summary={(page) => t('parties.pagination.summary', {
							page: page.pageIndex + 1,
							from: page.from,
						})}
					/>}
					status={status === 'loading' ? 'loading' : 'idle'}
					loadingLabel={t('parties.table.loading')}
					filtered={filtersActive}
					empty={{
						icon: 'parties',
						title: t(namespace + '.emptyTitle'),
						hint: t(namespace + '.emptyHint'),
					}}
					emptyFiltered={{
						icon: 'parties',
						title: t('parties.table.emptyFilteredTitle'),
						hint: t('parties.table.emptyFilteredHint'),
					}}
					selection={props.canManage
						? {
								selectedKeys: selectedIds,
								onSelectionChange: setSelectedIds,
								label: t('parties.selection.label'),
								rowLabel: (party) => t('parties.selection.rowLabel', {
									name: party.name,
								}),
								clearLabel: t('parties.selection.clear'),
							}
						: undefined}
					bulkActions={props.canManage
						? [
								{
									id: 'archive-selected',
									label: t('parties.action.archiveSelected'),
									icon: 'archive',
									tone: 'danger',
									disabled: archiveTargets.length === 0 ||
										status === 'submitting',
									reason: archiveTargets.length === 0
										? t('parties.action.archiveRefused')
										: undefined,
									onSelect: () => setConfirmArchiveMany(true),
								},
								{
									id: 'restore-selected',
									label: t('parties.action.restoreSelected'),
									icon: 'refresh',
									disabled: restoreTargets.length === 0 ||
										status === 'submitting',
									reason: restoreTargets.length === 0
										? t('parties.action.restoreRefused')
										: undefined,
									onSelect: restoreMany,
								},
							]
						: undefined}
					selectionSummary={(count) => t('parties.selection.summary', {
						count,
					})}
					actionsLabel={t('parties.table.column.actions')}
					actionsWidth={props.canManage ? '280px' : '160px'}
					actions={(party) => [
						{
							id: 'history',
							label: t('parties.action.history'),
							icon: 'activity',
							onSelect: () => void openHistory(party),
						},
						...(props.canManage
							? [
									{
										id: 'edit',
										label: t('parties.action.edit'),
										icon: 'file-text',
										onSelect: () => openForm(party),
									},
								]
							: []),
					]}
				/>
			</>
		}
		<Drawer
			open={formOpen}
			title={editingParty ? t('parties.drawer.edit') : t(namespace + '.new')}
			subtitle={editingParty
				? t('parties.drawer.editSubtitle')
				: t(namespace + '.drawerSubtitle')}
			width="lg"
			onClose={closeForm}
		>
			<PartyForm
				key={'party-form-' + formSession}
				party={editingParty}
				defaultKind={props.kind}
				busy={status === 'submitting'}
				error={error}
				onCancel={closeForm}
				onArchive={editingParty?.status === 'active'
					? () => changeStatus('archive')
					: undefined}
				onRestore={editingParty?.status === 'archived'
					? () => changeStatus('restore')
					: undefined}
				onDelete={editingParty?.status === 'archived'
					? () => setDeleteConfirmOpen(true)
					: undefined}
				onSubmit={(event) => void submit(event)}
			/>
		</Drawer>
		<PartyHistoryDrawer
			open={historyOpen}
			party={historyParty}
			entries={historyEntries}
			loading={historyLoading}
			error={historyError}
			onClose={() => {
				setHistoryOpen(false);
				setHistoryParty(null);
			}}
		/>
		<ConfirmDialog
			open={confirmArchiveMany}
			title={t('parties.archiveMany.title')}
			confirmLabel={t('parties.action.archiveSelected')}
			cancelLabel={t('parties.action.cancel')}
			busy={status === 'submitting'}
			onConfirm={archiveMany}
			onCancel={() => setConfirmArchiveMany(false)}
		>{t('parties.archiveMany.description', {
			count: archiveTargets.length,
		})}</ConfirmDialog>
		<ConfirmDialog
			open={deleteConfirmOpen}
			title={t('parties.delete.title')}
			confirmLabel={t('parties.delete.confirm')}
			cancelLabel={t('parties.action.cancel')}
			busy={status === 'submitting'}
			onConfirm={() => void remove()}
			onCancel={() => setDeleteConfirmOpen(false)}
		>{t('parties.delete.description', {
			name: editingParty?.name ?? '',
		})}</ConfirmDialog>
		<ToastHost
			label={t('parties.common.messages')}
			closeLabel={t('parties.action.close')}
		/>
	</div>
}

export function PartiesDashboardWidget() @{
	const widgetState = useMemo(() => createPartiesClientState(), []);
	const [parties] = useValue(widgetState.state.parties);
	const [nextCursor] = useValue(widgetState.state.nextCursor);
	const [status, setStatus] = useValue(widgetState.state.status);
	useEffect(() => {
		setStatus('loading');
		void loadParties({
			sort: 'name',
			direction: 'asc',
			limit: WIDGET_COUNT_LIMIT,
			kind: '',
			status: 'active',
			query: '',
			hasVatId: false,
			cursor: null,
		}).then((page) => {
			widgetState.store.act((transaction) => {
				transaction.set(widgetState.state.parties, page.items);
				transaction.set(widgetState.state.nextCursor, page.page.nextCursor);
			}, 'parties/widget-loaded');
		}).catch(() => undefined).finally(() => setStatus('idle'));
	}, []);
	<Kpi
		label={t('parties.widget.label')}
		value={status === 'loading'
			? '…'
			: new Intl.NumberFormat(activeLocale()).format(parties.length) +
				(nextCursor === null ? '' : '+')}
		note={t('parties.widget.note')}
		href="/customers"
		linkLabel={t('parties.widget.link')}
	/>
}
