import { Button, Card, Form, Input, Space, Tag } from 'antd';
import { CommandModal, dateText, PollNotice, usePolling } from '../../catalog';
import type { Customer } from '../../catalog';
export type ClientActionKind = 'note' | 'block' | 'unblock' | `resolve:${string}`;

type CustomerNote = {
  id: number;
  text: string;
  isActive: boolean;
  author: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
};

export function ClientAction({
  kind,
  client,
  current,
  onClose,
  onDone,
}: {
  kind: ClientActionKind;
  client: Customer;
  current: Customer;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form] = Form.useForm<{ text?: string; reason?: string; expectedVersion?: number }>();
  const isNote = kind === 'note';
  const isResolving = kind.startsWith('resolve:');
  let suffix: string = kind;
  let title = 'Снятие блокировки';
  if (isNote) {
    suffix = 'notes';
    title = 'Новая заметка';
  } else if (isResolving) {
    suffix = 'notes/' + kind.slice(8) + '/resolve';
    title = 'Закрыть заметку';
  } else if (kind === 'block') {
    title = 'Блокировка клиента';
  }
  return (
    <CommandModal
      title={title}
      path={'/customers/' + client.id + '/' + suffix}
      command={'customers.' + (isResolving ? 'resolve' : kind)}
      initial={{}}
      form={form}
      version={client.version}
      currentVersion={current.version}
      onClose={onClose}
      onDone={onDone}
    >
      {isNote || kind === 'block' ? (
        <Form.Item
          name={isNote ? 'text' : 'reason'}
          label={isNote ? 'Текст заметки' : 'Причина блокировки'}
          rules={[{ required: true, whitespace: true, message: 'Заполните поле.' }]}
        >
          <Input.TextArea rows={4} maxLength={isNote ? 4000 : 1000} />
        </Form.Item>
      ) : (
        <p>
          {isResolving
            ? 'Заметка останется в истории с автором и датой закрытия.'
            : 'Клиент снова сможет оформлять новые бронирования после подключения этого раздела.'}
        </p>
      )}
    </CommandModal>
  );
}
export function Notes({
  client,
  onAction,
}: {
  client: Customer;
  onAction: (kind: ClientActionKind) => void;
}) {
  const poll = usePolling<{ items: CustomerNote[] }>('/customers/' + client.id + '/notes');
  return (
    <>
      <Button onClick={() => onAction('note')}>Добавить заметку</Button>
      <PollNotice {...poll} />
      {poll.data?.items.map((note) => (
        <Card
          key={note.id}
          className="notice"
          title={
            <Space wrap>
              <Tag color={note.isActive ? 'blue' : 'default'}>
                {note.isActive ? 'Актуальна' : 'Закрыта'}
              </Tag>
              <span>
                {note.author} · {dateText(note.createdAt)}
              </span>
            </Space>
          }
          extra={
            note.isActive ? (
              <Button onClick={() => onAction(`resolve:${note.id}`)}>Закрыть заметку</Button>
            ) : undefined
          }
        >
          <p className="preserve-lines">{note.text}</p>
          {!note.isActive && (
            <p>
              Закрыл: {note.resolvedBy} · {dateText(note.resolvedAt!)}
            </p>
          )}
        </Card>
      ))}
      {poll.data?.items.length === 0 && <p>Заметок пока нет.</p>}
    </>
  );
}
