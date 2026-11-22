import type {
  CalendarVehicle,
  CalendarBooking,
  CalendarResponse,
  ScheduleEvent,
  CalendarPanel,
  RentPaymentProgress,
} from '../../contracts';
import { useEffect, useRef, useState } from 'react';
import { Badge, Dropdown, Tag, Tooltip } from 'antd';
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
function BookingBlock({
  name,
  start,
  phase,
  accountingEmailUnsent,
  invoicePayment,
}: {
  name: string;
  start: string;
  phase?: ScheduleEvent['checkoutPhase'];
  accountingEmailUnsent?: true;
  invoicePayment?: RentPaymentProgress;
}) {
  return (
    <span className="calendar-booking-content">
      {invoicePayment && (
        <span
          className="calendar-rent-payment-icon"
          data-status={invoicePayment.status}
          role="img"
          aria-label={rentPaymentLabels[invoicePayment.status]}
        >
          ₽
        </span>
      )}
      {accountingEmailUnsent && (
        <MailOutlined
          className="calendar-accounting-email-icon"
          aria-label="Данные для счёта не отправлены"
        />
      )}
      {phase === 'started' && <Badge status="processing" role="img" aria-label="Оформление" />}
      <Tag className="calendar-booking-start">{bookingStartLabel(start)}</Tag>
      <span className="calendar-booking-name">{name}</span>
    </span>
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
    start_at: string;
    end_at: string;
    booking_id?: number | null;
    kind?: string;
    reason?: string;
    accountingEmailUnsent?: true;
    invoicePayment?: RentPaymentProgress;
  };
}) {
  return (
    <div className="booking-tooltip">
      <div className="booking-tooltip-heading">
        <strong>{b.customer_name ?? 'Бронь №' + (b.booking_id ?? b.id)}</strong>
        {b.checkoutPhase === 'started' && <Tag color="processing">Оформление</Tag>}
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
            {rentPaymentLabels[b.invoicePayment.status]} · Осталось{' '}
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
type Drag = {
  bookingId: number;
  pointerId: number;
  source: HTMLElement;
  startX: number;
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
  blockedByVehicle: Map<number, string>;
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
  from,
  to,
  dayWidth,
  onSelect,
  onDragStart,
  groupBy,
}: Omit<Props, 'vehicles' | 'bookings' | 'unassignedBookings' | 'onMove'> & {
  vehicle: CalendarVehicle;
  onDragStart: (id: number, x: number, pointerId: number, source: HTMLElement) => void;
}) {
  const days = Math.ceil((to - from) / DAY);
  const [day, setDay] = useState(0);
  const start = moscowDateTimeInput(from + day * DAY + 10 * 3600000);
  const openVehicle = () => onSelect({ kind: 'vehicle', id: v.id });
  const create = () => onSelect({ kind: 'create', vehicleId: v.id, start });
  const layout = layoutCalendarEvents(
    events.filter(
      (s) => s.vehicle_id === v.id && Date.parse(s.start_at) < to && Date.parse(s.end_at) > from,
    ),
  );
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
            {Array.from({ length: days }, (_, i) => (
              <button
                key={i}
                className="calendar-cell"
                style={{ width: dayWidth }}
                aria-label={
                  v.plate +
                  ' · ' +
                  new Date(from + i * DAY).toLocaleDateString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                  })
                }
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
          const left = Math.max(0, ((Date.parse(s.start_at) - from) / DAY) * dayWidth),
            right = Math.min(days * dayWidth, ((Date.parse(s.end_at) - from) / DAY) * dayWidth);
          const activeRental = s.checkoutPhase === 'issued';
          const open = () => {
            if (!s.booking_id) openVehicle();
            else onSelect({ kind: s.checkoutPhase ? 'contract' : 'booking', id: s.booking_id });
          };
          return (
            <Dropdown
              key={s.id}
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
                  (activeRental
                    ? Number(s.financialSummary?.paidPercent) === 100
                      ? ' booking-paid'
                      : ' booking-unpaid'
                    : '') +
                  (s.booking_id && (s.kind === 'assignment' || s.kind === 'displaced')
                    ? ' calendar-draggable'
                    : '')
                }
                style={{ left, width: Math.max(4, right - left), top: 5 + s.lane * 38 }}
                onPointerDown={(e) => {
                  if (
                    e.button === 0 &&
                    s.booking_id &&
                    (s.kind === 'assignment' || s.kind === 'displaced')
                  )
                    onDragStart(s.booking_id, e.clientX, e.pointerId, e.currentTarget);
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
                <Tooltip title={s.booking_id ? <BookingTooltip booking={s} /> : s.reason}>
                  <span className="calendar-event-tooltip">
                    {s.booking_id ? (
                      <BookingBlock
                        name={s.customer_name ?? 'Бронь №' + s.booking_id}
                        phase={s.checkoutPhase}
                        accountingEmailUnsent={s.accountingEmailUnsent}
                        invoicePayment={s.invoicePayment}
                        start={s.start_at}
                      />
                    ) : (
                      s.reason
                    )}
                  </span>
                </Tooltip>
              </button>
            </Dropdown>
          );
        })}
        {layout.conflicts.flatMap((c) => {
          const left = Math.max(0, ((c.start - from) / DAY) * dayWidth),
            right = Math.min(days * dayWidth, ((c.end - from) / DAY) * dayWidth);
          return layout.events
            .filter((event) => c.eventIds.includes(event.id))
            .map((event) => (
              <button
                key={c.id + ':' + event.id}
                className="calendar-conflict-border"
                data-event-id={event.id}
                aria-label="Разобрать конфликт"
                title="Пересечение событий — открыть разбор"
                style={{ left, width: Math.max(4, right - left), top: 5 + event.lane * 38 }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(
                    c.bookingId
                      ? { kind: 'booking', id: c.bookingId }
                      : { kind: 'vehicle', id: v.id },
                  );
                }}
              />
            ));
        })}
      </div>
    </div>
  );
}
export default function CalendarGrid(props: Props) {
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const begin = (bookingId: number, startX: number, pointerId: number, source: HTMLElement) => {
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
      bookingId,
      pointerId,
      source,
      startX,
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
    if (ghostRef.current) {
      ghostRef.current.replaceChildren(
        ...Array.from(source.childNodes, (node) => node.cloneNode(true)),
      );
      const vehicle = document.createElement('span');
      vehicle.className = 'calendar-booking-vehicle';
      const reason = document.createElement('span');
      reason.className = 'calendar-booking-reason';
      ghostRef.current.append(vehicle, reason);
    }
  };
  useEffect(() => {
    const paint = () => {
      frameRef.current = 0;
      const d = dragRef.current,
        pointer = pointerRef.current;
      if (!d || !pointer) return;
      const p = propsRef.current,
        step = 3600000;
      const start =
        d.startAt + Math.round((pointer.x - d.startX) / (p.dayWidth * (step / DAY))) * step;
      const hit = document
        .elementFromPoint(pointer.x, pointer.y)
        ?.closest<HTMLElement>('[data-vehicle-id]');
      const vehicleId =
        hit && rootRef.current?.contains(hit) ? Number(hit.dataset.vehicleId) : null;
      if (!d.moved && Math.abs(pointer.x - d.startX) <= 2 && vehicleId === d.vehicleId) return;
      const firstMove = !d.moved,
        timeChanged = d.availabilityStart !== start,
        vehicleChanged = d.targetVehicleId !== vehicleId;
      d.moved = true;
      if (firstMove) d.source.classList.add('calendar-drag-source');
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.hidden = false;
        ghost.style.transform = `translate3d(${pointer.x + 12}px,${pointer.y + 12}px,0)`;
      }
      if (d.availabilityStart !== start) {
        d.availabilityStart = start;
        d.nextStartAt = start;
        const end = d.endAt + (start - d.startAt);
        for (const [id, row] of d.rows) {
          const vehicle = d.vehicles.get(id);
          const conflict = (d.events.get(id) ?? []).some(
            (item) => item.bookingId !== d.bookingId && item.start < end && item.end > start,
          );
          const reason = !vehicle?.is_ready
            ? 'Автомобиль не готов к выдаче'
            : conflict
              ? 'Автомобиль занят на выбранный период'
              : '';
          d.blockedByVehicle.set(id, reason);
          row.classList.toggle('calendar-drop-unavailable', !!reason);
          row.classList.toggle('calendar-drop-available', !reason);
        }
      }
      if (d.targetVehicleId !== vehicleId) {
        if (d.targetVehicleId !== null)
          d.rows.get(d.targetVehicleId)?.classList.remove('calendar-drop-target');
        d.targetVehicleId = vehicleId;
      }
      if (vehicleId !== null) d.rows.get(vehicleId)?.classList.add('calendar-drop-target');
      const reason =
        vehicleId === null
          ? 'Перетащите бронь на строку автомобиля'
          : (d.blockedByVehicle.get(vehicleId) ?? '');
      d.blocked = !!reason;
      ghost?.classList.toggle('blocked', d.blocked);
      if (ghost && (firstMove || timeChanged || vehicleChanged)) {
        const bookingStart = ghost.querySelector('.calendar-booking-start');
        if (bookingStart) bookingStart.textContent = bookingStartLabel(start);
        const vehicle = vehicleId === null ? undefined : d.vehicles.get(vehicleId),
          vehicleLine = ghost.querySelector('.calendar-booking-vehicle');
        if (vehicleLine)
          vehicleLine.textContent = vehicle
            ? [vehicle.brand_name, vehicle.model_name, '·', vehicle.plate].filter(Boolean).join(' ')
            : 'Автомобиль не выбран';
        const reasonLine = ghost.querySelector<HTMLElement>('.calendar-booking-reason');
        if (reasonLine) {
          reasonLine.textContent = reason;
          reasonLine.hidden = !reason;
        }
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
      d.source.classList.remove('calendar-drag-source');
      if (ghostRef.current) ghostRef.current.hidden = true;
      dragRef.current = null;
    };
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (!frameRef.current) frameRef.current = requestAnimationFrame(paint);
    };
    const up = (e: PointerEvent) => {
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
      if (!moved) return;
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
      if (e.pointerId === dragRef.current?.pointerId) clear();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      clear();
    };
  }, []);
  const days = Math.ceil((props.to - props.from) / DAY);
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
          <VehicleRow key={v.id} {...props} vehicle={v} onDragStart={begin} />
        ))}
        {unassigned.map((b) => {
          const open = () =>
            props.onSelect({ kind: b.checkoutPhase ? 'contract' : 'booking', id: b.id });
          const left = Math.max(0, ((Date.parse(b.start_at) - props.from) / DAY) * props.dayWidth),
            right = Math.min(
              days * props.dayWidth,
              ((Date.parse(b.end_at) - props.from) / DAY) * props.dayWidth,
            );
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
                <Tooltip title={<BookingTooltip booking={b} />}>
                  <button
                    className={
                      'calendar-event unassigned calendar-draggable' +
                      (b.problemReasons?.length ? ' problematic' : '')
                    }
                    style={{ left, width: Math.max(4, right - left) }}
                    onPointerDown={(e) => {
                      if (e.button === 0) begin(b.id, e.clientX, e.pointerId, e.currentTarget);
                    }}
                    onClick={(e) => {
                      if (e.currentTarget.dataset.suppressClick === 'true') {
                        e.currentTarget.dataset.suppressClick = '';
                        return;
                      }
                      open();
                    }}
                  >
                    <BookingBlock
                      name={b.customer_name + ' · Не назначен'}
                      start={b.start_at}
                      phase={b.checkoutPhase}
                      accountingEmailUnsent={b.accountingEmailUnsent}
                      invoicePayment={b.invoicePayment}
                    />
                  </button>
                </Tooltip>
                {b.problemReasons?.length > 0 &&
                  (b.conflicts ?? []).map((c) => {
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
                      <div key={c.id}>
                        <button
                          className="calendar-conflict-border"
                          aria-label="Разобрать конфликт неназначенной брони"
                          style={{ left: x, width: Math.max(4, w), top: 5 }}
                          onClick={() => props.onSelect({ kind: 'booking', id: b.id })}
                        />
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })}
      </>
    );
  };
  const monthSections: { label: string; days: number }[] = [];
  for (let i = 0; i < days; i++) {
    const value = new Date(props.from + i * DAY)
      .toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', month: 'long', year: 'numeric' })
      .replace(/\s*г\.$/, '');
    const label = value[0].toUpperCase() + value.slice(1);
    const last = monthSections.at(-1);
    if (last?.label === label) last.days++;
    else monthSections.push({ label, days: 1 });
  }
  return (
    <div
      ref={rootRef}
      className="calendar-grid-content"
      style={{ width: days * props.dayWidth + 260 }}
    >
      <div ref={ghostRef} className="calendar-drag-ghost" hidden />
      <div className="calendar-row calendar-head">
        <div className="calendar-label">Автомобиль</div>
        <div className="calendar-date-head">
          <div className="calendar-months">
            {monthSections.map((month, i) => (
              <div key={i} style={{ width: month.days * props.dayWidth }}>
                <span>{month.label}</span>
              </div>
            ))}
          </div>
          <div className="calendar-days">
            {Array.from({ length: days }, (_, i) => {
              const at = props.from + i * DAY;
              const weekday = new Date(at).toLocaleDateString('ru-RU', {
                timeZone: 'Europe/Moscow',
                weekday: 'short',
              });
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
                  {new Date(at).toLocaleDateString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                    day: 'numeric',
                  })}{' '}
                  {weekday}
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
