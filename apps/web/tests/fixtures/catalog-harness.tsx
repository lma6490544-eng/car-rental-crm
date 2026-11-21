import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Form, Input } from 'antd';
import { CommandModal, PollNotice, useListScroll, usePolling, History } from '../../src/catalog';

function Harness() {
  const [path, setPath] = useState('/contract/a');
  const [keep, setKeep] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [scrollKey, setScrollKey] = useState('a');
  const [ready, setReady] = useState(false);
  const [modal, setModal] = useState(false);
  const [version, setVersion] = useState(1);
  const [result, setResult] = useState('');
  const [form] = Form.useForm<{ name: string; expectedVersion?: number }>();
  useListScroll(scrollKey, ready);
  return (
    <div style={{ minHeight: 3000 }}>
      <div style={{ position: 'fixed', top: 0, right: 0, zIndex: 2000 }}>
        <button onClick={() => setPath('/contract/a')}>Path A</button>
        <button onClick={() => setPath('/contract/b')}>Path B</button>
        <button onClick={() => setPath('/contract/c')}>Path C</button>
        <button onClick={() => setKeep(!keep)}>Keep data</button>
        <button onClick={() => setMounted(!mounted)}>Mount polling</button>
        <button onClick={() => setScrollKey(scrollKey === 'a' ? 'b' : 'a')}>Scroll key</button>
        <button onClick={() => setReady(!ready)}>Scroll ready</button>
        <button
          onClick={() => {
            setVersion(1);
            setModal(true);
          }}
        >
          Open command
        </button>
        <button onClick={() => setVersion(2)}>Remote version</button>
      </div>
      {mounted && <Polling path={path} keep={keep} />}
      <output data-testid="result">{result}</output>
      {modal && (
        <CommandModal
          title="Contract command"
          path="/contract/save"
          command="contract.save"
          form={form}
          initial={{ name: 'original' }}
          version={1}
          currentVersion={version}
          prepare={(values) => ({ ...values, prepared: true })}
          onClose={() => setModal(false)}
          onDone={(value: { id: number }) => {
            setResult(String(value.id));
            setModal(false);
          }}
        >
          <Form.Item name="name" label="Contract name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </CommandModal>
      )}
      <History path="/contract/history" />
    </div>
  );
}
function Polling({ path, keep }: { path: string; keep: boolean }) {
  const poll = usePolling<{ value: string }>(path, keep);
  const originalReload = useRef(poll.reload);
  return (
    <section>
      <output data-testid="poll">
        {JSON.stringify({
          value: poll.data?.value ?? null,
          loading: poll.loading,
          error: poll.error,
          stable: originalReload.current === poll.reload,
        })}
      </output>
      <button onClick={() => void poll.reload()}>Reload data</button>
      <PollNotice {...poll} />
    </section>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
