import { useEffect, useRef, useState } from 'react';
import { AutoComplete, Button, Form, Input, InputNumber, Space, Switch, Table } from 'antd';
import { CommandModal, PollNotice, usePolling, type Vehicle } from '../catalog';
const procedures = [
  'ТО',
  'Замена ремня ГРМ',
  'Замена масла АКПП',
  'Замена масла КПП',
  'Замена масла редуктора',
  'Развал-схождение',
  'Регулировка клапанов',
];
type RecordItem = {
  id: number;
  performedOn: string;
  procedure: string;
  mileageKm: number | null;
  note: string;
  author: string;
};
type ServiceFormValues = Pick<RecordItem, 'performedOn' | 'procedure' | 'mileageKm' | 'note'> & {
  expectedVersion?: number;
  updateMileage?: boolean;
  nextMaintenanceDueKm?: number | null;
};
function ServiceEditor({
  snapshot,
  current,
  record,
  latestRecord,
  onClose,
  onDone,
}: {
  snapshot: Vehicle;
  current: Vehicle;
  record?: RecordItem;
  latestRecord?: RecordItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form] = Form.useForm<ServiceFormValues>();
  const update: boolean | undefined = Form.useWatch('updateMileage', form);
  const procedure: string | undefined = Form.useWatch('procedure', form);
  const isMaintenance =
    String(procedure ?? '')
      .trim()
      .toUpperCase() === 'ТО';
  const mileage: number | null | undefined = Form.useWatch('mileageKm', form);
  const manualThreshold = useRef(false);
  useEffect(() => {
    if (!record && isMaintenance && !manualThreshold.current)
      form.setFieldValue(
        'nextMaintenanceDueKm',
        (mileage ?? snapshot.currentMileageKm) === null
          ? undefined
          : (mileage ?? snapshot.currentMileageKm)! + 10000,
      );
  }, [record, isMaintenance, mileage, snapshot.currentMileageKm, form]);
  return (
    <CommandModal
      title={record ? 'Редактирование процедуры' : 'Выполненная процедура'}
      path={'/vehicles/' + snapshot.id + '/service-records' + (record ? '/' + record.id : '')}
      command={record ? 'vehicles.service.update' : 'vehicles.service'}
      method={record ? 'PATCH' : 'POST'}
      form={form}
      version={snapshot.version}
      currentVersion={current.version}
      initial={
        record
          ? { ...record }
          : {
              performedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }),
              updateMileage: false,
              nextMaintenanceDueKm:
                snapshot.currentMileageKm === null ? undefined : snapshot.currentMileageKm + 10000,
            }
      }
      onClose={onClose}
      onDone={onDone}
      onValuesChange={(changed) => {
        if ('nextMaintenanceDueKm' in changed) manualThreshold.current = true;
      }}
      currentValues={
        record ? (
          <p>
            {latestRecord
              ? `${latestRecord.performedOn} · ${latestRecord.procedure} · ${latestRecord.mileageKm ?? '—'} км · ${latestRecord.note}`
              : 'Перечитайте журнал перед подтверждением изменений.'}
          </p>
        ) : (
          <p>
            Текущий пробег: {current.currentMileageKm} км. Порог ТО: {current.nextMaintenanceDueKm}{' '}
            км.
          </p>
        )
      }
      prepare={({
        expectedVersion,
        performedOn,
        procedure,
        mileageKm = null,
        note = '',
        updateMileage = false,
        nextMaintenanceDueKm,
      }) =>
        record
          ? { expectedVersion, performedOn, procedure, mileageKm, note }
          : {
              expectedVersion,
              performedOn,
              procedure,
              mileageKm,
              note,
              updateMileage,
              ...(String(procedure ?? '')
                .trim()
                .toUpperCase() === 'ТО' &&
              nextMaintenanceDueKm !== undefined &&
              nextMaintenanceDueKm !== null
                ? { nextMaintenanceDueKm }
                : {}),
            }
      }
    >
      <div className="form-grid">
        <Form.Item
          name="performedOn"
          label="Дата выполнения"
          rules={[{ required: true, message: 'Укажите дату.' }]}
        >
          <Input
            type="date"
            max={new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' })}
          />
        </Form.Item>
        <Form.Item
          name="procedure"
          label="Процедура"
          rules={[{ required: true, whitespace: true, message: 'Укажите процедуру.' }]}
        >
          <AutoComplete options={procedures.map((value) => ({ value }))} />
        </Form.Item>
        <Form.Item
          name="mileageKm"
          label="Пробег при выполнении, км"
          rules={[{ required: update, message: 'Укажите пробег для обновления карточки.' }]}
        >
          <InputNumber min={0} max={10000000} precision={0} />
        </Form.Item>
        {!record && (
          <>
            <Form.Item
              name="updateMileage"
              label="Обновить текущий пробег автомобиля"
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            {isMaintenance && (
              <Form.Item name="nextMaintenanceDueKm" preserve label="Новый порог следующего ТО, км">
                <InputNumber min={0} max={10000000} precision={0} />
              </Form.Item>
            )}
          </>
        )}
      </div>
      <Form.Item name="note" label="Пометка">
        <Input.TextArea rows={3} maxLength={4000} />
      </Form.Item>
    </CommandModal>
  );
}
export default function ServiceRecords({
  vehicle,
  reload,
}: {
  vehicle: Vehicle;
  reload: () => Promise<void>;
}) {
  const [page, setPage] = useState(1),
    [snapshot, setSnapshot] = useState<Vehicle | null>(null);
  const [editing, setEditing] = useState<RecordItem>();
  const poll = usePolling<{ items: RecordItem[]; total: number }>(
    '/vehicles/' + vehicle.id + '/service-records?page=' + page,
  );
  return (
    <>
      <Space>
        {!vehicle.archivedAt && (
          <Button
            type="primary"
            onClick={() => {
              setEditing(undefined);
              setSnapshot(vehicle);
            }}
          >
            Добавить процедуру
          </Button>
        )}
      </Space>
      <PollNotice {...poll} />
      <Table<RecordItem>
        rowKey="id"
        dataSource={poll.data?.items}
        loading={poll.loading}
        scroll={{ x: 650 }}
        pagination={{
          current: page,
          total: poll.data?.total,
          pageSize: 20,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          {
            title: 'Дата',
            dataIndex: 'performedOn',
            render: (v) => v.split('-').reverse().join('.'),
          },
          { title: 'Процедура', dataIndex: 'procedure' },
          {
            title: 'Пробег, км',
            dataIndex: 'mileageKm',
            render: (v) => (v === null ? '—' : v.toLocaleString('ru-RU')),
          },
          {
            title: 'Пометка',
            dataIndex: 'note',
            render: (v) => <span className="preserve-lines">{v || '—'}</span>,
          },
          { title: 'Добавил', dataIndex: 'author' },
          {
            title: 'Действие',
            key: 'edit',
            render: (_, r) =>
              !vehicle.archivedAt && (
                <Button
                  onClick={() => {
                    setEditing(r);
                    setSnapshot(vehicle);
                  }}
                >
                  Редактировать
                </Button>
              ),
          },
        ]}
      />
      {snapshot && (
        <ServiceEditor
          snapshot={snapshot}
          current={vehicle}
          record={editing}
          latestRecord={poll.data?.items.find((r) => r.id === editing?.id)}
          onClose={() => setSnapshot(null)}
          onDone={() => {
            setSnapshot(null);
            void reload();
            void poll.reload();
          }}
        />
      )}
    </>
  );
}
