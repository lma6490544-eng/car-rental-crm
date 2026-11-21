import { useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import type { FormInstance } from 'antd';
import type { Quote, PricingFormValues } from './types';
import { buildQuoteBody, baseFormValues } from './formData';
export function usePricingQuote(
  form: FormInstance<PricingFormValues>,
  history: { data?: import('./types').History; reload: () => Promise<void> },
) {
  const [operation, setOperation] = useState('initial'),
    [base, setBase] = useState<Quote>(),
    [quote, setQuote] = useState<Quote>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [ack, setAck] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<{ command: string; path: string; body: unknown; key: string } | null>(
      null,
    ),
    active = useRef(false);
  const saved = history.data?.items.find((h) => h.id === quote?.id);
  const changed = !!saved && !!quote && saved.version > quote.version;
  const result = (q: Quote) => {
    setQuote(q);
    setAck(false);
    setDirty(false);
    void history.reload();
  };
  const send = async () => {
    if (!pending.current || active.current || !navigator.onLine) return;
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const p = pending.current;
      result(await api<Quote>(p.path, { method: 'POST', body: p.body, key: p.key }));
      pending.current = null;
      setUncertain(false);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) setUncertain(true);
      else {
        pending.current = null;
        setUncertain(false);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const recover = async () => {
    if (!pending.current || active.current) return;
    active.current = true;
    setBusy(true);
    try {
      const p = pending.current;
      const v = await api<{ result: Quote }>(
        '/operations/by-key?command=' + p.command + '&key=' + p.key,
      );
      result(v.result);
      pending.current = null;
      setUncertain(false);
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const submit = (v: PricingFormValues) => {
    try {
      const body = buildQuoteBody(v, operation, base);
      pending.current = {
        command: 'pricing.quote',
        path: '/pricing/quote',
        body,
        key: crypto.randomUUID(),
      };
      void send();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const load = async (id: number) => {
    if (active.current || uncertain) return;
    setBusy(true);
    setError('');
    try {
      result(await api<Quote>('/pricing/quotes/' + id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const startOperation = (kind: string) => {
    setBase(quote);
    setOperation(kind);
    setDirty(true);
    setAck(false);
    setError('');
    form.resetFields();
    form.setFieldsValue(baseFormValues(quote!, kind));
  };
  const initial = () => {
    setBase(undefined);
    setOperation('initial');
    setQuote(undefined);
    setDirty(false);
    setError('');
    form.resetFields();
  };
  const confirm = () => {
    if (!quote) return;
    pending.current = {
      command: 'pricing.confirm',
      path: '/pricing/quotes/' + quote.id + '/confirm',
      body: {
        expectedVersion: quote.version,
        confirmedOverrides: quote.calculation.overridesToConfirm,
      },
      key: crypto.randomUUID(),
    };
    void send();
  };
  const valuesChanged = () => {
    setDirty(true);
    setAck(false);
  };
  return {
    operation,
    base,
    quote,
    error,
    busy,
    dirty,
    ack,
    setAck,
    uncertain,
    changed,
    submit,
    load,
    startOperation,
    initial,
    confirm,
    recover,
    send,
    valuesChanged,
  };
}
