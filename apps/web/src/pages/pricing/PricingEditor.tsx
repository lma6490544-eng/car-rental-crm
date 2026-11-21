import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Typography,
} from 'antd';
import { dateText } from '../../catalog';
import type { FormInstance } from 'antd';
import type { Catalog, PricingFormValues } from './types';
import type { usePricingQuote } from './usePricingQuote';
import { names, rub } from './presentation';
import { moscowDateTimeInput } from '../../shared/moscowTime';
const required = [{ required: true, message: 'Заполните поле.' }];
const rubRules = [
  { pattern: /^(0|[1-9]\d{0,18})$/, message: 'Введите целые рубли без пробелов и копеек.' },
];
const defaultUsage = {
  odometerOutKm: 0,
  odometerInKm: 0,
  bodyType: 'sedan',
  fuelOutEighths: 8,
  fuelInEighths: 8,
};

type Props = Pick<
  ReturnType<typeof usePricingQuote>,
  'operation' | 'base' | 'initial' | 'busy' | 'uncertain' | 'submit' | 'valuesChanged'
> & { form: FormInstance<PricingFormValues>; catalog: { data?: Catalog; error: string } };
export function PricingEditor({
  form,
  catalog,
  operation,
  base,
  initial,
  busy,
  uncertain,
  submit,
  valuesChanged,
}: Props) {
  const manual = Form.useWatch('manual', form),
    surcharge = Form.useWatch('manualSurcharge', form);
  const clearOverrides = Form.useWatch('clearOverrides', form),
    discountType = Form.useWatch('discountType', form);
  return (
    <Card
      title={names[operation]}
      extra={
        <Button onClick={initial} disabled={busy || uncertain}>
          Новый расчёт
        </Button>
      }
    >
      {base && (
        <Alert
          className="notice"
          type="info"
          message={`Исходный расчёт №${base.id}, версия ${base.version}`}
          description={`${dateText(base.calculation.startAt)} — ${dateText(base.calculation.agreedReturnAt)} · ${base.calculation.contractDays} суток · ${rub(base.calculation.finalTotalRub)}`}
        />
      )}
      {operation === 'extension' && base && (
        <Alert
          className="notice"
          type="info"
          message={`Согласованные сутки №1–${base.calculation.contractDays} сохраняются без изменений`}
          description={
            <>
              <p>
                Цена, скидки и «Вых» прежнего периода сохранены. Здесь задаются только добавленные
                сутки. Прежние условия можно изменить отдельным действием из подтверждённого
                расчёта.
              </p>
              <p>
                Согласованные «Вых»:{' '}
                {base.calculation.nonBillableDays.length
                  ? base.calculation.nonBillableDays
                      .map((d) => `№${d.dayIndex} — ${d.reason}`)
                      .join('; ')
                  : 'нет'}
                .
              </p>
            </>
          }
        />
      )}
      {base && ['non_billable_day', 'adjustment'].includes(operation) && (
        <Alert
          className="notice"
          type="warning"
          message="Вы изменяете ранее согласованные условия"
          description="Проверьте изменения перед подтверждением. Будет создана отдельная редакция; исходный снимок сохранится."
        />
      )}
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          startAt: moscowDateTimeInput(Date.now()),
          contractDays: 3,
          dailyMileagePackageKm: 250,
          addedDays: 1,
          discountType: 'rub',
          usages: [],
        }}
        onValuesChange={valuesChanged}
        onFinish={submit}
        disabled={busy || uncertain}
      >
        {['initial', 'replacement'].includes(operation) && (
          <Form.Item name="pricingGroupId" label="Тарифная группа" rules={required}>
            <Select options={catalog.data?.items.map((g) => ({ value: g.id, label: g.name }))} />
          </Form.Item>
        )}
        {operation === 'initial' && (
          <>
            <Form.Item name="startAt" label="Начало (Москва)" rules={required}>
              <Input type="datetime-local" />
            </Form.Item>
            <Form.Item name="contractDays" label="Договорные сутки (по 24 часа)" rules={required}>
              <InputNumber min={1} max={3660} precision={0} />
            </Form.Item>
            <Form.Item name="dailyMileagePackageKm" label="Пакет пробега в сутки" rules={required}>
              <Select
                options={[100, 250, 400].map((v) => ({ value: v, label: v + ' км/сутки' }))}
              />
            </Form.Item>
          </>
        )}
        {operation === 'extension' && (
          <Form.Item name="addedDays" label="Добавить суток" rules={required}>
            <InputNumber min={1} max={3660} precision={0} />
          </Form.Item>
        )}
        {operation === 'replacement' && (
          <Form.Item name="replacementAt" label="Момент замены (Москва)" rules={required}>
            <Input type="datetime-local" />
          </Form.Item>
        )}
        {['return', 'early_return'].includes(operation) && (
          <Form.Item name="actualReturnAt" label="Фактический возврат (Москва)" rules={required}>
            <Input type="datetime-local" />
          </Form.Item>
        )}
        <Form.Item
          name="freeDays"
          label={operation === 'extension' ? '«Вых» среди добавленных суток' : 'Сутки «Вых»'}
          extra={
            operation === 'extension' && base
              ? `Номера суток от начала аренды, начиная с №${base.calculation.contractDays + 1}. Пустое поле — без новых «Вых»; прежние сохраняются.`
              : 'Номера 24-часовых суток от начала аренды, через запятую. Лимит пробега сохраняется.'
          }
        >
          <Input placeholder={operation === 'extension' ? 'Без новых «Вых»' : 'Например: 1, 3'} />
        </Form.Item>
        <Form.Item name="freeReason" label="Причина новых «Вых»">
          <Input maxLength={1000} />
        </Form.Item>
        {base?.calculation.overrides && (
          <>
            <Typography.Paragraph>
              Ручные условия исходного расчёта сохраняются до явного изменения. Причина:{' '}
              {base.calculation.overrides.reason}
            </Typography.Paragraph>
            <Form.Item name="clearOverrides" valuePropName="checked">
              <Checkbox>
                {operation === 'extension'
                  ? 'Цена добавленных суток — по тарифу, без новой скидки'
                  : 'Сбросить ручные условия к расчётным'}
              </Checkbox>
            </Form.Item>
          </>
        )}
        {clearOverrides && (
          <Form.Item
            name="clearOverridesReason"
            label="Причина сброса ручных условий"
            rules={required}
          >
            <Input maxLength={1000} />
          </Form.Item>
        )}
        {!clearOverrides && (
          <Form.Item name="manual" valuePropName="checked">
            <Checkbox>
              {operation === 'extension'
                ? 'Задать условия добавленных суток'
                : 'Задать ручные условия этой редакции'}
            </Checkbox>
          </Form.Item>
        )}
        {manual && !clearOverrides && (
          <>
            <Form.Item
              name="customDailyRateRub"
              label="Собственная цена за сутки, ₽"
              extra="Итог рассчитывается по оплачиваемым суткам. Эта же цена используется за дополнительные сутки при опоздании. 0 ₽ — бесплатная аренда. Пустое поле — цена по тарифу."
              rules={rubRules}
            >
              <Input inputMode="numeric" placeholder="Пусто — по тарифу" />
            </Form.Item>
            <Form.Item name="mileageLimitKm" label="Индивидуальный общий лимит, км">
              <InputNumber min={0} max={2147483647} precision={0} />
            </Form.Item>
            <Space align="start" wrap>
              <Form.Item name="discountType" label="Вид скидки">
                <Select
                  style={{ width: 140 }}
                  options={[
                    { value: 'rub', label: 'Рубли' },
                    { value: 'percent', label: 'Проценты' },
                  ]}
                />
              </Form.Item>
              <Form.Item
                name="discountValue"
                label={
                  operation === 'extension'
                    ? discountType === 'percent'
                      ? 'Скидка на добавленные сутки, %'
                      : 'Скидка на добавленные сутки, ₽'
                    : discountType === 'percent'
                      ? 'Скидка, %'
                      : 'Скидка, ₽'
                }
                rules={[
                  {
                    pattern: discountType === 'percent' ? /^(100|\d{1,2})$/ : /^(0|[1-9]\d{0,18})$/,
                    message: 'Введите целое неотрицательное значение.',
                  },
                ]}
              >
                <Input inputMode="numeric" />
              </Form.Item>
            </Space>
            <Form.Item name="reason" label="Причина ручных условий" rules={required}>
              <Input.TextArea maxLength={1000} />
            </Form.Item>
          </>
        )}
        <Collapse
          ghost
          items={[
            {
              key: 'usage',
              label: 'Пробег и топливо по автомобилям',
              children: (
                <>
                  <Typography.Paragraph type="secondary">
                    Добавьте отдельную запись для каждого автомобиля. Одометры разных автомобилей не
                    сравниваются. Это входные данные калькулятора.
                  </Typography.Paragraph>
                  <Form.List name="usages">
                    {(fields, { add, remove }) => (
                      <>
                        {fields.map((f) => (
                          <Card
                            key={f.key}
                            size="small"
                            title={'Автомобиль ' + (f.name + 1)}
                            extra={
                              <Button size="small" onClick={() => remove(f.name)}>
                                Убрать
                              </Button>
                            }
                            style={{ marginBottom: 12 }}
                          >
                            <Form.Item name={[f.name, 'bodyType']} label="Кузов" rules={required}>
                              <Select
                                options={[
                                  { value: 'sedan', label: 'Седан · 40 л' },
                                  { value: 'hatchback', label: 'Хэтчбек · 40 л' },
                                  { value: 'compact_van', label: 'Каблук · 40 л' },
                                  {
                                    value: 'cargo_minibus',
                                    label: 'Грузовой микроавтобус · 80 л',
                                  },
                                ]}
                              />
                            </Form.Item>
                            <Row gutter={12}>
                              {(['odometerOutKm', 'odometerInKm'] as const).map((key, i) => (
                                <Col span={12} key={key}>
                                  <Form.Item
                                    name={[f.name, key]}
                                    label={i ? 'Одометр при возврате' : 'Одометр при выдаче'}
                                    rules={required}
                                  >
                                    <InputNumber
                                      min={0}
                                      max={2147483647}
                                      precision={0}
                                      style={{ width: '100%' }}
                                    />
                                  </Form.Item>
                                </Col>
                              ))}
                            </Row>
                            <Row gutter={12}>
                              {(['fuelOutEighths', 'fuelInEighths'] as const).map((key, i) => (
                                <Col span={12} key={key}>
                                  <Form.Item
                                    name={[f.name, key]}
                                    label={i ? 'Топливо при возврате' : 'Топливо при выдаче'}
                                    rules={required}
                                  >
                                    <Select
                                      options={Array.from({ length: 9 }, (_, v) => ({
                                        value: v,
                                        label: v + '/8',
                                      }))}
                                    />
                                  </Form.Item>
                                </Col>
                              ))}
                            </Row>
                          </Card>
                        ))}
                        <Button onClick={() => add(defaultUsage)} disabled={fields.length >= 100}>
                          Добавить автомобиль
                        </Button>
                      </>
                    )}
                  </Form.List>
                </>
              ),
            },
          ]}
        />
        <Form.Item name="wash" valuePropName="checked">
          <Checkbox>Мойка · 1 000 ₽</Checkbox>
        </Form.Item>
        <Form.Item name="manualSurcharge" valuePropName="checked">
          <Checkbox>Изменить доплату за опоздание или перепробег</Checkbox>
        </Form.Item>
        {surcharge && (
          <>
            <Form.Item
              name="surchargeRub"
              label="Подтверждаемая доплата, ₽"
              rules={[...required, ...rubRules]}
            >
              <Input inputMode="numeric" />
            </Form.Item>
            <Form.Item name="surchargeReason" label="Причина изменения доплаты" rules={required}>
              <Input maxLength={1000} />
            </Form.Item>
          </>
        )}
        <Button
          aria-label="Рассчитать"
          aria-busy={busy}
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={busy || !navigator.onLine || !!catalog.error || uncertain}
        >
          Рассчитать
        </Button>
      </Form>
    </Card>
  );
}
