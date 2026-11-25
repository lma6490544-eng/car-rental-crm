import { List, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { usePolling } from '../../shared/hooks';
import { PollNotice } from '../../shared/PollNotice';
import { moscowDateTimeInput } from '../../shared/moscowTime';

type RentalHistoryRow = {
  id: number;
  issuedAt: string;
  returnedAt: string | null;
  status: string;
  plate: string;
  customer: string;
};

export function RentalHistory({ source, id }: { source: 'customers' | 'vehicles'; id: number }) {
  const poll = usePolling<RentalHistoryRow[]>(`/${source}/${id}/rental-history`);
  return (
    <>
      <PollNotice {...poll} />
      <List
        loading={poll.loading}
        dataSource={poll.data ?? []}
        locale={{ emptyText: 'Аренд пока нет' }}
        rowKey="id"
        renderItem={(row) => (
          <List.Item>
            <List.Item.Meta
              title={
                <Link to={'/rentals/' + row.id} state={{ returnToPrevious: true }}>
                  Аренда №{row.id} · {source === 'vehicles' ? row.customer : row.plate}
                </Link>
              }
              description={
                moscowDateTimeInput(row.issuedAt).replace('T', ' ') +
                (row.returnedAt
                  ? ' — ' + moscowDateTimeInput(row.returnedAt).replace('T', ' ')
                  : '')
              }
            />
            <Tag>
              {row.status === 'completed_early'
                ? 'Завершена досрочно'
                : row.returnedAt
                  ? 'Завершена'
                  : 'Активна'}
            </Tag>
          </List.Item>
        )}
      />
    </>
  );
}
