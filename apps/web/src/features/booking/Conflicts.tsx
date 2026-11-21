import type { ScheduleEvent, CalendarBooking } from '../../contracts';
import { Alert, Button, Space, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { dateText } from '../../catalog';
import { moscowDate as calendarDate } from '../../shared/moscowTime';
export function ConflictList({ items = [] }: { items?: ScheduleEvent[] }) {
  return (
    <div className="calendar-conflict-list">
      {items.map((c) => (
        <article key={c.id}>
          <strong>
            {c.booking_id
              ? 'Бронь №' + c.booking_id + ' · ' + c.customer_name
              : 'Техническая блокировка: ' + c.reason}
          </strong>
          <p>
            {dateText(c.start_at)} — {dateText(c.end_at)}
          </p>
          {c.overlap_start && (
            <p>
              Пересечение: {dateText(c.overlap_start)} — {dateText(c.overlap_end!)}
            </p>
          )}
          <Link
            target="_blank"
            rel="noopener"
            to={
              '/calendar?date=' +
              calendarDate(c.start_at) +
              (c.booking_id ? '&booking=' + c.booking_id : '&vehicle=' + c.vehicle_id)
            }
          >
            Открыть {c.booking_id ? 'бронь' : 'блокировку'} в новой вкладке
          </Link>
        </article>
      ))}
    </div>
  );
}
export function ProblemCard({
  booking: b,
  onOpen,
}: {
  booking: CalendarBooking;
  onOpen: (action?: 'assign' | 'edit') => void;
}) {
  const hasProblem = !!b.problemReasons?.length;
  return (
    <article className="calendar-problem-card">
      <Space wrap>
        <strong>
          Бронь №{b.id} · {b.customer_name}
        </strong>
        <Tag color={hasProblem ? 'red' : 'blue'}>
          {b.replacementReason
            ? 'Требуется замена'
            : b.availability?.status === 'unknown'
              ? 'Проверка не завершена'
              : hasProblem
                ? 'Требует решения'
                : 'Не назначен'}
        </Tag>
      </Space>
      <p>
        {dateText(b.start_at)} — {dateText(b.end_at)}
      </p>
      <p>{b.vehicle?.label ?? b.targetLabel}</p>
      <Alert
        type={hasProblem ? 'warning' : 'info'}
        message={
          (b.problemReasons ?? []).join('. ') ||
          'Автомобиль не назначен. Выберите подходящую машину.'
        }
        description={b.replacementReason}
      />
      <ConflictList items={b.conflicts} />
      <Space wrap>
        <Button type="primary" onClick={() => onOpen('assign')}>
          Подобрать автомобиль
        </Button>
        <Button onClick={() => onOpen('edit')}>Изменить условия</Button>
        <Button onClick={() => onOpen()}>Открыть бронь</Button>
      </Space>
    </article>
  );
}
