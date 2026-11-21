import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Form, Modal, Space } from 'antd';
import type { FormInstance } from 'antd';
import { api, ApiError, errorMessage } from '../api';
type Pending = { key: string; body: unknown };
// The modal is mounted per command. Its snapshot never changes when polling updates the parent.
export function CommandModal<Values extends object = Record<string, unknown>, Result = unknown>({
  title,
  path,
  command,
  method = 'POST',
  initial,
  version,
  currentVersion,
  currentValues,
  children,
  onClose,
  onDone,
  prepare,
  form,
  onValuesChange,
  submitDisabled = false,
}: {
  title: string;
  path: string;
  command: string;
  method?: string;
  initial: Record<string, unknown>;
  version?: number;
  currentVersion?: number;
  children: ReactNode;
  currentValues?: ReactNode;
  onClose: () => void;
  onDone: (result: Result) => void;
  prepare?: (values: Values) => unknown;
  form: FormInstance<Values>;
  onValuesChange?: (changed: Partial<Values>, values: Values) => void;
  submitDisabled?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const [expected, setExpected] = useState(version);
  const pending = useRef<Pending | null>(null);
  const active = useRef(false);
  const conflict =
    expected !== undefined && currentVersion !== undefined && currentVersion !== expected;
  const done = (result: Result) => {
    pending.current = null;
    onDone(result);
  };
  const send = async (values: unknown) => {
    if (active.current || !navigator.onLine || (submitDisabled && !pending.current)) return;
    active.current = true;
    setBusy(true);
    setError('');
    // Values originate in the supplied Ant Design form. Retries reuse the prepared body.
    pending.current ??= {
      key: crypto.randomUUID(),
      body: prepare ? prepare(values as Values) : values,
    };
    try {
      done(
        await api<Result>(path, { method, key: pending.current.key, body: pending.current.body }),
      );
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) setUncertain(true);
      else {
        pending.current = null;
        setUncertain(false);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const check = async () => {
    if (!pending.current || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      const value = await api<{ result: Result }>(
        '/operations/by-key?command=' + command + '&key=' + pending.current.key,
      );
      done(value.result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={title}
      footer={null}
      width={760}
      onCancel={onClose}
      closable={!busy && !uncertain}
      maskClosable={false}
      keyboard={!busy && !uncertain}
    >
      {error && <Alert role="alert" type="error" message={error} className="notice" />}
      {conflict && !uncertain && (
        <Alert
          type="warning"
          className="notice"
          message="Запись изменена другим сотрудником. Ваш ввод сохранён."
          description={
            <>
              <p>
                Сравните актуальные данные с вашим вводом ниже. Подтверждение позволит сохранить ваш
                ввод поверх новой версии.
              </p>
              {currentValues}
            </>
          }
          action={
            <Button
              onClick={() => {
                setExpected(currentVersion);
                // Command metadata is added by this modal, independently of the form fields.
                form.setFieldValue(
                  'expectedVersion' as Parameters<typeof form.setFieldValue>[0],
                  currentVersion,
                );
              }}
            >
              Сохранить мой ввод поверх новой версии
            </Button>
          }
        />
      )}
      {uncertain && (
        <Alert
          className="notice"
          type="warning"
          message="Результат пока неизвестен"
          description="Проверьте результат или повторите отправку. Сохранены исходные данные и ключ команды."
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ ...initial, expectedVersion: version }}
        onValuesChange={onValuesChange}
        onFinish={(v) => void send(v)}
        disabled={busy || uncertain}
        preserve={false}
      >
        <Form.Item name="expectedVersion" hidden>
          <input />
        </Form.Item>
        {children}
        {!uncertain && (
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={conflict || submitDisabled || !navigator.onLine}
            >
              Сохранить
            </Button>
            <Button onClick={onClose}>Отмена</Button>
          </Space>
        )}
      </Form>
      {uncertain && (
        <Space wrap>
          <Button loading={busy} onClick={() => void check()}>
            Проверить результат
          </Button>
          <Button loading={busy} onClick={() => void send(pending.current!.body)}>
            Повторить отправку
          </Button>
        </Space>
      )}
    </Modal>
  );
}
