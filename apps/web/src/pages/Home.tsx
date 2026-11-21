import { Button, Card, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
export default function Home() {
  const { user } = useAuth();
  return (
    <section>
      <Typography.Title level={2}>Рабочее пространство</Typography.Title>
      <Typography.Paragraph type="secondary">
        Вы вошли в CRM проката автомобилей.
      </Typography.Paragraph>
      <Card className="welcome-card">
        <Space direction="vertical" size="middle">
          <Tag color={user!.role === 'admin' ? 'blue' : 'default'}>
            {user!.role === 'admin' ? 'Администратор' : 'Менеджер'}
          </Tag>
          <Typography.Title level={3} style={{ margin: 0 }}>
            {user!.fullName}
          </Typography.Title>
          <Typography.Text type="secondary">Логин: {user!.login}</Typography.Text>
          {user!.role === 'admin' ? (
            <Link to="/users">
              <Button type="primary">Управление сотрудниками</Button>
            </Link>
          ) : (
            <Typography.Paragraph>
              Работайте с клиентами и автопарком через меню.
            </Typography.Paragraph>
          )}
          <Space wrap>
            <Link to="/clients">
              <Button>Клиенты</Button>
            </Link>
            <Link to="/fleet">
              <Button>Автопарк</Button>
            </Link>
            <Link to="/pricing">
              <Button>Расчёт цены</Button>
            </Link>
          </Space>
        </Space>
      </Card>
    </section>
  );
}
