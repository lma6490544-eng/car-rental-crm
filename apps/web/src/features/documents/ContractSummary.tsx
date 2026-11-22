import {
  CalendarOutlined,
  DashboardOutlined,
  DollarCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { Collapse } from 'antd';
import type { ReactNode } from 'react';
import type { Calculation } from '../../contracts';
import { rub } from '../../shared/formatters';
import { RentalPriceInfo } from '../booking/RentalPriceInfo';

const rentalStart = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const dayWord = { one: 'день', few: 'дня', many: 'дней', other: 'дня', two: 'дня', zero: 'дней' };
const dayPlural = new Intl.PluralRules('ru-RU');
const mileagePackages = [100, 250, 400];

function dailyRateText(periods: Calculation['periods'] = []) {
  const rates = periods.map((period) => period.customDailyRateRub ?? period.dailyRateRub);
  const [firstRate] = rates;
  if (firstRate === undefined) return rub(undefined);

  let minRate = firstRate;
  let maxRate = firstRate;
  for (const rate of rates) {
    if (BigInt(rate) < BigInt(minRate)) minRate = rate;
    if (BigInt(rate) > BigInt(maxRate)) maxRate = rate;
  }
  return minRate === maxRate ? rub(minRate) : `${rub(minRate)} – ${rub(maxRate)}`;
}

export function ContractSummary({
  calculation,
  deposit,
  additionalDriverName,
  editAction,
}: {
  calculation?: Calculation;
  deposit: string;
  additionalDriverName?: string;
  editAction?: ReactNode;
}) {
  const loyalty: { label: string; value: string }[] = [];
  const overrides = calculation?.overrides;
  const freeDays =
    calculation?.nonBillableDays ?? calculation?.dayLines?.filter((day) => day.nonBillable) ?? [];
  if (overrides?.customDailyRateRub !== undefined) {
    loyalty.push({ label: 'Собственная цена за сутки', value: rub(overrides.customDailyRateRub) });
  }
  if (calculation?.discountRub && calculation.discountRub !== '0') {
    loyalty.push({ label: 'Скидка', value: rub(calculation.discountRub) });
  }
  if (overrides?.mileageLimitKm !== undefined) {
    loyalty.push({
      label: 'Индивидуальный общий лимит',
      value: `${overrides.mileageLimitKm.toLocaleString('ru-RU')} км`,
    });
  }
  if (freeDays.length) {
    loyalty.push({
      label: 'Бесплатные сутки',
      value: freeDays
        .map(({ dayIndex, reason }) => (reason ? `№ ${dayIndex} — ${reason}` : `№ ${dayIndex}`))
        .join(', '),
    });
  }
  if (loyalty.length && overrides?.reason)
    loyalty.push({ label: 'Причина условий лояльности', value: overrides.reason });
  return (
    <div className="contract-summary">
      {calculation && (
        <>
          <h3>Условия аренды</h3>
          <dl className="contract-summary-terms">
            <div className="contract-summary-value">
              <dt>
                <CalendarOutlined aria-hidden="true" />
                Начало аренды
              </dt>
              <dd>{rentalStart.format(new Date(calculation.startAt))}</dd>
            </div>
            <div className="contract-summary-value">
              <dt>
                <CalendarOutlined aria-hidden="true" />
                Срок аренды
              </dt>
              <dd>
                {calculation.contractDays} {dayWord[dayPlural.select(calculation.contractDays)]}
              </dd>
            </div>
            <div className="contract-summary-value">
              <dt>
                <DashboardOutlined aria-hidden="true" />
                Пробег в сутки
              </dt>
              <dd>
                {mileagePackages.includes(calculation.dailyMileagePackageKm) ? (
                  <ul className="contract-summary-mileage" aria-label="Пакеты пробега">
                    {mileagePackages.map((mileage) => (
                      <li
                        key={mileage}
                        aria-current={
                          mileage === calculation.dailyMileagePackageKm ? 'true' : undefined
                        }
                      >
                        {mileage} км
                      </li>
                    ))}
                  </ul>
                ) : calculation.dailyMileagePackageKm ? (
                  `${calculation.dailyMileagePackageKm} км`
                ) : (
                  '—'
                )}
              </dd>
            </div>
          </dl>
          {loyalty.length > 0 && (
            <Collapse
              size="small"
              className="contract-summary-loyalty"
              items={[
                {
                  key: 'loyalty',
                  label: 'Лояльность и скидки',
                  children: (
                    <dl className="contract-summary-loyalty-data">
                      {loyalty.map(({ label, value }) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                  ),
                },
              ]}
            />
          )}
        </>
      )}
      <div className="contract-summary-footer">
        <dl className="contract-summary-finance">
          {calculation && (
            <>
              <div className="contract-summary-value">
                <dt>
                  <DollarCircleOutlined aria-hidden="true" />
                  Стоимость суток
                </dt>
                <dd>
                  <strong>{dailyRateText(calculation.periods)}</strong>
                </dd>
              </div>
              <div className="contract-summary-value">
                <dt>
                  <DollarCircleOutlined aria-hidden="true" />
                  Стоимость аренды
                </dt>
                <dd>
                  <strong>{rub(calculation.finalTotalRub)}</strong>
                  <RentalPriceInfo calculation={calculation} />
                </dd>
              </div>
            </>
          )}
          <div className="contract-summary-value">
            <dt>
              <SafetyCertificateOutlined aria-hidden="true" />
              Залог по договору
            </dt>
            <dd>
              <strong>{rub(deposit || undefined)}</strong>
            </dd>
          </div>
        </dl>
        {editAction}
      </div>
      {additionalDriverName && (
        <div className="contract-summary-driver">
          Дополнительный водитель: {additionalDriverName}
        </div>
      )}
    </div>
  );
}
