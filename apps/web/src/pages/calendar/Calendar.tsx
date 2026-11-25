import BookingForm from '../booking-form/BookingForm';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  ConfigProvider,
  DatePicker,
  Drawer,
  Input,
  Modal,
  Popover,
  Segmented,
  Select,
  Spin,
  Space,
  Tag,
} from 'antd';
import {
  CalendarOutlined,
  FilterOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { dateText, PollNotice } from '../../catalog';
import { api, createIdempotencyKey, errorMessage } from '../../api';
import { rub } from '../../shared/formatters';
import { moscowDate } from '../../shared/moscowTime';
import { PageTitle } from '../../shared/PageTitle';
import CalendarGrid from './CalendarGrid';
import { ProblemCard } from '../../features/booking/Conflicts';
import './Calendar.css';
import { ContractCheckout } from './ContractCheckout';
import type { CheckoutExitGuard } from './ContractCheckout';
import Action, { CommandLock } from './CalendarAction';
import Booking, { type BookingHeading } from './BookingPanel';
import VehiclePanel from './VehiclePanel';
import { DAY } from './dates';
import { useCalendarState } from './useCalendarState';
import { useCalendarMove } from './useCalendarMove';
import { AccountingEmailNotice } from './AccountingEmailNotice';
import type { CalendarPanel, CommandResult } from '../../contracts';

const compactHeaderQuery = window.matchMedia(
  '(max-width: 760px), (max-width: 960px) and (max-height: 540px)',
);

function subscribeToCompactHeader(onChange: () => void) {
  compactHeaderQuery.addEventListener('change', onChange);
  return () => compactHeaderQuery.removeEventListener('change', onChange);
}

function isCompactHeader() {
  return compactHeaderQuery.matches;
}

export default function Calendar() {
  const { rentalId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [bookingRevision, setBookingRevision] = useState(0);
  const [accountingEmailBookings, setAccountingEmailBookings] = useState<number[]>([]);
  const { moveRequest, movePreview, moveError, moveLoading, loadMove, closeMove } =
    useCalendarMove();
  const [createFooter, setCreateFooter] = useState<HTMLDivElement | null>(null);
  const [bookingHeading, setBookingHeading] = useState<BookingHeading>();
  const [locked, setLocked] = useState(false);
  const compactHeader = useSyncExternalStore(subscribeToCompactHeader, isCompactHeader);
  const checkoutExit = useRef<CheckoutExitGuard>(null);
  const {
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
    panel: calendarPanel,
    setPanel,
    scroll,
    select,
    change,
    vehicles,
    onScroll,
    onWheel,
    goToday,
    toggleGroup,
  } = useCalendarState();
  const canonicalId = Number(rentalId);
  const startingReturns = useRef(new Map<number, Promise<{ id: number }>>());
  const latestSelection = useRef<symbol>(undefined);
  useLayoutEffect(
    () => () => {
      latestSelection.current = undefined;
    },
    [calendarPanel, location.key],
  );
  const { message } = AntApp.useApp();
  const step = new URLSearchParams(location.search).get('step');
  const checkoutStep =
    step === 'checkout' || (step !== 'return' && location.state?.rentalStep === 'contract');
  const panel: CalendarPanel =
    Number.isSafeInteger(canonicalId) && canonicalId > 0
      ? {
          kind: 'contract',
          id: canonicalId,
          action: checkoutStep ? undefined : 'complete',
        }
      : calendarPanel;
  const openGridPanel = useCallback(
    async (next: CalendarPanel) => {
      const selection = Symbol();
      latestSelection.current = selection;
      if (next?.kind === 'contract' && next.action === 'complete') {
        let request = startingReturns.current.get(next.id);
        if (!request) {
          request = api<{ id: number }>('/bookings/' + next.id + '/return/start', {
            method: 'POST',
            key: createIdempotencyKey(),
          });
          startingReturns.current.set(next.id, request);
        }
        try {
          await request;
        } catch (error) {
          if (latestSelection.current === selection) void message.error(errorMessage(error));
          return;
        } finally {
          if (startingReturns.current.get(next.id) === request)
            startingReturns.current.delete(next.id);
        }
        if (latestSelection.current !== selection) return;
      }
      if (
        next?.kind === 'contract' &&
        (next.action === 'complete' ||
          p.data?.events.some(
            (event) =>
              event.booking_id === next.id &&
              (event.checkoutPhase === 'issued' || event.checkoutPhase === 'completed'),
          ))
      ) {
        setPanel(null);
        navigate('/rentals/' + next.id, {
          state: {
            returnToPrevious: true,
            rentalStep:
              next.action === 'complete' ||
              p.data?.events.some(
                (event) => event.booking_id === next.id && event.checkoutPhase === 'completed',
              )
                ? 'return'
                : 'contract',
          },
        });
        return;
      }
      setPanel(next);
    },
    [message, navigate, p.data, setPanel],
  );
  const grid = useMemo(
    () => (
      <CalendarGrid
        groupBy={groupBy}
        collapsed={collapsed}
        onToggle={toggleGroup}
        vehicles={vehicles}
        bookings={p.data?.bookings ?? []}
        unassignedBookings={p.data?.unassignedBookings ?? []}
        events={p.data?.events ?? []}
        from={from}
        to={to}
        dayWidth={dayWidth}
        onSelect={openGridPanel}
        onMove={(request) => void loadMove(request)}
      />
    ),
    [
      groupBy,
      collapsed,
      vehicles,
      p.data,
      from,
      to,
      dayWidth,
      loadMove,
      openGridPanel,
      toggleGroup,
    ],
  );
  const done = () => {
    void p.reload();
  };
  const completeMove = () => {
    closeMove();
    done();
    if (panel?.kind === 'contract') checkoutExit.current?.refreshVehicle();
    setPanel((current) =>
      current?.kind === 'booking' ? { kind: 'booking', id: current.id } : current,
    );
    setBookingRevision((value) => value + 1);
  };
  const watchAccountingEmail = (booking: CommandResult) => {
    if (booking.accountingEmailRequested)
      setAccountingEmailBookings((ids) => (ids.includes(booking.id) ? ids : [...ids, booking.id]));
  };
  const bookingCreated = (booking: CommandResult) => {
    watchAccountingEmail(booking);
    done();
    select({ kind: 'booking', id: booking.id });
  };
  const reloadCalendar = p.reload;
  const finishAccountingEmail = useCallback(
    (bookingId: number) => {
      setAccountingEmailBookings((ids) => ids.filter((id) => id !== bookingId));
      void reloadCalendar();
    },
    [reloadCalendar],
  );
  const closeContract = () => {
    if (rentalId) {
      if (location.state?.returnToPrevious) navigate(-1);
      else navigate('/calendar', { replace: true });
    } else select(null);
  };
  const closePanel = () => {
    if (locked) return;
    if (panel?.kind === 'contract' && checkoutExit.current) {
      checkoutExit.current.requestClose();
      return;
    }
    closeContract();
  };
  const cancelMove = () => {
    if (!locked) closeMove();
  };
  const contractPhase =
    panel?.kind === 'contract' || panel?.kind === 'booking'
      ? (p.data?.events.find((event) => event.booking_id === panel.id)?.checkoutPhase ??
        p.data?.unassignedBookings.find((booking) => booking.id === panel.id)?.checkoutPhase)
      : undefined;
  const activeFilters =
    Number(!!filter.trim()) + Number(statuses.length > 0) + Number(groupBy !== 'brand');
  const todayButton = <Button onClick={goToday}>Сегодня</Button>;
  const dateNavigation = (
    <div className="calendar-date-navigation">
      <Button
        aria-label="Предыдущий месяц"
        icon={<LeftOutlined />}
        onClick={() => change('date', moscowDate(selectedDate - 30 * DAY))}
      />
      <DatePicker
        id="calendar-date"
        aria-label="Дата календаря"
        format="DD.MM.YYYY"
        value={dayjs(date)}
        onChange={(v) => v && change('date', v.format('YYYY-MM-DD'))}
        suffixIcon={<CalendarOutlined />}
        allowClear={false}
      />
      <Button
        aria-label="Следующий месяц"
        icon={<RightOutlined />}
        onClick={() => change('date', moscowDate(selectedDate + 30 * DAY))}
      />
    </div>
  );
  const filters = (
    <div className="calendar-filter-content">
      {compactHeader && (
        <div className="calendar-filter-date">
          <label htmlFor="calendar-date">Дата календаря</label>
          {dateNavigation}
        </div>
      )}
      <label>
        Поиск по модели или госномеру
        <Input
          aria-label="Фильтр автомобилей"
          allowClear
          placeholder="Модель / номер"
          value={filter}
          onChange={(e) => change('q', e.target.value)}
        />
      </label>
      <label>
        Состояния
        <Select
          aria-label="Состояние автомобилей"
          mode="multiple"
          allowClear
          getPopupContainer={compactHeader ? undefined : (node) => node.parentElement!}
          optionFilterProp="label"
          placeholder="Все состояния"
          value={statuses}
          onChange={(v) => change('status', v.join(','))}
          options={[
            { value: 'ready', label: 'Готов' },
            { value: 'notReady', label: 'Не готов / неисправен' },
            { value: 'wash', label: 'Нужна мойка' },
            { value: 'maintenance', label: 'Требуется ТО' },
          ]}
        />
      </label>
      <label>
        Группировка
        <Segmented
          aria-label="Группировка автомобилей"
          block
          value={groupBy}
          onChange={(v) => change('group', String(v))}
          options={[
            { value: 'brand', label: 'Марка и модель' },
            { value: 'tariff', label: 'По тарифу' },
          ]}
        />
      </label>
      <label>
        Масштаб
        <Select
          aria-label="Масштаб"
          getPopupContainer={compactHeader ? undefined : (node) => node.parentElement!}
          value={scale}
          onChange={(v) => change('scale', String(v))}
          options={[
            { value: 1, label: 'Сутки' },
            { value: 2, label: 'Полсуток' },
            { value: 3, label: 'Часы' },
          ]}
        />
      </label>
      <span className="calendar-count">Показано: {vehicles.length}</span>
    </div>
  );
  return (
    <div className="calendar-page">
      {accountingEmailBookings.map((bookingId) => (
        <AccountingEmailNotice
          key={bookingId}
          bookingId={bookingId}
          onFinished={finishAccountingEmail}
        />
      ))}
      <header className="calendar-page-header">
        <PageTitle>
          <h1>График</h1>
        </PageTitle>
        {!compactHeader && (
          <div className="calendar-navigation">
            {dateNavigation}
            {todayButton}
          </div>
        )}
        <div className="calendar-header-actions">
          {compactHeader && todayButton}
          <Popover
            content={filters}
            trigger="click"
            placement={compactHeader ? 'bottom' : 'bottomRight'}
            arrow={false}
          >
            <Button
              className="calendar-filters-button"
              aria-label="Фильтры"
              icon={<FilterOutlined />}
            >
              <span className="calendar-action-label">Фильтры</span>
              {activeFilters > 0 && (
                <Badge count={activeFilters} className="calendar-filter-badge" />
              )}
            </Button>
          </Popover>
          <Button
            className="calendar-problems-button"
            aria-label={`Проблемы (${p.data?.problems.length ?? 0})`}
            danger={!!p.data?.problems.length}
            icon={<WarningOutlined />}
            onClick={() => select({ kind: 'problems' })}
          >
            <span className="calendar-action-label">Проблемы</span>
            {(p.data?.problems.length ?? 0) > 0 && <Badge count={p.data?.problems.length} />}
          </Button>
          <ConfigProvider
            theme={{
              components: {
                Button: {
                  colorPrimary: '#1668DC',
                  colorPrimaryHover: '#1A70E0',
                  colorPrimaryActive: '#1257B8',
                  colorPrimaryBorder: '#70A5F5',
                  primaryColor: '#FFFFFF',
                },
              },
            }}
          >
            <Button
              className="calendar-create-booking-button"
              type="primary"
              aria-label="Бронь"
              icon={<PlusOutlined />}
              onClick={() => select({ kind: 'create' })}
            >
              {!compactHeader && 'Бронь'}
            </Button>
          </ConfigProvider>
        </div>
      </header>
      <PollNotice {...p} />
      <section className="calendar-workspace">
        <div className="calendar-shell">
          {calendarLoading && (
            <div className="calendar-loading" role="status" aria-live="polite">
              <Spin size="small" />
              Загрузка дат…
            </div>
          )}
          <div
            className="calendar-grid"
            aria-busy={calendarLoading}
            ref={scroll}
            onScroll={onScroll}
            onWheel={onWheel}
          >
            {grid}
          </div>
        </div>
        {!p.loading && !vehicles.length && (
          <p className="calendar-empty">Нет автомобилей по выбранным фильтрам.</p>
        )}
      </section>
      <CommandLock.Provider value={{ locked, setLocked }}>
        <Modal
          title={moveRequest ? 'Изменение брони №' + moveRequest.bookingId : 'Изменение брони'}
          open={!!moveRequest}
          onCancel={cancelMove}
          closable={!locked}
          maskClosable={!locked}
          keyboard={!locked}
          destroyOnClose
          footer={
            movePreview ? (
              <div className="calendar-move-footer">
                <Button disabled={locked} onClick={closeMove}>
                  Отмена
                </Button>
                <Action
                  path={'/bookings/' + moveRequest?.bookingId + '/move'}
                  command="bookings.move"
                  label="Подтвердить изменения"
                  disabled={movePreview.blocked}
                  body={() => ({
                    vehicleId: movePreview.vehicleId,
                    startAt: movePreview.startAt,
                    expectedVersion: movePreview.expectedVersion,
                    availabilityToken: movePreview.availability.token,
                    ...(movePreview.quoteToken ? { quoteToken: movePreview.quoteToken } : {}),
                  })}
                  revision={JSON.stringify(movePreview)}
                  onAvailabilityChanged={() => {
                    if (moveRequest) void loadMove(moveRequest);
                  }}
                  onDone={completeMove}
                />
              </div>
            ) : null
          }
        >
          {moveLoading && <Spin />}
          {moveError && <Alert type="error" message={moveError} />}{' '}
          {movePreview && (
            <div className="calendar-move-preview">
              {movePreview.oldStartAt !== movePreview.startAt && (
                <div>
                  <strong>Даты и время</strong>
                  <span>
                    {dateText(movePreview.oldStartAt)} — {dateText(movePreview.oldEndAt)}
                    <br />→ {dateText(movePreview.startAt)} — {dateText(movePreview.endAt)}
                  </span>
                </div>
              )}
              {movePreview.oldVehicleId !== movePreview.vehicleId && (
                <div>
                  <strong>Автомобиль</strong>
                  <span>
                    {p.data?.vehicles.find((v) => v.id === movePreview.oldVehicleId)?.plate ??
                      'Не назначен'}{' '}
                    → {movePreview.vehiclePlate}
                  </span>
                </div>
              )}
              {movePreview.oldPriceRub !== movePreview.priceRub && (
                <div>
                  <strong>Стоимость</strong>
                  <span>
                    {rub(movePreview.oldPriceRub)} → {rub(movePreview.priceRub)}
                  </span>
                </div>
              )}
              {movePreview.blocked && (
                <Alert
                  type="error"
                  message={
                    movePreview.conflicts?.length
                      ? 'Автомобиль занят на выбранный период'
                      : 'Автомобиль не готов к выдаче'
                  }
                />
              )}{' '}
              {!movePreview.blocked && movePreview.availability?.status !== 'feasible' && (
                <Alert
                  type="warning"
                  message="Другим броням может потребоваться автомобиль. Этот перенос можно подтвердить."
                />
              )}
            </div>
          )}
        </Modal>
        <ConfigProvider componentDisabled={locked}>
          <Drawer
            className={
              (locked ? 'calendar-locked ' : '') +
              (panel?.kind === 'booking'
                ? 'booking-drawer'
                : panel?.kind === 'create'
                  ? 'booking-create-drawer'
                  : '')
            }
            open={!!panel}
            width={
              panel?.kind === 'booking'
                ? 'min(560px, 100vw)'
                : panel?.kind === 'create'
                  ? 'min(720px, 100vw)'
                  : panel?.kind === 'contract'
                    ? 'min(920px, 100vw)'
                    : 'min(640px, 100vw)'
            }
            footer={panel?.kind === 'create' ? <div ref={setCreateFooter} /> : undefined}
            styles={
              panel?.kind === 'create'
                ? {
                    header: { padding: '20px 28px' },
                    body: { padding: '20px 28px', minHeight: 0 },
                    footer: { padding: '16px 28px' },
                  }
                : panel?.kind === 'contract'
                  ? { body: { marginBlock: 16, paddingBlock: 0, minHeight: 0 } }
                  : undefined
            }
            closable={!locked}
            maskClosable={!locked}
            keyboard={!locked}
            onClose={closePanel}
            title={
              panel?.kind === 'create' ? (
                'Новое бронирование'
              ) : panel?.kind === 'booking' ? (
                <div className="booking-drawer-heading">
                  <div>
                    <span>Бронь №{panel.id}</span>
                    {bookingHeading?.id === panel.id && bookingHeading.status !== 'confirmed' && (
                      <Tag
                        color={
                          bookingHeading.status === 'active'
                            ? 'green'
                            : bookingHeading.status === 'cancelled'
                              ? 'default'
                              : 'gold'
                        }
                      >
                        {bookingHeading.status === 'active'
                          ? 'Выдана'
                          : bookingHeading.status === 'cancelled'
                            ? 'Отменена'
                            : null}
                      </Tag>
                    )}
                  </div>
                  {bookingHeading?.id === panel.id && bookingHeading.createdAt && (
                    <small>
                      Создана{' '}
                      {new Date(bookingHeading.createdAt).toLocaleDateString('ru-RU', {
                        timeZone: 'Europe/Moscow',
                      })}
                    </small>
                  )}
                </div>
              ) : panel?.kind === 'contract' ? (
                <Space>
                  Договор №{panel.id}
                  {contractPhase === 'started' && <Badge status="processing" text="Оформление" />}
                  {contractPhase === 'issued' && <Tag color="green">Автомобиль выдан</Tag>}
                </Space>
              ) : panel?.kind === 'vehicle' ? (
                'Автомобиль'
              ) : (
                'Проблемные бронирования'
              )
            }
            destroyOnClose
          >
            {panel?.kind === 'create' && (
              <BookingForm
                mode="booking"
                Action={Action}
                key={JSON.stringify(panel)}
                initial={panel}
                footerContainer={createFooter}
                onDone={bookingCreated}
              />
            )}
            {panel?.kind === 'booking' && (
              <Booking
                key={panel.id + ':' + (panel.action ?? '') + ':' + bookingRevision}
                id={panel.id}
                action={panel.action}
                checkoutPhase={contractPhase === 'completed' ? undefined : contractPhase}
                onDone={done}
                onAccountingEmailRequested={watchAccountingEmail}
                onMove={(request) => void loadMove(request)}
                onHeading={setBookingHeading}
                onCheckout={() =>
                  select({
                    kind: 'contract',
                    id: panel.id,
                    action: contractPhase ? undefined : 'start',
                  })
                }
              />
            )}
            {panel?.kind === 'contract' && (
              <ContractCheckout
                key={panel.id + ':' + (panel.action ?? '')}
                id={panel.id}
                autoStart={panel.action === 'start'}
                initialStep={
                  panel.action === 'complete'
                    ? 'return-act'
                    : step === 'checkout'
                      ? 'driver'
                      : undefined
                }
                ref={checkoutExit}
                onMove={(request) => void loadMove(request)}
                onClose={closeContract}
                onLock={setLocked}
                onChanged={done}
              />
            )}
            {panel?.kind === 'vehicle' && (
              <VehiclePanel key={panel.id} id={panel.id} onDone={done} />
            )}
            {panel?.kind === 'problems' && (
              <>
                {!p.data?.problems.length && <p>Проблемных броней в выбранном диапазоне нет.</p>}
                {p.data?.problems.map((b) => (
                  <ProblemCard
                    key={b.id}
                    booking={b}
                    onOpen={(action) => select({ kind: 'booking', id: b.id, action })}
                  />
                ))}
              </>
            )}
          </Drawer>
        </ConfigProvider>
      </CommandLock.Provider>
    </div>
  );
}
