import { moscowDate, moscowDayStart } from '../../shared/moscowTime';
import type { CalendarPanel } from '../../contracts';
import type { CalendarResponse } from '../../contracts';
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useSearchParams } from 'react-router-dom';
import { usePolling } from '../../catalog';
import type { UIEvent, WheelEvent } from 'react';
import { DAY, PAST_DAYS, scaleWidth } from './dates';
type Panel = CalendarPanel;
let savedPanel: Panel = null,
  savedScroll: number | null = null;
let savedPanelLocationKey: string | undefined;
let savedCollapsed = new Set<string>();
export function useCalendarState() {
  const [rangePending, setRangePending] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set(savedCollapsed));
  useEffect(() => {
    savedCollapsed = collapsed;
  }, [collapsed]);
  const [params, setParams] = useSearchParams();
  const { key: locationKey } = useLocation();
  const date = params.get('date') ?? moscowDate(Date.now()),
    scale = [2, 3].includes(Number(params.get('scale'))) ? Number(params.get('scale')) : 1,
    filter = params.get('q') ?? '';
  const groupBy: 'brand' | 'tariff' = params.get('group') === 'tariff' ? 'tariff' : 'brand';
  const statusFilter = params.get('status') ?? '';
  const statuses = statusFilter
    .split(',')
    .filter((s) => ['ready', 'notReady', 'wash', 'maintenance'].includes(s));
  const selectedDate = moscowDayStart(date);
  const from = selectedDate - PAST_DAYS * DAY,
    to = selectedDate + 30 * DAY;
  const dayWidth = scaleWidth(scale);
  const p = usePolling<CalendarResponse>(
    '/calendar?from=' +
      encodeURIComponent(new Date(from).toISOString()) +
      '&to=' +
      encodeURIComponent(new Date(to).toISOString()),
    true,
  );
  const calendarLoading = rangePending || p.loading;
  useEffect(() => {
    setRangePending(false);
  }, [from]);
  const [panel, setPanel] = useState<Panel>(() => {
    if (savedPanel?.kind === 'contract' && savedPanelLocationKey === locationKey) return savedPanel;
    const booking = Number(params.get('booking')),
      vehicle = Number(params.get('vehicle'));
    return Number.isInteger(booking) && booking > 0
      ? {
          kind: 'booking',
          id: booking,
          action:
            params.get('action') === 'assign'
              ? 'assign'
              : params.get('action') === 'edit'
                ? 'edit'
                : undefined,
        }
      : Number.isInteger(vehicle) && vehicle > 0
        ? { kind: 'vehicle', id: vehicle }
        : savedPanel;
  });
  const scroll = useRef<HTMLDivElement>(null);
  const shifting = useRef(false);
  const restoring = useRef(false);
  useEffect(() => {
    if (!p.loading) shifting.current = false;
  }, [p.loading]);
  useEffect(() => {
    savedPanel =
      panel?.kind === 'contract' && panel.action === 'start'
        ? { kind: 'contract', id: panel.id }
        : panel;
    savedPanelLocationKey = locationKey;
  }, [locationKey, panel]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    restoring.current = true;
    scroll.current.scrollLeft = savedScroll ?? PAST_DAYS * dayWidth;
    const frame = requestAnimationFrame(() => {
      restoring.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [from, dayWidth, p.loading]);
  const select = (next: Panel) => setPanel(next),
    change = (key: string, value: string, keepPosition = false) => {
      if (key === 'date' && !keepPosition) savedScroll = PAST_DAYS * dayWidth;
      if (key === 'scale')
        savedScroll =
          ((scroll.current?.scrollLeft ?? PAST_DAYS * dayWidth) / dayWidth) *
          scaleWidth(Number(value));
      const navigate = () =>
        setParams((prev) => {
          prev.set(key, value);
          return prev;
        });
      if (key === 'date' && value !== date) {
        flushSync(() => setRangePending(true));
        startTransition(navigate);
      } else navigate();
    };
  const vehicles = useMemo(
    () =>
      p.data?.vehicles.filter((v) => {
        const selectedStatuses = statusFilter
          .split(',')
          .filter((status) => ['ready', 'notReady', 'wash', 'maintenance'].includes(status));
        const readiness = selectedStatuses.filter((s) => s === 'ready' || s === 'notReady');
        return (
          (v.brand_name + ' ' + v.model_name + ' ' + v.plate)
            .toLowerCase()
            .includes(filter.toLowerCase()) &&
          (!readiness.length || readiness.includes(v.is_ready ? 'ready' : 'notReady')) &&
          (!selectedStatuses.includes('wash') || v.needs_wash) &&
          (!selectedStatuses.includes('maintenance') ||
            (v.current_mileage_km !== null &&
              v.next_maintenance_due_km !== null &&
              v.current_mileage_km >= v.next_maintenance_due_km))
        );
      }) ?? [],
    [p.data, filter, statusFilter],
  );
  const shiftWindow = (direction: number) => {
    if (shifting.current || calendarLoading) return;
    shifting.current = true;
    savedScroll = Math.max(1, (scroll.current?.scrollLeft ?? 0) - direction * 15 * dayWidth);
    change('date', moscowDate(selectedDate + direction * 15 * DAY), true);
  };
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (calendarLoading || restoring.current || shifting.current) return;
    const el = e.currentTarget;
    savedScroll = el.scrollLeft;
    const buffer = 2 * dayWidth;
    if (el.scrollLeft < buffer) shiftWindow(-1);
    else if (el.scrollLeft > el.scrollWidth - el.clientWidth - buffer) shiftWindow(1);
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (e.deltaX < 0 && (scroll.current?.scrollLeft ?? 0) < 10) shiftWindow(-1);
  };
  const goToday = () => {
    savedScroll = PAST_DAYS * dayWidth;
    if (scroll.current) scroll.current.scrollLeft = savedScroll;
    change('date', moscowDate(Date.now()));
  };
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return {
    p,
    calendarLoading,
    date,
    scale,
    filter,
    groupBy,
    statuses,
    selectedDate,
    from,
    to,
    dayWidth,
    collapsed,
    panel,
    setPanel,
    scroll,
    select,
    change,
    vehicles,
    onScroll,
    onWheel,
    goToday,
    toggleGroup,
  };
}
