import { Alert, Button } from 'antd';
export function PollNotice({ error, reload }: { error: string; reload: () => Promise<void> }) {
  return error ? (
    <Alert
      className="notice"
      type="warning"
      showIcon
      message={error}
      description="Показанные данные могут быть неактуальны. Ввод формы сохранён."
      action={<Button onClick={() => void reload()}>Обновить</Button>}
    />
  ) : null;
}
