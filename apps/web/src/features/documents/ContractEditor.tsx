import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { EditOutlined, ExportOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Space } from 'antd';
import type { AdditionalDriver, BookingDocuments } from './document-types';
import type { Calculation } from '../../contracts';
import type { DocumentCommand, TermsChange } from './useDocumentCommand';
import { rub } from '../../shared/formatters';
import { ContractSummary } from './ContractSummary';

const driverFields = [
  ['fullName', 'ФИО', 160],
  ['passport', 'Паспорт', 500],
  ['address', 'Адрес', 500],
  ['phone', 'Телефон', 40],
  ['license', 'Водительское удостоверение', 100],
] as const;
const emptyDriver: AdditionalDriver = {
  fullName: '',
  passport: '',
  address: '',
  phone: '',
  license: '',
};
export const contractGeneratingLabel = 'Формируем договор…';

export function OpenDocumentButton({
  path,
  label,
  onOpen,
}: {
  path: string;
  label: string;
  onOpen: () => void;
}) {
  return (
    <Button
      type="default"
      href={'/api/v1' + path}
      className="document-open-link"
      aria-label={label}
      disabled={false}
      target="_blank"
      rel="noreferrer"
      icon={<ExportOutlined />}
      onClick={onOpen}
    >
      Открыть
    </Button>
  );
}

export function ContractEditor({
  id,
  data,
  customerSectionTitle,
  command,
  actionsContainer,
  disabled,
  suggestedDeposit,
  driverDirty,
  namesNeedReview,
  calculation,
  renderTermsEditor,
  contractGenerating,
  termsChange,
  onEditing,
  onDirty,
  onDocumentOpen,
}: {
  id: number;
  data: BookingDocuments;
  customerSectionTitle: string;
  command: DocumentCommand;
  actionsContainer: HTMLElement | null;
  disabled: boolean;
  suggestedDeposit?: string;
  onEditing: (editing: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onDocumentOpen: (versionId: number) => void;
  driverDirty: boolean;
  namesNeedReview: boolean;
  calculation?: Calculation;
  renderTermsEditor: (deposit?: ReactNode) => ReactNode;
  contractGenerating: boolean;
  termsChange?: {
    ready: boolean;
    prepare: () => TermsChange | undefined;
    reset?: () => void;
  };
}) {
  const latest = data.contracts[0];
  const [editing, setEditing] = useState(false);
  const depositId = useId();
  function editContract(value: boolean) {
    setEditing(value);
    onEditing(value);
  }
  const [depositOverride, setDeposit] = useState<{ value: string; base: string }>();
  const [driverOverride, setDriver] = useState<{
    value: AdditionalDriver | null;
    base: AdditionalDriver | null;
  }>();
  const path = '/bookings/' + id + '/contracts';
  const canEdit = !!data.checkout && !data.checkout.issuedAt && data.booking.status === 'confirmed';
  const ready = latest?.status === 'ready';
  const current =
    latest?.bookingVersion === data.booking.version &&
    latest?.customerVersion === data.customerVersion;
  const showEditor = canEdit && (editing || !latest || !current || !!termsChange);
  const editingRevision = showEditor && editing && current;
  const locked = disabled || command.locked;
  const depositBase = latest?.securityDepositRub ?? suggestedDeposit ?? '';
  const driverBase = latest?.additionalDriver ?? null;
  const deposit = depositOverride?.value ?? depositBase;
  const driver = driverOverride ? driverOverride.value : driverBase;
  const dirty =
    showEditor &&
    (deposit !== depositBase || JSON.stringify(driver) !== JSON.stringify(driverBase));
  const canPrint =
    !contractGenerating &&
    ready &&
    !termsChange &&
    (!showEditor || (editingRevision && !dirty)) &&
    (current || data.checkout?.issuedAt);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const conflict =
    (depositOverride && depositOverride.base !== depositBase && deposit !== depositBase) ||
    (driverOverride &&
      JSON.stringify(driverOverride.base) !== JSON.stringify(driverBase) &&
      JSON.stringify(driver) !== JSON.stringify(driverBase));
  const configured = data.storageConfigured && data.lessorConfigured;
  const canGenerate =
    showEditor &&
    !locked &&
    (!termsChange || termsChange.ready) &&
    !driverDirty &&
    !namesNeedReview &&
    configured &&
    data.missing.length === 0 &&
    latest?.status !== 'pending' &&
    /^(0|[1-9]\d{0,17})$/.test(deposit) &&
    (!driver || Object.values(driver).every((value) => value.trim()));
  function updateDriver(value: AdditionalDriver | null) {
    editContract(true);
    setDriver((previous) => ({ value, base: previous ? previous.base : driverBase }));
  }
  function updateDeposit(value: string | null) {
    editContract(true);
    setDeposit((previous) => ({ value: value ?? '', base: previous?.base ?? depositBase }));
  }
  function clearDraft() {
    editContract(false);
    setDeposit(undefined);
    setDriver(undefined);
  }
  function cancelEdit() {
    termsChange?.reset?.();
    clearDraft();
  }
  function generateContract() {
    const terms = termsChange?.prepare();
    if (termsChange && !terms) return;
    command.createContract(
      '/bookings/' + id,
      {
        expectedBookingVersion: data.booking.version,
        expectedCustomerVersion: data.customerVersion,
        expectedContractVersionId: latest?.id ?? null,
        securityDepositRub: deposit,
        additionalDriver: driver,
      },
      clearDraft,
      terms,
    );
  }
  const editAction = canEdit && current && latest.status !== 'pending' && !showEditor && (
    <Button
      icon={<EditOutlined aria-hidden="true" />}
      disabled={locked}
      onClick={() => editContract(true)}
    >
      Изменить договор
    </Button>
  );
  const depositField = (
    <Form.Item
      className="contract-edit-deposit"
      label="Залог по договору"
      htmlFor={depositId}
      layout="vertical"
      required
    >
      <InputNumber
        id={depositId}
        aria-label="Залог по договору, ₽"
        aria-required="true"
        value={deposit || null}
        stringMode
        disabled={locked}
        inputMode="numeric"
        precision={0}
        min="0"
        max="999999999999999999"
        formatter={(value, { userTyping, input }) => {
          if (userTyping) return input;
          return value ? rub(value) : '';
        }}
        parser={(value) => (value ?? '').replace(/[\s₽]/g, '')}
        onChange={updateDeposit}
      />
    </Form.Item>
  );
  return (
    <Space direction="vertical" size="middle" className="document-stack">
      {actionsContainer &&
        createPortal(
          canPrint ? (
            <OpenDocumentButton
              path={path + '/' + latest.id + '/pdf'}
              label="Открыть договор"
              onOpen={() => onDocumentOpen(latest.id)}
            />
          ) : editingRevision && !contractGenerating ? (
            <Button disabled icon={<ExportOutlined />} aria-label="Открыть договор">
              Открыть
            </Button>
          ) : (
            <Button
              className="checkout-primary-button"
              type="primary"
              loading={contractGenerating}
              aria-busy={contractGenerating}
              aria-label={contractGenerating ? contractGeneratingLabel : undefined}
              disabled={!contractGenerating && !canGenerate}
              onClick={generateContract}
            >
              {contractGenerating ? contractGeneratingLabel : 'Сформировать договор'}
            </Button>
          ),
          actionsContainer,
        )}
      {!showEditor && !ready && renderTermsEditor()}
      {!ready && editAction}
      {!contractGenerating && latest?.status === 'failed' && current && !termsChange && (
        <Alert
          type="error"
          showIcon
          message="Не удалось сформировать PDF договора"
          action={
            <Button
              disabled={locked}
              onClick={() =>
                command.run('contracts.retry', path + '/' + latest.id + '/retry', { body: {} })
              }
            >
              Повторить
            </Button>
          }
        />
      )}
      {showEditor ? (
        <div className="contract-edit-form">
          {!configured && (
            <Alert
              type="warning"
              showIcon
              message="Для PDF нужны реквизиты арендодателя и приватное хранилище."
            />
          )}
          {data.missing.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`Заполните обязательные реквизиты в разделе «${customerSectionTitle}».`}
            />
          )}
          {conflict && (
            <Alert
              type="warning"
              showIcon
              message="Залог или дополнительного водителя изменили в другом окне. Проверьте введённые значения."
            />
          )}
          {renderTermsEditor(depositField)}
          <Checkbox
            checked={!!driver}
            disabled={locked}
            onChange={(e) => updateDriver(e.target.checked ? emptyDriver : null)}
          >
            Указать дополнительного водителя
          </Checkbox>
          {driver && (
            <div className="checkout-fields">
              {driverFields.map(([key, label, max]) => (
                <label className="document-field" key={key}>
                  <span>{label}</span>
                  <Input
                    disabled={locked}
                    value={driver[key]}
                    maxLength={max}
                    onChange={(e) => updateDriver({ ...driver, [key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
          )}
          {editingRevision ? (
            <div className="contract-edit-actions">
              <Button disabled={locked} onClick={cancelEdit}>
                Отменить
              </Button>
              <Button
                className="checkout-primary-button"
                type="primary"
                loading={contractGenerating}
                disabled={!canGenerate}
                onClick={generateContract}
              >
                Сохранить изменения
              </Button>
            </div>
          ) : (
            termsChange?.reset && (
              <Button disabled={locked} onClick={termsChange.reset}>
                Отменить правки условий
              </Button>
            )
          )}
        </div>
      ) : ready ? (
        <ContractSummary
          calculation={calculation}
          deposit={depositBase}
          additionalDriverName={driverBase?.fullName}
          editAction={editAction}
        />
      ) : (
        latest && (
          <>
            <span>Залог по договору: {rub(depositBase || undefined)}</span>
            {driver && <span>Дополнительный водитель: {driver.fullName}</span>}
          </>
        )
      )}
    </Space>
  );
}
