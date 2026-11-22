import { InfoCircleOutlined } from '@ant-design/icons';
import { Button, Popover } from 'antd';
import type { Calculation } from '../../contracts';
import { dateText } from '../../shared/formatters';

export function RentalPriceInfo({ calculation }: { calculation: Calculation }) {
  return (
    <Popover
      trigger={['hover', 'focus', 'click']}
      content={
        <div className="booking-price-details">
          Лимит: {calculation.effectiveMileageLimitKm} км
          <p>
            {dateText(calculation.startAt)} — {dateText(calculation.agreedReturnAt)}
          </p>
        </div>
      }
    >
      <Button type="text" aria-label="Детализация стоимости" icon={<InfoCircleOutlined />} />
    </Popover>
  );
}
