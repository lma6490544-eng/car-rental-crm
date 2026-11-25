import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import {
  Alert,
  App as AntApp,
  Avatar,
  Button,
  Drawer,
  Dropdown,
  Layout,
  Menu,
  Result,
  Spin,
} from 'antd';
import {
  CalculatorOutlined,
  CalendarOutlined,
  CarOutlined,
  CreditCardOutlined,
  HomeOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Link, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { errorMessage } from './api';
import { useTheme } from './theme';
import { InputTooltip, TouchInputContext } from './shared/InputTooltip';
import { MobileMenuTriggerContext, PageTitle } from './shared/PageTitle';
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
const mobileNavigationQuery = window.matchMedia('(max-width: 760px)');

function subscribeToMobileNavigation(onChange: () => void) {
  mobileNavigationQuery.addEventListener('change', onChange);
  return () => mobileNavigationQuery.removeEventListener('change', onChange);
}

function isMobileNavigation() {
  return mobileNavigationQuery.matches;
}

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
  const [touchInput, setTouchInput] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useSyncExternalStore(subscribeToMobileNavigation, isMobileNavigation);
  const calendarLayout =
    location.pathname === '/calendar' || location.pathname.startsWith('/rentals/');

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [isMobile, location.key]);

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
  const navigation = (
    <>
      <Link to="/" className="sidebar-brand">
        <span className="brand-mark small">А</span>
        <span>
          Автолига<small>Прокат автомобилей</small>
        </span>
      </Link>
      <Menu
        theme={mode}
        mode="inline"
        selectedKeys={[
          location.pathname.startsWith('/rentals/')
            ? '/calendar'
            : '/' + location.pathname.split('/')[1],
        ]}
        items={[
          { key: '/', icon: <HomeOutlined />, label: 'Главная' },
          {
            key: '/calendar',
            icon: <CalendarOutlined />,
            label: 'График',
          },
          { key: '/clients', icon: <TeamOutlined />, label: 'Клиенты' },
          { key: '/fleet', icon: <CarOutlined />, label: 'Автопарк' },
          {
            key: '/pricing',
            icon: <CalculatorOutlined />,
            label: 'Расчёт цены',
          },
          {
            key: '/payments',
            icon: <CreditCardOutlined />,
            label: 'Платежи',
          },
          ...(auth.user.role === 'admin'
            ? [
                {
                  key: '/users',
                  icon: <UserOutlined />,
                  label: 'Пользователи',
                },
              ]
            : []),
          {
            key: '/settings',
            icon: <SettingOutlined />,
            label: 'Настройки',
          },
        ].map((item) => ({
          ...item,
          title: '',
          label: (
            <InputTooltip placement="right" title={!isMobile && collapsed ? item.label : null}>
              <Link to={item.key}>{item.label}</Link>
            </InputTooltip>
          ),
        }))}
      />
      <div className="sidebar-bottom">
        <Dropdown
          trigger={['click']}
          menu={{
            items: [{ key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', disabled: leaving }],
            onClick: () => void logout(),
          }}
        >
          <button className="sidebar-profile" aria-label="Профиль пользователя">
            <Avatar size="small">{auth.user.fullName.slice(0, 1)}</Avatar>
            <span className="sidebar-profile-name">{auth.user.fullName}</span>
            <span className="sidebar-profile-more">⌄</span>
          </button>
        </Dropdown>
        {!isMobile && (
          <Button
            className="sidebar-collapse"
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            onClick={() => setCollapsed((v) => !v)}
          />
        )}
      </div>
    </>
  );
  const mobileMenuTrigger = isMobile ? (
    <Button
      className="mobile-menu-trigger"
      type="text"
      icon={<MenuOutlined aria-hidden="true" />}
      aria-label="Меню"
      aria-haspopup="dialog"
      aria-expanded={mobileMenuOpen}
      onClick={() => setMobileMenuOpen(true)}
    />
  ) : null;
  return (
    <TouchInputContext.Provider value={touchInput}>
      <Layout
        className="app-shell"
        onPointerOverCapture={(event) => setTouchInput(event.pointerType === 'touch')}
        onPointerDownCapture={(event) => setTouchInput(event.pointerType === 'touch')}
        onKeyDownCapture={() => setTouchInput(false)}
      >
        {isMobile ? (
          <Drawer
            className="sidebar mobile-navigation"
            title="Меню"
            placement="left"
            width={280}
            open={mobileMenuOpen}
            onClose={() => setMobileMenuOpen(false)}
          >
            {navigation}
          </Drawer>
        ) : (
          <Layout.Sider
            width={232}
            collapsedWidth={64}
            breakpoint={calendarLayout ? 'lg' : 'md'}
            onBreakpoint={setCollapsed}
            collapsible
            collapsed={collapsed}
            onCollapse={setCollapsed}
            trigger={null}
            className="sidebar"
          >
            {navigation}
          </Layout.Sider>
        )}
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
          <MobileMenuTriggerContext.Provider value={mobileMenuTrigger}>
            <Outlet />
          </MobileMenuTriggerContext.Provider>
        </Layout.Content>
      </Layout>
    </TouchInputContext.Provider>
  );
}
function AdminOnly() {
  const { user } = useAuth();
  return user?.role === 'admin' ? (
    <Users />
  ) : (
    <Result
      status="403"
      title={
        <PageTitle>
          <span>Доступ ограничен</span>
        </PageTitle>
      }
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
                  title={
                    <PageTitle>
                      <span>Страница не найдена</span>
                    </PageTitle>
                  }
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
