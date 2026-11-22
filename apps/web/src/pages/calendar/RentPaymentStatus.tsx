import { Tag } from 'antd';
import type { RentPaymentProgress } from '../../contracts';
import { rub } from '../../shared/formatters';

export const rentPaymentLabels = {
  unpaid: 'Не оплачено',
  partial: 'Оплачено частично',
  paid: 'Оплачено',
  not_required: 'Оплата не требуется',
};

const colors = { unpaid: 'default', partial: 'warning', paid: 'success', not_required: 'default' };

export function RentPaymentTag({ status }: { status: RentPaymentProgress['status'] }) {
  return <Tag color={colors[status]}>{rentPaymentLabels[status]}</Tag>;
}

export function RentPaymentSummary({ payment }: { payment: RentPaymentProgress }) {
  return (
    <section className="rent-payment-summary" aria-label="Оплата аренды">
      <div className="rent-payment-heading">
        <strong>Оплата аренды</strong>
        <RentPaymentTag status={payment.status} />
      </div>
      <dl className="rent-payment-amounts">
        <div>
          <dt>К оплате</dt>
          <dd>{rub(payment.priceRub)}</dd>
        </div>
        <div>
          <dt>Поступило</dt>
          <dd>{rub(payment.receivedRub)}</dd>
        </div>
        <div>
          <dt>Осталось</dt>
          <dd>{rub(payment.remainingRub)}</dd>
        </div>
      </dl>
    </section>
  );
}
