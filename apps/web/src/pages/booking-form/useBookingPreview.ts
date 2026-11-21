import { useEffect, useState } from 'react';
import type { BookingPreview, Inspection } from '../../contracts';
import { api, errorMessage } from '../../api';
export function useBookingPreview(draftKey: string, scheduleKey: string) {
  const [preview, setPreview] = useState<BookingPreview & { draftKey: string }>(),
    [calculating, setCalculating] = useState(false),
    [calcError, setCalcError] = useState(''),
    [manual, setManual] = useState(false);
  const [schedule, setSchedule] = useState<Inspection & { key: string }>(),
    [scheduleError, setScheduleError] = useState('');
  const [availabilityRevision, setAvailabilityRevision] = useState(0),
    [availabilityNotice, setAvailabilityNotice] = useState('');
  useEffect(() => {
    let alive = true;
    setSchedule(undefined);
    setScheduleError('');
    if (!scheduleKey) return;
    const timer = setTimeout(() => {
      void api<Inspection>('/availability/evaluate', {
        method: 'POST',
        body: JSON.parse(scheduleKey),
      })
        .then((v) => {
          if (alive) setSchedule({ ...v, key: scheduleKey });
        })
        .catch((e) => {
          if (alive) setScheduleError(errorMessage(e));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scheduleKey]);
  useEffect(() => {
    let alive = true;
    setPreview(undefined);
    setCalcError('');
    setManual(false);
    if (!draftKey) {
      setCalculating(false);
      return;
    }
    setCalculating(true);
    const timer = setTimeout(() => {
      void api<BookingPreview>('/bookings/preview', { method: 'POST', body: JSON.parse(draftKey) })
        .then((p) => {
          if (alive) setPreview({ ...p, draftKey });
        })
        .catch((e) => {
          if (alive) setCalcError(errorMessage(e));
        })
        .finally(() => {
          if (alive) setCalculating(false);
        });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draftKey, availabilityRevision]);
  useEffect(() => setAvailabilityNotice(''), [draftKey]);
  const refreshAvailability = () => {
    setAvailabilityNotice(
      'Доступность изменилась. Проверьте обновлённое предупреждение и сохраните бронь ещё раз. Введённые данные сохранены.',
    );
    setPreview(undefined);
    setAvailabilityRevision((v) => v + 1);
  };

  return {
    preview,
    calculating,
    calcError,
    manual,
    setManual,
    schedule,
    scheduleError,
    availabilityNotice,
    refreshAvailability,
  };
}
