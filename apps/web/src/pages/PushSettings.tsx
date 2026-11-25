import { useEffect, useState } from 'react';
import { Alert, Button } from 'antd';
import { api, errorMessage } from '../api';

export default function PushSettings() {
  const [key, setKey] = useState('');
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    async function load() {
      if (
        !window.isSecureContext ||
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      )
        throw new Error('Откройте CRM по HTTPS. На iPhone запустите её с домашнего экрана.');
      const { publicKey } = await api<{ publicKey: string | null }>('/push/config');
      if (!publicKey) throw new Error('Уведомления ещё не настроены на сервере.');
      await navigator.serviceWorker.register('/push-sw.js');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      const subscribed =
        sub &&
        (
          await api<{ subscribed: boolean }>('/push/status', {
            method: 'POST',
            body: { endpoint: sub.endpoint },
          })
        ).subscribed;
      if (active) {
        setEnabled(!!subscribed);
        setKey(publicKey);
        setRegistration(reg);
      }
    }
    void load().catch((e) => {
      if (active) setNotice(errorMessage(e));
    });
    return () => {
      active = false;
    };
  }, []);

  async function toggle() {
    if (!registration || busy) return;
    setBusy(true);
    setNotice('');
    try {
      if (!enabled && (await Notification.requestPermission()) !== 'granted')
        throw new Error('Разрешите уведомления для CRM в настройках устройства.');
      const existing = await registration.pushManager.getSubscription();
      if (enabled) {
        if (existing) {
          await api('/push/unsubscribe', { method: 'POST', body: { endpoint: existing.endpoint } });
          setEnabled(false);
          await existing.unsubscribe();
        } else setEnabled(false);
      } else {
        const sub =
          existing ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          }));
        await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
        setEnabled(true);
      }
    } catch (e) {
      setNotice(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>Уведомления о выдаче и приёмке</h2>
      <Button onClick={() => void toggle()} loading={busy} disabled={!registration}>
        {enabled ? 'Отключить на этом устройстве' : 'Включить на этом устройстве'}
      </Button>
      {notice && <Alert type="warning" message={notice} showIcon />}
    </section>
  );
}
