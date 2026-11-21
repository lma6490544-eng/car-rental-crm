import type { ReactNode } from 'react';
import { Button, Popover } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { Calculation } from '../../contracts';
import { dateText } from '../../catalog';
import { rub } from '../../shared/formatters';
export function BookingFooter({
  calculation,
  calculating,
  saveAction,
}: {
  calculation?: Calculation;
  calculating: boolean;
  saveAction: ReactNode;
}) {
  return (
    <div className="booking-create-footer">
      <div className="booking-create-total" aria-live="polite">
        <span>Стоимость аренды</span>
        <div>
          <strong>
            {calculating ? 'Расчёт…' : calculation ? rub(calculation.finalTotalRub) : '— ₽'}
          </strong>
          {calculation && (
            <Popover
              trigger={['hover', 'click']}
              content={
                <div className="booking-price-details">
                  Лимит: {calculation.effectiveMileageLimitKm} км
                  <p>
                    {dateText(calculation.startAt)} — {dateText(calculation.agreedReturnAt)}
                  </p>
                </div>
              }
            >
              <Button
                type="text"
                aria-label="Детализация стоимости"
                icon={<InfoCircleOutlined />}
              />
            </Popover>
          )}
        </div>
      </div>
      <div className="booking-create-submit">
        {saveAction || (
          <Button type="primary" disabled>
            Создать бронь
          </Button>
        )}
      </div>
    </div>
  );
}
