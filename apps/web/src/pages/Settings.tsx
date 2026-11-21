import { Switch, Typography } from 'antd';
import { useTheme } from '../theme';

export default function Settings() {
  const { mode, setMode } = useTheme();
  return (
    <section className="settings-page">
      <h1>Настройки</h1>
      <div className="settings-theme-row">
        <div>
          <Typography.Title level={5}>Тёмная тема</Typography.Title>
          <Typography.Text type="secondary">
            {mode === 'dark' ? 'Включена тёмная тема' : 'Включена светлая тема'}
          </Typography.Text>
        </div>
        <Switch
          aria-label="Тёмная тема"
          checked={mode === 'dark'}
          onChange={(checked) => setMode(checked ? 'dark' : 'light')}
        />
      </div>
    </section>
  );
}
