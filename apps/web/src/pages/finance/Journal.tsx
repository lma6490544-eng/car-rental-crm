import type { FinancialOperation } from '../../contracts';
import { Button, Table, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { dateText } from '../../catalog';
import { names, fundNames, bucketNames, rub } from './presentation';
export function Journal({
  items,
  onReverse,
}: {
  items: FinancialOperation[];
  onReverse?: (id: number) => void;
}) {
  return (
    <Table
      size="small"
      rowKey="id"
      scroll={{ x: 760 }}
      dataSource={items}
      pagination={{ pageSize: 10, showSizeChanger: false }}
      columns={[
        {
          title: '№ / время',
          key: 'id',
          render: (_, o) => (
            <>
              №{o.id}
              <br />
              {dateText(o.created_at)}
            </>
          ),
        },
        {
          title: 'Операция',
          key: 'kind',
          render: (_, o) => (
            <>
              {o.kind === 'to_credit' && o.allocations.some((a) => a.availableAt)
                ? 'Резерв на штрафы'
                : names[o.kind]}
              {o.reversal_of && <> №{o.reversal_of}</>}
              {o.reversedBy && <Tag>Компенсирована №{o.reversedBy}</Tag>}
              <div>{o.reason}</div>
            </>
          ),
        },
        {
          title: 'Клиент / бронь',
          key: 'customer',
          render: (_, o) => (
            <>
              {o.customer_id && <Link to={'/clients/' + o.customer_id}>{o.customer_name}</Link>}
              {o.booking_id && (
                <div>
                  {o.rentalId ? (
                    <Link to={'/rentals/' + o.rentalId} state={{ returnToPrevious: true }}>
                      Аренда №{o.rentalId}
                    </Link>
                  ) : (
                    <Link to={'/calendar?booking=' + o.booking_id}>Бронь №{o.booking_id}</Link>
                  )}
                </div>
              )}
            </>
          ),
        },
        {
          title: 'Деньги и распределения',
          key: 'money',
          render: (_, o) => (
            <>
              {o.external.map((e, i: number) => (
                <div key={'e' + i}>
                  {e.method === 'cash' ? 'Наличные' : 'Безналичные'}: {rub(e.amountRub)}
                </div>
              ))}
              {o.funds.map((f, i: number) => (
                <div key={'f' + i}>
                  {fundNames[f.fund]}: {rub(f.amountRub)}
                </div>
              ))}
              {o.chargeRub && <div>Начисление: {rub(o.chargeRub)}</div>}
              {o.allocations.map((a, i: number) => (
                <div key={'a' + i}>
                  {a.availableAt ? 'Резерв на штрафы' : bucketNames[a.bucket]} · источник №{a.lotId}
                  : {rub(a.amountRub)}
                </div>
              ))}
            </>
          ),
        },
        {
          title: 'Сотрудник',
          dataIndex: 'author',
          render: (v) => v ?? 'Перенос согласованных условий',
        },
        {
          title: '',
          key: 'action',
          render: (_, o) =>
            onReverse && !['charge', 'initial', 'reversal'].includes(o.kind) && !o.reversedBy ? (
              <Button onClick={() => onReverse(o.id)}>Компенсировать №{o.id}</Button>
            ) : null,
        },
      ]}
    />
  );
}
