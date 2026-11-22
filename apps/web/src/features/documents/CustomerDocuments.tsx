import { UploadOutlined } from '@ant-design/icons';
import { Button, Space, Typography, Upload } from 'antd';
import { usePolling } from '../../shared/hooks';
import { PollNotice } from '../../shared/PollNotice';
import type { PrivateFile } from './document-types';
import { CommandFeedback, PrivateFileItem } from './PrivateFileControls';
import { useDocumentCommand } from './useDocumentCommand';
import './documents.css';

export function CustomerDocuments({ id }: { id: number }) {
  const path = '/customers/' + id + '/private-documents';
  const poll = usePolling<PrivateFile[]>(path);
  const command = useDocumentCommand(poll.reload);
  const settings = usePolling<{ uploadsEnabled: boolean }>('/customer-document-settings');
  return (
    <Space direction="vertical" size="middle" className="document-stack">
      <PollNotice {...poll} />
      <CommandFeedback command={command} />
      {settings.data?.uploadsEnabled && !settings.error && (
        <Upload
          accept="image/jpeg,image/png,application/pdf"
          disabled={command.locked}
          showUploadList={false}
          beforeUpload={(file) => {
            command.run('files.upload', path, { file });
            return Upload.LIST_IGNORE;
          }}
        >
          <Button
            icon={<UploadOutlined />}
            disabled={command.locked}
            loading={command.activeCommand === 'files.upload'}
          >
            Загрузить документ клиента
          </Button>
        </Upload>
      )}
      {poll.data?.length === 0 && (
        <Typography.Text type="secondary">Файлы ещё не загружены.</Typography.Text>
      )}
      {poll.data?.map((file) => (
        <PrivateFileItem
          key={file.id}
          file={file}
          path={path}
          label={file.mime === 'application/pdf' ? 'Документ PDF' : 'Скан документа'}
        />
      ))}
    </Space>
  );
}
