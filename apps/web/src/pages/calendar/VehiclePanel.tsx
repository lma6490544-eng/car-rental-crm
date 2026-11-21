import type { TechnicalPreview, TechnicalBlock } from '../../contracts';
import type { Vehicle } from '../../catalog';
import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Space } from 'antd';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../../api';
import { dateText, PollNotice, usePolling } from '../../catalog';
import { ConflictList } from '../../features/booking/Conflicts';
import Action from './CalendarAction';
import { DAY, iso, local } from './dates';
export default function VehiclePanel({ id, onDone }: { id: number; onDone: () => void }) {
  const p = usePolling<Vehicle>('/vehicles/' + id),
    blocks = usePolling<{ items: TechnicalBlock[] }>('/vehicles/' + id + '/schedule');
  const [start, setStart] = useState(local(new Date().toISOString())),
    [end, setEnd] = useState(local(new Date(Date.now() + DAY).toISOString())),
    [reason, setReason] = useState('');
  const [editing, setEditing] = useState<{ id: number; version: number } | null>(null),
    [preview, setPreview] = useState<TechnicalPreview & { key: string }>(),
    [error, setError] = useState(''),
    [checking, setChecking] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [refresh, setRefresh] = useState(0);
  let input: { vehicleId: number; startAt: string; endAt: string; blockId?: number } | undefined;
  try {
    if (start && end && iso(end) > iso(start))
      input = {
        vehicleId: id,
        startAt: iso(start),
        endAt: iso(end),
        ...(editing ? { blockId: editing.id } : {}),
      };
  } catch {}
  const key = input ? JSON.stringify(input) : '';
  useEffect(() => {
    let alive = true;
    setPreview(undefined);
    setConfirmed(false);
    setError('');
    if (!key) {
      setChecking(false);
      return;
    }
    setChecking(true);
    const timer = setTimeout(() => {
      void api<TechnicalPreview>('/schedule-blocks/preview', {
        method: 'POST',
        body: JSON.parse(key),
      })
        .then((v) => {
          if (alive) setPreview({ ...v, key });
        })
        .catch((e) => {
          if (alive) setError(errorMessage(e));
        })
        .finally(() => {
          if (alive) setChecking(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, refresh]);
  const current = preview?.key === key ? preview : undefined,
    technical = current?.conflicts.filter((v) => v.kind === 'technical') ?? [],
    affected = current?.conflicts.filter((v) => v.booking_id) ?? [];
  const editBlock = (block: TechnicalBlock) => {
    setEditing({ id: block.id, version: block.version });
    setStart(local(block.start_at));
    setEnd(local(block.end_at));
    setReason(block.reason);
  };
  const done = () => {
    setEditing(null);
    setConfirmed(false);
    void blocks.reload();
    onDone();
    setPreview(undefined);
    setRefresh((v) => v + 1);
  };
  return (
    <>
      <PollNotice {...p} />
      <Link to={'/fleet/' + id}>Полная карточка автомобиля</Link>
      <p>
        {p.data?.plate} · {p.data?.modelName}
      </p>
      <p>{p.data?.isReady ? 'Готов к выдаче' : p.data?.readinessReason}</p>
      <h3>{editing ? 'Изменить техническую блокировку' : 'Техническая блокировка'}</h3>
      {editing && <Button onClick={() => setEditing(null)}>Новая блокировка</Button>}
      <Form layout="vertical">
        <Form.Item label="Начало (Москва)" required>
          <Input
            aria-label="Начало (Москва)"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Окончание (Москва)" required>
          <Input
            aria-label="Окончание (Москва)"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Причина блокировки" required>
          <Input
            aria-label="Причина блокировки"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
          />
        </Form.Item>
      </Form>
      {checking && <p role="status">Проверяем пересечения…</p>}
      {error && <Alert type="error" message={error} />}
      {!!technical.length && (
        <Alert
          type="warning"
          message="Период пересекается с технической блокировкой. Измените существующую вместо создания дубля."
        />
      )}
      <ConflictList items={current?.conflicts} />
      {technical.map((t) => (
        <Button key={t.id} onClick={() => editBlock(t)}>
          Изменить блокировку №{t.id}
        </Button>
      ))}
      {!!affected.length && !technical.length && (
        <>
          <Alert
            type="warning"
            message={'Будут сняты назначения: ' + affected.length}
            description="Брони, клиенты и согласованные цены сохранятся. После блокировки система заново проверит доступность замен."
          />
          <Space wrap>
            {affected.map((b) => (
              <Link
                key={b.id}
                target="_blank"
                rel="noopener"
                to={'/calendar?booking=' + b.booking_id + '&action=assign'}
              >
                Подобрать замену для брони №{b.booking_id}
              </Link>
            ))}
          </Space>
          <p>
            <Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
              Подтверждаю снятие назначений со всех указанных броней
            </Checkbox>
          </p>
        </>
      )}
      <Action
        path={editing ? '/schedule-blocks/' + editing.id : '/schedule-blocks'}
        command={editing ? 'schedule.update' : 'schedule.create'}
        label={
          affected.length
            ? 'Создать блокировку и снять назначения'
            : editing
              ? 'Сохранить блокировку'
              : 'Создать блокировку'
        }
        disabled={
          !current ||
          checking ||
          !reason.trim() ||
          technical.length > 0 ||
          (affected.length > 0 && !confirmed)
        }
        revision={JSON.stringify({ key, reason, confirmed, token: current?.token })}
        body={() => ({
          vehicleId: id,
          startAt: iso(start),
          endAt: iso(end),
          reason,
          ...(editing ? { expectedVersion: editing.version } : {}),
          ...(affected.length
            ? {
                conflictsToken: current!.token,
                displaceBookings: affected.map((v) => ({
                  id: v.booking_id,
                  expectedVersion: v.booking_version,
                })),
              }
            : {}),
        })}
        onDone={done}
      />
      <h3>Плановые блокировки</h3>
      <PollNotice {...blocks} />
      {blocks.data?.items.map((block) => (
        <section key={block.id}>
          <p>
            {dateText(block.start_at)} — {dateText(block.end_at)} · {block.reason}
          </p>
          <Button onClick={() => editBlock(block)}>Изменить период блокировки №{block.id}</Button>
          <Action
            path={'/schedule-blocks/' + block.id + '/cancel'}
            command="schedule.cancel"
            body={() => ({ expectedVersion: block.version, reason })}
            label="Снять техническую блокировку"
            disabled={!reason.trim()}
            onDone={done}
          />
        </section>
      ))}
    </>
  );
}
