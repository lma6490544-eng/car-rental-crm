import { useState } from 'react';
import { Pagination } from 'antd';
import { usePolling } from '../../shared/hooks';
import { PollNotice } from '../../shared/PollNotice';
import { dateText } from '../../shared/formatters';
import { bodyNames, transmissionNames } from '../../domain/catalogLabels';
const historyNames: Record<string, string> = {
  'bookings.displaced': 'Назначение снято из-за технической блокировки',
  'schedule.updated': 'Техническая блокировка изменена',
  'bookings.created': 'Бронь создана',
  'bookings.terms': 'Условия брони изменены',
  'bookings.assigned': 'Назначение автомобиля изменено',
  'bookings.cancelled': 'Бронь отменена',
  'vehicles.imported': 'Автомобиль импортирован',
  'customers.created': 'Клиент создан',
  'customers.updated': 'Реквизиты изменены',
  'customers.blocked': 'Клиент заблокирован',
  'customers.unblocked': 'Блокировка снята',
  'customers.note_added': 'Заметка добавлена',
  'customers.note_resolved': 'Заметка закрыта',
  'vehicles.created': 'Автомобиль добавлен',
  'vehicles.updated': 'Данные автомобиля изменены',
  'vehicles.archived': 'Автомобиль архивирован',
};
type HistoryValue = string | number | boolean | null | undefined;
type HistoryDetails = {
  reason?: string;
  availabilityStatus?: string;
  availabilityComment?: string;
  before: Record<string, HistoryValue>;
  after: Record<string, HistoryValue>;
  procedure?: string;
  performedOn?: string;
  mileageKm?: number | null;
  note?: string;
  mileageChange?: { before: number | null; after: number | null };
  maintenanceChange?: { before: number | null; after: number | null };
};

export function History({ path }: { path: string }) {
  const [page, setPage] = useState(1);
  const poll = usePolling<{
    terms?: {
      id: number;
      revision: number;
      priceRub: string;
      reason: string;
      createdAt: string;
      author: string;
    }[];
    total: number;
    items: {
      id: number;
      action: string;
      author: string;
      createdAt: string;
      details: HistoryDetails;
    }[];
  }>(path + '?page=' + page);
  const changes: Record<string, [string, string]> = {
    plate: ['plate', 'Госномер'],
    vin: ['vin', 'VIN'],
    year: ['year', 'Год'],
    bodyType: ['body_type', 'Кузов'],
    isReady: ['is_ready', 'Готов к выдаче'],
    readinessReason: ['readiness_reason', 'Причина неготовности'],
    needsWash: ['needs_wash', 'Требуется мойка'],
    issueNotes: ['issue_notes', 'Замечания'],
  };
  const display = (v: unknown) =>
    typeof v === 'boolean' ? (v ? 'Да' : 'Нет') : (bodyNames[String(v)] ?? String(v || '—'));
  changes.transmission = ['transmission', 'Коробка'];
  return (
    <>
      <PollNotice {...poll} />
      {poll.data?.terms && (
        <section aria-label="История стоимости брони">
          <h4>Стоимость по редакциям условий</h4>
          {poll.data.terms.map((t) => (
            <p key={t.id}>
              Редакция {t.revision}: <strong>{BigInt(t.priceRub).toLocaleString('ru-RU')} ₽</strong>{' '}
              · {dateText(t.createdAt)} · {t.author}
              <br />
              {t.reason}
            </p>
          ))}
        </section>
      )}
      <div className="history-list">
        {poll.data?.items.map((h) => (
          <article key={h.id}>
            <strong>
              {h.action === 'vehicles.service_updated'
                ? 'Процедура изменена'
                : h.action === 'vehicles.serviced'
                  ? 'Процедура выполнена'
                  : (historyNames[h.action] ?? h.action)}
            </strong>
            <div>
              {dateText(h.createdAt)} · {h.author ?? 'Тестовое заполнение'}
            </div>
            {h.details.reason && <p>{h.details.reason}</p>}
            {h.details.availabilityStatus && (
              <p>
                {h.details.availabilityStatus === 'unknown'
                  ? 'Сохранено с предупреждением: доступность автомобилей не подтверждена.'
                  : 'Сохранено с предупреждением: на выбранный период автомобилей не хватает.'}
              </p>
            )}
            {h.details.availabilityComment &&
              h.details.availabilityComment !==
                'Сохранение брони с предупреждением о доступности' && (
                <p>Комментарий: {h.details.availabilityComment}</p>
              )}
            {h.action === 'vehicles.updated' && h.details.before && (
              <>
                {h.details.before.current_mileage_km !== h.details.after.currentMileageKm && (
                  <p>
                    Пробег: {h.details.before.current_mileage_km} →{' '}
                    {h.details.after.currentMileageKm} км.
                  </p>
                )}
                {h.details.before.next_maintenance_due_km !==
                  h.details.after.nextMaintenanceDueKm && (
                  <p>
                    Порог ТО: {h.details.before.next_maintenance_due_km} →{' '}
                    {h.details.after.nextMaintenanceDueKm} км.
                  </p>
                )}
              </>
            )}
            {h.action === 'vehicles.service_updated' &&
              Object.entries({
                performedOn: 'Дата выполнения',
                procedure: 'Процедура',
                mileageKm: 'Пробег при выполнении',
                note: 'Пометка',
              })
                .filter(([key]) => h.details.before[key] !== h.details.after[key])
                .map(([key, label]) => (
                  <p key={key}>
                    {label}: {h.details.before[key] ?? '—'} → {h.details.after[key] ?? '—'}
                  </p>
                ))}
            {h.action === 'vehicles.serviced' && (
              <>
                <p>
                  Выполнено: {h.details.procedure} · {h.details.performedOn} ·{' '}
                  {h.details.mileageKm ?? 'Пробег не указан'}
                </p>
                <p>{h.details.note}</p>
                {h.details.mileageChange && (
                  <p>
                    Пробег: {h.details.mileageChange.before} → {h.details.mileageChange.after} км.
                  </p>
                )}
                {h.details.maintenanceChange && (
                  <p>
                    Порог ТО: {h.details.maintenanceChange.before} →{' '}
                    {h.details.maintenanceChange.after} км.
                  </p>
                )}
              </>
            )}
            {h.action === 'vehicles.updated' && (
              <div>
                {Object.entries(changes)
                  .filter(
                    ([key, [old]]) =>
                      (h.details.before[old] ?? '') !== (h.details.after[key] ?? ''),
                  )
                  .map(([key, [old, label]]) => (
                    <p key={key}>
                      {label}:{' '}
                      {transmissionNames[String(h.details.before[old])] ??
                        display(h.details.before[old])}{' '}
                      →{' '}
                      {transmissionNames[String(h.details.after[key])] ??
                        display(h.details.after[key])}
                    </p>
                  ))}
                {h.details.before.model_id !== h.details.after.modelId && (
                  <p>Изменена модель автомобиля.</p>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      <Pagination
        current={page}
        pageSize={50}
        total={poll.data?.total ?? 0}
        onChange={setPage}
        showSizeChanger={false}
        hideOnSinglePage
      />
    </>
  );
}
