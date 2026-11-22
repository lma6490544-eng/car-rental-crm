import { App } from 'antd';
import { useEffect, useRef } from 'react';
import { usePolling } from '../../shared/hooks';

type Status = 'none' | 'pending' | 'running' | 'done' | 'failed' | 'unknown' | 'cancelled';

export type AccountingEmailStatus = {
  status: Status;
  canRequest: boolean;
  isCompany: boolean;
  sentAt: string | null;
};

export function AccountingEmailNotice({
  bookingId,
  onFinished,
}: {
  bookingId: number;
  onFinished: (bookingId: number) => void;
}) {
  const { notification } = App.useApp();
  const { data } = usePolling<AccountingEmailStatus>(`/bookings/${bookingId}/accounting-email`);
  const finished = useRef(false);
  const status = data?.status;

  useEffect(() => {
    if (!status || status === 'pending' || status === 'running' || finished.current) return;
    finished.current = true;
    const description = `Бронь №${bookingId}`;
    if (status === 'done')
      notification.success({ message: 'Данные для счёта отправлены в бухгалтерию', description });
    if (status === 'failed')
      notification.error({ message: 'Не удалось отправить письмо в бухгалтерию', description });
    if (status === 'unknown')
      notification.warning({ message: 'Отправку письма подтвердить не удалось', description });
    onFinished(bookingId);
  }, [bookingId, status, notification, onFinished]);

  return null;
}
