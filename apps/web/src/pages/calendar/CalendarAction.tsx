import type { Availability, CommandResult } from '../../contracts';
import { createContext, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import { Alert, Button, Input } from 'antd';
import { api, ApiError, errorMessage } from '../../api';
export const CommandLock = createContext({ locked: false, setLocked: (_value: boolean) => {} });
export default function Action({
  path,
  command,
  body,
  label,
  onDone,
  disabled = false,
  revision,
  riskLabel = 'Сохранить с предупреждением',
  onAvailabilityChanged,
}: {
  path: string;
  command: string;
  body: () => unknown;
  label: string;
  onDone: (result: CommandResult) => void;
  disabled?: boolean;
  revision?: string;
  riskLabel?: string;
  onAvailabilityChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<{
      key: string;
      body: object;
    }>(),
    [risk, setRisk] = useState<Availability>(),
    [reason, setReason] = useState('');
  const active = useRef(false);
  const resetRevisionState = useEffectEvent(() => {
    if (!active.current && !pending) {
      setRisk(undefined);
      setError('');
      setReason('');
    }
  });
  useEffect(() => {
    resetRevisionState();
  }, [revision]);
  const lock = useContext(CommandLock);
  const { setLocked } = lock;
  useEffect(() => {
    if (busy || pending) {
      setLocked(true);
      return () => setLocked(false);
    }
  }, [busy, pending, setLocked]);
  async function send(check = false) {
    if (active.current || !navigator.onLine) return;
    active.current = true;
    setBusy(true);
    setError('');
    let operation = pending;
    try {
      if (check) {
        const v = await api<{ result: CommandResult }>(
          '/operations/by-key?command=' + command + '&key=' + pending!.key,
        );
        setPending(undefined);
        onDone(v.result);
        return;
      }
      operation ??= {
        key: crypto.randomUUID(),
        body: {
          ...(body() as object),
          ...(risk ? { riskAcceptance: { token: risk.token, reason } } : {}),
        },
      };
      const value = await api<CommandResult>(path, {
        method: command === 'bookings.terms' || command === 'schedule.update' ? 'PATCH' : 'POST',
        key: operation.key,
        body: operation.body,
      });
      setPending(undefined);
      setRisk(undefined);
      onDone(value);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError) {
        if (
          e.code === 'RISK_ACCEPTANCE_REQUIRED' ||
          (onAvailabilityChanged &&
            [
              'VEHICLE_ASSIGNMENT_CONFLICT',
              'VEHICLE_NOT_READY',
              'MOVE_PREVIEW_STALE',
              'BOOKING_VERSION_CONFLICT',
              'AVAILABILITY_CHANGED',
            ].includes(e.code))
        ) {
          if (onAvailabilityChanged) {
            setRisk(undefined);
            setError('');
            onAvailabilityChanged();
          } else setRisk(e.details as Availability);
          setPending(undefined);
        } else if (e.status === 0 || e.status >= 500) setPending(operation);
        else if (!check) setPending(undefined);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="calendar-action">
      {error && <Alert type="error" message={error} />}{' '}
      {risk && (
        <Alert
          type="warning"
          message={
            risk.status === 'unknown'
              ? 'Доступность автомобилей пока не подтверждена'
              : 'Автомобилей не хватает — броней больше, чем доступных машин'
          }
          description={
            <>
              <p>
                Перед сохранением проверьте выбранный автомобиль и период. Нерешённые назначения
                останутся в разделе «Проблемные брони».
              </p>
              <Input
                aria-label="Комментарий к доступности"
                placeholder="Комментарий (необязательно)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
              />
            </>
          }
        />
      )}
      {pending ? (
        <>
          <Alert type="warning" message="Результат пока неизвестен. Исходная команда сохранена." />
          <Button
            disabled={busy || !navigator.onLine}
            loading={busy}
            onClick={() => void send(true)}
          >
            Проверить результат
          </Button>
          <Button disabled={busy || !navigator.onLine} loading={busy} onClick={() => void send()}>
            Повторить с тем же ключом
          </Button>
        </>
      ) : (
        <Button
          aria-label={risk ? riskLabel : label}
          type="primary"
          loading={busy}
          disabled={disabled || lock.locked || !navigator.onLine}
          onClick={() => void send()}
        >
          {risk ? riskLabel : label}
        </Button>
      )}
    </div>
  );
}
