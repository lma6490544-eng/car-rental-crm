import { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { History, PollNotice, useListScroll, usePolling } from '../../catalog';
import type { Customer } from '../../catalog';
import { ClientFinance } from '../finance/ClientFinance';
import { CustomerEditor } from './CustomerEditor';
import type { ClientActionKind } from './ClientNotes';
import { ClientAction, Notes } from './ClientNotes';
import { companyLabels, identityLabels } from './customer-fields';
export { companyLabels, identityLabels } from './customer-fields';

function ClientData({ client }: { client: Customer }) {
  const labels = client.type === 'individual' ? identityLabels : companyLabels;
  const fieldLabels: Record<string, string> = { ...identityLabels, ...companyLabels, inn: 'ИНН' };
  const missingFields = client.documentReadiness.missing
    .map((key) => fieldLabels[key] ?? key)
    .join(', ');
  const items = [
    { key: 'phone', label: 'Телефон', children: client.phone || '—' },
    { key: 'email', label: 'Email', children: client.email || '—' },
    ...(client.type === 'company'
      ? [{ key: 'inn', label: 'ИНН', children: client.inn || '—' }]
      : []),
    ...Object.entries(labels).map(([key, label]) => ({
      key,
      label,
      children: client.details[key] || '—',
    })),
  ];
  return (
    <>
      <Descriptions bordered column={{ xs: 1, sm: 2 }} items={items} />
      <Alert
        className="notice"
        type={client.documentReadiness.ready ? 'success' : 'info'}
        message={
          client.documentReadiness.ready
            ? 'Основные реквизиты заполнены'
            : 'Анкета заполнена не полностью'
        }
        description={
          client.documentReadiness.ready
            ? 'Проверка документов и условий выдачи появится на соответствующем этапе.'
            : 'Не заполнено: ' + missingFields
        }
      />
    </>
  );
}
export default function Clients() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [creating, setCreating] = useState(false);
  const query = params.toString();
  const poll = usePolling<{ items: Customer[]; total: number }>('/customers?' + query);
  useListScroll('/clients?' + query, !!poll.data);
  const changeFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set('page', '1');
    setParams(next, { replace: true });
  };
  const changePage = (page: number) => {
    const next = new URLSearchParams(params);
    next.set('page', String(page));
    setParams(next);
  };
  const openCreatedClient = (result: Pick<Customer, 'id'>) =>
    navigate('/clients/' + result.id, { state: { back: location.pathname + location.search } });
  return (
    <section>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Клиенты</Typography.Title>
          <Typography.Text type="secondary">Физические лица и организации</Typography.Text>
        </div>
        <Button type="primary" onClick={() => setCreating(true)}>
          Добавить клиента
        </Button>
      </div>
      <PollNotice {...poll} />
      <Space wrap className="catalog-toolbar">
        <Input.Search
          aria-label="Поиск клиентов"
          placeholder="Имя, телефон или ИНН"
          value={params.get('q') ?? ''}
          onChange={(event) => changeFilter('q', event.target.value)}
          allowClear
        />
        <Select
          aria-label="Тип клиента"
          value={params.get('type') ?? ''}
          onChange={(value: string) => changeFilter('type', value)}
          options={[
            { value: '', label: 'Все клиенты' },
            { value: 'individual', label: 'Физические лица' },
            { value: 'company', label: 'Организации' },
          ]}
        />
        <Select
          aria-label="Блокировка"
          value={params.get('blocked') ?? ''}
          onChange={(value: string) => changeFilter('blocked', value)}
          options={[
            { value: '', label: 'Все статусы' },
            { value: 'true', label: 'Заблокированы' },
            { value: 'false', label: 'Без блокировки' },
          ]}
        />
        <Button onClick={() => void poll.reload()}>Обновить</Button>
      </Space>
      <Table<Customer>
        rowKey="id"
        loading={poll.loading}
        dataSource={poll.data?.items}
        scroll={{ x: 650 }}
        pagination={{
          current: Number(params.get('page') ?? 1),
          pageSize: 20,
          total: poll.data?.total,
          showSizeChanger: false,
          onChange: changePage,
        }}
        columns={[
          {
            title: 'Клиент',
            dataIndex: 'displayName',
            render: (_, client) => (
              <Link
                to={'/clients/' + client.id}
                state={{ back: location.pathname + location.search }}
              >
                {client.displayName}
              </Link>
            ),
          },
          {
            title: 'Тип',
            dataIndex: 'type',
            render: (type: Customer['type']) => (type === 'company' ? 'Организация' : 'Физлицо'),
          },
          { title: 'Телефон', dataIndex: 'phone' },
          { title: 'ИНН', dataIndex: 'inn' },
          {
            title: 'Статус',
            render: (_, client) => (client.isBlocked ? <Tag color="red">Заблокирован</Tag> : '—'),
          },
        ]}
      />
      {creating && <CustomerEditor onClose={() => setCreating(false)} onDone={openCreatedClient} />}
    </section>
  );
}
export function ClientDetail() {
  const { id } = useParams();
  const location = useLocation();
  const poll = usePolling<Customer>('/customers/' + id);
  const [action, setAction] = useState<{
    kind: ClientActionKind | 'edit';
    snapshot: Customer;
  } | null>(null);
  const client = poll.data;
  if (!client)
    return (
      <>
        <PollNotice {...poll} />
        {poll.loading ? 'Загрузка…' : null}
      </>
    );
  const closeAction = () => setAction(null);
  const completeAction = () => {
    closeAction();
    void poll.reload();
  };
  const openAction = (kind: ClientActionKind | 'edit') => setAction({ kind, snapshot: client });
  let actionModal = null;
  if (action?.kind === 'edit') {
    actionModal = (
      <CustomerEditor
        customer={action.snapshot}
        current={client}
        onClose={closeAction}
        onDone={completeAction}
      />
    );
  } else if (action) {
    actionModal = (
      <ClientAction
        kind={action.kind}
        client={action.snapshot}
        current={client}
        onClose={closeAction}
        onDone={completeAction}
      />
    );
  }
  return (
    <section>
      <Link to={location.state?.back ?? '/clients'}>← К списку клиентов</Link>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>{client.displayName}</Typography.Title>
          <Space>
            {client.isBlocked && <Tag color="red">Заблокирован</Tag>}
            <Tag>{client.type === 'company' ? 'Организация' : 'Физическое лицо'}</Tag>
          </Space>
        </div>
        <Space wrap>
          <Button onClick={() => openAction('edit')}>Редактировать</Button>
          <Button
            danger={!client.isBlocked}
            onClick={() => openAction(client.isBlocked ? 'unblock' : 'block')}
          >
            {client.isBlocked ? 'Разблокировать' : 'Заблокировать'}
          </Button>
        </Space>
      </div>
      <PollNotice {...poll} />
      {client.isBlocked && (
        <Alert type="warning" message={'Причина блокировки: ' + client.blockedReason} />
      )}
      <Tabs
        items={[
          { key: 'data', label: 'Данные', children: <ClientData client={client} /> },
          { key: 'rentals', label: 'Аренды', disabled: true },
          { key: 'deposits', label: 'Залоги', children: <ClientFinance customerId={client.id} /> },
          {
            key: 'notes',
            label: 'Заметки',
            children: <Notes key={client.version} client={client} onAction={openAction} />,
          },
          { key: 'documents', label: 'Документы', disabled: true },
          {
            key: 'history',
            label: 'История изменений',
            children: <History path={'/customers/' + client.id + '/history'} />,
          },
        ]}
      />
      <Typography.Paragraph type="secondary">
        Фактические аренды, штрафы и файлы подключаются на следующих этапах.
      </Typography.Paragraph>
      {actionModal}
    </section>
  );
}
