import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, App as AntApp, Avatar, Button, Dropdown, Layout, Menu, Result, Spin } from 'antd';
import {
  CalculatorOutlined,
  CalendarOutlined,
  CarOutlined,
  CreditCardOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { errorMessage } from './api';
import { useTheme } from './theme';
const Settings = lazy(() => import('./pages/Settings'));
const Login = lazy(() => import('./pages/Login'));
const Home = lazy(() => import('./pages/Home'));
const Users = lazy(() => import('./pages/Users'));
const Clients = lazy(() => import('./pages/clients/Clients'));
const ClientDetail = lazy(() =>
  import('./pages/clients/Clients').then((m) => ({ default: m.ClientDetail })),
);
const Fleet = lazy(() => import('./pages/Fleet'));
const Pricing = lazy(() => import('./pages/pricing/Pricing'));
const Calendar = lazy(() => import('./pages/calendar/Calendar'));
const Payments = lazy(() => import('./pages/finance/Finance'));
const VehicleDetail = lazy(() =>
  import('./pages/Fleet').then((m) => ({ default: m.VehicleDetail })),
);
function Wait() {
  return (
    <div className="loading-view" role="status">
      <Spin size="large" />
      <p>Загрузка…</p>
    </div>
  );
}
function Shell() {
  const { mode } = useTheme();
  const auth = useAuth();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const [leaving, setLeaving] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const rentalRoute = location.pathname.startsWith('/rentals/');
  const calendarLayout = location.pathname === '/calendar' || rentalRoute;
  if (!auth.user)
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  const logout = async () => {
    setLeaving(true);
    try {
      await auth.logout();
    } catch (error) {
      void message.error(errorMessage(error));
    } finally {
      setLeaving(false);
    }
  };
  return (
    <Layout className="app-shell">
      <Layout.Sider
        width={232}
        collapsedWidth={64}
        breakpoint="md"
        onBreakpoint={setCollapsed}
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        trigger={null}
        className="sidebar"
      >
        <Link to="/" className="sidebar-brand">
          <span className="brand-mark small">А</span>
          <span>
            Автолига<small>Прокат автомобилей</small>
          </span>
        </Link>
        <Menu
          theme={mode}
          mode="inline"
          selectedKeys={[rentalRoute ? '/calendar' : '/' + location.pathname.split('/')[1]]}
          items={[
            { key: '/', icon: <HomeOutlined />, label: <Link to="/">Главная</Link> },
            {
              key: '/calendar',
              icon: <CalendarOutlined />,
              label: <Link to="/calendar">График</Link>,
            },
            { key: '/clients', icon: <TeamOutlined />, label: <Link to="/clients">Клиенты</Link> },
            { key: '/fleet', icon: <CarOutlined />, label: <Link to="/fleet">Автопарк</Link> },
            {
              key: '/pricing',
              icon: <CalculatorOutlined />,
              label: <Link to="/pricing">Расчёт цены</Link>,
            },
            {
              key: '/payments',
              icon: <CreditCardOutlined />,
              label: <Link to="/payments">Платежи</Link>,
            },
            ...(auth.user.role === 'admin'
              ? [
                  {
                    key: '/users',
                    icon: <UserOutlined />,
                    label: <Link to="/users">Пользователи</Link>,
                  },
                ]
              : []),
            {
              key: '/settings',
              icon: <SettingOutlined />,
              label: <Link to="/settings">Настройки</Link>,
            },
          ]}
        />
        <div className="sidebar-bottom">
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', disabled: leaving },
              ],
              onClick: () => void logout(),
            }}
          >
            <button className="sidebar-profile" aria-label="Профиль пользователя">
              <Avatar size="small">{auth.user.fullName.slice(0, 1)}</Avatar>
              <span className="sidebar-profile-name">{auth.user.fullName}</span>
              <span className="sidebar-profile-more">⌄</span>
            </button>
          </Dropdown>
          <Button
            className="sidebar-collapse"
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            onClick={() => setCollapsed((v) => !v)}
          />
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Content className={'app-content' + (calendarLayout ? ' app-content-calendar' : '')}>
          {auth.error && (
            <Alert
              className="notice"
              type="warning"
              showIcon
              message={auth.error}
              action={<Button onClick={() => void auth.reload()}>Повторить</Button>}
            />
          )}
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
function AdminOnly() {
  const { user } = useAuth();
  return user?.role === 'admin' ? (
    <Users />
  ) : (
    <Result
      status="403"
      title="Доступ ограничен"
      subTitle="Управление сотрудниками доступно администратору."
      extra={
        <Link to="/">
          <Button>На главную</Button>
        </Link>
      }
    />
  );
}
export default function App() {
  const auth = useAuth();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  if (auth.loading) return <Wait />;
  if (auth.error && !auth.user)
    return (
      <Result
        status="warning"
        title="Нет связи с сервером"
        subTitle={auth.error}
        extra={
          <Button type="primary" onClick={() => void auth.reload()}>
            Повторить подключение
          </Button>
        }
      />
    );
  return (
    <>
      {!online && (
        <Alert
          banner
          type="warning"
          message="Нет соединения с сетью. Несохранённый ввод остаётся в этой вкладке; действия не отправляются автоматически."
        />
      )}
      <Suspense fallback={<Wait />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Shell />}>
            <Route index element={<Home />} />
            <Route path="users" element={<AdminOnly />} />
            <Route path="clients" element={<Clients />} />
            <Route path="clients/:id" element={<ClientDetail />} />
            <Route path="fleet" element={<Fleet />} />
            <Route path="fleet/:id" element={<VehicleDetail />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="rentals/:rentalId" element={<Calendar />} />
            <Route path="payments" element={<Payments />} />
            <Route path="settings" element={<Settings />} />
            <Route
              path="*"
              element={
                <Result
                  status="404"
                  title="Страница не найдена"
                  extra={
                    <Link to="/">
                      <Button>На главную</Button>
                    </Link>
                  }
                />
              }
            />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
