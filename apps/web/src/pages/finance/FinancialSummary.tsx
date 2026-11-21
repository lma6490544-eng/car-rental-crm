import type { FinancialSummary as Summary } from '../../contracts';
import { Descriptions, Statistic } from 'antd';
import { rub } from './presentation';
const summaryFields = [
  ['priceRub', 'Плановая стоимость брони'],
  ['coverageRub', 'Покрытие оплаты'],
  ['overpaymentRub', 'Переплата'],
  ['depositRub', 'Залог'],
  ['availableCreditRub', 'Доступный остаток клиента'],
] as const;
export function FinancialSummary({
  value: s,
  compact = false,
}: {
  value: Summary;
  compact?: boolean;
}) {
  if (compact)
    return (
      <div className="booking-financial-summary">
        {summaryFields.map(([key, label]) => (
          <div
            key={key}
            className={
              'booking-financial-cell' +
              (['priceRub', 'debtRub'].includes(key) ? ' booking-financial-cell-primary' : '')
            }
          >
            <Statistic title={label} value={s[key]} formatter={() => rub(s[key])} />
          </div>
        ))}
      </div>
    );
  return (
    <Descriptions
      size="small"
      layout="vertical"
      column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }}
      items={summaryFields.map(([key, label]) => ({
        key,
        label,
        children: <span style={{ whiteSpace: 'nowrap' }}>{rub(s[key])}</span>,
      }))}
    />
  );
}
