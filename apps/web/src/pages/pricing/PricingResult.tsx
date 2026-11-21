import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Descriptions,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { dateText } from '../../catalog';
import type { usePricingQuote } from './usePricingQuote';
import { names, overrideNames, rub } from './presentation';
type Props = Pick<
  ReturnType<typeof usePricingQuote>,
  | 'quote'
  | 'dirty'
  | 'changed'
  | 'load'
  | 'ack'
  | 'setAck'
  | 'busy'
  | 'uncertain'
  | 'confirm'
  | 'startOperation'
> & { historyError: string };
export function PricingResult({
  quote,
  dirty,
  changed,
  load,
  ack,
  setAck,
  busy,
  uncertain,
  confirm,
  startOperation,
  historyError,
}: Props) {
  const c = quote?.calculation;
  return (
    <>
      {' '}
      {!c && (
        <Card>
          <Typography.Title level={4}>Выберите условия аренды</Typography.Title>
          <Typography.Paragraph>
            Результат покажет ставку, сутки, лимит и составляющие стоимости. Для перерасчёта сначала
            подтвердите исходный расчёт.
          </Typography.Paragraph>
        </Card>
      )}
      {c && quote && (
        <Card
          title={`Расчёт №${quote.id}`}
          extra={
            <Tag color={quote.confirmedAt ? 'green' : 'blue'}>
              {quote.confirmedAt ? 'Снимок подтверждён' : 'Предварительный'}
            </Tag>
          }
        >
          {c.overrides?.customTotalRub !== undefined && (
            <Alert
              className="notice"
              type="warning"
              message="В этом старом снимке собственная цена была общей суммой за аренду. Для нового расчёта укажите цену за сутки либо явно вернитесь к тарифу. Историческая сумма сохранена."
            />
          )}
          {dirty && (
            <Alert
              className="notice"
              type="warning"
              message="Показан прежний результат. Рассчитайте изменённые условия заново."
            />
          )}
          {changed && (
            <Alert
              className="notice"
              type="warning"
              message="Состояние расчёта изменилось другим оператором. Ввод сохранён."
              action={<Button onClick={() => void load(quote.id)}>Перечитать расчёт</Button>}
            />
          )}
          <Descriptions
            layout="vertical"
            column={{ xs: 1, sm: 2, md: 2, lg: 2, xl: 2, xxl: 2 }}
            size="small"
            items={[
              {
                key: 'period',
                label: 'Срок',
                children: `${c.contractDays} суток · оплачиваемых ${c.billableDays}`,
              },
              {
                key: 'limit',
                label: 'Пакет / общий лимит',
                children: `${c.dailyMileagePackageKm} км/сутки · ${c.effectiveMileageLimitKm} км (расчётный ${c.calculatedMileageLimitKm})`,
              },
              {
                key: 'end',
                label: c.earlyReturn ? 'Полные сутки до' : 'Окончание',
                children: dateText(c.agreedReturnAt),
              },
              ...(c.earlyReturn
                ? [
                    {
                      key: 'originalEnd',
                      label: 'Сдача по исходному договору',
                      children: dateText(c.earlyReturn.originalReturnAt),
                    },
                    {
                      key: 'actualEnd',
                      label: 'Фактический возврат',
                      children: dateText(c.earlyReturn.actualReturnAt),
                    },
                    {
                      key: 'fullHours',
                      label: 'Полные часы после суток',
                      children: String(c.earlyReturn.remainingFullHours),
                    },
                  ]
                : []),
              { key: 'base', label: 'После «Вых»', children: rub(c.baseTotalRub) },
              { key: 'discount', label: 'Скидка', children: rub(c.discountRub) },
              {
                key: 'adjust',
                label: 'Итоговая корректировка',
                children: rub(c.finalAdjustmentRub),
              },
              {
                key: 'rent',
                label: 'Цена аренды',
                children: <strong>{rub(c.finalTotalRub)}</strong>,
              },
              {
                key: 'lateRate',
                label: 'Дополнительные сутки при опоздании',
                children: rub(c.lateDailyRateRub) + '/сутки',
              },
              {
                key: 'late',
                label: c.earlyReturn ? 'Доплата за часы' : 'Доплата за опоздание',
                children: rub(c.lateCandidateRub),
              },
              {
                key: 'mileage',
                label: 'Доплата за перепробег',
                children: rub(c.mileageCandidateRub),
              },
              {
                key: 'confirmed',
                label: 'Доплата к оплате',
                children: rub(c.confirmedSurchargeRub),
              },
              { key: 'fuel', label: 'Топливо отдельно', children: rub(c.fuelTotalRub) },
              { key: 'wash', label: 'Мойка отдельно', children: rub(c.washRub) },
              {
                key: 'total',
                label: 'Всего с доплатами',
                children: <Typography.Text strong>{rub(c.totalWithExtrasRub)}</Typography.Text>,
              },
              {
                key: 'vat',
                label: 'В т.ч. НДС 5% (справочно)',
                children: rub(c.includedVatRub),
              },
              ...(c.old
                ? [
                    {
                      key: 'old',
                      label: 'Прежняя цена / лимит',
                      children: `${rub(c.old.finalTotalRub)} / ${c.old.effectiveMileageLimitKm} км`,
                    },
                    { key: 'diff', label: 'Разница всего', children: rub(c.differenceRub!) },
                  ]
                : []),
              ...(c.refundOrCreditIfFullyPaidRub !== undefined
                ? [
                    {
                      key: 'refund',
                      label: 'К возврату или зачёту при полной оплате прежнего итога',
                      children: rub(c.refundOrCreditIfFullyPaidRub),
                    },
                  ]
                : []),
            ]}
          />
          {c.surchargeOverride && (
            <Typography.Paragraph>
              По расчёту — {rub(c.selectedSurchargeRub)}. Изменено на {rub(c.confirmedSurchargeRub)}
              . Причина: {c.surchargeOverride.reason}
            </Typography.Paragraph>
          )}
          <Typography.Paragraph type="secondary">
            {c.earlyReturn
              ? 'За часы после полных суток и перепробег'
              : 'За опоздание и перепробег'}{' '}
            рассчитывается одна доплата — большая из двух сумм. Топливо и мойка оплачиваются
            отдельно.
          </Typography.Paragraph>
          {c.differenceRub && BigInt(c.differenceRub) < 0n && (
            <Typography.Paragraph>
              Стоимость уменьшилась на {rub((-BigInt(c.differenceRub)).toString())}. Фактическая
              переплата зависит от будущего учёта платежей; выплата этим расчётом не проводится.
            </Typography.Paragraph>
          )}
          <Typography.Title level={5}>Как получилась цена</Typography.Title>
          {c.explanation.map((s, i) => (
            <Typography.Paragraph key={i}>{s}</Typography.Paragraph>
          ))}
          <Table
            size="small"
            rowKey="sequence"
            pagination={false}
            scroll={{ x: 760 }}
            dataSource={c.periods}
            columns={[
              {
                title: 'Период',
                render: (_, p) => (p.groupStartDay === 1 ? 'Первоначальный срок' : 'Продление'),
              },
              { title: 'Сутки', render: (_, p) => `${p.fromDay}–${p.toDay}` },
              { title: 'Тарифная группа', render: (_, p) => p.pricingGroup.name },
              { title: 'Диапазон выбран по сроку', dataIndex: 'tariffDurationDays' },
              {
                title: 'Цена за сутки',
                render: (_, p) => rub(p.customDailyRateRub ?? p.dailyRateRub),
              },
            ]}
          />
          <Collapse
            style={{ marginTop: 16 }}
            items={[
              {
                key: 'days',
                label: 'Строки суток и «Вых»',
                children: (
                  <Table
                    size="small"
                    rowKey="dayIndex"
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 540 }}
                    dataSource={c.dayLines}
                    columns={[
                      { title: '№', dataIndex: 'dayIndex' },
                      { title: 'Начало', dataIndex: 'startAt', render: dateText },
                      { title: 'По тарифу', dataIndex: 'baseRateRub', render: rub },
                      {
                        title: 'Цена за сутки',
                        render: (_, d) => rub(d.agreedDailyRateRub ?? d.baseRateRub),
                      },
                      { title: 'Стоимость', dataIndex: 'amountRub', render: rub },
                      {
                        title: 'Условия',
                        render: (_, d) =>
                          d.nonBillable
                            ? `Вых · Бесплатные сутки: 0 ₽ · ${d.reason}`
                            : d.agreedDailyRateRub !== undefined &&
                                d.agreedDailyRateRub !== d.baseRateRub
                              ? 'Собственная цена'
                              : 'По тарифу',
                      },
                    ]}
                  />
                ),
              },
              {
                key: 'fuel',
                label: 'Топливо по автомобилям',
                children: c.fuelCharges.map((f, i) => (
                  <Typography.Paragraph key={f.key}>
                    Автомобиль {i + 1}: {f.outEighths}/8 → {f.inEighths}/8 · бак {f.tankLiters} л ·{' '}
                    {rub(f.amountRub)}
                  </Typography.Paragraph>
                )),
              },
            ]}
          />
          {c.warnings.map((s, i) => (
            <Alert
              key={i}
              className="notice"
              type="warning"
              message={
                quote.confirmedAt && s.startsWith('Ручные условия')
                  ? 'Ручные условия этой редакции подтверждены. Значения и причины сохранены в снимке.'
                  : s
              }
            />
          ))}
          {c.overrides && (
            <Typography.Paragraph>
              Причина ручных условий: {c.overrides.reason}
            </Typography.Paragraph>
          )}
          <Typography.Paragraph type="secondary">
            Правила: {c.ruleVersion} · создан {dateText(quote.createdAt)}
            {!quote.confirmedAt && ` · подтвердить до ${dateText(quote.expiresAt)}`}
          </Typography.Paragraph>
          {!quote.confirmedAt && (
            <Space direction="vertical">
              {!!c.overridesToConfirm.length && (
                <Checkbox
                  checked={ack}
                  disabled={dirty || busy || uncertain}
                  onChange={(e) => setAck(e.target.checked)}
                >
                  Подтверждаю ручные условия:{' '}
                  {c.overridesToConfirm.map((k) => overrideNames[k]).join(', ')}. Причины и значения
                  проверены.
                </Checkbox>
              )}
              <Button
                aria-label="Подтвердить снимок расчёта"
                aria-busy={busy}
                type="primary"
                onClick={confirm}
                loading={busy}
                disabled={
                  busy ||
                  dirty ||
                  changed ||
                  uncertain ||
                  !navigator.onLine ||
                  !!historyError ||
                  (!ack && !!c.overridesToConfirm.length)
                }
              >
                Подтвердить снимок расчёта
              </Button>
            </Space>
          )}
          {quote.confirmedAt && c.contractDays > 0 && (
            <Space wrap>
              {[
                'extension',
                'early_return',
                'replacement',
                'non_billable_day',
                'adjustment',
                'return',
              ].map((kind) => (
                <Button
                  key={kind}
                  onClick={() => startOperation(kind)}
                  disabled={
                    busy ||
                    uncertain ||
                    (c.overrides?.customTotalRub !== undefined && kind !== 'adjustment')
                  }
                >
                  {names[kind]}
                </Button>
              ))}
            </Space>
          )}
          {quote.confirmedAt && c.contractDays === 0 && (
            <Typography.Paragraph>
              Для нового перерасчёта выберите в истории исходный договор до досрочного возврата.
            </Typography.Paragraph>
          )}
        </Card>
      )}
    </>
  );
}
