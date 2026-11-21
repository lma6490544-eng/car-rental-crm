import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { errorMessage } from '../api';
export default function Login() {
  const auth = useAuth();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = location.state?.from;
  const destination =
    typeof from === 'string' &&
    /^\/(?:users|calendar|pricing|payments|clients(?:\/[1-9][0-9]*)?|fleet(?:\/[1-9][0-9]*)?)(?:\?[^#]*)?$/.test(
      from,
    )
      ? from
      : '/';
  if (auth.user) return <Navigate to={destination} replace />;
  const submit = async ({ login, password }: { login: string; password: string }) => {
    setBusy(true);
    setError(null);
    try {
      await auth.login(login.trim(), password);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <section className="login-intro">
        <div className="brand-mark">А</div>
        <Typography.Text className="eyebrow">АВТОЛИГА · ПРОКАТ АВТОМОБИЛЕЙ</Typography.Text>
        <h1>
          Рабочее пространство
          <br />
          вашей команды
        </h1>
        <p>Войдите под своей учётной записью.</p>
      </section>
      <section className="login-panel" aria-labelledby="login-heading">
        <Typography.Title level={2} id="login-heading">
          Вход в систему
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          Используйте логин и пароль, полученные от администратора.
        </Typography.Paragraph>
        {auth.expired && (
          <Alert
            type="info"
            showIcon
            message="Сессия завершена. Войдите снова."
            className="notice"
          />
        )}
        {error && <Alert role="alert" type="error" showIcon message={error} className="notice" />}
        <Form layout="vertical" onFinish={submit} requiredMark={false} disabled={busy}>
          <Form.Item
            label="Логин"
            name="login"
            rules={[{ required: true, whitespace: true, message: 'Введите логин.' }]}
          >
            <Input autoComplete="username" autoFocus size="large" maxLength={64} />
          </Form.Item>
          <Form.Item
            label="Пароль"
            name="password"
            rules={[{ required: true, message: 'Введите пароль.' }]}
          >
            <Input.Password autoComplete="current-password" size="large" maxLength={128} />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={busy}>
            Войти
          </Button>
        </Form>
        <p className="login-help">Если нет доступа, обратитесь к администратору.</p>
      </section>
    </main>
  );
}
