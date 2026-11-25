import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { api, ApiError, errorMessage, type User } from '../api';
import { PageTitle } from '../shared/PageTitle';
type NewUser = { fullName: string; login: string; password: string };
type Pending = { key: string; body: NewUser };
export default function Users() {
  const { message } = App.useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [changing, setChanging] = useState<number | null>(null);
  const [statusUncertain, setStatusUncertain] = useState(false);
  const [form] = Form.useForm<NewUser>();
  const pending = useRef<Pending | null>(null);
  const statusPending = useRef<{
    user: User;
    key: string;
    body: { isActive: boolean; expectedVersion: number };
  } | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers((await api<{ items: User[] }>('/admin/users')).items);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const created = async () => {
    pending.current = null;
    setUncertain(false);
    setOpen(false);
    form.resetFields();
    setFormError(null);
    void message.success('Сотрудник создан.');
    await load();
  };
  const create = async (input: NewUser) => {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    pending.current ??= {
      key: crypto.randomUUID(),
      body: { ...input, fullName: input.fullName.trim(), login: input.login.trim().toLowerCase() },
    };
    try {
      await api('/admin/users', {
        method: 'POST',
        body: pending.current.body,
        key: pending.current.key,
      });
      await created();
    } catch (error) {
      setFormError(errorMessage(error));
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500))
        setUncertain(true);
      else {
        pending.current = null;
        setUncertain(false);
      }
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    if (!pending.current) return;
    setBusy(true);
    try {
      await api('/operations/by-key?command=users.create&key=' + pending.current.key);
      await created();
    } catch (error) {
      setFormError(
        error instanceof ApiError && error.status === 404
          ? 'Результат пока не найден. Можно повторить отправку: ключ операции сохранён.'
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  };
  const changeStatus = async (user: User) => {
    if (changing) return;
    const active = statusPending.current;
    if (active && active.user.id !== user.id) return;
    statusPending.current ??= {
      user,
      key: crypto.randomUUID(),
      body: { isActive: !user.isActive, expectedVersion: user.version },
    };
    const command = statusPending.current;
    setChanging(user.id);
    setError(null);
    try {
      await api('/admin/users/' + user.id + '/status', {
        method: 'PATCH',
        key: command.key,
        body: command.body,
      });
      statusPending.current = null;
      setStatusUncertain(false);
      await load();
      void message.success(
        command.body.isActive
          ? 'Доступ восстановлен.'
          : 'Сотрудник заблокирован, сессии завершены.',
      );
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && (error.status === 0 || error.status >= 500))
        setStatusUncertain(true);
      else {
        statusPending.current = null;
        setStatusUncertain(false);
        if (error instanceof ApiError && error.status === 409) {
          await load();
          setError(errorMessage(error));
        }
      }
    } finally {
      setChanging(null);
    }
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <PageTitle>
            <Typography.Title level={2}>Сотрудники</Typography.Title>
          </PageTitle>
          <Typography.Text type="secondary">Учётные записи и доступ к системе</Typography.Text>
        </div>
        <Button
          type="primary"
          onClick={() => {
            setOpen(true);
            setFormError(null);
          }}
        >
          Добавить сотрудника
        </Button>
      </div>
      {error && <Alert role="alert" type="error" showIcon message={error} className="notice" />}
      {statusUncertain && (
        <Alert
          type="warning"
          className="notice"
          showIcon
          message="Результат изменения доступа пока неизвестен."
          description="Повторите действие с сохранённым ключом. Новое изменение не будет создано."
          action={
            <Button
              loading={!!changing}
              onClick={() => void changeStatus(statusPending.current!.user)}
            >
              Повторить
            </Button>
          }
        />
      )}
      <div className="table-toolbar">
        <Button aria-label="Обновить список" onClick={() => void load()} loading={loading}>
          Обновить список
        </Button>
      </div>
      <Table<User>
        rowKey="id"
        dataSource={users}
        loading={loading}
        scroll={{ x: 650 }}
        pagination={{ pageSize: 10, hideOnSinglePage: true }}
        locale={{ emptyText: 'Сотрудники не найдены' }}
        columns={[
          { title: 'ФИО', dataIndex: 'fullName', key: 'name' },
          { title: 'Логин', dataIndex: 'login', key: 'login' },
          {
            title: 'Роль',
            dataIndex: 'role',
            render: (value) => (value === 'admin' ? 'Администратор' : 'Менеджер'),
          },
          {
            title: 'Статус',
            dataIndex: 'isActive',
            render: (value) => (
              <Tag color={value ? 'green' : 'default'}>{value ? 'Активен' : 'Заблокирован'}</Tag>
            ),
          },
          {
            title: 'Действие',
            key: 'action',
            render: (_, user) =>
              user.role === 'admin' ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <Popconfirm
                  title={user.isActive ? 'Заблокировать сотрудника?' : 'Восстановить доступ?'}
                  description={user.isActive ? 'Все его сессии будут завершены.' : undefined}
                  okText="Подтвердить"
                  cancelText="Отмена"
                  onConfirm={() => changeStatus(user)}
                >
                  <Button
                    danger={user.isActive}
                    loading={changing === user.id}
                    disabled={statusUncertain || !!changing}
                  >
                    {user.isActive ? 'Заблокировать' : 'Активировать'}
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <Modal
        title="Новый сотрудник"
        open={open}
        onCancel={() => {
          if (!busy && !uncertain) {
            setOpen(false);
            form.resetFields();
            pending.current = null;
          }
        }}
        footer={null}
        closable={!busy && !uncertain}
        maskClosable={!busy && !uncertain}
        keyboard={!busy && !uncertain}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Новая учётная запись получает роль менеджера.
        </Typography.Paragraph>
        {formError && (
          <Alert role="alert" type="error" showIcon message={formError} className="notice" />
        )}
        {uncertain && (
          <Alert
            type="warning"
            className="notice"
            message="Сервер мог сохранить сотрудника."
            description="Проверьте результат или повторите отправку с теми же данными. Форма сохранена в этой вкладке."
          />
        )}
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={create}
          disabled={busy || uncertain}
          preserve={false}
        >
          <Form.Item
            name="fullName"
            label="ФИО"
            rules={[{ required: true, whitespace: true, message: 'Укажите ФИО.' }, { max: 120 }]}
          >
            <Input autoComplete="off" maxLength={120} />
          </Form.Item>
          <Form.Item
            name="login"
            label="Логин"
            rules={[
              { required: true, message: 'Укажите логин.' },
              {
                pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/,
                message: '3–64 латинских символа, цифры, точка, дефис или подчёркивание.',
              },
            ]}
          >
            <Input autoComplete="off" maxLength={64} />
          </Form.Item>
          <Form.Item
            name="password"
            label="Пароль"
            rules={[
              { required: true, message: 'Укажите пароль.' },
              { min: 8, message: 'Не менее 8 символов.' },
              { max: 128 },
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          {!uncertain && (
            <Button type="primary" htmlType="submit" loading={busy}>
              Создать сотрудника
            </Button>
          )}
        </Form>
        {uncertain && (
          <Space wrap>
            <Button loading={busy} onClick={() => void check()}>
              Проверить результат
            </Button>
            <Button
              type="primary"
              loading={busy}
              onClick={() => void create(pending.current!.body)}
            >
              Повторить отправку
            </Button>
          </Space>
        )}
      </Modal>
    </section>
  );
}
