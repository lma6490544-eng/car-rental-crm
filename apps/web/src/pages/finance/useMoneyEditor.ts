import type { ShortfallWarning } from '../../contracts';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import type { MoneyEditorProps } from './types';
import { names } from './presentation';
import { availableSources, buildMoneyOperation } from './operationData';
export function useMoneyEditor({
  customerId,
  bookingId,
  data,
  onDone,
  onLock,
  initialKind = 'refund',
  operationId,
}: Omit<MoneyEditorProps, 'onClose'>) {
  const [kind, setKind] = useState(initialKind),
    [selectedBooking, setSelectedBooking] = useState(bookingId),
    [amount, setAmount] = useState(''),
    [method, setMethod] = useState('cash'),
    [fund, setFund] = useState('operating_cash'),
    [reason, setReason] = useState(
      ['rent_payment', 'deposit_receipt'].includes(initialKind) ? names[initialKind] : '',
    ),
    [parts, setParts] = useState<Record<string, string>>({});
  const [error, setError] = useState(''),
    [warning, setWarning] = useState<ShortfallWarning>(),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<{ key: string; body: unknown }>();
  const active = useRef(false),
    [version, setVersion] = useState(
      data?.bookings.find((b) => b.bookingId === bookingId)?.bookingVersion,
    );
  const summary = data?.bookings.find((b) => b.bookingId === selectedBooking);
  useEffect(() => {
    if (version === undefined && summary) setVersion(summary.bookingVersion);
  }, [summary, version]);
  useEffect(() => {
    onLock?.(busy || !!pending);
    return () => onLock?.(false);
  }, [busy, pending, onLock]);
  useEffect(() => {
    if (!pending && !busy) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const navigate = (e: MouseEvent) => {
      if ((e.target as Element)?.closest('a')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', leave);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', leave);
      document.removeEventListener('click', navigate, true);
    };
  }, [busy, pending]);
  const available = availableSources(data?.sources ?? [], kind, selectedBooking);
  const edit = () => {
    setWarning(undefined);
    setAccepted(false);
    setError('');
  };
  const conflict = summary && version !== summary.bookingVersion;
  const build = () =>
    buildMoneyOperation({
      kind,
      reason,
      fund,
      amount,
      method,
      operationId,
      customerId,
      selectedBooking,
      version,
      parts,
      available,
    });
  async function send(check = false) {
    if (active.current || !navigator.onLine) return;
    active.current = true;
    setBusy(true);
    setError('');
    let command = pending;
    try {
      if (check) {
        await api('/operations/by-key?command=finance.post&key=' + pending!.key);
        setPending(undefined);
        onDone();
        return;
      }
      command ??= {
        key: crypto.randomUUID(),
        body: {
          ...build(),
          ...(warning ? { shortfallAcknowledged: accepted, warningToken: warning.token } : {}),
        },
      };
      await api('/financial-operations', { method: 'POST', key: command.key, body: command.body });
      setPending(undefined);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError) {
        if (e.code === 'FUND_SHORTFALL_CONFIRMATION') {
          setWarning(e.details as ShortfallWarning);
          setAccepted(false);
        }
        if (e.status === 0 || e.status >= 500) setPending(command);
        else if (!check) setPending(undefined);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const sourceMode = ['to_credit', 'credit_use', 'refund'].includes(kind);
  const changeKind = (value: string) => {
    setKind(value);
    setParts({});
    setAmount('');
    setReason(['rent_payment', 'deposit_receipt'].includes(value) ? names[value] : '');
    edit();
  };
  const changeBooking = (value: number | undefined) => {
    setSelectedBooking(value);
    setVersion(data?.bookings.find((b) => b.bookingId === value)?.bookingVersion);
    setParts({});
    edit();
  };
  const changeFund = (value: string) => {
    setFund(value);
    edit();
  };
  const changeAmount = (value: string) => {
    setAmount(value);
    edit();
  };
  const changeMethod = (value: string) => {
    setMethod(value);
    edit();
  };
  const changeReason = (value: string) => {
    setReason(value);
    edit();
  };
  const changePart = (key: string, value: string) => {
    setParts({ ...parts, [key]: value });
    edit();
  };
  const acceptVersion = () => {
    setVersion(summary!.bookingVersion);
    edit();
  };
  const useSuggestedDeposit = () => {
    setAmount(summary!.suggestedDepositRub!);
    edit();
  };
  return {
    kind,
    selectedBooking,
    amount,
    method,
    fund,
    reason,
    parts,
    error,
    warning,
    accepted,
    setAccepted,
    busy,
    pending,
    summary,
    conflict,
    available,
    sourceMode,
    send,
    changeKind,
    changeBooking,
    changeFund,
    changeAmount,
    changeMethod,
    changeReason,
    changePart,
    acceptVersion,
    useSuggestedDeposit,
  };
}
