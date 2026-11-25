import type {
  CalendarVehicle,
  CalendarBooking,
  CalendarResponse,
  ScheduleEvent,
  CalendarPanel,
  RentPaymentProgress,
} from '../../contracts';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Badge, Dropdown, Tag } from 'antd';
import { InputTooltip as Tooltip } from '../../shared/InputTooltip';
import {
  CalendarOutlined,
  PhoneOutlined,
  ClearOutlined,
  WarningOutlined,
  MailOutlined,
} from '@ant-design/icons';
import { layoutCalendarEvents } from './calendar-layout';
import { rub } from '../../shared/formatters';
import { rentPaymentLabels } from './RentPaymentStatus';
import CurrentTimeIndicator from './CurrentTimeIndicator';
import CalendarEventTooltip from './CalendarEventTooltip';
import {
  DAY_MS as DAY,
  moscowDateTimeInput,
  moscowDate,
  moscowDayStart,
} from '../../shared/moscowTime';
const bookingStartDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const bookingStartLabel = (value: string | number) => {
  const p = Object.fromEntries(
    bookingStartDate.formatToParts(new Date(value)).map(({ type, value }) => [type, value]),
  );
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};
const compactDebtNumber = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
function progressLabel(phase: ScheduleEvent['checkoutPhase'], returnInProgress?: true) {
  if (returnInProgress) return 'Приёмка';
  if (phase === 'started') return 'Оформление';
}
function BookingBlock({
  name,
  start,
  phase,
  returnInProgress,
  accountingEmailUnsent,
}: {
  name: string;
  start: string;
  phase?: ScheduleEvent['checkoutPhase'];
  returnInProgress?: true;
  accountingEmailUnsent?: true;
}) {
  const label = progressLabel(phase, returnInProgress);
  return (
    <span className="calendar-booking-content">
      {accountingEmailUnsent && (
        <MailOutlined
          className="calendar-accounting-email-icon"
          aria-label="Данные для счёта не отправлены"
        />
      )}
      {label && <Badge status="processing" role="img" aria-label={label} />}
      <span className="calendar-booking-start-clip">
        <Tag className="calendar-booking-start">{bookingStartLabel(start)}</Tag>
      </span>
      <span className="calendar-booking-name">{name}</span>
    </span>
  );
}

function CalendarEventContent({
  children,
  invoicePayment,
  tooltip,
}: {
  children: ReactNode;
  invoicePayment?: RentPaymentProgress;
  tooltip?: ReactNode;
}) {
  const content = <span className="calendar-event-content">{children}</span>;
  if (invoicePayment?.status !== 'unpaid' && invoicePayment?.status !== 'partial') {
    return (
      <span className="calendar-event-content-anchor">
        {tooltip ? <CalendarEventTooltip title={tooltip}>{content}</CalendarEventTooltip> : content}
      </span>
    );
  }

  const amount = rub(invoicePayment.remainingRub);
  const compactAmount =
    compactDebtNumber.format(BigInt(invoicePayment.remainingRub)).replace(/\sтыс\.$/, 'к') + ' ₽';
  const debtContent = (
    <div className="calendar-booking-debt-region">
      <Badge.Ribbon
        rootClassName="calendar-booking-with-debt"
        className="calendar-booking-debt-ribbon"
        color="var(--calendar-booking-debt-badge-bg)"
        text={
          <>
            <span className="calendar-booking-debt-amount">{amount}</span>
            <span className="calendar-booking-debt-compact">{compactAmount}</span>
          </>
        }
      >
        <span className="calendar-booking-debt-details">
          <span className="calendar-event-content-anchor">{content}</span>
        </span>
        <Badge
          className="calendar-booking-debt-badge"
          count="!"
          size="small"
          color="var(--calendar-booking-debt-badge-bg)"
          role="img"
          aria-label={`Осталось оплатить: ${amount}`}
        />
      </Badge.Ribbon>
    </div>
  );
  return tooltip ? (
    <CalendarEventTooltip title={tooltip}>{debtContent}</CalendarEventTooltip>
  ) : (
    debtContent
  );
}
const tooltipDate = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const tooltipPhone = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return /^[78]\d{10}$/.test(digits)
    ? '+7 ' +
        digits.slice(1, 4) +
        ' ' +
        digits.slice(4, 7) +
        '-' +
        digits.slice(7, 9) +
        '-' +
        digits.slice(9)
    : value;
};
function BookingTooltip({
  booking: b,
}: {
  booking: {
    id: number | string;
    customer_name?: string;
    customer_phone?: string;
    checkoutPhase?: ScheduleEvent['checkoutPhase'];
    returnInProgress?: true;
    start_at: string;
    end_at: string;
    booking_id?: number | null;
    kind?: string;
    reason?: string;
    accountingEmailUnsent?: true;
    invoicePayment?: RentPaymentProgress;
  };
}) {
  const label = progressLabel(b.checkoutPhase, b.returnInProgress);
  return (
    <div className="booking-tooltip">
      <div className="booking-tooltip-heading">
        <strong>{b.customer_name ?? 'Бронь №' + (b.booking_id ?? b.id)}</strong>
        {label && <Tag color="processing">{label}</Tag>}
      </div>
      <div className="booking-tooltip-row">
        <CalendarOutlined />
        <span>
          {tooltipDate.format(new Date(b.start_at))} — {tooltipDate.format(new Date(b.end_at))}
        </span>
      </div>
      {b.customer_phone && (
        <div className="booking-tooltip-row">
          <PhoneOutlined />
          <span>{tooltipPhone(b.customer_phone)}</span>
        </div>
      )}
      {b.accountingEmailUnsent && (
        <div className="booking-tooltip-row">
          <MailOutlined aria-hidden />
          <span>Данные для счёта не отправлены</span>
        </div>
      )}
      {b.invoicePayment && (
        <div className="booking-tooltip-row">
          <span aria-hidden>₽</span>
          <span>
            {rentPaymentLabels[b.invoicePayment.status]} · Осталось оплатить:{' '}
            {rub(b.invoicePayment.remainingRub)}
          </span>
        </div>
      )}
      {b.kind === 'displaced' && (
        <div className="booking-tooltip-row">
          <WarningOutlined />
          <span>Требуется замена: {b.reason || 'техническая блокировка'}</span>
        </div>
      )}
    </div>
  );
}
const dayLabel = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' });
const dayNumber = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric' });
const weekdayLabel = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  weekday: 'short',
});
const monthLabel = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  month: 'long',
  year: 'numeric',
});

function calendarDates(from: number, to: number) {
  const days = Array.from({ length: Math.ceil((to - from) / DAY) }, (_, index) => {
    const at = from + index * DAY;
    return {
      at,
      label: dayLabel.format(at),
      number: dayNumber.format(at),
      weekday: weekdayLabel.format(at),
    };
  });
  const months: { label: string; days: number }[] = [];
  for (const { at } of days) {
    const value = monthLabel.format(at).replace(/\s*г\.$/, '');
    const label = value[0].toUpperCase() + value.slice(1);
    const last = months.at(-1);
    if (last?.label === label) last.days++;
    else months.push({ label, days: 1 });
  }
  return { days, months };
}

type PointerPosition = { x: number; y: number };

type Drag = {
  touch: boolean;
  bookingId: number;
  pointerId: number;
  source: HTMLElement;
  startPointer: PointerPosition;
  startAt: number;
  endAt: number;
  vehicleId: number | null;
  targetVehicleId: number | null;
  nextStartAt: number;
  blocked: boolean;
  moved: boolean;
  rows: Map<number, HTMLElement>;
  vehicles: Map<number, CalendarVehicle>;
  events: Map<number | null, { bookingId: number | null; start: number; end: number }[]>;
  blockedByVehicle: Map<number, boolean>;
  availabilityStart: number | null;
};
type Props = {
  vehicles: CalendarVehicle[];
  events: ScheduleEvent[];
  bookings?: CalendarResponse['bookings'];
  unassignedBookings?: CalendarBooking[];
  from: number;
  to: number;
  dayWidth: number;
  onSelect: (p: CalendarPanel) => void;
  onMove: (p: { bookingId: number; vehicleId: number; startAt: string }) => void;
  groupBy: 'brand' | 'tariff';
  collapsed: Set<string>;
  onToggle: (key: string) => void;
};
function VehicleRow({
  vehicle: v,
  events,
  dates,
  from,
  dayWidth,
  onSelect,
  onDragStart,
  groupBy,
}: Pick<Props, 'events' | 'from' | 'dayWidth' | 'onSelect' | 'groupBy'> & {
  vehicle: CalendarVehicle;
  dates: ReturnType<typeof calendarDates>['days'];
  onDragStart: (id: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const days = dates.length;
  const [day, setDay] = useState(0);
  const start = moscowDateTimeInput(from + day * DAY + 10 * 3600000);
  const openVehicle = () => onSelect({ kind: 'vehicle', id: v.id });
  const create = () => onSelect({ kind: 'create', vehicleId: v.id, start });
  const layout = useMemo(() => layoutCalendarEvents(events), [events]);
  return (
    <div className="calendar-row" style={{ height: 6 + layout.lanes * 38 }} data-vehicle-id={v.id}>
      <button
        className="calendar-label"
        onClick={openVehicle}
        title={v.brand_name + ' ' + v.model_name + ' · ' + v.plate}
      >
        {groupBy === 'tariff' && (
          <span className="calendar-vehicle-model">
            {v.brand_name} {v.model_name}
          </span>
        )}
        <span className="calendar-vehicle-summary">
          <strong className="calendar-vehicle-plate">{v.plate}</strong>
          <span className="calendar-vehicle-indicators">
            {!!layout.conflicts.length && (
              <Tooltip title="Есть пересечения, требуется разбор" trigger={['hover', 'focus']}>
                <Tag color="red" tabIndex={0}>
                  <WarningOutlined /> {layout.conflicts.length}
                </Tag>
              </Tooltip>
            )}
            {!v.is_ready && (
              <Tooltip
                title={'Не готов к выдаче: ' + (v.readiness_reason || 'причина не указана')}
                trigger={['hover', 'focus']}
              >
                <WarningOutlined
                  className="calendar-vehicle-status not-ready"
                  aria-label="Не готов к выдаче"
                  tabIndex={0}
                />
              </Tooltip>
            )}
            {v.needs_wash && (
              <Tooltip title="Нужна мойка" trigger={['hover', 'focus']}>
                <ClearOutlined
                  className="calendar-vehicle-status needs-wash"
                  aria-label="Нужна мойка"
                  tabIndex={0}
                />
              </Tooltip>
            )}
          </span>
        </span>
      </button>
      <div className="calendar-track" style={{ width: days * dayWidth }}>
        <Dropdown
          trigger={['contextMenu', 'click']}
          menu={{
            items: [
              { key: 'create', label: 'Забронировать' },
              { key: 'vehicle', label: 'Автомобиль / блокировка' },
            ],
            onClick: ({ key }) => (key === 'create' ? create() : openVehicle()),
          }}
        >
          <div className="calendar-cells">
            {dates.map(({ label }, i) => (
              <button
                key={i}
                className="calendar-cell"
                style={{ width: dayWidth }}
                aria-label={v.plate + ' · ' + label}
                onClick={() => setDay(i)}
                onContextMenu={() => setDay(i)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onSelect({
                    kind: 'create',
                    vehicleId: v.id,
                    start: moscowDateTimeInput(from + i * DAY + 10 * 3600000),
                  });
                }}
              />
            ))}
          </div>
        </Dropdown>
        {layout.events.map((s) => {
          const eventLeft = ((s.start - from) / DAY) * dayWidth;
          const eventRight = ((s.end - from) / DAY) * dayWidth;
          const left = Math.max(0, eventLeft);
          const right = Math.min(days * dayWidth, eventRight);
          const width = Math.max(4, right - left);
          const position: CSSProperties & {
            '--event-left': string;
            '--event-width': string;
            '--event-paid-width'?: string;
          } = {
            '--event-left': `${left}px`,
            '--event-width': `${width}px`,
            top: 5 + s.lane * 38,
          };
          const conflicts = layout.conflicts.filter((conflict) => conflict.eventIds.includes(s.id));
          const activeRental = s.checkoutPhase === 'issued';
          let paymentClass = '';
          if (activeRental || s.checkoutPhase === 'completed') {
            const paidRatio = s.paidRatio ?? (Number(s.financialSummary?.paidPercent) || 0) / 100;
            if (paidRatio >= 1) paymentClass = ' booking-paid';
            else if (paidRatio > 0) {
              paymentClass = ' booking-partially-paid';
              const paidEnd = eventLeft + (eventRight - eventLeft) * paidRatio;
              const paidWidth = Math.max(0, Math.min(width, paidEnd - left));
              position['--event-paid-width'] = `${paidWidth}px`;
            } else paymentClass = ' booking-unpaid';
          }
          const open = () => {
            if (!s.booking_id) openVehicle();
            else onSelect({ kind: s.checkoutPhase ? 'contract' : 'booking', id: s.booking_id });
          };
          return (
            <Fragment key={s.id}>
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    ...(activeRental ? [{ key: 'complete', label: 'Завершить аренду' }] : []),
                    ...(!s.checkoutPhase
                      ? [
                          {
                            key: 'open',
                            label: s.booking_id ? 'Открыть бронь' : 'Открыть блокировку',
                          },
                        ]
                      : []),
                    ...(s.booking_id && (s.checkoutPhase || s.kind === 'assignment')
                      ? [
                          {
                            key: 'checkout',
                            label: s.checkoutPhase ? 'Открыть договор' : 'Создать договор',
                          },
                        ]
                      : []),
                    { key: 'vehicle', label: 'Автомобиль' },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'complete' && s.booking_id)
                      onSelect({ kind: 'contract', id: s.booking_id, action: 'complete' });
                    else if (key === 'checkout' && s.booking_id)
                      onSelect({
                        kind: 'contract',
                        id: s.booking_id,
                        action: s.checkoutPhase ? undefined : 'start',
                      });
                    else if (key === 'open') open();
                    else openVehicle();
                  },
                }}
              >
                <button
                  className={
                    'calendar-event ' +
                    (s.kind === 'technical' ? 'technical' : 'booking') +
                    paymentClass +
                    (s.booking_id && (s.kind === 'assignment' || s.kind === 'displaced')
                      ? ' calendar-draggable'
                      : '')
                  }
                  style={position}
                  onPointerDown={(e) => {
                    if (
                      e.button === 0 &&
                      s.booking_id &&
                      (s.kind === 'assignment' || s.kind === 'displaced')
                    )
                      onDragStart(s.booking_id, e);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.currentTarget.dataset.suppressClick === 'true') {
                      e.currentTarget.dataset.suppressClick = '';
                      return;
                    }
                    open();
                  }}
                  onContextMenu={(event) => event.stopPropagation()}
                >
                  <CalendarEventContent
                    tooltip={s.booking_id ? <BookingTooltip booking={s} /> : s.reason}
                    invoicePayment={s.invoicePayment}
                  >
                    {s.booking_id ? (
                      <BookingBlock
                        name={s.customer_name ?? 'Бронь №' + s.booking_id}
                        phase={s.checkoutPhase}
                        returnInProgress={s.returnInProgress}
                        accountingEmailUnsent={s.accountingEmailUnsent}
                        start={s.start_at}
                      />
                    ) : (
                      s.reason
                    )}
                  </CalendarEventContent>
                </button>
              </Dropdown>
              {conflicts.length > 0 && (
                <div className="calendar-conflict-clip" style={position}>
                  {conflicts.map((conflict) => {
                    const start = Math.max(left, ((conflict.start - from) / DAY) * dayWidth);
                    const end = Math.min(right, ((conflict.end - from) / DAY) * dayWidth);
                    return (
                      <button
                        key={conflict.id}
                        className="calendar-conflict-border"
                        data-event-id={s.id}
                        aria-label="Разобрать конфликт"
                        title="Пересечение событий — открыть разбор"
                        style={{ left: start - left, width: Math.max(4, end - start) }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(
                            conflict.bookingId
                              ? { kind: 'booking', id: conflict.bookingId }
                              : { kind: 'vehicle', id: v.id },
                          );
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
export default function CalendarGrid(props: Props) {
  const dragRef = useRef<Drag | null>(null);
  const holdRef = useRef<{
    timer: number;
    pointerId: number;
    initialPointer: PointerPosition;
    latestPointer: PointerPosition;
    source: HTMLElement;
  } | null>(null);
  const frameRef = useRef(0);
  const pointerRef = useRef<PointerPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const begin = (
    bookingId: number,
    startPointer: PointerPosition,
    pointerId: number,
    source: HTMLElement,
    touch: boolean,
  ) => {
    if (dragRef.current) return;
    const p = propsRef.current,
      b =
        p.bookings?.find((x) => x.id === bookingId) ??
        p.unassignedBookings?.find((x) => x.id === bookingId);
    if (!b) return;
    const rows = new Map<number, HTMLElement>();
    rootRef.current
      ?.querySelectorAll<HTMLElement>('[data-vehicle-id]')
      .forEach((row) => rows.set(Number(row.dataset.vehicleId), row));
    const events = new Map<
      number | null,
      { bookingId: number | null; start: number; end: number }[]
    >();
    for (const item of p.events) {
      if (item.kind === 'displaced') continue;
      const list = events.get(item.vehicle_id) ?? [];
      list.push({
        bookingId: item.booking_id ?? null,
        start: Date.parse(item.start_at),
        end: Date.parse(item.end_at),
      });
      events.set(item.vehicle_id, list);
    }
    dragRef.current = {
      touch,
      bookingId,
      pointerId,
      source,
      startPointer,
      startAt: Date.parse(b.start_at),
      endAt: Date.parse(b.end_at),
      vehicleId: b.vehicle_id ?? null,
      targetVehicleId: b.vehicle_id ?? null,
      nextStartAt: Date.parse(b.start_at),
      blocked: false,
      moved: false,
      rows,
      vehicles: new Map(p.vehicles.map((v) => [v.id, v])),
      events,
      blockedByVehicle: new Map(),
      availabilityStart: null,
    };
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.className = source.className;
      ghost.classList.remove('calendar-draggable');
      ghost.classList.add('calendar-drag-ghost');
      ghost.style.setProperty('--drag-source-width', `${source.getBoundingClientRect().width}px`);
      ghost.replaceChildren(...Array.from(source.childNodes, (node) => node.cloneNode(true)));
    }
  };
  function requestDrag(bookingId: number, event: ReactPointerEvent<HTMLButtonElement>) {
    if (!event.isPrimary || holdRef.current || dragRef.current) return;
    const { pointerId, clientX: x, clientY: y, currentTarget: source } = event;
    const initialPointer = { x, y };
    if (event.pointerType !== 'touch') {
      begin(bookingId, initialPointer, pointerId, source, false);
      return;
    }
    const timer = window.setTimeout(() => {
      const hold = holdRef.current;
      holdRef.current = null;
      if (!hold || !source.isConnected) return;
      begin(bookingId, hold.latestPointer, pointerId, source, true);
      if (dragRef.current) source.classList.add('calendar-drag-ready');
    }, 500);
    holdRef.current = { timer, pointerId, initialPointer, latestPointer: initialPointer, source };
  }
  useEffect(() => {
    const root = rootRef.current;
    const cancelHold = () => {
      if (holdRef.current) window.clearTimeout(holdRef.current.timer);
      holdRef.current = null;
    };
    const paint = () => {
      frameRef.current = 0;
      const d = dragRef.current,
        pointer = pointerRef.current;
      if (!d || !pointer) return;
      const deltaX = pointer.x - d.startPointer.x;
      if (d.touch && !d.moved && deltaX === 0 && pointer.y === d.startPointer.y) return;
      const p = propsRef.current,
        step = 3600000;
      const start = d.startAt + Math.round(deltaX / (p.dayWidth * (step / DAY))) * step;
      const hit = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest<HTMLElement>('[data-vehicle-id]');
      const vehicleId =
        hit && rootRef.current?.contains(hit) ? Number(hit.dataset.vehicleId) : null;
      if (!d.moved && Math.abs(deltaX) <= 2 && vehicleId === d.vehicleId) return;
      const firstMove = !d.moved;
      const timeChanged = d.availabilityStart !== start;
      d.moved = true;
      if (firstMove) d.source.classList.add('calendar-drag-source');
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.hidden = false;
        const x = Math.max(8, Math.min(pointer.x + 12, window.innerWidth - ghost.offsetWidth - 8));
        const y = Math.max(
          8,
          Math.min(pointer.y + 12, window.innerHeight - ghost.offsetHeight - 8),
        );
        ghost.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
      if (timeChanged) {
        d.availabilityStart = start;
        d.nextStartAt = start;
        const end = d.endAt + (start - d.startAt);
        for (const [id, row] of d.rows) {
          const vehicle = d.vehicles.get(id);
          const conflict = (d.events.get(id) ?? []).some(
            (item) => item.bookingId !== d.bookingId && item.start < end && item.end > start,
          );
          const blocked = !vehicle?.is_ready || conflict;
          d.blockedByVehicle.set(id, blocked);
          row.classList.toggle('calendar-drop-unavailable', blocked);
          row.classList.toggle('calendar-drop-available', !blocked);
        }
      }
      if (d.targetVehicleId !== vehicleId) {
        if (d.targetVehicleId !== null)
          d.rows.get(d.targetVehicleId)?.classList.remove('calendar-drop-target');
        d.targetVehicleId = vehicleId;
      }
      if (vehicleId !== null) d.rows.get(vehicleId)?.classList.add('calendar-drop-target');
      d.blocked = vehicleId === null || d.blockedByVehicle.get(vehicleId) === true;
      ghost?.classList.toggle('blocked', d.blocked);
      if (ghost && timeChanged) {
        const bookingStart = ghost.querySelector('.calendar-booking-start');
        if (bookingStart) bookingStart.textContent = bookingStartLabel(start);
      }
    };
    const clear = () => {
      const d = dragRef.current;
      if (!d) return;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      pointerRef.current = null;
      d.rows.forEach((row) =>
        row.classList.remove(
          'calendar-drop-available',
          'calendar-drop-unavailable',
          'calendar-drop-target',
        ),
      );
      d.source.classList.remove('calendar-drag-source', 'calendar-drag-ready');
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.hidden = true;
        ghost.className = 'calendar-drag-ghost';
        ghost.replaceChildren();
      }
      dragRef.current = null;
    };
    const move = (e: PointerEvent) => {
      const hold = holdRef.current;
      if (hold?.pointerId === e.pointerId) {
        const { x, y } = hold.initialPointer;
        if (Math.hypot(e.clientX - x, e.clientY - y) > 8) cancelHold();
        else hold.latestPointer = { x: e.clientX, y: e.clientY };
        return;
      }
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (!frameRef.current) frameRef.current = requestAnimationFrame(paint);
    };
    const up = (e: PointerEvent) => {
      if (holdRef.current?.pointerId === e.pointerId) cancelHold();
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      paint();
      const {
        moved,
        blocked,
        targetVehicleId,
        nextStartAt,
        startAt,
        vehicleId,
        bookingId,
        source,
      } = d;
      clear();
      if (!moved && !d.touch) return;
      source.dataset.suppressClick = 'true';
      setTimeout(() => {
        source.dataset.suppressClick = '';
      }, 100);
      if (!blocked && targetVehicleId && (nextStartAt !== startAt || targetVehicleId !== vehicleId))
        propsRef.current.onMove({
          bookingId,
          vehicleId: targetVehicleId,
          startAt: new Date(nextStartAt).toISOString(),
        });
    };
    const cancel = (e: PointerEvent) => {
      if (holdRef.current?.pointerId === e.pointerId) cancelHold();
      if (e.pointerId === dragRef.current?.pointerId) clear();
    };
    const interrupt = () => {
      cancelHold();
      clear();
    };
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length > 1) interrupt();
    };
    const onTouchMove = (event: TouchEvent) => {
      // Let the browser scroll until the hold finishes. Changing touch-action
      // after pointerdown cannot take over the current gesture.
      if (dragRef.current?.touch && event.cancelable) event.preventDefault();
    };
    const onContextMenu = (event: MouseEvent) => {
      const source =
        holdRef.current?.source ?? (dragRef.current?.touch ? dragRef.current.source : null);
      if (event.target instanceof Node && source?.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    root?.addEventListener('touchmove', onTouchMove, { passive: false });
    root?.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', interrupt);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      root?.removeEventListener('touchmove', onTouchMove);
      root?.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', interrupt);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      interrupt();
    };
  }, []);
  const { from, to, events } = props;
  const dates = useMemo(() => calendarDates(from, to), [from, to]);
  const days = dates.days.length;
  const eventsByVehicle = useMemo(() => {
    const grouped = new Map<number, ScheduleEvent[]>();
    for (const event of events) {
      if (
        event.vehicle_id === null ||
        Date.parse(event.start_at) >= to ||
        Date.parse(event.end_at) <= from
      )
        continue;
      const group = grouped.get(event.vehicle_id);
      if (group) group.push(event);
      else grouped.set(event.vehicle_id, [event]);
    }
    return grouped;
  }, [events, from, to]);
  const today = moscowDayStart(moscowDate(Date.now()));
  const grouped = new Map<string, CalendarVehicle[]>();
  for (const v of props.vehicles) {
    const name =
      props.groupBy === 'brand' ? v.brand_name : (v.pricing_group_name ?? 'Без тарифной группы');
    const list = grouped.get(name) ?? [];
    list.push(v);
    grouped.set(name, list);
  }
  const groups = [...grouped].sort(([a], [b]) => a.localeCompare(b, 'ru'));
  const header = (key: string, name: string, count: number, model = false, brand = '') => (
    <div className={'calendar-brand-row' + (model ? ' calendar-model-row' : '')}>
      <button
        className="calendar-group-toggle"
        aria-label={model ? 'Модель ' + brand + ' ' + name : 'Группа ' + name}
        aria-expanded={!props.collapsed.has(key)}
        onClick={() => props.onToggle(key)}
      >
        <span className="calendar-label">
          <Tooltip title={props.collapsed.has(key) ? 'Развернуть группу' : 'Свернуть группу'}>
            <span aria-hidden="true">{props.collapsed.has(key) ? '▸' : '▾'}</span>
          </Tooltip>
          <span className="calendar-group-name">{name}</span>
          <Badge count={count} overflowCount={999} className="calendar-group-count" />
        </span>
      </button>
    </div>
  );
  const rows = (vehicles: CalendarVehicle[]) => {
    const modelIds = new Set(vehicles.map((v) => v.model_id));
    const unassigned = (props.unassignedBookings ?? []).filter((b) => {
      const model = b.models?.find((id: number) => props.vehicles.some((v) => v.model_id === id));
      return modelIds.has(model!);
    });
    return (
      <>
        {vehicles.map((v) => (
          <VehicleRow
            key={v.id}
            vehicle={v}
            dates={dates.days}
            events={eventsByVehicle.get(v.id) ?? []}
            from={from}
            dayWidth={props.dayWidth}
            onSelect={props.onSelect}
            groupBy={props.groupBy}
            onDragStart={requestDrag}
          />
        ))}
        {unassigned.map((b) => {
          const open = () =>
            props.onSelect({ kind: b.checkoutPhase ? 'contract' : 'booking', id: b.id });
          const left = Math.max(0, ((Date.parse(b.start_at) - props.from) / DAY) * props.dayWidth),
            right = Math.min(
              days * props.dayWidth,
              ((Date.parse(b.end_at) - props.from) / DAY) * props.dayWidth,
            );
          const position = {
            '--event-left': `${left}px`,
            '--event-width': `${Math.max(4, right - left)}px`,
          } as CSSProperties;
          return (
            <div
              className="calendar-row calendar-unassigned-row"
              key={'unassigned-' + b.id}
              data-unassigned-booking={b.id}
            >
              <button className="calendar-label" onClick={open}>
                Без автомобиля · №{b.id}
                {!!b.problemReasons?.length && (
                  <Tooltip
                    title="Бронь требует внимания — открыть для разбора"
                    trigger={['hover', 'focus']}
                  >
                    <WarningOutlined className="calendar-unassigned-warning" tabIndex={0} />
                  </Tooltip>
                )}
              </button>
              <div className="calendar-track" style={{ width: days * props.dayWidth }}>
                <CalendarEventTooltip title={<BookingTooltip booking={b} />}>
                  <button
                    className={
                      'calendar-event unassigned calendar-draggable' +
                      (b.problemReasons?.length ? ' problematic' : '')
                    }
                    style={position}
                    onPointerDown={(e) => {
                      if (e.button === 0) requestDrag(b.id, e);
                    }}
                    onClick={(e) => {
                      if (e.currentTarget.dataset.suppressClick === 'true') {
                        e.currentTarget.dataset.suppressClick = '';
                        return;
                      }
                      open();
                    }}
                  >
                    <CalendarEventContent invoicePayment={b.invoicePayment}>
                      <BookingBlock
                        name={b.customer_name + ' · Не назначен'}
                        start={b.start_at}
                        phase={b.checkoutPhase}
                        returnInProgress={b.returnInProgress}
                        accountingEmailUnsent={b.accountingEmailUnsent}
                      />
                    </CalendarEventContent>
                  </button>
                </CalendarEventTooltip>
                {b.problemReasons?.length > 0 && !!b.conflicts?.length && (
                  <div className="calendar-conflict-clip" style={position}>
                    {b.conflicts.map((c) => {
                      const start = Math.max(
                          props.from,
                          Date.parse(b.start_at),
                          Date.parse(c.overlap_start ?? c.start_at),
                        ),
                        end = Math.min(
                          props.to,
                          Date.parse(b.end_at),
                          Date.parse(c.overlap_end ?? c.end_at),
                        );
                      if (start >= end) return null;
                      const x = ((start - props.from) / DAY) * props.dayWidth,
                        w = ((end - start) / DAY) * props.dayWidth;
                      return (
                        <button
                          key={c.id}
                          className="calendar-conflict-border"
                          aria-label="Разобрать конфликт неназначенной брони"
                          style={{ left: x - left, width: Math.max(4, w) }}
                          onClick={() => props.onSelect({ kind: 'booking', id: b.id })}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </>
    );
  };
  return (
    <div
      ref={rootRef}
      className="calendar-grid-content"
      style={{ width: `calc(${days * props.dayWidth}px + var(--calendar-label-width))` }}
    >
      <div ref={ghostRef} className="calendar-drag-ghost" hidden aria-hidden="true" />
      <div className="calendar-row calendar-head">
        <div className="calendar-label">Автомобиль</div>
        <div className="calendar-date-head">
          <div className="calendar-months">
            {dates.months.map((month, i) => (
              <div key={i} style={{ width: month.days * props.dayWidth }}>
                <span>{month.label}</span>
              </div>
            ))}
          </div>
          <div className="calendar-days">
            {dates.days.map(({ at, number, weekday }, i) => {
              const weekend = ['сб', 'вс'].includes(weekday);
              return (
                <div
                  style={{ width: props.dayWidth }}
                  className={
                    (at === today ? 'calendar-day-today ' : '') +
                    (weekend ? 'calendar-day-weekend' : '')
                  }
                  aria-current={at === today ? 'date' : undefined}
                  key={i}
                >
                  {number} {weekday}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <CurrentTimeIndicator from={props.from} to={props.to} dayWidth={props.dayWidth} />
      {groups.map(([name, vehicles]) => {
        const key = props.groupBy + ':' + name;
        const models = new Map<string, CalendarVehicle[]>();
        if (props.groupBy === 'brand')
          for (const v of vehicles) {
            const list = models.get(v.model_name) ?? [];
            list.push(v);
            models.set(v.model_name, list);
          }
        const singleModel = props.groupBy === 'brand' && models.size === 1;
        const title = singleModel ? name + ' ' + models.keys().next().value : name;
        return (
          <div className="calendar-group" key={key}>
            {header(key, title, vehicles.length)}
            {!props.collapsed.has(key) &&
              (props.groupBy === 'tariff' || singleModel
                ? rows(vehicles)
                : [...models]
                    .sort(([a], [b]) => a.localeCompare(b, 'ru'))
                    .map(([model, list]) => {
                      const modelKey = 'model:' + JSON.stringify([name, model]);
                      return (
                        <div className="calendar-model-group" key={modelKey}>
                          {header(modelKey, model, list.length, true, name)}
                          {!props.collapsed.has(modelKey) && rows(list)}
                        </div>
                      );
                    }))}
          </div>
        );
      })}
    </div>
  );
}
