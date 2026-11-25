import { moscowDateTimeInput as local } from '../../shared/moscowTime';
import { buildBookingCommand } from './bookingCommand';
import { BookingFooter } from './BookingFooter';
import type { ActionProps, BookingInitial, BookingFormValues } from './types';
import { useBookingCustomer } from './useBookingCustomer';
import { buildBookingDraft, clean } from './bookingDraft';
import { useBookingPreview } from './useBookingPreview';
import type { BookingOptions, CommandResult } from '../../contracts';
import { useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentType, ReactNode, Ref } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Collapse,
  ConfigProvider,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Radio,
  Segmented,
  Select,
  Space,
  Tag,
  theme,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { usePolling } from '../../catalog';
import { normalizePhone, PhoneInput, phoneRules } from '../../formats';
import { identityLabels, companyLabels } from '../../features/customers/customer-fields';
import { ConflictList } from '../../features/booking/Conflicts';
import { compactVehicleOption } from '../../features/vehicles/CompactVehicleOption';
import { RentalPriceInfo } from '../../features/booking/RentalPriceInfo';
import { rub } from '../../shared/formatters';

const rentalDayPlural = new Intl.PluralRules('ru-RU');
const rentalDayLabels = {
  one: 'день',
  few: 'дня',
  many: 'дней',
  other: 'дня',
  two: 'дня',
  zero: 'дней',
};
const contractDurationOptions = Array.from({ length: 3660 }, (_, index) => {
  const days = index + 1;
  return { value: days, label: `${days} ${rentalDayLabels[rentalDayPlural.select(days)]}` };
});

function RentalDateInput({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value: string) => void;
}) {
  // Keep the picker's pending selection when the booking preview updates the form.
  const date = useMemo(() => (value ? dayjs(value) : null), [value]);
  return (
    <DatePicker
      aria-label="Начало аренды"
      showTime={{ format: 'HH:mm' }}
      format="DD.MM.YYYY, HH:mm"
      value={date}
      onChange={(v) => onChange?.(v ? v.format('YYYY-MM-DDTHH:mm') : '')}
    />
  );
}
export type BookingTermsForm = {
  buildBody: () => ReturnType<typeof buildBookingCommand> | undefined;
  refreshAvailability: () => void;
};

type BookingFormAction =
  | {
      mode: 'booking';
      initial?: BookingInitial;
      Action: ComponentType<ActionProps>;
      onDone: (result: CommandResult) => void;
      termsRef?: never;
    }
  | {
      mode: 'terms';
      initial: BookingInitial;
      termsRef: Ref<BookingTermsForm>;
      Action?: never;
      onDone?: never;
    };

export default function BookingForm({
  mode,
  initial,
  onDone,
  Action,
  footerContainer,
  onTermsDirtyChange,
  onTermsReadyChange,
  termsRef,
  contractDeposit,
  disabled = false,
}: {
  footerContainer?: HTMLElement | null;
  onTermsDirtyChange?: (dirty: boolean) => void;
  onTermsReadyChange?: (ready: boolean) => void;
  contractDeposit?: ReactNode;
  disabled?: boolean;
} & BookingFormAction) {
  const { token } = theme.useToken();
  const [termsTouched, setTermsTouched] = useState(false);
  const [fieldsValid, setFieldsValid] = useState(false);
  const [form] = Form.useForm<BookingFormValues>(),
    values: BookingFormValues = Form.useWatch([], form) ?? {};
  const termsOnly = mode === 'terms';
  const options = usePolling<BookingOptions>(termsOnly ? undefined : '/booking-options');
  const customer = useBookingCustomer(form, termsOnly ? undefined : initial?.customerId);
  const {
    selected,
    selecting,
    query,
    matches,
    searching,
    searchError,
    searchField,
    extras,
    setExtras,
    choose,
    resetClient,
    search,
    cancelSelectionOnEdit,
    changeCustomerType,
  } = customer;
  const [withoutVehicle, setWithoutVehicle] = useState(false);
  const initialTarget = initial?.target?.split(':'),
    calculation = initial?.calculation;
  const [advanced, setAdvanced] = useState(
    !!initialTarget && ['model', 'equivalence_group'].includes(initialTarget[0]),
  );
  const type = selected?.type ?? values.type ?? 'individual';
  const initialValues = {
    type: 'individual',
    details: {},
    start: initial?.start ?? local(new Date().toISOString()),
    days: calculation?.contractDays ?? 1,
    package: calculation?.dailyMileagePackageKm ?? 250,
    vehicleId:
      initial?.vehicleId ??
      (initialTarget?.[0] === 'vehicle' ? Number(initialTarget[1]) : undefined),
    brandId: initialTarget?.[0] === 'brand' ? Number(initialTarget[1]) : undefined,
    advancedTarget:
      initialTarget && ['model', 'equivalence_group'].includes(initialTarget[0])
        ? initial!.target
        : undefined,
    custom: calculation?.overrides?.customDailyRateRub,
    discountMode: calculation?.overrides?.discountBps !== undefined ? 'percent' : 'rub',
    discount:
      calculation?.overrides?.discountBps !== undefined
        ? String(calculation.overrides.discountBps / 100)
        : calculation?.overrides?.discountRub,
    limit: calculation?.overrides?.mileageLimitKm,
    loyaltyReason: calculation?.overrides?.reason ?? calculation?.nonBillableDays?.[0]?.reason,
    freeDays: calculation?.nonBillableDays?.map((d) => d.dayIndex).join(','),
  };
  const termsDirty =
    termsOnly &&
    termsTouched &&
    ((
      [
        'start',
        'days',
        'package',
        'custom',
        'discount',
        'limit',
        'loyaltyReason',
        'freeDays',
      ] as const
    ).some((field) => clean(values[field]) !== clean(initialValues[field])) ||
      (!!clean(values.discount) && values.discountMode !== initialValues.discountMode));
  useEffect(() => onTermsDirtyChange?.(termsDirty), [onTermsDirtyChange, termsDirty]);
  const previewEnabled = !termsOnly || termsDirty;
  const watchedVehicle = options.data?.vehicles.find((v) => v.id === values.vehicleId);
  const watchedBrandId = watchedVehicle?.brandId;
  useEffect(() => {
    if (watchedBrandId !== undefined && values.brandId !== watchedBrandId)
      form.setFieldValue('brandId', watchedBrandId);
  }, [watchedBrandId, values.brandId, form]);
  const autoProps = (field: 'name' | 'phone') => ({
    onSearch: (text: string) => search(text, field),
    onSelect: (v: string) => void choose(v),
    filterOption: false as const,
    options:
      initial?.customerId || field !== searchField || !query
        ? []
        : matches
            .filter((c) => c.type === type)
            .map((c) => ({
              value: String(c.id),
              label: (
                <div className="booking-client-option">
                  <strong>{c.displayName}</strong>
                  <span>
                    {c.phone}
                    {c.isBlocked && <Tag color="red">Заблокирован</Tag>}
                  </span>
                </div>
              ),
              disabled: c.isBlocked,
            })),
    notFoundContent:
      !initial?.customerId && query.trim().length >= 2
        ? searching
          ? 'Поиск…'
          : 'Совпадений нет'
        : null,
  });
  const { target, scheduleKey, draft, draftKey, discountValid, loyalty, requiresVehicle } =
    buildBookingDraft(values, advanced, options.data, selected, selecting, initial, mode);
  const {
    preview,
    calculating,
    calcError,
    manual,
    setManual,
    schedule,
    scheduleError,
    availabilityNotice,
    refreshAvailability,
  } = useBookingPreview(previewEnabled ? draftKey : '', previewEnabled ? scheduleKey : '');
  useEffect(() => {
    if (target?.type === 'vehicle') setWithoutVehicle(false);
  }, [target?.type]);
  const body = () => {
    if (!preview || preview.draftKey !== draftKey)
      throw new Error('Дождитесь актуального расчёта.');
    return buildBookingCommand(
      form.getFieldsValue(true),
      selected,
      preview,
      target,
      draft!.pricing,
      manual,
      initial,
      mode,
    );
  };
  const hasStoredDetails =
    !!selected &&
    Object.keys(type === 'individual' ? identityLabels : companyLabels).some(
      (k) => !!clean(selected.details?.[k]),
    );
  const required = [{ required: true, whitespace: true, message: 'Заполните поле.' }];
  useEffect(() => {
    let alive = true;
    setFieldsValid(false);
    void form
      .validateFields({ validateOnly: true })
      .then(() => {
        if (alive) setFieldsValid(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [form, values, advanced, loyalty, requiresVehicle]);
  const vehicleOptions = (options.data?.vehicles ?? [])
    .filter(
      (v) =>
        (!values.brandId || v.brandId === values.brandId) &&
        (!values.modelId || v.modelId === values.modelId),
    )
    .map(compactVehicleOption);
  const currentPreview = previewEnabled
    ? preview?.draftKey === draftKey
      ? preview
      : schedule?.key === scheduleKey
        ? schedule
        : undefined
    : undefined;
  const hasAvailabilityWarning =
    !!currentPreview?.availability && currentPreview.availability.status !== 'feasible';
  const savesWithoutVehicle = !termsOnly && !!target && target.type !== 'vehicle';
  const blocked =
    (target?.type === 'vehicle' || (termsOnly && !!initial?.vehicleId)) &&
    !!currentPreview &&
    (currentPreview.conflicts?.length > 0 ||
      (currentPreview.vehicle && !currentPreview.vehicle.isReady));
  const chooseAlternative = (id: number) => {
    setAdvanced(false);
    setWithoutVehicle(false);
    form.setFieldsValue({ vehicleId: id, modelId: undefined });
  };
  const saveUnassigned = () => {
    const model = watchedVehicle?.modelId;
    if (!model) return;
    setAdvanced(true);
    setWithoutVehicle(true);
    form.setFieldsValue({ advancedTarget: 'model:' + model, vehicleId: undefined });
  };
  const currentCalculation = preview?.draftKey === draftKey ? preview!.calculation : undefined;
  const saveWithoutVehicle = withoutVehicle || (savesWithoutVehicle && hasAvailabilityWarning);
  const saveLabel = initial?.bookingId
    ? saveWithoutVehicle
      ? 'Сохранить без автомобиля'
      : 'Сохранить бронь'
    : 'Создать бронь';
  const canSave =
    fieldsValid &&
    !!preview &&
    preview.draftKey === draftKey &&
    !calculating &&
    !selecting &&
    !selected?.isBlocked &&
    (!preview.calculation.overridesToConfirm.length || manual);
  const termsReady = termsDirty && !blocked && canSave;
  useEffect(() => onTermsReadyChange?.(termsReady), [onTermsReadyChange, termsReady]);
  useImperativeHandle(termsRef, () => ({
    buildBody: () => (termsReady && !disabled ? body() : undefined),
    refreshAvailability,
  }));
  const saveAction = Action && !blocked && (
    <Action
      path={initial?.bookingId ? '/bookings/' + initial.bookingId + '/terms' : '/bookings'}
      command={initial?.bookingId ? 'bookings.terms' : 'bookings.create'}
      label={saveLabel}
      body={body}
      onDone={onDone}
      onAvailabilityChanged={refreshAvailability}
      invoicePrompt={
        !initial?.bookingId && type === 'company'
          ? target?.type === 'vehicle'
            ? 'now'
            : 'no-vehicle'
          : undefined
      }
      revision={JSON.stringify({
        values,
        selected: selected?.id,
        customerVersion: selected?.version,
        token: preview?.previewToken,
        availabilityToken: preview?.availability?.token,
      })}
      disabled={!canSave}
    />
  );
  const changeVehicleTarget = (value: string | undefined) => {
    const [kind, id] = String(value ?? '').split(':');
    const model = options.data?.models.find((m) => m.id === Number(id));
    form.setFieldsValue({
      modelId: kind === 'model' ? Number(id) : undefined,
      brandId: kind === 'model' ? model?.brandId : kind === 'brand' ? Number(id) : undefined,
      vehicleId: undefined,
    });
    setManual(false);
  };

  const handleValuesChange = (changed: Partial<BookingFormValues>) => {
    if (termsOnly) setTermsTouched(true);
    setManual(false);
    cancelSelectionOnEdit(changed);
  };
  const displayedCalculation = termsOnly && !termsDirty ? calculation : currentCalculation;
  const mileageField = (
    <Form.Item name="package" label="Пробег в сутки" rules={[{ required: true }]}>
      <Segmented
        aria-label="Пробег в сутки"
        block
        options={[100, 250, 400].map((value) => ({ value, label: value + ' км' }))}
      />
    </Form.Item>
  );
  const footer = (
    <BookingFooter
      calculation={displayedCalculation}
      calculating={previewEnabled && calculating}
      saveAction={saveAction}
      showSave={!!Action}
    />
  );
  return (
    <ConfigProvider
      theme={{
        components: {
          Segmented: { itemSelectedBg: token.colorPrimary, itemSelectedColor: token.colorBgBase },
        },
      }}
    >
      <Form
        className={termsOnly ? 'booking-form contract-terms-form' : 'booking-form'}
        form={form}
        layout="vertical"
        initialValues={initialValues}
        disabled={disabled || undefined}
        onValuesChange={handleValuesChange}
      >
        {!termsOnly && (
          <>
            {searchError && <Alert type="error" message={searchError} />}
            <section className="booking-form-section">
              <div className="booking-form-section-heading">
                <h3>Клиент</h3>
                <Form.Item name="type" rules={[{ required: true }]}>
                  <Segmented
                    aria-label="Тип клиента"
                    disabled={!!selected}
                    options={[
                      { value: 'individual', label: 'Физическое лицо' },
                      { value: 'company', label: 'Организация' },
                    ]}
                    onChange={changeCustomerType}
                  />
                </Form.Item>
              </div>
              <div className="form-grid">
                {type === 'individual' ? (
                  <>
                    <Form.Item name={['details', 'lastName']} label="Фамилия" rules={required}>
                      <AutoComplete {...autoProps('name')} aria-label="Фамилия">
                        <Input maxLength={100} />
                      </AutoComplete>
                    </Form.Item>
                    <Form.Item name={['details', 'firstName']} label="Имя" rules={required}>
                      <Input aria-label="Имя" maxLength={100} />
                    </Form.Item>
                    <Form.Item name={['details', 'middleName']} label="Отчество">
                      <Input aria-label="Отчество" maxLength={100} />
                    </Form.Item>
                  </>
                ) : (
                  <Form.Item name="displayName" label="Название организации" rules={required}>
                    <AutoComplete {...autoProps('name')} aria-label="Название организации">
                      <Input maxLength={250} />
                    </AutoComplete>
                  </Form.Item>
                )}
                <Form.Item
                  name="phone"
                  label="Телефон"
                  rules={[{ required: true, message: 'Укажите телефон.' }, ...phoneRules]}
                >
                  <AutoComplete {...autoProps('phone')} aria-label="Телефон">
                    <Input
                      type="tel"
                      maxLength={18}
                      placeholder="+7 (999) 999-99-99"
                      onBlur={() =>
                        form.setFieldValue(
                          'phone',
                          normalizePhone(form.getFieldValue('phone') ?? ''),
                        )
                      }
                    />
                  </AutoComplete>
                </Form.Item>
                <Form.Item
                  className="booking-form-full"
                  name="email"
                  label="Email"
                  rules={[{ type: 'email' }]}
                >
                  <Input aria-label="Email" />
                </Form.Item>
                {type === 'company' && (
                  <Form.Item className="booking-form-full" name="inn" label="ИНН">
                    <Input maxLength={12} />
                  </Form.Item>
                )}
              </div>
              {selecting && (
                <Typography.Text type="secondary" role="status">
                  Загрузка карточки…
                </Typography.Text>
              )}
              {selected && !initial?.customerId && (
                <Button className="booking-reset-client" type="link" onClick={resetClient}>
                  Очистить клиента
                </Button>
              )}
              {hasStoredDetails && (
                <Collapse
                  activeKey={extras}
                  onChange={(keys) => setExtras(Array.isArray(keys) ? keys : [keys])}
                  items={[
                    {
                      key: 'details',
                      label: type === 'individual' ? 'Документы и адреса' : 'Реквизиты организации',
                      forceRender: true,
                      children: (
                        <div className="form-grid">
                          {Object.entries(
                            type === 'individual' ? identityLabels : companyLabels,
                          ).map(([key, label]) => (
                            <Form.Item key={key} name={['details', key]} label={label}>
                              {key === 'representativePhone' ? (
                                <PhoneInput />
                              ) : (
                                <Input
                                  type={key.endsWith('Date') ? 'date' : 'text'}
                                  maxLength={500}
                                />
                              )}
                            </Form.Item>
                          ))}
                        </div>
                      ),
                    },
                  ]}
                />
              )}
            </section>
            <Divider />
          </>
        )}
        <section className="booking-form-section">
          {!termsOnly && (
            <>
              <h3>Автомобиль и аренда</h3>
              <Form.Item name="brandId" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="modelId" hidden>
                <Input />
              </Form.Item>
              <div className="form-grid">
                <Form.Item
                  label="Марка и модель"
                  required={!advanced}
                  extra={advanced ? 'Выбран вариант из дополнительных настроек.' : undefined}
                >
                  <Select
                    aria-label="Марка и модель"
                    showSearch
                    allowClear
                    disabled={advanced}
                    optionFilterProp="label"
                    value={
                      values.modelId
                        ? 'model:' + values.modelId
                        : values.brandId
                          ? 'brand:' + values.brandId
                          : undefined
                    }
                    options={[
                      {
                        label: 'Марки',
                        options: (options.data?.brands ?? []).map((b) => ({
                          value: 'brand:' + b.id,
                          label: b.label,
                        })),
                      },
                      {
                        label: 'Модели',
                        options: (options.data?.models ?? []).map((m) => ({
                          value: 'model:' + m.id,
                          label: m.label,
                        })),
                      },
                    ]}
                    onChange={changeVehicleTarget}
                  />
                </Form.Item>
                <Form.Item
                  name="vehicleId"
                  label="Автомобиль"
                  rules={[{ required: requiresVehicle }]}
                  extra={
                    requiresVehicle
                      ? 'У марки несколько тарифов: выберите автомобиль или модель.'
                      : undefined
                  }
                >
                  <Select
                    aria-label="Автомобиль"
                    showSearch
                    allowClear
                    disabled={advanced}
                    optionFilterProp="searchLabel"
                    options={vehicleOptions}
                    placeholder="Без назначения автомобиля"
                  />
                </Form.Item>
              </div>
            </>
          )}
          <div className={termsOnly ? 'contract-terms-fields' : 'form-grid'}>
            <Form.Item name="start" label="Начало аренды" rules={required}>
              <RentalDateInput />
            </Form.Item>
            <Form.Item
              name="days"
              label={termsOnly ? 'Срок аренды' : 'Количество дней'}
              rules={[{ required: true }]}
            >
              {termsOnly ? (
                <Select
                  aria-label="Срок аренды"
                  showSearch
                  options={contractDurationOptions}
                  optionFilterProp="label"
                />
              ) : (
                <InputNumber aria-label="Количество дней" min={1} max={3660} precision={0} />
              )}
            </Form.Item>
            {termsOnly && mileageField}
          </div>
          {!termsOnly && mileageField}
        </section>
        {!termsOnly && (
          <Collapse
            className="booking-form-options"
            activeKey={advanced ? ['other'] : []}
            onChange={(keys) => {
              setAdvanced(keys.length > 0);
              form.setFieldValue('advancedTarget', undefined);
            }}
            items={[
              {
                key: 'other',
                label: 'Другие варианты бронирования',
                children: (
                  <Form.Item
                    name="advancedTarget"
                    label="Модель или группа аналогов"
                    rules={[{ required: advanced }]}
                  >
                    <Select
                      aria-label="Модель или группа аналогов"
                      showSearch
                      optionFilterProp="label"
                      options={[
                        ...(options.data?.models ?? []).map((m) => ({
                          value: 'model:' + m.id,
                          label: m.label + ' · Модель',
                        })),
                        ...(options.data?.groups ?? []).map((g) => ({
                          value: 'equivalence_group:' + g.id,
                          label: g.label + ' · Аналоги',
                        })),
                      ]}
                    />
                  </Form.Item>
                ),
              },
            ]}
          />
        )}
        <Collapse
          className="booking-form-options"
          items={[
            {
              key: 'loyalty',
              label: 'Лояльность и скидки',
              forceRender: true,
              children: (
                <>
                  <div className="form-grid">
                    <Form.Item name="custom" label="Собственная цена за сутки, ₽">
                      <Input placeholder="Пусто — тариф; 0 — бесплатно" />
                    </Form.Item>
                    <div>
                      <Form.Item name="discountMode" label="Скидка">
                        <Radio.Group
                          block
                          optionType="button"
                          options={[
                            { value: 'rub', label: '₽' },
                            { value: 'percent', label: '%' },
                          ]}
                          onChange={() => form.setFieldValue('discount', undefined)}
                        />
                      </Form.Item>
                      <Form.Item
                        name="discount"
                        label={
                          values.discountMode === 'percent'
                            ? 'Размер скидки, %'
                            : 'Размер скидки, ₽'
                        }
                        validateStatus={!discountValid ? 'error' : undefined}
                        help={
                          !discountValid
                            ? values.discountMode === 'percent'
                              ? 'От 0 до 100, максимум два знака после запятой'
                              : 'Введите целое неотрицательное число'
                            : undefined
                        }
                      >
                        <Input inputMode="decimal" />
                      </Form.Item>
                    </div>
                    <Form.Item name="limit" label="Индивидуальный общий лимит, км">
                      <InputNumber min={0} />
                    </Form.Item>
                  </div>
                  <Form.Item name="freeDays" label="Бесплатные сутки «Вых» (номера через запятую)">
                    <Input placeholder="2, 5" />
                  </Form.Item>
                  <Form.Item
                    name="loyaltyReason"
                    label="Причина условий лояльности"
                    rules={[{ required: loyalty }]}
                  >
                    <Input />
                  </Form.Item>
                  {(preview?.calculation.overridesToConfirm.length ?? 0) > 0 && (
                    <Checkbox checked={manual} onChange={(e) => setManual(e.target.checked)}>
                      Подтверждаю ручные условия
                    </Checkbox>
                  )}
                </>
              ),
            },
          ]}
        />
        {previewEnabled && calcError && <Alert type="warning" message={calcError} />}
        {previewEnabled && scheduleError && (
          <Alert type="warning" message={'Не удалось проверить доступность: ' + scheduleError} />
        )}
        {currentPreview && (
          <div className="calendar-availability">
            {blocked && (
              <Alert
                type="error"
                message={
                  currentPreview.conflicts?.length
                    ? 'Автомобиль занят на выбранный период'
                    : 'Автомобиль не готов к выдаче'
                }
                description={
                  termsOnly
                    ? 'Измените даты или замените автомобиль в разделе «Акт».'
                    : 'Выберите свободную замену, измените даты или сохраните бронь без назначения автомобиля.'
                }
              />
            )}
            <ConflictList items={currentPreview.conflicts} />
            {blocked && !termsOnly && (
              <>
                <p>Свободные автомобили на весь период:</p>
                <Space wrap>
                  {currentPreview.alternatives?.map((v) => (
                    <Button key={v.id} onClick={() => chooseAlternative(v.id)}>
                      {v.label}
                    </Button>
                  ))}
                  {!currentPreview.alternatives?.length && (
                    <span>Подходящих свободных автомобилей нет.</span>
                  )}
                </Space>
                <p>
                  <Button onClick={saveUnassigned}>Сохранить без автомобиля</Button>
                </p>
              </>
            )}
            {!blocked && hasAvailabilityWarning && (
              <Alert
                type="warning"
                message={
                  currentPreview.availability.status === 'unknown'
                    ? 'Доступность автомобилей пока не подтверждена'
                    : 'На выбранный период автомобилей не хватает'
                }
                description={
                  savesWithoutVehicle
                    ? 'Бронь для клиента сохранится, но автомобиль пока не будет назначен. Подобрать машину можно позже в разделе «Проблемные брони».'
                    : 'Броней больше, чем доступных машин. Выбранный автомобиль будет назначен этой брони; для других броней может потребоваться замена.'
                }
              />
            )}
          </div>
        )}
        {withoutVehicle && !hasAvailabilityWarning && (
          <Typography.Paragraph type="secondary">
            Конкретный автомобиль не закреплён. Сохраняется бронь на модель.
          </Typography.Paragraph>
        )}
        {(withoutVehicle || (savesWithoutVehicle && hasAvailabilityWarning)) && (
          <Form.Item name="unassignedReason" label="Комментарий (необязательно)">
            <Input maxLength={1000} />
          </Form.Item>
        )}
        {availabilityNotice && (
          <Typography.Paragraph role="status" type="secondary">
            {availabilityNotice}
          </Typography.Paragraph>
        )}
        {termsOnly && contractDeposit ? (
          <div className="contract-edit-finance">
            <Form.Item label="Стоимость аренды" required>
              <div className="contract-edit-price">
                <Input
                  aria-label="Стоимость аренды"
                  readOnly
                  value={calculating ? 'Рассчитываем…' : rub(displayedCalculation?.finalTotalRub)}
                />
                {displayedCalculation && <RentalPriceInfo calculation={displayedCalculation} />}
              </div>
            </Form.Item>
            {contractDeposit}
          </div>
        ) : footerContainer ? (
          createPortal(footer, footerContainer)
        ) : (
          footer
        )}
      </Form>
    </ConfigProvider>
  );
}
