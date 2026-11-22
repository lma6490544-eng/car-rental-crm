import { Alert, Button, Card, Checkbox, Form, Input, Radio, Select, Space } from 'antd';
import type { MoneyEditorProps } from './types';
import { useMoneyEditor } from './useMoneyEditor';
import { FinancialSummary } from './FinancialSummary';
import { names, fundNames, bucketNames, rub } from './presentation';
import { sourceKey } from './operationData';
export function MoneyEditor(props: MoneyEditorProps) {
  const { bookingId, data, operationId, onClose } = props;
  const {
    kind,
    selectedBooking,
    amount,
    method,
    fund,
    reason,
    parts,
    error,
    warning,
    accepted,
    setAccepted,
    busy,
    pending,
    summary,
    conflict,
    available,
    sourceMode,
    send,
    changeKind,
    changeBooking,
    changeFund,
    changeAmount,
    changeMethod,
    changeReason,
    changePart,
    acceptVersion,
    useSuggestedDeposit,
  } = useMoneyEditor(props);
  return (
    <Card
      size="small"
      title={operationId ? `Компенсация операции №${operationId}` : 'Денежная операция'}
      style={{ marginBlock: 16 }}
    >
      {error && <Alert role="alert" type="error" message={error} />}
      {pending && (
        <Alert
          type="warning"
          message="Результат пока неизвестен"
          description="Исходная команда и ключ сохранены. Проверьте результат или повторите отправку с тем же ключом."
        />
      )}
      {conflict && !pending && (
        <Alert
          type="warning"
          message="Условия брони изменились. Ввод сохранён."
          action={<Button onClick={acceptVersion}>Принять актуальные условия</Button>}
        />
      )}
      <Form layout="vertical" onFinish={() => void send()} disabled={busy || !!pending}>
        {!operationId && kind !== 'initial' && (
          <Form.Item label="Операция" required>
            <Select
              aria-label="Денежная операция"
              value={kind}
              onChange={changeKind}
              options={(summary?.paymentsAllowed
                ? ['rent_payment', 'deposit_receipt', 'to_credit', 'refund']
                : ['to_credit', 'refund']
              ).map((value) => ({ value, label: names[value] }))}
            />
          </Form.Item>
        )}
        {kind === 'initial' && (
          <Form.Item label="Фонд" required>
            <Select
              aria-label="Фонд"
              value={fund}
              onChange={changeFund}
              options={Object.entries(fundNames).map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        )}
        {!['initial', 'reversal'].includes(kind) && (
          <Form.Item label="Бронь" required={kind !== 'refund'}>
            <Select
              aria-label="Бронь для оплаты"
              value={selectedBooking}
              disabled={!!bookingId || busy || !!pending}
              allowClear={!bookingId && kind === 'refund'}
              onChange={changeBooking}
              options={data?.bookings.map((b) => ({
                value: b.bookingId,
                label: `№${b.bookingId} · ${b.status === 'cancelled' ? 'Отменена' : 'Бронь'} · плановая стоимость ${rub(b.priceRub)}`,
              }))}
            />
          </Form.Item>
        )}
        {summary && !['initial', 'reversal'].includes(kind) && <FinancialSummary value={summary} />}
        {['rent_payment', 'deposit_receipt', 'initial'].includes(kind) && (
          <Form.Item label="Сумма, ₽" required>
            <Input
              aria-label="Сумма, ₽"
              inputMode="numeric"
              value={amount}
              onChange={(e) => changeAmount(e.target.value)}
              maxLength={19}
            />
          </Form.Item>
        )}
        {['rent_payment', 'refund'].includes(kind) && (
          <Form.Item label="Способ расчёта" required>
            <Radio.Group
              value={method}
              onChange={(e) => changeMethod(e.target.value)}
              options={[
                { value: 'cash', label: 'Наличные' },
                { value: 'bank', label: 'Безналичные' },
              ]}
            />
          </Form.Item>
        )}
        {kind === 'deposit_receipt' && (
          <>
            <p>Залог принимается наличными. Нулевой залог не требует денежной операции.</p>
            {summary?.suggestedDepositRub && (
              <Button onClick={useSuggestedDeposit}>
                Подставить рекомендуемый залог: {rub(summary.suggestedDepositRub)}
              </Button>
            )}
          </>
        )}
        {kind === 'to_credit' && (
          <p>
            Перевод переплаты или освобождение залога в доступный остаток выполняется явно. Цена
            брони не меняется.
          </p>
        )}
        {sourceMode && (
          <>
            <h4>Источники средств</h4>
            {available.length === 0 ? (
              <Alert type="info" message="Доступных источников нет" />
            ) : (
              available.map((s) => (
                <Form.Item
                  key={sourceKey(s)}
                  label={`${bucketNames[s.bucket]} · источник №${s.lotId} · ${s.method === 'cash' ? 'наличные' : 'безналичные'} · ${s.fund ? fundNames[s.fund] : 'банк'} · доступно ${rub(s.availableRub)}`}
                >
                  <Input
                    aria-label={'Сумма из источника ' + sourceKey(s)}
                    inputMode="numeric"
                    placeholder="0"
                    value={parts[sourceKey(s)] ?? ''}
                    onChange={(e) => changePart(sourceKey(s), e.target.value)}
                    maxLength={19}
                  />
                </Form.Item>
              ))
            )}
          </>
        )}
        <Form.Item label="Причина / комментарий" required>
          <Input.TextArea
            aria-label="Причина денежной операции"
            value={reason}
            onChange={(e) => changeReason(e.target.value)}
            maxLength={1000}
          />
        </Form.Item>
        {warning && (
          <Alert
            type="warning"
            message="Физический остаток станет отрицательным"
            description={
              <>
                {warning.negative.map((f) => (
                  <p key={f.id}>
                    {fundNames[f.id]}: {rub(f.balanceRub)} → {rub(f.afterRub)}
                  </p>
                ))}
                <Checkbox checked={accepted} onChange={(e) => setAccepted(e.target.checked)}>
                  Подтверждаю проведение с указанным дефицитом и причиной
                </Checkbox>
              </>
            }
          />
        )}
        {!pending && (
          <Space wrap>
            <Button
              type="primary"
              htmlType="submit"
              aria-label="Провести денежную операцию"
              loading={busy}
              disabled={
                !reason.trim() ||
                !!conflict ||
                !navigator.onLine ||
                (!!warning && !accepted) ||
                (!['initial', 'reversal', 'refund'].includes(kind) && !selectedBooking)
              }
            >
              Провести операцию
            </Button>
            <Button onClick={onClose}>Отмена</Button>
          </Space>
        )}
      </Form>
      {pending && (
        <Space wrap>
          <Button
            disabled={busy || !navigator.onLine}
            loading={busy}
            onClick={() => void send(true)}
          >
            Проверить результат
          </Button>
          <Button disabled={busy || !navigator.onLine} loading={busy} onClick={() => void send()}>
            Повторить с тем же ключом
          </Button>
        </Space>
      )}
    </Card>
  );
}
