import { Alert, Button, Space, Tag } from 'antd';
import { dateText } from '../../shared/formatters';
import type { PrivateFile } from './document-types';
import type { DocumentCommand } from './useDocumentCommand';

export function CommandFeedback({ command }: { command: DocumentCommand }) {
  return (
    <>
      {command.error && <Alert type="error" message={command.error} showIcon />}
      {command.pending && (
        <Alert
          type="warning"
          showIcon
          message="Результат команды пока неизвестен."
          action={
            <Space wrap>
              <Button disabled={command.busy} onClick={command.check}>
                Проверить результат
              </Button>
              <Button loading={command.busy} onClick={command.retry}>
                Повторить с тем же ключом
              </Button>
            </Space>
          }
        />
      )}
    </>
  );
}

export function PrivateFileItem({
  file,
  path,
  label,
}: {
  file: PrivateFile;
  path: string;
  label: string;
}) {
  return (
    <Space wrap>
      <span>
        {label} · {dateText(file.createdAt)}
      </span>
      {file.status === 'ready' && <a href={'/api/v1' + path + '/' + file.id}>Скачать</a>}
      {file.status === 'pending' && <Tag>Загрузка обрабатывается</Tag>}
      {file.status === 'failed' && <Tag color="red">Загрузка не завершена</Tag>}
      {['expired', 'deleted'].includes(file.status) && <Tag>Фото удалены по сроку хранения</Tag>}
    </Space>
  );
}
