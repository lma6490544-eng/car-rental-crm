import { useState } from 'react';
import { Alert, Button, Card, Col, Form, Pagination, Row, Space, Table, Typography } from 'antd';
import { dateText, PollNotice, usePolling } from '../../catalog';
import type { Catalog, History, PricingFormValues } from './types';
import { names, rub } from './presentation';
import { usePricingQuote } from './usePricingQuote';
import { PricingEditor } from './PricingEditor';
import { PricingResult } from './PricingResult';
export default function Pricing() {
  const catalog = usePolling<Catalog>('/pricing/catalog');
  const [page, setPage] = useState(1),
    history = usePolling<History>('/pricing/quotes?page=' + page);
  const [form] = Form.useForm<PricingFormValues>();
  const pricing = usePricingQuote(form, history);
  const { error, uncertain, busy, recover, send, load } = pricing;
  return (
    <section>
      <Typography.Title level={2}>Расчёт цены</Typography.Title>
      <Typography.Paragraph>
        Предварительная стоимость и объяснение условий. Подтверждение сохраняет расчёт; бронь и
        движение денег оформляются на следующих этапах.
      </Typography.Paragraph>
      <PollNotice {...catalog} />
      <PollNotice {...history} />
      {error && <Alert className="notice" type="error" showIcon message={error} />}
      {uncertain && (
        <Alert
          className="notice"
          type="warning"
          message="Результат пока неизвестен"
          description="Исходный запрос и ключ сохранены. Проверьте результат или повторите отправку."
          action={
            <Space wrap>
              <Button
                aria-label="Проверить результат"
                aria-busy={busy}
                onClick={() => void recover()}
                loading={busy}
              >
                Проверить результат
              </Button>
              <Button
                aria-label="Повторить отправку"
                aria-busy={busy}
                onClick={() => void send()}
                loading={busy}
              >
                Повторить отправку
              </Button>
            </Space>
          }
        />
      )}
      <Row gutter={[20, 20]}>
        <Col xs={24} xl={10}>
          <PricingEditor form={form} catalog={catalog} {...pricing} />
        </Col>
        <Col xs={24} xl={14}>
          <PricingResult {...pricing} historyError={history.error} />
        </Col>
      </Row>
      <Card title="История расчётов" style={{ marginTop: 20 }}>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{ x: 600 }}
          dataSource={history.data?.items}
          columns={[
            {
              title: '№',
              dataIndex: 'id',
              render: (id: number) => (
                <Button type="link" disabled={busy || uncertain} onClick={() => void load(id)}>
                  {id}
                </Button>
              ),
            },
            { title: 'Сценарий', dataIndex: 'operationKind', render: (s: string) => names[s] },
            { title: 'Цена аренды', dataIndex: 'finalTotalRub', render: rub },
            {
              title: 'Состояние',
              dataIndex: 'confirmedAt',
              render: (s: string | null) => (s ? 'Подтверждён' : 'Предварительный'),
            },
            { title: 'Автор', dataIndex: 'author' },
            { title: 'Создан', dataIndex: 'createdAt', render: dateText },
          ]}
        />
        <Pagination
          current={page}
          pageSize={20}
          total={history.data?.total ?? 0}
          showSizeChanger={false}
          hideOnSinglePage
          onChange={setPage}
        />
      </Card>
    </section>
  );
}
