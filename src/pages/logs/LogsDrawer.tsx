import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { MultiSelectFilter, type FilterSelection } from '../../components/EntityFilters';
import { PopoverScrim } from '../../components/FilterPopover';
import { plural } from '../../domain/format';
import { logClient } from '../../bistApi/logClient';
import {
  LOG_VALUE_COUNT_LIMIT,
  type LogExtent,
  type LogExtents,
  type LogQueryResult,
  type LogSource,
  type LogValueCounts,
  type StoredErrorType,
  type TrafficLogType,
  type WireDirection,
} from '../../bistApi/logTypes';
import { LogsTable } from './LogsTable';
import {
  ERROR_TYPES,
  LOG_TABS,
  TRAFFIC_TYPES,
  VALUE_FILTER_KEYS_BY_TAB,
  VALUE_FILTER_NOUNS,
  WIRE_DIRECTIONS,
  clampRangeToExtent,
  columnsFor,
  daysBetween,
  extentDateBounds,
  extentForTab,
  filterLoadedRows,
  formatDateKey,
  formatRange,
  idOf,
  rangeToMilliseconds,
  rangeTriggerLabel,
  shiftDateKey,
  sortRows,
  sourceLogName,
  timestampOf,
  todayInIstanbul,
  valueFilterOptions,
  type LogEnvelope,
  type LogRange,
  type LogsTab,
  type SortDirection,
  type ValueFilterKey,
} from './logsModel';

import './logs.css';

export interface LogsDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface SourcePage {
  source: LogSource;
  rows: LogEnvelope[];
  total: number;
  countsByType: Record<string, number>;
  /** Operation/account id (wire) or path (API) counts; the error log has none. */
  valueCounts: Partial<Record<ValueFilterKey, LogValueCounts>>;
  /** Wire-only: rows per direction in the range, ignoring every selection. */
  directionCounts: Record<WireDirection, number> | null;
  extent: LogExtent;
  exhausted: boolean;
}

/** What one server read is narrowed by. Search is not here: it never leaves the browser. */
interface PageFilter {
  types: readonly string[];
  /** Wire-only. */
  directions: readonly WireDirection[];
  /** `null` asks for every value of that filter; an empty list for none. */
  values: Partial<Record<ValueFilterKey, readonly string[] | null>>;
}

const NO_FILTER: PageFilter = { types: [], directions: [], values: {} };

interface ViewState {
  signature: string;
  pages: Partial<Record<LogSource, SourcePage>>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
}

type TypeSelections = {
  errors: StoredErrorType[];
  wire: TrafficLogType[];
  api: TrafficLogType[];
};

type ValueSelections = Record<ValueFilterKey, FilterSelection>;

/**
 * The last operation, account id, or path counts per filter, kept by the range
 * they counted. They ignore the selection, so ticking a box — which reloads
 * the page — does not empty the list the next box is being picked from.
 */
type RangeValueCounts = Record<ValueFilterKey, { rangeKey: string; counts: LogValueCounts } | null>;

type SortByTab = Record<LogsTab, { key: string; direction: SortDirection }>;

const PAGE_SIZE = 100;
/** `all` sits beside it; `none` is how one picks two operations out of forty. */
const VALUE_FILTER_PICKS = [{ label: 'none', select: new Set<string>() }];
const EMPTY_EXTENTS: LogExtents = {
  errors: { minMs: null, maxMs: null },
  wire: { minMs: null, maxMs: null },
  api: { minMs: null, maxMs: null },
};

function initialRanges(today: string): Record<LogsTab, LogRange> {
  const range = () => ({ from: today, to: today });
  return {
    errors: range(),
    wire: range(),
    api: range(),
  };
}

function initialSearches(): Record<LogsTab, string> {
  return { errors: '', wire: '', api: '' };
}

const INITIAL_SORTS: SortByTab = {
  errors: { key: 'time', direction: 'descending' },
  wire: { key: 'at', direction: 'descending' },
  api: { key: 'at', direction: 'descending' },
};

function emptyView(signature = ''): ViewState {
  return {
    signature,
    pages: {},
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  };
}

function unfilteredCount(
  pages: Partial<Record<LogSource, SourcePage>>,
  sources: readonly LogSource[],
): number {
  return sources.reduce((total, source) => {
    const page = pages[source];
    if (!page) return total;
    return (
      total + Object.values(page.countsByType).reduce((subtotal, count) => subtotal + count, 0)
    );
  }, 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'The local log database did not return a readable result.';
}

function toPage(result: LogQueryResult): SourcePage {
  let rows: LogEnvelope[];
  const valueCounts: Partial<Record<ValueFilterKey, LogValueCounts>> = {};
  let directionCounts: Record<WireDirection, number> | null = null;
  if (result.source === 'errors') {
    const errorRows = result.rows;
    rows = errorRows.map((row) => ({ source: 'errors', row }));
  } else if (result.source === 'wire') {
    const wireRows = result.rows;
    rows = wireRows.map((row) => ({ source: 'wire', row }));
    valueCounts.operation = result.operationCounts;
    valueCounts.accountId = result.accountIdCounts;
    directionCounts = result.countsByDirection;
  } else {
    const apiRows = result.rows;
    rows = apiRows.map((row) => ({ source: 'api', row }));
    valueCounts.path = result.pathCounts;
  }
  return {
    source: result.source,
    rows,
    total: result.total,
    countsByType: { ...result.countsByType },
    valueCounts,
    directionCounts,
    extent: result.extent,
    exhausted: rows.length < PAGE_SIZE || rows.length >= result.total,
  };
}

/** `null` asks the server for every value of that filter; `undefined` means the filter does not apply here. */
function queryValues(values: PageFilter['values'], key: ValueFilterKey): string[] | undefined {
  const selection = values[key];
  return selection === undefined || selection === null ? undefined : [...selection];
}

async function readPage(
  source: LogSource,
  range: LogRange,
  { types, directions, values }: PageFilter,
  beforeId?: number,
  limit = PAGE_SIZE,
): Promise<SourcePage> {
  const window = rangeToMilliseconds(range);
  if (source === 'errors') {
    return toPage(
      await logClient.query({
        source,
        ...window,
        types: types.length > 0 ? (types as StoredErrorType[]) : undefined,
        beforeId,
        limit,
      }),
    );
  }
  const trafficTypes = types.length > 0 ? (types as TrafficLogType[]) : undefined;
  if (source === 'wire') {
    return toPage(
      await logClient.query({
        source,
        ...window,
        types: trafficTypes,
        directions: directions.length > 0 ? [...directions] : undefined,
        operations: queryValues(values, 'operation'),
        accountIds: queryValues(values, 'accountId'),
        beforeId,
        limit,
      }),
    );
  }
  return toPage(
    await logClient.query({
      source,
      ...window,
      types: trafficTypes,
      paths: queryValues(values, 'path'),
      beforeId,
      limit,
    }),
  );
}

async function nearestDayForSource(
  source: LogSource,
  range: LogRange,
  extent: LogExtent,
): Promise<string | null> {
  const bounds = extentDateBounds(extent);
  if (!bounds.min || !bounds.max) return null;
  if (range.from > bounds.max) return bounds.max;
  if (range.to < bounds.min) return bounds.min;

  const candidates: string[] = [];
  const dayBefore = shiftDateKey(range.from, -1);
  if (bounds.min <= dayBefore) {
    const before = await readPage(
      source,
      { from: bounds.min, to: dayBefore },
      NO_FILTER,
      undefined,
      1,
    );
    const nearestBefore = before.rows[0];
    if (nearestBefore) {
      candidates.push(todayInIstanbul(timestampOf(nearestBefore)));
    }
  }

  let low = shiftDateKey(range.to, 1);
  let high = bounds.max;
  if (low <= high) {
    while (low < high) {
      const middle = shiftDateKey(low, Math.floor(daysBetween(low, high) / 2));
      const prefix = await readPage(source, { from: low, to: middle }, NO_FILTER, undefined, 1);
      if (prefix.total > 0) high = middle;
      else low = shiftDateKey(middle, 1);
    }
    candidates.push(low);
  }

  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => {
    const leftDistance =
      left < range.from ? daysBetween(left, range.from) : daysBetween(range.to, left);
    const rightDistance =
      right < range.from ? daysBetween(right, range.from) : daysBetween(range.to, right);
    return leftDistance - rightDistance;
  })[0]!;
}

function selectedFilterFor(
  source: LogSource,
  activeTab: LogsTab,
  types: TypeSelections,
  directions: readonly WireDirection[],
  values: ValueSelections,
): PageFilter {
  if (activeTab !== source) return NO_FILTER;
  const valueMap: Partial<Record<ValueFilterKey, readonly string[] | null>> = {};
  for (const key of VALUE_FILTER_KEYS_BY_TAB[source]) {
    valueMap[key] = selectionList(values[key]);
  }
  return {
    types: types[source],
    directions: source === 'wire' ? directions : [],
    values: valueMap,
  };
}

/** Sorted, so one selection always makes the same request and the same signature. */
function selectionList(selection: FilterSelection): string[] | null {
  return selection === null ? null : [...selection].sort();
}

function rangeKeyOf(range: LogRange): string {
  return `${range.from}:${range.to}`;
}

function copyWithFallback(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.className = 'logs-copy-fallback';
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) {
      throw new Error('The browser did not accept the copy command.');
    }
    return Promise.resolve();
  } finally {
    textarea.remove();
  }
}

export function LogsDrawer({ open, onClose }: LogsDrawerProps) {
  const today = todayInIstanbul();
  const [activeTab, setActiveTab] = useState<LogsTab>('errors');
  const [ranges, setRanges] = useState<Record<LogsTab, LogRange>>(() => initialRanges(today));
  const [rangeNotices, setRangeNotices] = useState<Record<LogsTab, string>>({
    errors: '',
    wire: '',
    api: '',
  });
  const [searches, setSearches] = useState<Record<LogsTab, string>>(initialSearches);
  const [typeSelections, setTypeSelections] = useState<TypeSelections>({
    errors: [],
    wire: [],
    api: [],
  });
  const [valueSelections, setValueSelections] = useState<ValueSelections>({
    operation: null,
    accountId: null,
    path: null,
  });
  const [rangeValueCounts, setRangeValueCounts] = useState<RangeValueCounts>({
    operation: null,
    accountId: null,
    path: null,
  });
  /** Wire-only: the wire log is the only tab with a direction column. */
  const [directionSelection, setDirectionSelection] = useState<WireDirection[]>([]);
  const [openFilter, setOpenFilter] = useState<string | null>(null);
  const [sorts, setSorts] = useState<SortByTab>(INITIAL_SORTS);
  const [widths, setWidths] = useState<Record<LogsTab, Record<string, number>>>({
    errors: {},
    wire: {},
    api: {},
  });
  const [extents, setExtents] = useState<LogExtents | null>(null);
  const [extentsLoading, setExtentsLoading] = useState(false);
  const [extentsError, setExtentsError] = useState<string | null>(null);
  const [extentsReload, setExtentsReload] = useState(0);
  const [queryReload, setQueryReload] = useState(0);
  const [view, setView] = useState<ViewState>(emptyView);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [nearestDay, setNearestDay] = useState<{
    signature: string;
    value: string | null;
    loading: boolean;
  } | null>(null);

  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const rangeButtonRef = useRef<HTMLButtonElement>(null);
  const rangePopoverRef = useRef<HTMLDivElement>(null);
  const fromDateRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const queryGeneration = useRef(0);
  const extentsGeneration = useRef(0);
  const copyTimer = useRef<number | null>(null);
  const nearestGeneration = useRef(0);

  const currentRange = ranges[activeTab];
  const currentExtents = extents ?? EMPTY_EXTENTS;
  const activeExtent = useMemo(
    () => extentForTab(currentExtents, activeTab),
    [activeTab, currentExtents],
  );
  const activeBounds = extentDateBounds(activeExtent);
  const activeTypes =
    activeTab === 'errors' || activeTab === 'wire' || activeTab === 'api'
      ? typeSelections[activeTab]
      : [];
  const typeSignature = activeTypes.join(',');
  const activeValueFilterKeys = VALUE_FILTER_KEYS_BY_TAB[activeTab];
  const activeDirections = activeTab === 'wire' ? directionSelection : [];
  const directionSignature = [...activeDirections].sort().join(',');
  const valueSignature = JSON.stringify(
    activeValueFilterKeys.map((key) => selectionList(valueSelections[key])),
  );
  const viewSignature = `${activeTab}:${currentRange.from}:${currentRange.to}:${typeSignature}:${directionSignature}:${valueSignature}:${queryReload}`;

  useEffect(() => {
    if (!open) return;
    const generation = ++extentsGeneration.current;
    setExtentsLoading(true);
    setExtentsError(null);
    void logClient
      .extents()
      .then((result) => {
        if (generation !== extentsGeneration.current) return;
        setExtents(result);
      })
      .catch((error: unknown) => {
        if (generation !== extentsGeneration.current) return;
        setExtents(null);
        setExtentsError(errorMessage(error));
      })
      .finally(() => {
        if (generation === extentsGeneration.current) setExtentsLoading(false);
      });
    return () => {
      extentsGeneration.current += 1;
    };
  }, [extentsReload, open]);

  useEffect(() => {
    if (!open || !extents || extentsLoading || extentsError) return;
    const generation = ++queryGeneration.current;
    const sources: readonly LogSource[] = [activeTab];
    setExpandedCell(null);
    setView({
      ...emptyView(viewSignature),
      loading: true,
    });
    void Promise.all(
      sources.map((source) =>
        readPage(
          source,
          currentRange,
          selectedFilterFor(source, activeTab, typeSelections, directionSelection, valueSelections),
        ),
      ),
    )
      .then((pages) => {
        if (generation !== queryGeneration.current) return;
        const counted = pages.filter((page) => Object.keys(page.valueCounts).length > 0);
        if (counted.length > 0) {
          setRangeValueCounts((current) => {
            const next = { ...current };
            for (const page of counted) {
              for (const key of Object.keys(page.valueCounts) as ValueFilterKey[]) {
                next[key] = { rangeKey: rangeKeyOf(currentRange), counts: page.valueCounts[key]! };
              }
            }
            return next;
          });
        }
        setView({
          signature: viewSignature,
          pages: Object.fromEntries(pages.map((page) => [page.source, page])) as Partial<
            Record<LogSource, SourcePage>
          >,
          loading: false,
          loadingMore: false,
          error: null,
          loadMoreError: null,
        });
      })
      .catch((error: unknown) => {
        if (generation !== queryGeneration.current) return;
        setView({
          ...emptyView(viewSignature),
          error: errorMessage(error),
        });
      });
    return () => {
      queryGeneration.current += 1;
    };
  }, [
    activeTab,
    currentRange.from,
    currentRange.to,
    directionSignature,
    extents,
    extentsError,
    extentsLoading,
    open,
    queryReload,
    typeSignature,
    valueSignature,
  ]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const animationFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      cancelAnimationFrame(animationFrame);
      document.body.style.overflow = previousOverflow;
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setRangeOpen(false);
      setOpenFilter(null);
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        /* The filter popover closes itself, and returns focus, while focus is
           inside it; this catches an Escape pressed after focus left it. */
        if (openFilter) {
          setOpenFilter(null);
        } else if (rangeOpen) {
          setRangeOpen(false);
          requestAnimationFrame(() => rangeButtonRef.current?.focus());
        } else {
          onClose();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open, openFilter, rangeOpen]);

  useEffect(() => {
    if (!open || !rangeOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rangePopoverRef.current?.contains(target) || rangeButtonRef.current?.contains(target)) {
        return;
      }
      setRangeOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open, rangeOpen]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const scopeSources = useMemo<readonly LogSource[]>(() => [activeTab], [activeTab]);

  const activePages = useMemo(
    () =>
      scopeSources
        .map((source) => view.pages[source])
        .filter((page): page is SourcePage => page !== undefined),
    [scopeSources, view.pages],
  );
  const loadedRows = useMemo(() => activePages.flatMap((page) => page.rows), [activePages]);
  const columns = useMemo(() => columnsFor(activeTab), [activeTab]);
  const activeSort = sorts[activeTab];
  const sortColumn = columns.find((column) => column.key === activeSort.key) ?? columns[0]!;
  const orderText =
    sortColumn.format === 'timestamp'
      ? activeSort.direction === 'descending'
        ? 'newest first'
        : 'oldest first'
      : `sorted by ${sortColumn.label}, ${activeSort.direction}`;
  const searchedRows = useMemo(
    () => filterLoadedRows(loadedRows, searches[activeTab]),
    [activeTab, loadedRows, searches],
  );
  const visibleRows = useMemo(
    () => sortRows(searchedRows, sortColumn, activeSort.direction),
    [activeSort.direction, searchedRows, sortColumn],
  );
  const loadedCount = activePages.reduce((total, page) => total + page.rows.length, 0);
  const totalCount = activePages.reduce((total, page) => total + page.total, 0);
  const canLoadMore = activePages.some((page) => !page.exhausted && page.rows.length < page.total);
  const nextPageCount = activePages.reduce(
    (total, page) =>
      total +
      (page.exhausted ? 0 : Math.min(PAGE_SIZE, Math.max(0, page.total - page.rows.length))),
    0,
  );
  const currentSearch = searches[activeTab];
  const rangeText = formatRange(currentRange);
  const nearestSignature = `${view.signature}:${scopeSources.join(',')}`;

  useEffect(() => {
    const shouldFind =
      open &&
      extents !== null &&
      !view.loading &&
      !view.error &&
      totalCount === 0 &&
      unfilteredCount(view.pages, scopeSources) === 0 &&
      currentSearch.trim() === '';
    if (!shouldFind) {
      setNearestDay(null);
      return;
    }
    const generation = ++nearestGeneration.current;
    setNearestDay({
      signature: nearestSignature,
      value: null,
      loading: true,
    });
    void nearestDayForSource(activeTab, currentRange, extents[activeTab])
      .then((value) => {
        if (generation !== nearestGeneration.current) return;
        setNearestDay({
          signature: nearestSignature,
          value,
          loading: false,
        });
      })
      .catch(() => {
        if (generation !== nearestGeneration.current) return;
        setNearestDay({
          signature: nearestSignature,
          value: null,
          loading: false,
        });
      });
    return () => {
      nearestGeneration.current += 1;
    };
  }, [
    currentRange,
    currentSearch,
    activeTab,
    extents,
    nearestSignature,
    open,
    scopeSources,
    totalCount,
    view.error,
    view.loading,
    view.pages,
  ]);

  const loadMore = useCallback(async () => {
    const generation = queryGeneration.current;
    const signature = view.signature;
    const pagesToLoad = scopeSources
      .map((source) => view.pages[source])
      .filter(
        (page): page is SourcePage =>
          page !== undefined &&
          !page.exhausted &&
          page.rows.length < page.total &&
          page.rows.length > 0,
      );
    if (pagesToLoad.length === 0 || view.loadingMore) return;
    setView((current) => ({
      ...current,
      loadingMore: true,
      loadMoreError: null,
    }));
    try {
      const nextPages = await Promise.all(
        pagesToLoad.map((page) =>
          readPage(
            page.source,
            currentRange,
            selectedFilterFor(
              page.source,
              activeTab,
              typeSelections,
              directionSelection,
              valueSelections,
            ),
            idOf(page.rows[page.rows.length - 1]!),
          ),
        ),
      );
      if (generation !== queryGeneration.current) return;
      setView((current) => {
        if (current.signature !== signature) return current;
        const pages = { ...current.pages };
        for (const nextPage of nextPages) {
          const previous = pages[nextPage.source];
          if (!previous) continue;
          const known = new Set(previous.rows.map((entry) => idOf(entry)));
          const additions = nextPage.rows.filter((entry) => !known.has(idOf(entry)));
          const rows = [...previous.rows, ...additions];
          pages[nextPage.source] = {
            ...previous,
            rows,
            exhausted: nextPage.rows.length < PAGE_SIZE || rows.length >= previous.total,
          };
        }
        return {
          ...current,
          pages,
          loadingMore: false,
          loadMoreError: null,
        };
      });
    } catch (error) {
      if (generation !== queryGeneration.current) return;
      setView((current) =>
        current.signature === signature
          ? {
              ...current,
              loadingMore: false,
              loadMoreError: errorMessage(error),
            }
          : current,
      );
    }
  }, [
    activeTab,
    currentRange,
    directionSelection,
    scopeSources,
    typeSelections,
    valueSelections,
    view.loadingMore,
    view.pages,
    view.signature,
  ]);

  const switchTab = (tab: LogsTab) => {
    setActiveTab(tab);
    setRangeOpen(false);
    setOpenFilter(null);
    setExpandedCell(null);
  };

  const openFilterPopover = (name: string | null) => {
    setOpenFilter(name);
    if (name !== null) setRangeOpen(false);
  };

  const updateRange = (range: LogRange, notice = '') => {
    setRanges((current) => ({ ...current, [activeTab]: range }));
    setRangeNotices((current) => ({ ...current, [activeTab]: notice }));
  };

  const changeRangeEnd = (which: 'from' | 'to', event: ChangeEvent<HTMLInputElement>) => {
    const raw = event.target.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return;
    let value = raw;
    let notice = '';
    if (activeBounds.min && value < activeBounds.min) {
      value = activeBounds.min;
      notice = `That day is before this log starts, so it moved to ${formatDateKey(value)}.`;
    } else if (activeBounds.max && value > activeBounds.max) {
      value = activeBounds.max;
      notice = `That day is after this log ends, so it moved to ${formatDateKey(value)}.`;
    }
    if (which === 'from') {
      if (value > currentRange.to) {
        updateRange(
          { from: value, to: value },
          'The from-day passed the to-day, so the to-day moved with it.',
        );
      } else {
        updateRange({ ...currentRange, from: value }, notice);
      }
    } else if (value < currentRange.from) {
      updateRange(
        { from: value, to: value },
        'The to-day fell behind the from-day, so the from-day moved with it.',
      );
    } else {
      updateRange({ ...currentRange, to: value }, notice);
    }
  };

  const pickToday = () => {
    updateRange({ from: today, to: today });
  };

  const pickLastSevenDays = () => {
    const end = clampRangeToExtent({ from: today, to: today }, activeExtent).to;
    const requested = { from: shiftDateKey(end, -6), to: end };
    const clamped = clampRangeToExtent(requested, activeExtent);
    const bounds = extentDateBounds(activeExtent);
    const everything =
      bounds.min !== null &&
      bounds.max !== null &&
      clamped.from === bounds.min &&
      clamped.to === bounds.max;
    updateRange(
      clamped,
      clamped.from !== requested.from
        ? everything
          ? 'Seven days back is where this log starts, so that is everything it has.'
          : `Seven days reached before this log starts, so the range begins at ${formatDateKey(clamped.from)}.`
        : '',
    );
  };

  const pickEverything = () => {
    const bounds = extentDateBounds(activeExtent);
    if (!bounds.min || !bounds.max) return;
    updateRange({ from: bounds.min, to: bounds.max });
  };

  const toggleRange = () => {
    setOpenFilter(null);
    setRangeOpen((current) => {
      const next = !current;
      if (next) requestAnimationFrame(() => fromDateRef.current?.focus());
      return next;
    });
  };

  const toggleType = (type: StoredErrorType | TrafficLogType) => {
    setTypeSelections((current) => {
      const selected = current[activeTab] as string[];
      const next = selected.includes(type)
        ? selected.filter((value) => value !== type)
        : [...selected, type];
      return { ...current, [activeTab]: next } as TypeSelections;
    });
  };

  const toggleDirection = (direction: WireDirection) => {
    setDirectionSelection((current) =>
      current.includes(direction)
        ? current.filter((value) => value !== direction)
        : [...current, direction],
    );
  };

  const toggleSort = (key: string) => {
    setSorts((current) => {
      const selected = current[activeTab];
      return {
        ...current,
        [activeTab]: {
          key,
          direction:
            selected.key === key && selected.direction === 'descending'
              ? 'ascending'
              : 'descending',
        },
      };
    });
  };

  const resizeColumn = (key: string, width: number) => {
    setWidths((current) => ({
      ...current,
      [activeTab]: { ...current[activeTab], [key]: width },
    }));
  };

  const copyPayload = (key: string, text: string) => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    void copyWithFallback(text)
      .then(() => setCopyFeedback({ key, message: 'Copied' }))
      .catch(() => setCopyFeedback({ key, message: 'Copy unavailable' }))
      .finally(() => {
        copyTimer.current = window.setTimeout(() => {
          setCopyFeedback(null);
          copyTimer.current = null;
        }, 2_000);
      });
  };

  const backdropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (rangeOpen) {
      event.stopPropagation();
      setRangeOpen(false);
    } else onClose();
  };

  const keyOnTab = (event: ReactKeyboardEvent, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + offset + LOG_TABS.length) % LOG_TABS.length;
    const tab = LOG_TABS[next]!;
    switchTab(tab.key);
    requestAnimationFrame(() =>
      drawerRef.current?.querySelector<HTMLElement>(`[data-log-tab="${tab.key}"]`)?.focus(),
    );
  };

  if (!open) return null;

  const sourcePage = view.pages[activeTab];
  const typeCounts = sourcePage?.countsByType ?? {};
  const unfilteredRangeCount = Object.values(typeCounts).reduce((total, count) => total + count, 0);
  const selectedTypeList = activeTab === 'errors' ? ERROR_TYPES : TRAFFIC_TYPES;
  /*
   * A chip counts within the current range (SCREEN-MAP), so a type with no
   * row in it is not a filter worth offering. A selected chip always stays,
   * or the control the user just pressed would vanish under them.
   */
  const offeredTypeList = selectedTypeList.filter(
    (type) => (typeCounts[type] ?? 0) > 0 || activeTypes.includes(type as never),
  );
  const directionCounts = sourcePage?.directionCounts ?? null;
  /* Same rule as the type chips: an unrepresented direction is not offered. */
  const offeredDirectionList = WIRE_DIRECTIONS.filter(
    (direction) => (directionCounts?.[direction] ?? 0) > 0 || activeDirections.includes(direction),
  );
  const hasEscalation = loadedRows.some(
    (entry) =>
      entry.source === 'errors' &&
      (entry.row.type === 'OrderAccountMismatch' || entry.row.type === 'AccountFeedSilent'),
  );
  const exactTodayRange = currentRange.from === today && currentRange.to === today;
  const lastSevenEnd = clampRangeToExtent({ from: today, to: today }, activeExtent).to;
  const lastSevenRange = clampRangeToExtent(
    { from: shiftDateKey(lastSevenEnd, -6), to: lastSevenEnd },
    activeExtent,
  );
  const exactLastSeven =
    currentRange.from === lastSevenRange.from &&
    currentRange.to === lastSevenRange.to &&
    !exactTodayRange;
  const activeLogName = sourceLogName(activeTab);

  return (
    <div className="logs-backdrop" onPointerDown={backdropPointerDown}>
      <div
        ref={drawerRef}
        className="logs-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logs-drawer-title"
        aria-describedby="logs-drawer-description"
      >
        <header className="logs-header fading-rule">
          <div className="logs-heading-copy">
            <h5 id="logs-drawer-title">Logs</h5>
            <span id="logs-drawer-description" className="muted">
              read-only · nothing here is checked unless something is wrong
            </span>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="btn btn-secondary logs-close"
            onClick={onClose}
          >
            Close
          </button>
        </header>

        <div className="logs-toolbar">
          <div className="seg logs-tabs" role="tablist" aria-label="Log source">
            {LOG_TABS.map((tab, index) => (
              <button
                key={tab.key}
                id={`logs-tab-${tab.key}`}
                type="button"
                role="tab"
                data-log-tab={tab.key}
                aria-selected={activeTab === tab.key}
                aria-controls="logs-tab-panel"
                tabIndex={activeTab === tab.key ? 0 : -1}
                className="logs-tab"
                onClick={() => switchTab(tab.key)}
                onKeyDown={(event) => keyOnTab(event, index)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="logs-toolbar-spacer" />

          {/* Offered once the range is counted, or while a selection needs a
              way back to `all`. Wire offers both operation and account id. */}
          {activeValueFilterKeys.map((key) => {
            const nouns = VALUE_FILTER_NOUNS[key];
            const selection = valueSelections[key];
            const cached = rangeValueCounts[key];
            const knownCounts =
              cached?.rangeKey === rangeKeyOf(currentRange) ? cached.counts : null;
            if (knownCounts === null && selection === null) return null;
            return (
              <div className="logs-value-filter" key={key}>
                <MultiSelectFilter
                  name={`values-${key}`}
                  open={openFilter === `values-${key}`}
                  setOpen={openFilterPopover}
                  heading={`${nouns.many} in these days`}
                  help="Counted across these days whatever the type chips keep. Unlike search, this asks the log itself, so totals and older pages follow it."
                  note={
                    knownCounts && !knownCounts.complete
                      ? `These days hold more than ${LOG_VALUE_COUNT_LIMIT} ${nouns.many}; only the most frequent are listed, and a narrowed selection keeps only the ticked ones.`
                      : undefined
                  }
                  options={valueFilterOptions(knownCounts, selection)}
                  picks={VALUE_FILTER_PICKS}
                  selected={selection}
                  onChange={(next) =>
                    setValueSelections((current) => ({ ...current, [key]: next }))
                  }
                  one={nouns.one}
                  many={nouns.many}
                  align="right"
                />
              </div>
            );
          })}

          <div className="logs-range-wrap">
            <button
              ref={rangeButtonRef}
              type="button"
              className="input logs-range-trigger"
              aria-haspopup="dialog"
              aria-expanded={rangeOpen}
              aria-controls="logs-range-popover"
              disabled={extentsLoading || extentsError !== null}
              onClick={toggleRange}
            >
              <span>{rangeTriggerLabel(currentRange, activeExtent, today)}</span>
              <span aria-hidden="true">▾</span>
            </button>
            {rangeOpen && (
              <div
                ref={rangePopoverRef}
                id="logs-range-popover"
                className="card elev-lg logs-range-popover"
                role="dialog"
                aria-label={`Days in ${activeLogName}`}
              >
                <div className="logs-range-heading">
                  <span className="kicker">days in {activeLogName}</span>
                  <button
                    type="button"
                    className="btn btn-ghost logs-everything"
                    disabled={!activeBounds.min || !activeBounds.max}
                    onClick={pickEverything}
                  >
                    everything
                  </button>
                </div>
                <div className="logs-date-grid">
                  <div className="field">
                    <label htmlFor="logs-range-from">from</label>
                    <input
                      ref={fromDateRef}
                      id="logs-range-from"
                      className="input logs-date-input"
                      type="date"
                      value={currentRange.from}
                      min={activeBounds.min ?? undefined}
                      max={activeBounds.max ?? undefined}
                      onChange={(event) => changeRangeEnd('from', event)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="logs-range-to">to</label>
                    <input
                      id="logs-range-to"
                      className="input logs-date-input"
                      type="date"
                      value={currentRange.to}
                      min={activeBounds.min ?? undefined}
                      max={activeBounds.max ?? undefined}
                      onChange={(event) => changeRangeEnd('to', event)}
                    />
                  </div>
                </div>
                <div className="logs-range-presets">
                  <button
                    type="button"
                    className={`tag ${exactTodayRange ? 'tag-accent' : 'tag-neutral'}`}
                    aria-pressed={exactTodayRange}
                    onClick={pickToday}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className={`tag ${exactLastSeven ? 'tag-accent' : 'tag-neutral'}`}
                    aria-pressed={exactLastSeven}
                    onClick={pickLastSevenDays}
                  >
                    Last 7 days
                  </button>
                </div>
                <p className="logs-extent-copy">
                  {extentDescription(activeTab, activeExtent)} Each tab remembers its own days.
                </p>
                {rangeNotices[activeTab] && (
                  <p className="logs-range-notice" role="status">
                    {rangeNotices[activeTab]}
                  </p>
                )}
              </div>
            )}
          </div>

          <label className="logs-search-label">
            <span className="sr-only">Search loaded rows</span>
            <input
              type="search"
              className="input logs-search"
              value={currentSearch}
              placeholder="search text…"
              onChange={(event) =>
                setSearches((current) => ({
                  ...current,
                  [activeTab]: event.target.value,
                }))
              }
            />
          </label>
        </div>

        <main
          id="logs-tab-panel"
          className="logs-content"
          role="tabpanel"
          aria-labelledby={`logs-tab-${activeTab}`}
        >
          {extentsLoading && !extents && (
            <StateBlock tone="plain" title="Loading log bounds" busy />
          )}
          {extentsError && (
            <StateBlock
              tone="warn"
              title="The log databases are unavailable"
              detail={extentsError}
              actionLabel="Try again"
              onAction={() => setExtentsReload((value) => value + 1)}
            />
          )}

          {!extentsError && extents && (
            <>
              {activeTab === 'wire' && (
                <BoundaryNote>
                  Read directly from wire-log.db through the local read-only bridge. A schema
                  mismatch disables this tab; it does not affect the Book.
                </BoundaryNote>
              )}
              {activeTab === 'api' && (
                <BoundaryNote>
                  Read directly from api-log.db: every REST call made by bots and this viewer. Use
                  it to establish whether a caller asked and whether the server answered.
                </BoundaryNote>
              )}

              <div className="logs-filter-row" aria-label="Log filters">
                <button
                  type="button"
                  className={`tag ${activeTypes.length === 0 ? 'tag-accent' : 'tag-neutral'}`}
                  aria-pressed={activeTypes.length === 0}
                  onClick={() =>
                    setTypeSelections((current) => ({
                      ...current,
                      [activeTab]: [],
                    }))
                  }
                >
                  All types
                </button>
                {offeredTypeList.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`tag ${activeTypes.includes(type as never) ? 'tag-accent' : 'tag-neutral'}`}
                    aria-pressed={activeTypes.includes(type as never)}
                    aria-label={`${type} ${typeCounts[type] ?? 0}`}
                    onClick={() => toggleType(type)}
                  >
                    {type}
                    <span className="logs-chip-count">{typeCounts[type] ?? 0}</span>
                  </button>
                ))}
              </div>

              {activeTab === 'wire' && (
                <div className="logs-filter-row" aria-label="Wire direction filters">
                  <button
                    type="button"
                    className={`tag ${activeDirections.length === 0 ? 'tag-accent' : 'tag-neutral'}`}
                    aria-pressed={activeDirections.length === 0}
                    onClick={() => setDirectionSelection([])}
                  >
                    All directions
                  </button>
                  {offeredDirectionList.map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      className={`tag ${activeDirections.includes(direction) ? 'tag-accent' : 'tag-neutral'}`}
                      aria-pressed={activeDirections.includes(direction)}
                      aria-label={`${direction} ${directionCounts?.[direction] ?? 0}`}
                      onClick={() => toggleDirection(direction)}
                    >
                      {direction}
                      <span className="logs-chip-count">{directionCounts?.[direction] ?? 0}</span>
                    </button>
                  ))}
                </div>
              )}

              {hasEscalation && (
                <div className="logs-escalation" role="status">
                  This range contains an account mismatch or silent account feed. Those conditions
                  require attention on the Book even when the rows here are closed.
                </div>
              )}

              {view.loading && <StateBlock tone="plain" title={`Loading ${activeLogName}`} busy />}
              {view.error && (
                <StateBlock
                  tone="warn"
                  title="This log range could not be read"
                  detail={view.error}
                  actionLabel="Try again"
                  onAction={() => setQueryReload((value) => value + 1)}
                />
              )}

              {!view.loading && !view.error && (
                <>
                  {visibleRows.length > 0 && (
                    <LogsTable
                      rows={visibleRows}
                      columns={columns}
                      widths={widths[activeTab]}
                      sort={activeSort}
                      expandedCell={expandedCell}
                      copyFeedback={copyFeedback}
                      onSort={toggleSort}
                      onResize={resizeColumn}
                      onTogglePayload={(key) =>
                        setExpandedCell((current) => (current === key ? null : key))
                      }
                      onCopyPayload={copyPayload}
                    />
                  )}

                  {visibleRows.length === 0 && (
                    <EmptyLogState
                      search={currentSearch}
                      loadedCount={loadedCount}
                      totalCount={totalCount}
                      unfilteredRangeCount={unfilteredRangeCount}
                      hasTypeFilter={activeTypes.length > 0}
                      hasDirectionFilter={activeDirections.length > 0}
                      valueFilters={activeValueFilterKeys.flatMap((key) => {
                        const selection = valueSelections[key];
                        return selection === null
                          ? []
                          : [{ ...VALUE_FILTER_NOUNS[key], none: selection.size === 0 }];
                      })}
                      range={currentRange}
                      extent={activeExtent}
                      nearestDay={
                        nearestDay?.signature === nearestSignature ? nearestDay.value : null
                      }
                      nearestLoading={
                        nearestDay?.signature === nearestSignature && nearestDay.loading
                      }
                    />
                  )}

                  <footer className="logs-footer">
                    <span className="logs-count-line">
                      {countLine({
                        search: currentSearch,
                        visible: visibleRows.length,
                        loaded: loadedCount,
                        total: totalCount,
                        range: rangeText,
                        order: orderText,
                      })}
                    </span>
                    <span className="logs-footer-spacer" />
                    <span className="logs-older-note">
                      {view.loadMoreError
                        ? view.loadMoreError
                        : canLoadMore
                          ? `asks for the next ${plural(nextPageCount, 'row')} before the last ones shown, inside the same days — it never widens the range`
                          : totalCount > 0
                            ? 'every row in these days is loaded'
                            : ''}
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary logs-older-button"
                      disabled={!canLoadMore || view.loadingMore}
                      onClick={() => void loadMore()}
                    >
                      {view.loadingMore
                        ? 'Loading…'
                        : canLoadMore
                          ? `Older ${nextPageCount}`
                          : 'Older'}
                    </button>
                  </footer>
                </>
              )}
            </>
          )}
        </main>
        {openFilter ? <PopoverScrim onClose={() => setOpenFilter(null)} /> : null}
      </div>
    </div>
  );
}

function extentDescription(tab: LogsTab, extent: LogExtent): string {
  const bounds = extentDateBounds(extent);
  const name = `The ${sourceLogName(tab)}`;
  if (!bounds.min || !bounds.max) return `${name} currently holds no row.`;
  return `${name} currently runs ${formatDateKey(bounds.min)} → ${formatDateKey(bounds.max)}; these bounds come from rows on disk.`;
}

function countLine({
  search,
  visible,
  loaded,
  total,
  range,
  order,
}: {
  search: string;
  visible: number;
  loaded: number;
  total: number;
  range: string;
  order: string;
}): string {
  if (total === 0) return 'nothing in these days';
  if (search.trim()) {
    return `${visible} matches in ${loaded} loaded · ${total} in ${range} · ${order}`;
  }
  return `${loaded} of ${total} in ${range} · ${order}`;
}

function EmptyLogState({
  search,
  loadedCount,
  totalCount,
  unfilteredRangeCount,
  hasTypeFilter,
  hasDirectionFilter,
  valueFilters,
  range,
  extent,
  nearestDay,
  nearestLoading,
}: {
  search: string;
  loadedCount: number;
  totalCount: number;
  unfilteredRangeCount: number;
  hasTypeFilter: boolean;
  /** Wire-only. */
  hasDirectionFilter: boolean;
  /** The operation, account id, and/or path selections that narrow the read. */
  valueFilters: readonly { one: string; many: string; none: boolean }[];
  range: LogRange;
  extent: LogExtent;
  nearestDay: string | null;
  nearestLoading: boolean;
}) {
  if (search.trim() && loadedCount > 0) {
    return (
      <p className="logs-empty" role="status">
        No loaded row matches “{search.trim()}”. Search checks the {plural(loadedCount, 'row')}{' '}
        loaded in these days.
      </p>
    );
  }
  const emptyValueFilter = valueFilters.find((filter) => filter.none);
  if (emptyValueFilter && totalCount === 0 && unfilteredRangeCount > 0) {
    return (
      <p className="logs-empty" role="status">
        {`No ${emptyValueFilter.one} is ticked, so no row in ${formatRange(range)} is shown.`}
      </p>
    );
  }
  const narrowedValueFilters = valueFilters.filter((filter) => !filter.none);
  if (narrowedValueFilters.length > 0 && totalCount === 0 && unfilteredRangeCount > 0) {
    const namedFilters = narrowedValueFilters.map((filter) => filter.many).join(' and ');
    const chipSuffix = hasTypeFilter || hasDirectionFilter ? ' and the selected chips' : '';
    return (
      <p className="logs-empty" role="status">
        {`No row in ${formatRange(range)} matches the ticked ${namedFilters}${chipSuffix}. The counts show what these days hold.`}
      </p>
    );
  }
  if ((hasTypeFilter || hasDirectionFilter) && totalCount === 0 && unfilteredRangeCount > 0) {
    const label =
      hasTypeFilter && hasDirectionFilter
        ? 'type or direction'
        : hasTypeFilter
          ? 'type'
          : 'direction';
    return (
      <p className="logs-empty" role="status">
        {`No selected ${label} has a row in ${formatRange(range)}. The counts show what these days hold.`}
      </p>
    );
  }
  const bounds = extentDateBounds(extent);
  return (
    <p className="logs-empty" role="status">
      No row in {formatRange(range)}.{' '}
      {nearestDay
        ? `The nearest day this log holds one is ${formatDateKey(nearestDay)}.`
        : nearestLoading
          ? 'Checking the nearest stored day…'
          : bounds.min && bounds.max
            ? `This log has rows elsewhere between ${formatDateKey(bounds.min)} and ${formatDateKey(bounds.max)}.`
            : 'This log holds no row at all.'}
    </p>
  );
}

function StateBlock({
  tone,
  title,
  detail,
  busy = false,
  actionLabel,
  onAction,
}: {
  tone: 'plain' | 'warn';
  title: string;
  detail?: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div
      className={`logs-state ${tone === 'warn' ? 'logs-state--warn' : ''}`}
      role={tone === 'warn' ? 'alert' : 'status'}
      aria-busy={busy || undefined}
    >
      <div className="logs-state-title">
        {busy && <span className="spinner" aria-hidden="true" />}
        <span>{title}</span>
      </div>
      {detail && <p>{detail}</p>}
      {actionLabel && onAction && (
        <button type="button" className="btn btn-secondary" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function BoundaryNote({ children }: { children: string }) {
  return <div className="logs-boundary-note">{children}</div>;
}
