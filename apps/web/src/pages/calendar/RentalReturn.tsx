import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MouseEventHandler } from 'react';
import { DamageChargeForm } from './DamageChargeForm';
import {
  CameraOutlined,
  CarOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  DashboardOutlined,
  DownOutlined,
  FileTextOutlined,
  FireOutlined,
  ToolOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Select,
  Slider,
  Space,
  Switch,
  Upload,
} from 'antd';
import { Link } from 'react-router-dom';
import { api, ApiError, createIdempotencyKey, errorMessage } from '../../api';
import { useAuth } from '../../auth';
import type { DocumentCommand } from '../../features/documents/useDocumentCommand';
import { ReturnPayments } from './ReturnPayments';
import type { InspectionWork } from '../../features/documents/document-types';
import { rub } from '../../shared/formatters';
import { local } from './dates';

const preparations = [
  { value: 'wash', label: 'Мойка' },
  { value: 'maintenance', label: 'ТО' },
  { value: 'repair', label: 'Ремонт' },
];
const labels = {
  rent: 'Аренда',
  surcharge: 'Опоздание или перепробег',
  fuel: 'Топливо',
  wash: 'Мойка',
};
type Line = keyof typeof labels;
const lines = Object.keys(labels) as Line[];
const dateTimeInput = (value: string) =>
  local(value) + ':' + new Date(value).toISOString().slice(17, 19);
type Inspection = {
  returnedAt: string;
  mileageKm: number;
  fuelEighths: number;
  remarks: string;
  backdateReason?: string;
  damage: boolean;
  photoException: boolean;
  photoIds: string[];
  excludedPhotoIds?: string[];
  preparation: string[];
};
type Adjustment = { line: Line; amountRub: string; reason: string };
type Calculation = {
  lines: Record<Line, string>;
  pricing: { lateCandidateRub: string; mileageCandidateRub: string; earlyReturn?: object };
  adjustments: (Adjustment & { originalRub: string; actorId: number; at: string })[];
  totalRub: string;
  receivedRub: string;
  debtRub: string;
  overpaymentRub: string;
  differenceRub: string;
};
type Preview = { calculation: Calculation; token: string; revision: number; missingLines: Line[] };
type SettlementInput = { expectedRevision: number; wash: boolean; adjustments: Adjustment[] };
type SettlementReview = { input: SettlementInput; attempt: number } & (
  { preview: Preview; error?: never } | { error: string; preview?: never }
);
export type RentalReturnData = {
  rental: {
    issuedAt: string;
    returnedAt: string | null;
    mileageOut: number;
    fuelOut: number;
    maintenanceDue: number | null;
    customerId: number;
    version: number;
  };
  history: {
    revision: number;
    inspection: Inspection;
    calculation: Calculation | null;
    actor: string;
    at: string;
    reason: string | null;
  }[];
  inspectionWork: InspectionWork | null;
  finance: {
    bookingId: number;
    customerId: number;
    bookingVersion: number;
    priceRub: string;
    coverageRub: string;
    debtRub: string;
    overpaymentRub: string;
    depositRub: string;
  };
  reserves: { amountRub: string; releaseAt: string }[];
  photos: { id: string; status: string; addedBy: string; addedAt: string }[];
  damageCharges: { id: number; amountRub: string; reason: string; actor: string; at: string }[];
};

export function RentalReturn({
  id,
  data,
  reload,
  command,
  actionsContainer,
  settlementContainer,
  settlementActionsContainer,
  onReveal,
  onRevealSettlement,
  onChanged,
  onBusy,
  onEditing,
  onDirty,
  onSettlementDirty,
  onPaymentClick,
}: {
  id: number;
  data: RentalReturnData;
  reload: () => Promise<void>;
  command: DocumentCommand;
  actionsContainer: HTMLElement | null;
  settlementContainer: HTMLElement | null;
  settlementActionsContainer: HTMLElement | null;
  onReveal: () => void;
  onRevealSettlement: () => void;
  onChanged: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onEditing: (editing: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onSettlementDirty: (dirty: boolean) => void;
  onPaymentClick: MouseEventHandler<HTMLAnchorElement>;
}) {
  const { user } = useAuth();
  const path = '/bookings/' + id;
  const photoPath = '/api/v1' + path + '/inspection-photos/';
  const acceptedPhotos = 'image/jpeg,image/png';
  const latest = data.history[0];
  const returned = !!data.rental.returnedAt;
  const work = data.inspectionWork;
  const ownWork = !!work && work.operatorId === user?.id;
  const [draft, setEdit] = useState<{
    correction: boolean;
    workId?: number;
    revision: number;
    inspection: Inspection;
    excludedPhotoIds: string[];
    reason: string;
    manualTime: boolean;
  }>();
  const edit = draft?.correction === returned ? draft : undefined;
  const originalDraft = useRef(edit);
  const [fileIds, setFileIds] = useState<string[]>([]);
  const originalFileCount = useRef(0);
  const dirty =
    !!edit &&
    (JSON.stringify(edit) !== JSON.stringify(originalDraft.current) ||
      (!returned && fileIds.length !== originalFileCount.current));
  const [confirming, setConfirming] = useState<'cancel' | number>();
  const [photoPreview, setPhotoPreview] = useState<string>();
  const cameraInput = useRef<HTMLInputElement>(null);
  const [wash, setWash] = useState(false);
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [settlementReview, setSettlementReview] = useState<SettlementReview>();
  const [reviewAttempt, setReviewAttempt] = useState(0);
  const [removed, setRemoved] = useState<Line[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [reviewEdited, setReviewEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const actionRunning = useRef(false);
  const [error, setError] = useState<{ area: 'inspection' | 'settlement'; message: string }>();
  const [uploadFailed, setUploadFailed] = useState(false);
  const [damageDirty, setDamageDirty] = useState(false);
  const [paymentsDirty, setPaymentsDirty] = useState(false);
  const request = useRef<{ fingerprint: string; key: string }>(null);
  const readyPhotos = data.photos.filter(
    ({ id, status }) => status === 'ready' && !edit?.excludedPhotoIds.includes(id),
  );
  const settlementDirty =
    damageDirty ||
    (!edit && !work && paymentsDirty) ||
    (!returned && (wash || adjustments.length > 0));
  useEffect(() => onSettlementDirty(settlementDirty), [settlementDirty, onSettlementDirty]);
  const waiting = data.photos.some((photo) => photo.status === 'pending');
  const failed = uploadFailed || data.photos.some((photo) => photo.status === 'failed');
  const locked = command.locked || busy;
  const isEditing = returned && !!edit;
  useEffect(() => onEditing(isEditing), [isEditing, onEditing]);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  function openEditor(workId?: number) {
    onReveal();
    const initial = {
      correction: returned,
      workId,
      revision: latest?.revision ?? 0,
      inspection: latest?.inspection ?? {
        returnedAt: new Date().toISOString(),
        mileageKm: data.rental.mileageOut,
        fuelEighths: data.rental.fuelOut,
        remarks: '',
        damage: false,
        photoException: false,
        photoIds: [],
        preparation: [],
      },
      reason: '',
      manualTime: false,
      excludedPhotoIds: [],
    };
    originalDraft.current = initial;
    originalFileCount.current = fileIds.length;
    setEdit(initial);
    setError(undefined);
    setPreview(undefined);
    setRemoved([]);
  }

  function startEdit(replaceWorkId?: number) {
    if (returned || (ownWork && work)) {
      openEditor(work?.id);
      return;
    }
    onReveal();
    void run(async () => {
      const { id: workId } = await submit<{ id: number }>(
        'inspections/check_in/start',
        { expectedBookingVersion: data.rental.version, replaceWorkId },
        true,
      );
      await reload();
      openEditor(workId);
    });
  }

  function discardEdit() {
    setEdit(undefined);
    setPreview(undefined);
    setRemoved([]);
    setError(undefined);
  }

  function cancelEdit() {
    if (!ownWork || !work || (edit && edit.workId !== work.id)) {
      discardEdit();
      return;
    }
    onReveal();
    void run(async () => {
      await submit(
        'inspections/check_in/cancel',
        { expectedBookingVersion: data.rental.version, workId: work.id },
        true,
      );
      await reload();
      discardEdit();
    });
  }

  function handleWorkConfirmation() {
    if (confirming === 'cancel') cancelEdit();
    if (typeof confirming === 'number') startEdit(confirming);
    setConfirming(undefined);
  }

  function changeInspection(fields: Partial<Inspection>, manualTime = edit?.manualTime ?? false) {
    if (!edit) return;
    setEdit({ ...edit, manualTime, inspection: { ...edit.inspection, ...fields } });
    setPreview(undefined);
    setRemoved([]);
  }

  async function run(
    action: () => Promise<void>,
    area: 'inspection' | 'settlement' = 'inspection',
  ) {
    if (actionRunning.current) return;
    actionRunning.current = true;
    setBusy(true);
    onBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await reload();
      setError({ area, message: errorMessage(failure) });
    } finally {
      actionRunning.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  async function submit<T>(suffix: string, body: unknown, command = false) {
    const fingerprint = JSON.stringify([suffix, body]);
    if (command && request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: createIdempotencyKey() };
    const result = await api<T>(path + '/' + suffix, {
      method: 'POST',
      body,
      key: command ? request.current?.key : undefined,
    });
    if (command) request.current = null;
    return result;
  }

  async function saveInspection() {
    if (!edit || !canSave) return;
    const inspection = edit.inspection;
    await submit(
      'return/inspection',
      {
        ...inspection,
        photoIds: readyPhotos.map(({ id }) => id),
        excludedPhotoIds: edit.excludedPhotoIds,
        returnedAt: edit.manualTime || latest ? inspection.returnedAt : null,
        backdateReason: inspection.backdateReason || undefined,
        expectedRevision: edit.revision,
        workId: edit.workId,
      },
      true,
    );
    setFileIds((previous) => previous.filter((id) => !edit.excludedPhotoIds.includes(id)));
    setEdit(undefined);
    await onChanged();
  }

  async function upload(files: File[]) {
    setUploadFailed(false);
    for (const file of files) {
      try {
        const { id } = await api<{ id: string }>(
          path + '/inspection-photos/check_in/' + data.rental.version,
          {
            method: 'POST',
            file,
            key: createIdempotencyKey(),
          },
        );
        setFileIds((previous) => [...previous, id]);
      } catch (failure) {
        setUploadFailed(true);
        setError({ area: 'inspection', message: errorMessage(failure) });
      }
    }
    await reload();
  }

  async function damageSaved() {
    await onChanged();
  }

  async function reviewCorrection(commit: boolean) {
    if (!edit) return;
    const body = {
      expectedRevision: edit.revision,
      returnedAt: edit.inspection.returnedAt,
      mileageKm: edit.inspection.mileageKm,
      fuelEighths: edit.inspection.fuelEighths,
      reason: edit.reason,
      removeLines: removed,
    };
    if (!commit) {
      setPreview(await submit<Preview>('return/correction-preview', body));
      setReviewEdited(false);
      return;
    }
    try {
      await submit('return/correct', { ...body, token: preview?.token }, true);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'RETURN_REVIEW_CHANGED')
        setPreview(await submit<Preview>('return/correction-preview', body));
      throw failure;
    }
    setPreview(undefined);
    setEdit(undefined);
    await onChanged();
  }

  function retrySettlementReview() {
    setReviewAttempt((attempt) => attempt + 1);
  }

  async function confirmReturn() {
    if (!settlementInput || !currentReview?.preview) return;
    try {
      await submit(
        'return/confirm',
        {
          ...settlementInput,
          expectedRevision: currentReview.preview.revision,
          token: currentReview.preview.token,
        },
        true,
      );
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'RETURN_REVIEW_CHANGED')
        retrySettlementReview();
      throw failure;
    }
    setSettlementReview(undefined);
    await onChanged();
  }

  function adjust(line: Line, values: Partial<Adjustment>) {
    const existing = adjustments.find((row) => row.line === line);
    setAdjustments([
      ...adjustments.filter((row) => row.line !== line),
      {
        line,
        amountRub: calculation?.lines[line] ?? '0',
        reason: '',
        ...existing,
        ...values,
      },
    ]);
  }

  const editing = edit?.inspection;
  const current = editing ?? latest?.inspection;
  const timeOfDay = current && local(current.returnedAt).slice(11);
  const outsideHours = timeOfDay && (timeOfDay < '09:15' || timeOfDay > '20:15');
  const maintenance =
    current &&
    data.rental.maintenanceDue !== null &&
    current.mileageKm >= data.rental.maintenanceDue;
  const fuelDeficit = editing ? data.rental.fuelOut - editing.fuelEighths : 0;
  const uncertainPhotos =
    waiting ||
    fileIds.some(
      (id) =>
        !latest?.inspection.excludedPhotoIds?.includes(id) &&
        !data.photos.some((photo) => photo.id === id),
    );
  const draftStale = edit && edit.revision !== (latest?.revision ?? 0);
  const workChanged = !!edit && !returned && (!ownWork || edit.workId !== work?.id);
  const draftLocked = locked || !!draftStale || workChanged;
  const invalid =
    !editing || !Number.isInteger(editing.mileageKm) || editing.mileageKm < data.rental.mileageOut;
  const adjustedInputInvalid = adjustments.some(
    ({ amountRub, reason }) => !/^\d+$/.test(amountRub) || !reason.trim(),
  );
  const reviewRevision = !returned && !work && !edit ? latest?.revision : undefined;
  const settlementInput = useMemo(
    (): SettlementInput | undefined =>
      reviewRevision === undefined || adjustedInputInvalid
        ? undefined
        : { expectedRevision: reviewRevision, wash, adjustments },
    [reviewRevision, adjustedInputInvalid, wash, adjustments],
  );
  useEffect(() => {
    if (!settlementInput) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const preview = await api<Preview>(path + '/return/review', {
          method: 'POST',
          body: settlementInput,
        });
        if (active)
          setSettlementReview({ input: settlementInput, attempt: reviewAttempt, preview });
      } catch (failure) {
        if (active)
          setSettlementReview({
            input: settlementInput,
            attempt: reviewAttempt,
            error: errorMessage(failure),
          });
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [path, settlementInput, reviewAttempt]);
  const currentReview =
    settlementReview?.input === settlementInput && settlementReview?.attempt === reviewAttempt
      ? settlementReview
      : undefined;
  const reviewing = !!settlementInput && !currentReview;
  const visiblePreview = returned && edit ? preview : undefined;
  const calculation = returned
    ? (visiblePreview?.calculation ?? latest?.calculation)
    : currentReview?.preview?.calculation;
  const correctionReady =
    !!visiblePreview &&
    !reviewEdited &&
    !draftStale &&
    visiblePreview.missingLines.every((line) => removed.includes(line));
  const canPreviewCorrection =
    returned && !!edit && !draftLocked && !invalid && !!edit.reason.trim();
  const canAddPhotos = returned ? !locked : !!edit && !draftLocked;
  const canRemovePhotos = !!edit && !returned && !draftLocked;
  const canSave =
    !!edit &&
    !draftLocked &&
    !invalid &&
    !(edit.manualTime && !edit.inspection.backdateReason?.trim()) &&
    (!uncertainPhotos || edit.inspection.photoException) &&
    (!edit.inspection.damage ||
      (!!edit.inspection.remarks.trim() &&
        (readyPhotos.length > 0 || edit.inspection.photoException)));
  const editLabel = returned
    ? 'Исправить приёмку'
    : latest
      ? 'Изменить осмотр'
      : 'Заполнить осмотр';
  const headerActions =
    edit && !workChanged ? (
      <Space wrap size="small" className="inspection-header-actions">
        <Button disabled={locked} onClick={() => (dirty ? setConfirming('cancel') : cancelEdit())}>
          Отменить
        </Button>
        {returned ? (
          <Button
            className="checkout-primary-button"
            type="primary"
            disabled={!canPreviewCorrection}
            onClick={onRevealSettlement}
          >
            К расчёту исправления
          </Button>
        ) : (
          <Button
            className="checkout-primary-button"
            type="primary"
            icon={<FileTextOutlined aria-hidden="true" />}
            disabled={!canSave}
            loading={busy}
            onClick={() => {
              onReveal();
              void run(saveInspection);
            }}
          >
            Сохранить акт
          </Button>
        )}
      </Space>
    ) : work ? (
      <Space wrap size="small" className="inspection-header-actions">
        {ownWork && (
          <Button disabled={locked} onClick={cancelEdit}>
            Отменить
          </Button>
        )}
        <Button
          className={ownWork ? 'checkout-primary-button' : undefined}
          type={ownWork ? 'primary' : 'default'}
          disabled={locked}
          onClick={() => (ownWork ? startEdit() : setConfirming(work.id))}
        >
          {ownWork ? 'Продолжить осмотр' : 'Взять осмотр в работу'}
        </Button>
      </Space>
    ) : (
      <Button
        className={!latest ? 'checkout-primary-button' : undefined}
        type={latest ? 'default' : 'primary'}
        disabled={locked}
        onClick={() => startEdit()}
      >
        {editLabel}
      </Button>
    );

  function handleSettlementConfirmation() {
    onRevealSettlement();
    const action = returned ? () => reviewCorrection(true) : confirmReturn;
    void run(action, 'settlement');
  }

  const settlementAction =
    returned && !edit ? null : (
      <Button
        className="checkout-primary-button"
        type="primary"
        disabled={
          locked || (returned ? !correctionReady || !canPreviewCorrection : !currentReview?.preview)
        }
        onClick={handleSettlementConfirmation}
      >
        {returned ? 'Подтвердить исправление' : 'Подтвердить приёмку'}
      </Button>
    );
  const finalBalance = returned && !visiblePreview;
  const received = finalBalance ? data.finance.coverageRub : calculation?.receivedRub;
  const debt = finalBalance ? data.finance.debtRub : calculation?.debtRub;
  const overpayment = finalBalance ? data.finance.overpaymentRub : calculation?.overpaymentRub;
  const rentBalance = finalBalance
    ? {
        due: data.finance.debtRub,
        price: data.finance.priceRub,
        received: data.finance.coverageRub,
      }
    : calculation && {
        due: calculation.debtRub,
        price: calculation.totalRub,
        received: calculation.receivedRub,
      };
  const settlement = (
    <div className="checkout-return-settlement">
      {error?.area === 'settlement' && <Alert showIcon type="error" message={error.message} />}
      {work ? (
        <Alert
          type="info"
          showIcon
          message="Дождитесь завершения осмотра в разделе «Акт приёмки»."
        />
      ) : (
        <>
          {reviewing && <span role="status">Обновляем итоговый расчёт…</span>}
          {currentReview?.error && (
            <Alert
              showIcon
              type="error"
              message={currentReview.error}
              action={<Button onClick={retrySettlementReview}>Повторить</Button>}
            />
          )}
          {returned && edit && (
            <Button
              className="checkout-primary-button"
              type={correctionReady ? 'default' : 'primary'}
              disabled={!canPreviewCorrection}
              onClick={() => void run(() => reviewCorrection(false), 'settlement')}
            >
              Показать разницу в расчёте
            </Button>
          )}
          {!returned && !edit && (
            <p className="checkout-return-note">
              Подготовьте доплату и расчёт по залогу. Провести их можно после подтверждения приёмки.
            </p>
          )}
          {!edit && (
            <ReturnPayments
              data={data}
              rentBalance={rentBalance ?? null}
              confirmed={returned}
              command={command}
              disabled={locked}
              onDirty={setPaymentsDirty}
            />
          )}
          <div className="checkout-return-columns">
            <div className="checkout-payment-summary checkout-return-summary">
              <WalletOutlined aria-hidden="true" />
              <div>
                <h3>Итоговый расчёт</h3>
                <dl className="checkout-payment-totals">
                  <div>
                    <dt>Итого</dt>
                    <dd>{calculation ? rub(calculation.totalRub) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Получено</dt>
                    <dd>{received === undefined ? '—' : rub(received)}</dd>
                  </div>
                  <div>
                    <dt>К доплате</dt>
                    <dd>{debt === undefined ? '—' : rub(debt)}</dd>
                  </div>
                  <div>
                    <dt>Переплата по аренде</dt>
                    <dd>{overpayment === undefined ? '—' : rub(overpayment)}</dd>
                  </div>
                  <div>
                    <dt>Залог</dt>
                    <dd>{rub(data.finance.depositRub)}</dd>
                  </div>
                  {returned && visiblePreview && (
                    <div>
                      <dt>Изменение начисления</dt>
                      <dd>{rub(visiblePreview.calculation.differenceRub)}</dd>
                    </div>
                  )}
                </dl>
                <Link
                  to={`/payments?customerId=${data.rental.customerId}&bookingId=${data.finance.bookingId}`}
                  onClick={onPaymentClick}
                >
                  Платежи
                </Link>
              </div>
            </div>
            <div className="checkout-return-breakdown">
              <h3>Начисления</h3>
              <div className="checkout-return-lines">
                {lines.map((line) => {
                  const adjustment = adjustments.find((row) => row.line === line);
                  return (
                    <div key={line}>
                      <span>{labels[line]}</span>
                      <span className="checkout-return-amount">
                        {calculation ? rub(calculation.lines[line]) : '—'}
                      </span>
                      {!returned && !edit && adjustment && (
                        <div className="checkout-return-adjustment">
                          <label className="document-field">
                            Сумма, ₽
                            <Input
                              inputMode="numeric"
                              value={adjustment.amountRub}
                              disabled={locked}
                              onChange={(event) => adjust(line, { amountRub: event.target.value })}
                            />
                          </label>
                          <label className="document-field">
                            Причина
                            <Input
                              maxLength={1000}
                              value={adjustment.reason}
                              disabled={locked}
                              onChange={(event) => adjust(line, { reason: event.target.value })}
                            />
                          </label>
                          <Button
                            size="small"
                            disabled={locked}
                            onClick={() =>
                              setAdjustments(adjustments.filter((row) => row.line !== line))
                            }
                          >
                            Сбросить
                          </Button>
                        </div>
                      )}
                      {!returned && !edit && !adjustment && (
                        <Button
                          size="small"
                          type="link"
                          aria-label={`Изменить строку «${labels[line]}»`}
                          disabled={locked || !calculation}
                          onClick={() => adjust(line, {})}
                        >
                          Изменить
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              {calculation && (
                <p className="checkout-return-note">
                  По времени {rub(calculation.pricing.lateCandidateRub)} · по пробегу{' '}
                  {rub(calculation.pricing.mileageCandidateRub)}
                </p>
              )}
              {!returned && !edit && (
                <Checkbox
                  checked={wash}
                  disabled={locked}
                  onChange={(event) => setWash(event.target.checked)}
                >
                  Начислить мойку 1 000 ₽
                </Checkbox>
              )}
            </div>
          </div>
          {!returned && adjustedInputInvalid && (
            <Alert
              type="info"
              showIcon
              message="Укажите сумму в целых рублях и причину изменения строки."
            />
          )}
          {visiblePreview?.missingLines.map((line) => (
            <Checkbox
              key={line}
              checked={removed.includes(line)}
              disabled={locked}
              onChange={(event) => {
                setReviewEdited(true);
                setRemoved(
                  event.target.checked
                    ? [...removed, line]
                    : removed.filter((item) => item !== line),
                );
              }}
            >
              Снять строку «{labels[line]}». Основание исчезло. Пересчитайте разницу перед
              подтверждением.
            </Checkbox>
          ))}
          {returned && latest && user && (
            <DamageChargeForm
              key={user.id}
              userId={user.id}
              bookingId={id}
              revision={latest.revision}
              hidden={!!edit}
              disabled={locked}
              onDirty={setDamageDirty}
              run={run}
              onSaved={damageSaved}
            />
          )}
          {returned && (
            <details>
              <summary>История расчётов</summary>
              {data.history.map(
                ({ revision, at, actor, reason, calculation }) =>
                  calculation && (
                    <div key={revision}>
                      <p>
                        {local(at).replace('T', ' ')} · {actor} · {reason || 'Подтверждение'}
                      </p>
                      <p>Итог {rub(calculation.totalRub)}</p>
                      {calculation.adjustments.map((adjustment) => (
                        <p key={adjustment.line}>
                          {labels[adjustment.line]} {rub(adjustment.originalRub)} →{' '}
                          {rub(adjustment.amountRub)} · {adjustment.reason} · сотрудник №
                          {adjustment.actorId} · {local(adjustment.at).replace('T', ' ')}
                        </p>
                      ))}
                    </div>
                  ),
              )}
              {data.damageCharges.map((charge) => (
                <p key={charge.id}>
                  Ущерб {rub(charge.amountRub)} · {charge.reason} · {charge.actor} ·{' '}
                  {local(charge.at).replace('T', ' ')}
                </p>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );

  return (
    <Space
      direction="vertical"
      size="middle"
      className="document-stack inspection-editor return-act"
    >
      {actionsContainer && createPortal(headerActions, actionsContainer)}
      {!latest && !edit && !work && (
        <p>Зафиксируйте показания и состояние автомобиля при возврате.</p>
      )}
      {error?.area === 'inspection' && <Alert showIcon type="error" message={error.message} />}
      {(draftStale || workChanged) && (
        <Alert
          type="warning"
          message={
            workChanged
              ? 'Осмотр передан другому оператору или отменён.'
              : 'Осмотр обновил другой оператор.'
          }
          action={
            workChanged ? (
              <Button disabled={locked} onClick={discardEdit}>
                Закрыть черновик
              </Button>
            ) : (
              <Button disabled={locked} onClick={() => startEdit()}>
                Открыть актуальный осмотр
              </Button>
            )
          }
        />
      )}
      {editing ? (
        <>
          {outsideHours && (
            <Alert
              className="return-act-hours"
              showIcon
              type="warning"
              message="Возврат вне рабочих часов 09:15–20:15."
            />
          )}
          <div className="return-act-form">
            <div className="return-act-row">
              <div className="return-act-field">
                <label className="document-field">
                  <span className="return-act-label">
                    <ClockCircleOutlined aria-hidden="true" /> Время возврата (МСК)
                  </span>
                  <Input
                    type="datetime-local"
                    step={1}
                    value={dateTimeInput(editing.returnedAt)}
                    min={dateTimeInput(data.rental.issuedAt)}
                    max={dateTimeInput(new Date().toISOString())}
                    disabled={draftLocked}
                    onChange={(event) => {
                      if (event.target.value)
                        changeInspection(
                          { returnedAt: new Date(event.target.value + '+03:00').toISOString() },
                          true,
                        );
                    }}
                  />
                </label>
                {!latest && !edit.manualTime && (
                  <span className="return-act-hint">По умолчанию — время сохранения</span>
                )}
                {!returned && edit.manualTime && (
                  <label className="document-field">
                    <span>Причина ввода прошедшего времени</span>
                    <Input
                      value={editing.backdateReason}
                      disabled={draftLocked}
                      onChange={(event) => changeInspection({ backdateReason: event.target.value })}
                    />
                  </label>
                )}
              </div>
              {!returned && (
                <div className="return-act-field">
                  <span className="return-act-label">
                    <CarOutlined aria-hidden="true" /> Новые повреждения
                  </span>
                  <label className="return-act-damage">
                    <Switch
                      aria-label="Новые повреждения"
                      checked={editing.damage}
                      disabled={draftLocked}
                      onChange={(damage) => changeInspection({ damage })}
                    />
                    {editing.damage ? 'Есть новые повреждения' : 'Нет новых повреждений'}
                  </label>
                  {editing.damage && (failed || editing.photoException) && (
                    <Checkbox
                      checked={editing.photoException}
                      disabled={draftLocked}
                      onChange={(event) =>
                        changeInspection({ photoException: event.target.checked })
                      }
                    >
                      Подтвердить с описанием повреждений после сбоя загрузки
                    </Checkbox>
                  )}
                </div>
              )}
            </div>
            <div className="return-act-row">
              <label className="document-field">
                <span className="return-act-label">
                  <DashboardOutlined aria-hidden="true" /> Пробег при возврате, км
                </span>
                <InputNumber
                  aria-label="Пробег при возврате, км"
                  min={data.rental.mileageOut}
                  max={2147483647}
                  precision={0}
                  value={editing.mileageKm < 0 ? null : editing.mileageKm}
                  disabled={draftLocked}
                  formatter={(value, { userTyping, input }) =>
                    userTyping ? input : value == null ? '' : Number(value).toLocaleString('ru-RU')
                  }
                  onChange={(mileage) => changeInspection({ mileageKm: mileage ?? -1 })}
                />
                <span className="return-act-mileage return-act-hint">
                  <span>
                    При выдаче: <b>{data.rental.mileageOut.toLocaleString('ru-RU')} км</b>
                  </span>
                  <span>
                    За аренду:{' '}
                    <strong>
                      {Math.max(0, editing.mileageKm - data.rental.mileageOut).toLocaleString(
                        'ru-RU',
                      )}{' '}
                      км
                    </strong>
                  </span>
                </span>
              </label>
              <div className="return-act-field">
                <span className="return-act-label">
                  <FireOutlined aria-hidden="true" /> Топливо при возврате · {editing.fuelEighths}/8
                </span>
                <div className="return-act-fuel-meter">
                  <div className="return-act-fuel-marker-track" aria-hidden="true">
                    <span
                      className="return-act-fuel-marker"
                      style={{ left: `${(data.rental.fuelOut / 8) * 100}%` }}
                    >
                      Выдача
                    </span>
                  </div>
                  <Slider
                    ariaLabelForHandle="Топливо при возврате"
                    ariaValueTextFormatterForHandle={(value) =>
                      `${value}/8. При выдаче: ${data.rental.fuelOut}/8`
                    }
                    className="return-act-fuel-slider"
                    min={0}
                    max={8}
                    marks={{ 0: '0', 2: '2', 4: '4', 6: '6', 8: '8' }}
                    value={editing.fuelEighths}
                    disabled={draftLocked}
                    onChange={(fuelEighths) => changeInspection({ fuelEighths })}
                  />
                </div>
                {fuelDeficit > 0 && (
                  <span className="return-act-fuel-deficit">Недостача: {fuelDeficit}/8</span>
                )}
              </div>
            </div>
            {returned ? (
              <label className="document-field return-act-row">
                <span>Причина исправления</span>
                <Input.TextArea
                  value={edit.reason}
                  disabled={draftLocked}
                  onChange={(event) => {
                    setEdit({ ...edit, reason: event.target.value });
                    setPreview(undefined);
                  }}
                />
              </label>
            ) : (
              <div className="return-act-row">
                <label className="document-field">
                  <span className="return-act-label">
                    <FileTextOutlined aria-hidden="true" /> Замечания
                  </span>
                  <Input.TextArea
                    placeholder="При наличии"
                    value={editing.remarks}
                    autoSize={{ minRows: 2 }}
                    maxLength={4000}
                    disabled={draftLocked}
                    onChange={(event) => changeInspection({ remarks: event.target.value })}
                  />
                </label>
                <label className="document-field">
                  <span className="return-act-label">
                    <ToolOutlined aria-hidden="true" /> Подготовка автомобиля
                  </span>
                  <Select
                    aria-label="Подготовка автомобиля"
                    placeholder="Выберите состояние автомобиля"
                    suffixIcon={<DownOutlined />}
                    mode="multiple"
                    virtual={false}
                    options={preparations}
                    value={editing.preparation}
                    disabled={draftLocked}
                    onChange={(preparation) => changeInspection({ preparation })}
                  />
                </label>
              </div>
            )}
          </div>
          {maintenance && (
            <Alert type="warning" message={`Достигнут порог ТО ${data.rental.maintenanceDue} км`} />
          )}
          {invalid && (
            <p role="alert">Пробег при возврате должен быть не меньше пробега при выдаче.</p>
          )}
        </>
      ) : (
        <>
          {current && (
            <Descriptions
              size="small"
              column={1}
              items={[
                {
                  key: 'time',
                  label: 'Фактический возврат (МСК)',
                  children: local(current.returnedAt).replace('T', ' '),
                },
                {
                  key: 'mileage',
                  label: 'Пробег',
                  children: `${current.mileageKm} км (+${current.mileageKm - data.rental.mileageOut} км)`,
                },
                { key: 'fuel', label: 'Топливо', children: current.fuelEighths + '/8' },
                { key: 'remarks', label: 'Замечания', children: current.remarks || '—' },
                {
                  key: 'preparation',
                  label: 'Подготовка',
                  children:
                    preparations
                      .filter(({ value }) => current.preparation.includes(value))
                      .map(({ label }) => label)
                      .join(', ') || '—',
                },
              ]}
            />
          )}
        </>
      )}
      {(edit || latest) && (
        <section className="inspection-photo-section" aria-label="Фотографии приёмки">
          <h3>
            <CameraOutlined aria-hidden="true" /> Фотографии приёмки
            <span className="inspection-photo-count">{readyPhotos.length}</span>
          </h3>
          <Upload
            className="inspection-photos inspection-photos-edit"
            listType="picture-card"
            accept={acceptedPhotos}
            multiple
            disabled={locked || (!!edit && draftLocked)}
            fileList={readyPhotos.map(({ id }, index) => ({
              uid: id,
              name: 'Фото приёмки ' + (index + 1),
              status: 'done',
              url: photoPath + id,
              thumbUrl: photoPath + id,
            }))}
            beforeUpload={(file, files) => {
              if (canAddPhotos && file === files[0]) void run(() => upload(files));
              return Upload.LIST_IGNORE;
            }}
            showUploadList={{
              showPreviewIcon: false,
              showDownloadIcon: false,
              showRemoveIcon: canRemovePhotos,
              removeIcon: <CloseOutlined aria-hidden="true" />,
            }}
            onPreview={(file) => setPhotoPreview(file.url)}
            onRemove={(file) => {
              if (!canRemovePhotos) return false;
              setEdit(
                (previous) =>
                  previous && {
                    ...previous,
                    excludedPhotoIds: [...previous.excludedPhotoIds, file.uid],
                  },
              );
              return true;
            }}
          >
            {canAddPhotos && (
              <Space direction="vertical" size={4}>
                <CameraOutlined aria-hidden="true" />
                <span>Добавить фото</span>
              </Space>
            )}
          </Upload>
          <input
            ref={cameraInput}
            type="file"
            accept={acceptedPhotos}
            capture="environment"
            disabled={!canAddPhotos}
            hidden
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (files.length) void run(() => upload(files));
            }}
          />
          {canAddPhotos && (
            <Button
              className="inspection-camera-button"
              icon={<CameraOutlined />}
              onClick={() => cameraInput.current?.click()}
            >
              Сделать снимок
            </Button>
          )}
          {uncertainPhotos && <p role="status">Фотографии загружаются…</p>}
          {data.photos.some(({ status }) => status === 'expired' || status === 'deleted') && (
            <p>Фото удалены по сроку хранения.</p>
          )}
        </section>
      )}
      {settlementContainer && latest && createPortal(settlement, settlementContainer)}
      {settlementActionsContainer &&
        latest &&
        createPortal(settlementAction, settlementActionsContainer)}
      {data.history.length > 0 && (
        <details>
          <summary>История приёмки</summary>
          {data.history.map((row) => (
            <div key={row.revision}>
              <p>
                {local(row.at).replace('T', ' ')} · {row.actor} ·{' '}
                {row.reason || (row.calculation ? 'Подтверждение' : 'Сохранение осмотра')}
              </p>
              <p>
                {local(row.inspection.returnedAt).replace('T', ' ')} · {row.inspection.mileageKm} км
                · топливо {row.inspection.fuelEighths}/8. {row.inspection.backdateReason}{' '}
                {row.inspection.remarks}
              </p>
              {row.inspection.photoException && <p>Зафиксирован сбой загрузки фотографии.</p>}
            </div>
          ))}
          {data.photos
            .filter(({ addedBy }) => addedBy)
            .map((photo) => (
              <p key={photo.id}>
                Фото добавлено {local(photo.addedAt).replace('T', ' ')} · {photo.addedBy}
              </p>
            ))}
        </details>
      )}
      <Modal
        open={confirming !== undefined}
        title={confirming === 'cancel' ? 'Отменить изменения осмотра?' : 'Взять осмотр в работу?'}
        okText={confirming === 'cancel' ? 'Отменить изменения' : 'Взять в работу'}
        cancelText="Назад"
        onOk={handleWorkConfirmation}
        onCancel={() => setConfirming(undefined)}
      >
        {confirming === 'cancel'
          ? 'Правки в форме будут потеряны.'
          : 'Вы станете ответственным за осмотр. Несохранённые данные другого оператора не перенесутся.'}
      </Modal>
      <Modal
        open={!!photoPreview}
        title="Фото приёмки"
        footer={null}
        onCancel={() => setPhotoPreview(undefined)}
      >
        {photoPreview && <img src={photoPreview} alt="Фото приёмки" style={{ width: '100%' }} />}
      </Modal>
    </Space>
  );
}
