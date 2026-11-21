import BookingForm from '../booking-form/BookingForm';
import type { BookingOptions, BookingDetail } from '../../contracts';
import { useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Collapse,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Select,
  Space,
  Tag,
  Tooltip,
} from 'antd';
import {
  CalendarOutlined,
  CarOutlined,
  DownOutlined,
  UserOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { History, PollNotice, usePolling } from '../../catalog';
import { ClientFinance } from '../finance/ClientFinance';
import { rub } from '../../shared/formatters';
import { SwapOutlined } from '@ant-design/icons';
import { ConflictList } from '../../features/booking/Conflicts';
import { compactVehicleOption } from '../../features/vehicles/CompactVehicleOption';
import Action, { CommandLock } from './CalendarAction';
import { local } from './dates';
export type BookingHeading = { id: number; status: string; createdAt?: string };
const bookingDate = (value: string, year: boolean) =>
  new Date(value)
    .toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' as const } : {}),
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(/\.(?=,)/, '');
function bookingDuration(start: string, end: string) {
  const minutes = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60000)),
    days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return (
    [
      days ? days + ' ' + (days % 10 === 1 && days % 100 !== 11 ? 'сутки' : 'суток') : '',
      hours ? hours + ' ч' : '',
      rest ? rest + ' мин' : '',
    ]
      .filter(Boolean)
      .join(' ') || '0 мин'
  );
}
export default function Booking({
  id,
  onDone,
  onMove,
  action,
  onHeading,
}: {
  id: number;
  onDone: () => void;
  onMove: (request: { bookingId: number; vehicleId: number; startAt: string }) => void;
  action?: 'assign' | 'edit';
  onHeading: (value: BookingHeading) => void;
}) {
  const p = usePolling<BookingDetail>('/bookings/' + id),
    fleet = usePolling<BookingOptions>('/booking-options'),
    lock = useContext(CommandLock);
  const [edit, setEdit] = useState(action === 'edit'),
    [dialog, setDialog] = useState<{ kind: 'assign' | 'cancel'; version: number } | null>(null);
  const [reason, setReason] = useState('');
  const expected = useRef<number | undefined>(undefined),
    b = p.data;
  const bookingStatus = b?.status;
  const bookingCreatedAt = b?.created_at;
  useEffect(() => {
    if (bookingStatus !== undefined)
      onHeading({ id, status: bookingStatus, createdAt: bookingCreatedAt });
  }, [id, bookingStatus, bookingCreatedAt, onHeading]);
  const hasBooking = !!b;
  const openInitialAssignment = useEffectEvent(() => {
    if (b && action === 'assign') setDialog({ kind: 'assign', version: b.version });
  });
  // Open on arrival/action changes; polling must not replace the dialog's version snapshot.
  useEffect(() => {
    openInitialAssignment();
  }, [hasBooking, action]);
  if (!b) return <PollNotice {...p} />;
  expected.current ??= b.version;
  const done = () => {
    expected.current = b.version + 1;
    setDialog(null);
    setEdit(false);
    void p.reload();
    onDone();
  };
  const open = (kind: 'assign' | 'cancel') => {
    setReason('');
    setDialog({ kind, version: expected.current! });
    if (kind === 'assign') {
      void fleet.reload();
      void p.reload();
    }
  };
  const targetId =
    b.target_vehicle_id ?? b.target_model_id ?? b.target_brand_id ?? b.target_group_id;
  const assigned = fleet.data?.vehicles.find((v) => v.id === b.vehicle_id);
  const statusById = new Map<number | null, BookingDetail['vehicleOptions'][number]>(
    (b.vehicleOptions ?? []).map((v) => [v.id, v]),
  );
  const groupByModel = new Map<number | undefined, number>(
    (fleet.data?.models ?? []).map((m) => [m.id, m.pricingGroupId]),
  );
  const currentTariffId =
    b.terms[0]?.snapshot.periods?.[0]?.pricingGroup?.id ??
    statusById.get(b.vehicle_id)?.pricingGroupId ??
    groupByModel.get(assigned?.modelId);
  const choices = (fleet.data?.vehicles ?? []).map((v) => {
    const status = statusById.get(v.id),
      busy = !!status?.busy,
      notReady = !v.isReady;
    return {
      ...compactVehicleOption(v),
      pricingGroupId: status?.pricingGroupId ?? groupByModel.get(v.modelId),
      free: !busy && !notReady,
      disabled: busy || notReady,
      title: busy ? 'Занят на выбранный период' : notReady ? 'Не готов к выдаче' : undefined,
    };
  });
  const assignmentOptions = [
    {
      label: 'Тот же тариф',
      options: choices.filter((v) => v.free && v.pricingGroupId === currentTariffId),
    },
    {
      label: 'Другие автомобили',
      options: choices.filter((v) => v.free && v.pricingGroupId !== currentTariffId),
    },
    { label: 'Недоступны на эти даты', options: choices.filter((v) => !v.free) },
  ].filter((group) => group.options.length);
  const showYear = local(b.start_at).slice(0, 4) !== local(b.end_at).slice(0, 4);
  return (
    <div className="booking-details">
      <PollNotice {...p} />
      <section className="booking-overview" aria-label="Сведения о брони">
        <div className="booking-overview-row">
          <UserOutlined aria-label="Клиент" />
          <Link to={'/clients/' + b.customer_id}>{b.customer_name}</Link>
        </div>
        <div className="booking-overview-row">
          <CarOutlined aria-label="Автомобиль" />
          <Space wrap>
            {b.vehicle_id ? (
              <Link to={'/fleet/' + b.vehicle_id}>
                {assigned?.label ?? 'Автомобиль №' + b.vehicle_id}
              </Link>
            ) : (
              <span>Автомобиль не назначен</span>
            )}
            {b.status === 'confirmed' &&
              (b.vehicle_id ? (
                <Tooltip title="Изменить автомобиль">
                  <Button
                    size="small"
                    type="text"
                    aria-label="Изменить автомобиль"
                    icon={<SwapOutlined />}
                    onClick={() => open('assign')}
                  />
                </Tooltip>
              ) : (
                <Button size="small" onClick={() => open('assign')}>
                  Назначить автомобиль
                </Button>
              ))}
          </Space>
        </div>
        <div className="booking-overview-row">
          <CalendarOutlined aria-label="Период" />
          <div className="booking-date-range">
            <span>
              {bookingDate(b.start_at, showYear)} — {bookingDate(b.end_at, showYear)}
            </span>
            <Tooltip title="Продолжительность интервала бронирования">
              <Tag>{bookingDuration(b.start_at, b.end_at)}</Tag>
            </Tooltip>
          </div>
        </div>
        <div className="booking-overview-row">
          <WalletOutlined />
          <span>
            Согласованная стоимость: <strong>{rub(b.terms[0]?.snapshot.finalTotalRub)}</strong>
          </span>
        </div>
      </section>
      {!!b.problemReasons?.length && (
        <Popover
          trigger={['hover', 'click']}
          content={
            <div className="booking-problem-details">
              <p>{b.problemReasons.join('. ')}</p>
              {b.replacementReason && <p>{b.replacementReason}</p>}
              <ConflictList items={b.conflicts} />
            </div>
          }
        >
          <Alert
            className="booking-problem-alert"
            type="warning"
            showIcon
            message={<span>{b.problemReasons[0]}</span>}
          />
        </Popover>
      )}
      {!!b.conflicts?.length && !b.problemReasons?.length && (
        <Collapse
          size="small"
          items={[
            {
              key: 'conflicts',
              label: 'Пересечения · ' + b.conflicts.length,
              children: <ConflictList items={b.conflicts} />,
            },
          ]}
        />
      )}
      {expected.current !== b.version && (
        <Alert
          type="warning"
          message="Бронь изменена другим сотрудником. Ваш ввод сохранён."
          action={
            <Button
              onClick={() => {
                expected.current = b.version;
                setDialog(null);
                setEdit(false);
              }}
            >
              Принять актуальную версию
            </Button>
          }
        />
      )}
      {b.status === 'confirmed' && (
        <div className="booking-primary-actions">
          <Button type="primary" onClick={() => setEdit(!edit)}>
            {edit ? 'Закрыть редактирование' : 'Изменить условия'}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [{ key: 'cancel', label: 'Отменить бронь', danger: true }],
              onClick: () => open('cancel'),
            }}
          >
            <Button danger aria-label="Действия с бронью">
              Отменить бронь <DownOutlined />
            </Button>
          </Dropdown>
        </div>
      )}
      {edit && (
        <BookingForm
          Action={Action}
          initial={{
            bookingId: id,
            customerId: b.customer_id,
            calculation: b.terms[0]?.snapshot,
            version: expected.current,
            target: b.target_type + ':' + targetId,
            start: local(b.start_at),
          }}
          onDone={done}
        />
      )}
      <Modal
        open={!!dialog}
        title={dialog?.kind === 'assign' ? 'Выберите автомобиль' : 'Отменить бронь'}
        footer={null}
        closable={!lock.locked}
        maskClosable={!lock.locked}
        keyboard={!lock.locked}
        onCancel={() => {
          if (!lock.locked) setDialog(null);
        }}
        destroyOnClose
      >
        {dialog && (
          <>
            {dialog.kind === 'assign' ? (
              <>
                <Select
                  aria-label="Назначаемый автомобиль"
                  showSearch
                  optionFilterProp="searchLabel"
                  style={{ width: '100%' }}
                  placeholder="Найти модель или номер"
                  value={b.vehicle_id ?? undefined}
                  onChange={(v) => {
                    if (v && v !== b.vehicle_id) {
                      setDialog(null);
                      onMove({
                        bookingId: id,
                        vehicleId: v,
                        startAt: new Date(b.start_at).toISOString(),
                      });
                    }
                  }}
                  options={assignmentOptions}
                />
              </>
            ) : (
              <>
                <Form layout="vertical">
                  <Form.Item label="Причина изменения" required>
                    <Input
                      aria-label="Причина изменения"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={1000}
                    />
                  </Form.Item>
                </Form>
                <Action
                  path={'/bookings/' + id + '/cancel'}
                  command="bookings.cancel"
                  label="Подтвердить отмену"
                  disabled={!reason.trim()}
                  revision={JSON.stringify({ reason, dialog })}
                  body={() => ({ expectedVersion: dialog.version, reason })}
                  onDone={done}
                />
              </>
            )}
          </>
        )}
      </Modal>
      <section className="booking-finance-section">
        <h3>Стоимость и денежная история</h3>
        <ClientFinance compact customerId={b.customer_id} bookingId={id} onLock={lock.setLocked} />
      </section>
      <Collapse
        className="booking-history"
        size="small"
        items={[
          {
            key: 'history',
            label: 'История',
            children: <History path={'/bookings/' + id + '/history'} />,
          },
        ]}
      />
    </div>
  );
}
