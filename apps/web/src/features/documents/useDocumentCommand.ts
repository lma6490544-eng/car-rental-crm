import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../api';
import type { AdditionalDriver } from './document-types';

type CommandName =
  | 'customers.update'
  | 'finance.post'
  | 'files.upload'
  | 'inspections.save'
  | 'inspections.start'
  | 'inspections.cancel'
  | 'bookings.terms'
  | 'contracts.create'
  | 'contracts.retry'
  | 'checkout.start'
  | 'checkout.stop'
  | 'checkout.issue'
  | 'acts.generate'
  | 'acts.retry';
type Result = { id: number | string; version?: number };

type Attempt = {
  name: CommandName;
  path: string;
  key: string;
  data: { body: unknown; method?: 'PATCH' } | { file: File };
  done?: (id: number | string) => void;
  onRejected?: (failure: ApiError) => boolean;
  next?: (result: Result) => Attempt;
  onAvailabilityChanged?: () => void;
};

type Batch = { operations: Attempt[]; errors: string[] };

type ContractInput = {
  expectedBookingVersion: number;
  expectedCustomerVersion: number;
  expectedContractVersionId: number | null;
  securityDepositRub: string;
  additionalDriver: AdditionalDriver | null;
};

export type TermsChange = {
  body: unknown;
  onSaved: (version: number) => void;
  onAvailabilityChanged: () => void;
};

async function submit(operation: Attempt, check: boolean) {
  if (check) {
    const query = new URLSearchParams({ command: operation.name, key: operation.key });
    return (await api<{ result: Result }>('/operations/by-key?' + query)).result;
  }
  return api<Result>(operation.path, {
    method: 'POST',
    key: operation.key,
    ...operation.data,
  });
}

export function useDocumentCommand(
  reload: () => Promise<void>,
  onLock?: (locked: boolean) => void,
) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [activeCommand, setActiveCommand] = useState<CommandName>();
  const [pending, setPending] = useState<Batch>();
  const [error, setError] = useState('');
  const locked = busy || !!pending;
  useEffect(() => {
    if (!locked || !onLock) return;
    onLock(true);
    return () => onLock(false);
  }, [locked, onLock]);

  async function send(batch: Batch, check = false) {
    if (active.current) return;
    const operations = [...batch.operations];
    const errors = [...batch.errors];
    if (!navigator.onLine) {
      if (operations[0]?.name === 'files.upload') setPending(batch);
      setError('Нет связи. Повторите после восстановления соединения.');
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    try {
      for (const [index, operation] of operations.entries()) {
        setActiveCommand(operation.name);
        const checking = check && index === 0;
        try {
          const result = await submit(operation, checking);
          operation.done?.(result.id);
          if (operation.next) operations.push(operation.next(result));
        } catch (failure) {
          const error = errorMessage(failure);
          const uncertain =
            failure instanceof ApiError &&
            (failure.status === 0 || failure.status >= 500) &&
            !['CONTRACT_CONFIGURATION_REQUIRED', 'PRIVATE_STORAGE_UNAVAILABLE'].includes(
              failure.code,
            );
          if (checking || uncertain) {
            setPending({ operations: operations.slice(index), errors });
            setError([...new Set([...errors, error])].join(' '));
            return;
          }
          if (
            failure instanceof ApiError &&
            [
              'RISK_ACCEPTANCE_REQUIRED',
              'VEHICLE_ASSIGNMENT_CONFLICT',
              'VEHICLE_NOT_READY',
              'AVAILABILITY_CHANGED',
            ].includes(failure.code)
          ) {
            operation.onAvailabilityChanged?.();
          }
          if (!(failure instanceof ApiError && operation.onRejected?.(failure))) errors.push(error);
        }
      }
      setPending(undefined);
      setError([...new Set(errors)].join(' '));
    } finally {
      try {
        await reload();
      } finally {
        active.current = false;
        setActiveCommand(undefined);
        setBusy(false);
      }
    }
  }

  function run(
    name: CommandName,
    path: string,
    data: Attempt['data'],
    done?: Attempt['done'],
    onRejected?: Attempt['onRejected'],
  ) {
    if (!pending)
      void send({
        operations: [{ name, path, key: crypto.randomUUID(), data, done, onRejected }],
        errors: [],
      });
  }

  function createContract(
    path: string,
    body: ContractInput,
    done: () => void,
    terms?: TermsChange,
  ) {
    if (pending) return;
    const contract: Attempt = {
      name: 'contracts.create',
      path: path + '/contracts',
      key: crypto.randomUUID(),
      data: { body },
      done,
    };
    const first: Attempt = terms
      ? {
          name: 'bookings.terms',
          path: path + '/terms',
          key: crypto.randomUUID(),
          data: { method: 'PATCH', body: terms.body },
          onAvailabilityChanged: terms.onAvailabilityChanged,
          next(result) {
            if (result.version === undefined) {
              throw new Error('Условия сохранены. Дождитесь обновления брони и сформируйте PDF.');
            }
            terms.onSaved(result.version);
            return {
              ...contract,
              data: { body: { ...body, expectedBookingVersion: result.version } },
            };
          },
        }
      : contract;
    void send({ operations: [first], errors: [] });
  }

  function uploadFiles(path: string, files: File[], done: NonNullable<Attempt['done']>) {
    if (pending || !files.length) return;
    const operations = files.map((file): Attempt => ({
      name: 'files.upload',
      path,
      key: crypto.randomUUID(),
      data: { file },
      done,
    }));
    void send({ operations, errors: [] });
  }
  return {
    error,
    busy,
    activeCommand,
    locked,
    pending: !!pending,
    run,
    createContract,
    uploadFiles,
    retry: () => pending && void send(pending),
    check: () => pending && void send(pending, true),
  };
}

export type DocumentCommand = ReturnType<typeof useDocumentCommand>;
