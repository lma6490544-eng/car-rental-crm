import { useEffect, useState } from 'react';
import { Alert, Button, Input, Space } from 'antd';
import { api, ApiError, createIdempotencyKey } from '../../api';

type Charge = { amountRub: string; reason: string };
type Attempt = { key: string; body: Charge & { expectedRevision: number } };
const emptyCharge: Charge = { amountRub: '', reason: '' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readAttempt(storageKey: string): Attempt | undefined {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return;
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && typeof value.key === 'string' && isRecord(value.body)) {
    const { amountRub, reason, expectedRevision } = value.body;
    if (
      typeof amountRub === 'string' &&
      typeof reason === 'string' &&
      typeof expectedRevision === 'number' &&
      Number.isSafeInteger(expectedRevision)
    ) {
      return { key: value.key, body: { amountRub, reason, expectedRevision } };
    }
  }
  throw new Error('Не удалось прочитать сохранённое начисление.');
}

export function DamageChargeForm({
  bookingId,
  userId,
  revision,
  disabled,
  hidden,
  onDirty,
  run,
  onSaved,
}: {
  bookingId: number;
  userId: number;
  revision: number;
  disabled: boolean;
  hidden: boolean;
  onDirty: (dirty: boolean) => void;
  run: (action: () => Promise<void>, area: 'settlement') => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const storageKey = `crm.rentalDamage.${userId}.${bookingId}`;
  const [draft, setDraft] = useState(emptyCharge);
  const [pending, setPending] = useState<Attempt>();
  const [storageError, setStorageError] = useState('');
  const values = pending?.body ?? draft;
  const dirty = !!(values.amountRub || values.reason);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => {
    function restore() {
      try {
        setPending(readAttempt(storageKey));
        setStorageError('');
      } catch {
        setStorageError('Не удалось открыть сохранённое начисление. Проверьте хранилище браузера.');
      }
    }
    function handleStorage(event: StorageEvent) {
      if (event.key === storageKey || event.key === null) restore();
    }
    restore();
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [storageKey]);

  async function execute(action: 'submit' | 'check' | 'retry') {
    const stored = readAttempt(storageKey);
    // Another tab may have started or resolved this charge since the last render.
    if (
      (action === 'submit' && stored) ||
      (action !== 'submit' && (!stored || stored.key !== pending?.key))
    ) {
      setPending(stored);
      return;
    }
    const attempt = stored ?? {
      key: createIdempotencyKey(),
      body: { ...draft, expectedRevision: revision },
    };
    if (!stored) {
      localStorage.setItem(storageKey, JSON.stringify(attempt));
      setPending(attempt);
      setDraft(emptyCharge);
    }
    try {
      if (action === 'check') {
        const query = new URLSearchParams({ command: 'rentalReturn.damage', key: attempt.key });
        await api('/operations/by-key?' + query);
      } else {
        await api('/bookings/' + bookingId + '/return/damage', {
          method: 'POST',
          body: attempt.body,
          key: attempt.key,
        });
      }
    } catch (failure) {
      if (
        action !== 'check' &&
        failure instanceof ApiError &&
        (failure.status === 422 || failure.code === 'RETURN_CHANGED')
      ) {
        localStorage.removeItem(storageKey);
        setPending(undefined);
        setDraft({ amountRub: attempt.body.amountRub, reason: attempt.body.reason });
      }
      throw failure;
    }
    localStorage.removeItem(storageKey);
    setPending(undefined);
    setDraft(emptyCharge);
    await onSaved();
  }

  function handleAction(action: 'submit' | 'check' | 'retry') {
    void run(async () => {
      if (!navigator.locks) return execute(action);
      await navigator.locks.request(storageKey, { ifAvailable: true }, async (lock) => {
        if (!lock) throw new Error('Начисление уже обрабатывается в другой вкладке.');
        await execute(action);
      });
    }, 'settlement');
  }

  return (
    <details hidden={hidden} open={pending ? true : undefined}>
      <summary>Начислить ущерб</summary>
      <Space direction="vertical">
        {storageError && <Alert type="error" message={storageError} />}
        <label>
          Сумма ущерба, ₽
          <Input
            inputMode="numeric"
            disabled={disabled || !!pending}
            value={values.amountRub}
            onChange={(event) => setDraft({ ...draft, amountRub: event.target.value })}
          />
        </label>
        <label>
          Причина начисления
          <Input.TextArea
            maxLength={1000}
            disabled={disabled || !!pending}
            value={values.reason}
            onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
          />
        </label>
        {pending ? (
          <>
            <Alert
              type="info"
              message="Проверьте результат начисления или повторите отправку с сохранённым ключом."
            />
            <Space wrap>
              <Button disabled={disabled} onClick={() => handleAction('check')}>
                Проверить результат
              </Button>
              <Button disabled={disabled} onClick={() => handleAction('retry')}>
                Повторить отправку
              </Button>
            </Space>
          </>
        ) : (
          <Button
            disabled={
              disabled ||
              !!storageError ||
              !/^[1-9]\d{0,18}$/.test(draft.amountRub) ||
              !draft.reason.trim()
            }
            onClick={() => handleAction('submit')}
          >
            Провести начисление
          </Button>
        )}
      </Space>
    </details>
  );
}
