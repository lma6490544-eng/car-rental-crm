import { useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Typography,
} from 'antd';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  bodyNames,
  transmissionNames,
  CommandModal,
  History,
  Model,
  PollNotice,
  useListScroll,
  usePolling,
  Vehicle,
  VehicleTags,
} from '../catalog';
import { PlateInput, plateCanonical, platePattern } from '../formats';
import ServiceRecords from './ServiceRecords';
type VehicleFormValues = Partial<Vehicle> & { expectedVersion?: number; reason?: string };
type VehicleDetails = Vehicle & { activeBookingIds: number[] };

function AssignedBookingsWarning({ bookingIds }: { bookingIds: number[] }) {
  return (
    <Alert
      className="notice"
      type="warning"
      showIcon
      message="На автомобиль есть брони"
      description={
        <Space direction="vertical">
          <span>Сначала замените автомобиль в каждой из этих броней.</span>
          {bookingIds.map((id) => (
            <Link key={id} to={'/calendar?booking=' + id + '&action=assign'}>
              Заменить автомобиль в брони №{id}
            </Link>
          ))}
        </Space>
      }
    />
  );
}

function VehicleEditor({
  vehicle,
  current,
  onClose,
  onDone,
}: {
  vehicle?: Vehicle;
  current?: VehicleDetails;
  onClose: () => void;
  onDone: (result: Pick<Vehicle, 'id'>) => void;
}) {
  const [form] = Form.useForm<VehicleFormValues>();
  const models = usePolling<{ items: Model[] }>('/vehicle-models');
  const brand: string = Form.useWatch('brandName', form) ?? vehicle?.brandName ?? '';
  const model: string = Form.useWatch('modelName', form) ?? vehicle?.modelName ?? '';
  const ready: boolean | undefined = Form.useWatch('isReady', form);
  const mileage: number | null | undefined = Form.useWatch('currentMileageKm', form);
  const due: number | null | undefined = Form.useWatch('nextMaintenanceDueKm', form);
  const prices = usePolling<{ items: { id: number; name: string }[] }>('/pricing-groups');
  const normalize = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();
  const existing = models.data?.items.find(
    (m) => normalize(m.brandName) === normalize(brand) && normalize(m.name) === normalize(model),
  );
  const correction =
    !!vehicle && (mileage !== vehicle.currentMileageKm || due !== vehicle.nextMaintenanceDueKm);
  const changesModel =
    current &&
    (existing
      ? existing.id !== current.modelId
      : normalize(brand) !== normalize(current.brandName) ||
        normalize(model) !== normalize(current.modelName));
  const blockingBookings = changesModel ? current.activeBookingIds : [];
  return (
    <CommandModal
      title={vehicle ? 'Редактирование автомобиля' : 'Новый автомобиль'}
      path={vehicle ? '/vehicles/' + vehicle.id : '/vehicles'}
      command={vehicle ? 'vehicles.update' : 'vehicles.create'}
      method={vehicle ? 'PATCH' : 'POST'}
      form={form}
      initial={
        vehicle
          ? { ...vehicle, vin: vehicle.vin ?? '' }
          : {
              isReady: true,
              needsWash: false,
              currentMileageKm: null,
              bodyType: 'sedan',
              year: new Date().getFullYear(),
            }
      }
      version={vehicle?.version}
      currentVersion={current?.version}
      onClose={onClose}
      onDone={onDone}
      submitDisabled={blockingBookings.length > 0}
      currentValues={
        current && (
          <details>
            <summary>Актуальные данные автомобиля</summary>
            <p>
              {current.brandName} {current.modelName} · {current.plate} ·{' '}
              {current.vin || 'VIN не указан'} · {current.year} · {bodyNames[current.bodyType]}
            </p>
            <p>
              Пробег {current.currentMileageKm} км; порог ТО {current.nextMaintenanceDueKm} км
            </p>
            <VehicleTags v={current} />
            <p>
              {current.readinessReason} {current.issueNotes}
            </p>
          </details>
        )
      }
      prepare={({
        expectedVersion,
        reason = '',
        brandName,
        modelName,
        pricingGroupId,
        plate,
        vin = '',
        year,
        bodyType,
        transmission,
        currentMileageKm,
        nextMaintenanceDueKm,
        isReady,
        needsWash,
        note = '',
      }) => {
        const data = {
          brandName,
          modelName,
          ...(!existing ? { pricingGroupId } : {}),
          plate,
          vin,
          year,
          bodyType,
          transmission,
          currentMileageKm: currentMileageKm ?? null,
          nextMaintenanceDueKm: nextMaintenanceDueKm ?? null,
          isReady,
          needsWash,
          note,
        };
        return vehicle ? { expectedVersion, reason, data } : data;
      }}
    >
      {blockingBookings.length > 0 && <AssignedBookingsWarning bookingIds={blockingBookings} />}
      <PollNotice {...models} />
      <div className="form-grid">
        <Form.Item
          name="brandName"
          label="Марка"
          rules={[{ required: true, whitespace: true, message: 'Укажите марку.' }]}
        >
          <AutoComplete
            options={[...new Set(models.data?.items.map((m) => m.brandName))].map((value) => ({
              value,
            }))}
            filterOption={(v, o) => String(o?.value).toLowerCase().includes(v.toLowerCase())}
          />
        </Form.Item>
        <Form.Item
          name="modelName"
          label="Модель"
          rules={[{ required: true, whitespace: true, message: 'Укажите модель.' }]}
        >
          <AutoComplete
            options={models.data?.items
              .filter((m) => normalize(m.brandName) === normalize(brand))
              .map((m) => ({ value: m.name }))}
            filterOption={(v, o) => String(o?.value).toLowerCase().includes(v.toLowerCase())}
          />
        </Form.Item>
        {!existing && (
          <Form.Item
            name="pricingGroupId"
            label="Тарифная группа"
            rules={[{ required: true, message: 'Выберите тарифную группу новой модели.' }]}
          >
            <Select options={prices.data?.items.map((p) => ({ value: p.id, label: p.name }))} />
          </Form.Item>
        )}
        <Form.Item
          name="plate"
          label="Госномер"
          rules={[
            { required: true, message: 'Укажите номер.' },
            {
              validator: (_, v) =>
                !v || platePattern.test(plateCanonical(v))
                  ? Promise.resolve()
                  : Promise.reject(new Error('Формат: А 000 АА и регион из 2–3 цифр.')),
            },
          ]}
        >
          <PlateInput />
        </Form.Item>
        <Form.Item name="vin" label="VIN">
          <Input maxLength={30} />
        </Form.Item>
        <Form.Item
          name="year"
          label="Год выпуска"
          rules={[{ required: true, message: 'Укажите год.' }]}
        >
          <InputNumber min={1900} max={new Date().getFullYear() + 1} precision={0} />
        </Form.Item>
        <Form.Item name="bodyType" label="Кузов" rules={[{ required: true }]}>
          <Select options={Object.entries(bodyNames).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item
          name="transmission"
          label="Коробка"
          rules={[{ required: true, message: 'Выберите коробку передач.' }]}
        >
          <Select
            options={Object.entries(transmissionNames).map(([value, label]) => ({ value, label }))}
          />
        </Form.Item>
        <Form.Item name="currentMileageKm" label="Текущий пробег, км" extra="Пусто — неизвестен">
          <InputNumber min={0} max={10000000} precision={0} />
        </Form.Item>
        <Form.Item name="nextMaintenanceDueKm" label="Следующее ТО, км" extra="Пусто — неизвестен">
          <InputNumber min={0} max={10000000} precision={0} />
        </Form.Item>
        <Form.Item name="isReady" label="Готов к выдаче" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="needsWash" label="Требуется мойка" valuePropName="checked">
          <Switch />
        </Form.Item>
      </div>
      <Form.Item
        name="note"
        label={ready === false ? 'Причина неготовности / пометка' : 'Пометка'}
        rules={[
          { required: ready === false, whitespace: true, message: 'Укажите причину неготовности.' },
        ]}
      >
        <Input.TextArea maxLength={2000} />
      </Form.Item>
      {correction && (
        <Form.Item
          name="reason"
          label="Комментарий к изменению пробега / ТО"
          rules={[
            { required: true, whitespace: true, message: 'Укажите комментарий для истории.' },
          ]}
        >
          <Input.TextArea maxLength={1000} />
        </Form.Item>
      )}
    </CommandModal>
  );
}
export default function Fleet() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const poll = usePolling<{ items: Vehicle[]; total: number }>('/vehicles?' + params.toString());
  useListScroll('/fleet?' + params.toString(), !!poll.data);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set('page', '1');
    setParams(next, { replace: true });
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Автопарк</Typography.Title>
          <Typography.Text type="secondary">Автомобили, готовность и обслуживание</Typography.Text>
        </div>
        <Button type="primary" onClick={() => setCreating(true)}>
          Добавить автомобиль
        </Button>
      </div>
      <PollNotice {...poll} />
      <Space wrap className="catalog-toolbar">
        <Input.Search
          aria-label="Поиск автомобилей"
          placeholder="Марка, модель, номер или VIN"
          value={params.get('q') ?? ''}
          onChange={(e) => change('q', e.target.value)}
          allowClear
        />
        <Select
          aria-label="Кузов"
          value={params.get('bodyType') ?? ''}
          onChange={(v) => change('bodyType', v)}
          options={[
            { value: '', label: 'Все кузова' },
            ...Object.entries(bodyNames).map(([value, label]) => ({ value, label })),
          ]}
        />
        <Select
          aria-label="Состояние"
          value={params.get('state') ?? ''}
          onChange={(v) => change('state', v)}
          options={Object.entries({
            '': 'Все состояния',
            ready: 'Готов к выдаче',
            not_ready: 'Не готов',
            wash: 'Требуется мойка',
            issue: 'Есть пометка',
            maintenance: 'ТО в пределах 1000 км',
          }).map(([value, label]) => ({ value, label }))}
        />
        <Select
          aria-label="Архив"
          value={params.get('archived') ?? 'false'}
          onChange={(v) => change('archived', v)}
          options={[
            { value: 'false', label: 'Действующие' },
            { value: 'true', label: 'Архив' },
          ]}
        />
        <Select
          aria-label="Сортировка"
          value={params.get('sort') ?? 'name'}
          onChange={(v) => change('sort', v)}
          options={[
            { value: 'name', label: 'По модели' },
            { value: 'mileage', label: 'По пробегу' },
            { value: 'maintenance', label: 'По расстоянию до ТО' },
          ]}
        />
        <Button onClick={() => change('order', params.get('order') === 'desc' ? 'asc' : 'desc')}>
          {params.get('order') === 'desc' ? 'По убыванию ↓' : 'По возрастанию ↑'}
        </Button>
        <Button onClick={() => void poll.reload()}>Обновить</Button>
      </Space>
      <Table<Vehicle>
        rowKey="id"
        loading={poll.loading}
        dataSource={poll.data?.items}
        scroll={{ x: 800 }}
        pagination={{
          current: Number(params.get('page') ?? 1),
          pageSize: 20,
          total: poll.data?.total,
          showSizeChanger: false,
          onChange: (p) => {
            const next = new URLSearchParams(params);
            next.set('page', String(p));
            setParams(next);
          },
        }}
        columns={[
          {
            title: 'Автомобиль',
            render: (_, v) => (
              <Link to={'/fleet/' + v.id} state={{ back: location.pathname + location.search }}>
                {v.brandName} {v.modelName}
                <br />
                {v.plate}
              </Link>
            ),
          },
          {
            title: 'Кузов / год',
            render: (_, v) => (
              <>
                {bodyNames[v.bodyType]} / {v.year}
              </>
            ),
          },
          {
            title: 'Пробег',
            render: (_, v) =>
              v.currentMileageKm === null
                ? 'Неизвестен'
                : v.currentMileageKm.toLocaleString('ru-RU') + ' км',
          },
          {
            title: 'Следующее ТО',
            render: (_, v) => (
              <>
                {v.nextMaintenanceDueKm === null
                  ? 'Неизвестен'
                  : v.nextMaintenanceDueKm.toLocaleString('ru-RU')}{' '}
                км
                <br />
                <Typography.Text
                  type={
                    v.nextMaintenanceDueKm !== null &&
                    v.currentMileageKm !== null &&
                    v.nextMaintenanceDueKm <= v.currentMileageKm
                      ? 'danger'
                      : 'secondary'
                  }
                >
                  {v.nextMaintenanceDueKm === null || v.currentMileageKm === null
                    ? 'Расстояние до ТО неизвестно'
                    : `Осталось ${v.nextMaintenanceDueKm - v.currentMileageKm} км`}
                </Typography.Text>
              </>
            ),
          },
          { title: 'Состояние', render: (_, v) => <VehicleTags v={v} /> },
        ]}
      />
      {creating && (
        <VehicleEditor
          onClose={() => setCreating(false)}
          onDone={(r) =>
            navigate('/fleet/' + r.id, { state: { back: location.pathname + location.search } })
          }
        />
      )}
    </section>
  );
}
function Archive({
  vehicle,
  current,
  onClose,
  onDone,
}: {
  vehicle: Vehicle;
  current: VehicleDetails;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form] = Form.useForm();
  return (
    <CommandModal
      title="Архивировать автомобиль"
      path={'/vehicles/' + vehicle.id + '/archive'}
      command="vehicles.archive"
      initial={{}}
      version={vehicle.version}
      currentVersion={current.version}
      form={form}
      onClose={onClose}
      onDone={onDone}
      submitDisabled={current.activeBookingIds.length > 0}
    >
      {current.activeBookingIds.length > 0 && (
        <AssignedBookingsWarning bookingIds={current.activeBookingIds} />
      )}
      <p>Карточка и история останутся доступны в архиве.</p>
      <Form.Item
        name="reason"
        label="Причина архивации"
        rules={[{ required: true, whitespace: true, message: 'Укажите причину.' }]}
      >
        <Input.TextArea maxLength={1000} />
      </Form.Item>
    </CommandModal>
  );
}
export function VehicleDetail() {
  const { id } = useParams();
  const location = useLocation();
  const poll = usePolling<VehicleDetails>('/vehicles/' + id);
  const [action, setAction] = useState<{ kind: string; snapshot: Vehicle } | null>(null);
  const v = poll.data;
  if (!v)
    return (
      <>
        <PollNotice {...poll} />
        {poll.loading ? 'Загрузка…' : null}
      </>
    );
  const done = () => {
    setAction(null);
    void poll.reload();
  };
  return (
    <section>
      <Link to={location.state?.back ?? '/fleet'}>← К автопарку</Link>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>
            {v.brandName} {v.modelName} · {v.plate}
          </Typography.Title>
          <VehicleTags v={v} />
        </div>
        {!v.archivedAt && (
          <Space wrap>
            <Button onClick={() => setAction({ kind: 'edit', snapshot: v })}>Редактировать</Button>
            <Button danger onClick={() => setAction({ kind: 'archive', snapshot: v })}>
              В архив
            </Button>
          </Space>
        )}
      </div>
      <PollNotice {...poll} />
      {!v.isReady && <Alert className="notice" type="warning" message={v.readinessReason} />}
      <Tabs
        items={[
          {
            key: 'data',
            label: 'Данные',
            children: (
              <Descriptions
                bordered
                column={{ xs: 1, sm: 2 }}
                items={[
                  { key: 'vin', label: 'VIN', children: v.vin || 'Не указан' },
                  { key: 'year', label: 'Год', children: v.year },
                  { key: 'body', label: 'Кузов', children: bodyNames[v.bodyType] },
                  {
                    key: 'transmission',
                    label: 'Коробка',
                    children: transmissionNames[v.transmission ?? ''] ?? 'Не указана',
                  },
                  { key: 'pricing', label: 'Тарифная группа', children: v.pricingGroupName },
                  { key: 'tank', label: 'Бак', children: v.tankLiters + ' л' },
                  {
                    key: 'mileage',
                    label: 'Пробег',
                    children:
                      v.currentMileageKm === null ? 'Неизвестен' : v.currentMileageKm + ' км',
                  },
                  {
                    key: 'maintenance',
                    label: 'Порог ТО',
                    children:
                      v.nextMaintenanceDueKm === null
                        ? 'Неизвестен'
                        : v.nextMaintenanceDueKm + ' км',
                  },
                  {
                    key: 'remaining',
                    label: 'До ТО',
                    children:
                      v.nextMaintenanceDueKm === null || v.currentMileageKm === null
                        ? 'Неизвестно'
                        : v.nextMaintenanceDueKm - v.currentMileageKm + ' км',
                  },
                  {
                    key: 'issues',
                    label: 'Пометка',
                    children: <span className="preserve-lines">{v.note || '—'}</span>,
                  },
                ]}
              />
            ),
          },
          { key: 'rentals', label: 'Аренды', disabled: true },
          {
            key: 'maintenance',
            label: 'Обслуживание',
            children: <ServiceRecords vehicle={v} reload={poll.reload} />,
          },
          {
            key: 'history',
            label: 'История изменений',
            children: <History path={'/vehicles/' + v.id + '/history'} />,
          },
        ]}
      />
      {action?.kind === 'edit' ? (
        <VehicleEditor
          vehicle={action.snapshot}
          current={v}
          onClose={() => setAction(null)}
          onDone={done}
        />
      ) : (
        action && (
          <Archive
            vehicle={action.snapshot}
            current={v}
            onClose={() => setAction(null)}
            onDone={done}
          />
        )
      )}
    </section>
  );
}
