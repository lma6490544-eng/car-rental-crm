import type { ReactNode } from 'react';
import { Button } from 'antd';
import type { Calculation } from '../../contracts';
import { RentalPriceInfo } from '../../features/booking/RentalPriceInfo';
import { rub } from '../../shared/formatters';
export function BookingFooter({
  calculation,
  calculating,
  saveAction,
  showSave = true,
  saveLabel = 'Создать бронь',
}: {
  calculation?: Calculation;
  calculating: boolean;
  saveAction: ReactNode;
  showSave?: boolean;
  saveLabel?: string;
}) {
  return (
    <div className="booking-create-footer">
      <div className="booking-create-total" aria-live="polite">
        <span>Стоимость аренды</span>
        <div>
          <strong>
            {calculating ? 'Расчёт…' : calculation ? rub(calculation.finalTotalRub) : '— ₽'}
          </strong>
          {calculation && <RentalPriceInfo calculation={calculation} />}
        </div>
      </div>
      {showSave && (
        <div className="booking-create-submit">
          {saveAction || (
            <Button type="primary" disabled>
              {saveLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
