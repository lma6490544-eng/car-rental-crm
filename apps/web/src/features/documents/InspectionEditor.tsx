import { useEffect, useRef, useState } from 'react';
import type { MouseEventHandler, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  CameraOutlined,
  CarOutlined,
  CloseOutlined,
  DashboardOutlined,
  EditOutlined,
  FileTextOutlined,
  FireOutlined,
  PictureOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Slider,
  Space,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { UploadFile } from 'antd';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { OpenDocumentButton } from './ContractEditor';
import type {
  BookingDocuments,
  ActVersion,
  InspectionVersion,
  InspectionWork,
  PhotoKind,
} from './document-types';
import type { DocumentCommand } from './useDocumentCommand';

type Draft = {
  workId: number;
  vehicleId: number | null;
  expectedRevision: number;
  mileageKm: number | null;
  fuelEighths: number | null;
  damageNotes: string;
  specialNotes: string;
  photoIds: string[];
  acknowledgeNoPhotos: boolean;
};
const acceptedPhotos = 'image/jpeg,image/png';
const photoLimit = 20;
const kindLabel = { pickup: 'Осмотр выдачи', check_in: 'Осмотр приёмки' };
export const actGeneratingLabel = 'Формируем акт…';

export function InspectionEditor({
  id,
  data,
  command,
  actionsContainer,
  replaceVehicleAction,
  onVehicleClick,
  kind,
  onKindChange,
  work,
  onReveal,
  disabled,
  onEditing,
  onDirty,
  onDocumentOpen,
  latestAct,
  actGenerating,
}: {
  id: number;
  data: BookingDocuments;
  command: DocumentCommand;
  actionsContainer: HTMLElement | null;
  replaceVehicleAction?: ReactNode;
  onVehicleClick: MouseEventHandler<HTMLAnchorElement>;
  kind: PhotoKind;
  onKindChange: (kind: PhotoKind) => void;
  work?: InspectionWork;
  onReveal: () => void;
  disabled: boolean;
  onEditing: (editing: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onDocumentOpen: (versionId: number) => void;
  latestAct?: ActVersion;
  actGenerating: boolean;
}) {
  const { user } = useAuth();
  const [draft, setDraft] = useState<Draft>();
  const [confirming, setConfirming] = useState<'cancel' | 'takeover'>();
  const originalDraft = useRef<Draft>(undefined);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [photoNotice, setPhotoNotice] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string>();
  const versions = data.inspections.filter((inspection) => inspection.kind === kind);
  const latest = versions[0];
  const currentInspection = latest?.vehicleId === data.booking.vehicleId ? latest : undefined;
  const path = '/bookings/' + id;
  const photoPath = path + '/inspection-photos';
  const pickupLocked = kind === 'pickup' && !!data.checkout?.issuedAt;
  const editable =
    !disabled &&
    !pickupLocked &&
    data.booking.status === 'confirmed' &&
    data.booking.vehicleId !== null;
  const locked = command.locked || disabled;
  const ownWork = !!work && work.operatorId === user?.id;
  const outdated =
    !!draft &&
    (!ownWork ||
      work?.id !== draft.workId ||
      draft.vehicleId !== data.booking.vehicleId ||
      draft.expectedRevision !== (latest?.revision ?? 0));
  const draftLocked = locked || outdated;
  const selectedReady =
    !!draft &&
    draft.photoIds.every((id) =>
      data.photos.some((photo) => photo.id === id && photo.status === 'ready'),
    );
  const canSave =
    editable &&
    !draftLocked &&
    draft?.expectedRevision === (latest?.revision ?? 0) &&
    draft?.vehicleId === data.booking.vehicleId &&
    selectedReady &&
    !!draft &&
    draft.mileageKm !== null &&
    draft.fuelEighths !== null &&
    (kind === 'check_in' || !!draft.photoIds.length || draft.acknowledgeNoPhotos);

  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(originalDraft.current);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  function stopEditing() {
    setDraft(undefined);
    onEditing(false);
  }
  function openEditor(workId: number, reload = false) {
    onReveal();
    if (!reload && draft?.workId === workId) return;
    setPhotoNotice('');
    onEditing(true);
    const base = currentInspection;
    const initial: Draft = {
      workId,
      vehicleId: data.booking.vehicleId,
      expectedRevision: latest?.revision ?? 0,
      mileageKm: base?.mileageKm ?? null,
      fuelEighths: base?.fuelEighths ?? null,
      damageNotes: base?.damageNotes ?? '',
      specialNotes: base?.specialNotes ?? '',
      photoIds:
        base?.photoIds.filter((id) =>
          data.photos.some((photo) => photo.id === id && photo.status === 'ready'),
        ) ?? [],
      acknowledgeNoPhotos: false,
    };
    originalDraft.current = initial;
    setDraft(initial);
  }
  function startEditing(reload = false, replaceWorkId?: number) {
    if (!editable || locked) return;
    if (ownWork && work) {
      openEditor(work.id, reload);
      return;
    }
    command.run(
      'inspections.start',
      path + '/inspections/' + kind + '/start',
      {
        body: { expectedBookingVersion: data.booking.version, replaceWorkId },
      },
      (workId) => openEditor(Number(workId), reload),
    );
  }
  function cancelEditing() {
    if (!ownWork || !work || work.id !== draft?.workId) {
      stopEditing();
      return;
    }
    command.run(
      'inspections.cancel',
      path + '/inspections/' + kind + '/cancel',
      {
        body: { expectedBookingVersion: data.booking.version, workId: work.id },
      },
      stopEditing,
    );
  }
  function confirmWorkAction() {
    if (confirming === 'takeover' && work) startEditing(false, work.id);
    if (confirming === 'cancel') cancelEditing();
    setConfirming(undefined);
  }
  function update(patch: Partial<Draft>) {
    setDraft((previous) => previous && { ...previous, ...patch });
  }
  function togglePhoto(id: string, selected: boolean) {
    setDraft(
      (previous) =>
        previous && {
          ...previous,
          acknowledgeNoPhotos: false,
          photoIds: selected
            ? [...new Set([...previous.photoIds, id])]
            : previous.photoIds.filter((file) => file !== id),
        },
    );
  }
  function save() {
    if (!draft || !canSave) return;
    const { vehicleId, ...fields } = draft;
    const damageNotes = draft.damageNotes.trim();
    if (vehicleId !== data.booking.vehicleId) return;
    command.run(
      'inspections.save',
      path + '/inspections/' + kind,
      {
        body: {
          ...fields,
          expectedBookingVersion: data.booking.version,
          damageNotes,
          noDamage: damageNotes.length === 0,
        },
      },
      stopEditing,
    );
  }
  function photoItems(ids: string[]): UploadFile[] {
    return ids.map((id) => {
      const photo = data.photos.find((item) => item.id === id);
      const name = 'Фото осмотра';
      if (photo?.status === 'ready') {
        const url = '/api/v1' + photoPath + '/' + id;
        return { uid: id, name, status: 'done', type: photo.mime, url, thumbUrl: url };
      }
      if (!photo || photo.status === 'pending')
        return { uid: id, name: 'Фото обрабатывается', status: 'uploading' };
      if (photo.status === 'failed')
        return { uid: id, name: 'Фото не загрузилось', status: 'error' };
      return { uid: id, name: 'Истёк срок хранения фото', status: 'error' };
    });
  }
  function showPhoto(file: UploadFile) {
    if (file.url) setPreviewUrl(file.url);
  }
  const canAddPhotos =
    !!draft && !outdated && data.storageConfigured && draft.photoIds.length < photoLimit;
  function uploadPhotos(files: File[]) {
    if (!draft || !canAddPhotos || draftLocked || !files.length) return;
    const batch = files.slice(0, photoLimit - draft.photoIds.length);
    setPhotoNotice(
      batch.length < files.length
        ? 'В осмотре может быть до 20 фото. Остальные выбранные файлы пропущены.'
        : '',
    );
    command.uploadFiles(photoPath + '/' + kind + '/' + data.booking.version, batch, (fileId) =>
      togglePhoto(String(fileId), true),
    );
  }
  const actConfigured = data.storageConfigured && data.lessorConfigured;
  const canGenerate =
    !!currentInspection &&
    !work &&
    !latestAct &&
    data.booking.status === 'confirmed' &&
    !locked &&
    actConfigured &&
    !draft;

  function generateAct() {
    if (!currentInspection || !canGenerate) return;
    command.run('acts.generate', path + '/acts', {
      body: {
        expectedBookingVersion: data.booking.version,
        inspectionRevisionId: currentInspection.id,
      },
    });
  }
  const summary = (inspection: InspectionVersion) => (
    <Space direction="vertical" className="document-stack">
      <dl className="inspection-metrics">
        <div>
          <dt>
            <DashboardOutlined aria-hidden="true" /> Одометр
          </dt>
          <dd>{inspection.mileageKm.toLocaleString('ru-RU')} км</dd>
        </div>
        <div>
          <dt>
            <FireOutlined aria-hidden="true" /> Топливо
          </dt>
          <dd>{inspection.fuelEighths}/8 бака</dd>
        </div>
      </dl>
      {inspection.vehicleSnapshot.nextMaintenanceDueKm != null && (
        <span className="inspection-maintenance">
          Следующее ТО · {inspection.vehicleSnapshot.nextMaintenanceDueKm.toLocaleString('ru-RU')}{' '}
          км
        </span>
      )}
      <dl className="inspection-notes">
        <div>
          <dt>
            <CarOutlined aria-hidden="true" /> Описание повреждений
          </dt>
          <dd className="document-text">
            {inspection.noDamage ? 'Повреждений нет' : inspection.damageNotes}
          </dd>
        </div>
        {inspection.specialNotes && (
          <div>
            <dt>
              <FileTextOutlined aria-hidden="true" /> Особые пометки
            </dt>
            <dd className="document-text">{inspection.specialNotes}</dd>
          </div>
        )}
      </dl>
      <section className="inspection-photo-section" aria-label="Фото осмотра">
        <h3>
          <CameraOutlined aria-hidden="true" /> Фото осмотра{' '}
          <span className="inspection-photo-count">{inspection.photoIds.length}</span>
        </h3>
        {inspection.photoIds.length > 0 && (
          <Upload
            className="inspection-photos"
            listType="picture-card"
            fileList={photoItems(inspection.photoIds)}
            showUploadList={{
              showPreviewIcon: false,
              showRemoveIcon: false,
              showDownloadIcon: false,
            }}
            onPreview={showPhoto}
          />
        )}
        {inspection.noPhotosAcknowledged && (
          <span className="inspection-maintenance">Отсутствие фото подтверждено.</span>
        )}
      </section>
    </Space>
  );
  let headerAction: ReactNode = (
    <Button
      type="primary"
      icon={<FileTextOutlined aria-hidden="true" />}
      disabled={!actGenerating && !canGenerate}
      loading={actGenerating}
      aria-busy={actGenerating}
      aria-label={actGenerating ? actGeneratingLabel : undefined}
      onClick={generateAct}
    >
      {actGenerating ? actGeneratingLabel : 'Сформировать акт'}
    </Button>
  );
  if (work) {
    headerAction = ownWork ? (
      <Button type="primary" disabled={locked || !editable} onClick={() => startEditing()}>
        Продолжить осмотр
      </Button>
    ) : (
      <Button disabled={locked || !editable} onClick={() => setConfirming('takeover')}>
        Взять осмотр в работу
      </Button>
    );
  } else if (!currentInspection) {
    headerAction = (
      <Button type="primary" disabled={locked || !editable} onClick={() => startEditing()}>
        Начать осмотр
      </Button>
    );
  } else if (!draft && latestAct?.status === 'ready') {
    headerAction = (
      <OpenDocumentButton
        path={path + '/acts/' + latestAct.id + '/pdf'}
        label="Открыть акт"
        onOpen={() => onDocumentOpen(latestAct.id)}
      />
    );
  }
  if (draft) {
    headerAction = (
      <Space wrap size="small" className="inspection-header-actions">
        {work && !ownWork && headerAction}
        <Button
          disabled={locked}
          onClick={() => (dirty ? setConfirming('cancel') : cancelEditing())}
        >
          Отменить
        </Button>
        <Button
          type="primary"
          icon={<FileTextOutlined aria-hidden="true" />}
          disabled={!canSave}
          onClick={save}
        >
          Сохранить акт
        </Button>
      </Space>
    );
  }
  const vehicleId = data.booking.vehicleId;
  const vehicle = currentInspection?.vehicleSnapshot ?? data.vehicle;
  const canEditInspection = !draft && !work && editable && currentInspection;
  return (
    <Space direction="vertical" size="middle" className="document-stack inspection-editor">
      {actionsContainer && createPortal(headerAction, actionsContainer)}
      {(vehicleId !== null || replaceVehicleAction) && (
        <div className="inspection-toolbar">
          <div>
            {currentInspection && !draft && <h3>Параметры при осмотре</h3>}
            <Space size="small" wrap>
              {vehicleId !== null && (
                <Link to={'/fleet/' + vehicleId} onClick={onVehicleClick}>
                  {vehicle
                    ? `${vehicle.brand} ${vehicle.model} · ${vehicle.plate}`
                    : 'Автомобиль №' + vehicleId}
                </Link>
              )}
              {replaceVehicleAction}
            </Space>
          </div>
          {canEditInspection && (
            <Tooltip title="Изменить осмотр" trigger={['hover', 'focus']}>
              <Button
                aria-label="Изменить осмотр"
                icon={<EditOutlined aria-hidden="true" />}
                disabled={locked}
                onClick={() => startEditing()}
              >
                Изменить осмотр
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      {data.checkout?.issuedAt && (
        <Segmented
          options={Object.entries(kindLabel).map(([value, label]) => ({ value, label }))}
          value={kind}
          onChange={(value) => onKindChange(value as PhotoKind)}
          disabled={!!draft || locked}
        />
      )}
      {latest && (
        <>
          {!work && !actGenerating && latestAct?.status === 'failed' && (
            <Space wrap>
              <Typography.Text type="danger">Ошибка генерации акта</Typography.Text>
              <Button
                disabled={locked}
                onClick={() =>
                  command.run('acts.retry', path + '/acts/' + latestAct.id + '/retry', { body: {} })
                }
              >
                Повторить генерацию акта
              </Button>
            </Space>
          )}
        </>
      )}
      {currentInspection && !draft && summary(currentInspection)}
      {data.booking.vehicleId === null && data.booking.status === 'confirmed' && (
        <Alert type="info" message="Назначьте автомобиль для оформления осмотра." />
      )}
      {draft && (
        <Space direction="vertical" size="middle" className="document-stack">
          {outdated && (
            <Alert
              type="warning"
              showIcon
              message="Осмотр изменился или передан другому оператору. Сверьте актуальные данные."
              action={
                <Button
                  disabled={locked || !editable || (!!work && !ownWork)}
                  onClick={() => startEditing(true)}
                >
                  Загрузить актуальный осмотр
                </Button>
              }
            />
          )}
          <div className="inspection-edit-metrics">
            <label className="document-field">
              <span>
                <DashboardOutlined aria-hidden="true" /> Одометр, км
              </span>
              <InputNumber
                aria-label="Одометр, км"
                value={draft.mileageKm}
                min={0}
                max={2147483647}
                precision={0}
                disabled={draftLocked}
                formatter={(value, { userTyping, input }) =>
                  userTyping ? input : value == null ? '' : Number(value).toLocaleString('ru-RU')
                }
                onChange={(value) => update({ mileageKm: value })}
              />
            </label>
            <div className="document-field inspection-fuel">
              <span>
                <FireOutlined aria-hidden="true" /> Топливо ·{' '}
                {draft.fuelEighths === null ? 'не выбрано' : `${draft.fuelEighths}/8`}
              </span>
              <Slider
                ariaLabelForHandle="Топливо, делений"
                className="inspection-fuel-slider"
                min={0}
                max={8}
                step={1}
                value={draft.fuelEighths ?? 0}
                marks={{ 0: '0', 2: '2', 4: '4', 6: '6', 8: '8' }}
                disabled={draftLocked}
                onChange={(value) => update({ fuelEighths: value })}
              />
              {draft.fuelEighths === null && (
                <Button
                  size="small"
                  disabled={draftLocked}
                  onClick={() => update({ fuelEighths: 0 })}
                >
                  Указать 0 делений
                </Button>
              )}
            </div>
          </div>
          <div className="inspection-edit-notes">
            <label className="document-field">
              <span>
                <CarOutlined aria-hidden="true" /> Описание повреждений
              </span>
              <Input.TextArea
                value={draft.damageNotes}
                onChange={(event) => update({ damageNotes: event.target.value })}
                maxLength={4000}
                autoSize={{ minRows: 2 }}
                disabled={draftLocked}
              />
            </label>
            <label className="document-field">
              <span>
                <FileTextOutlined aria-hidden="true" /> Особые пометки
              </span>
              <Input.TextArea
                value={draft.specialNotes}
                onChange={(event) => update({ specialNotes: event.target.value })}
                maxLength={4000}
                autoSize={{ minRows: 2 }}
                disabled={draftLocked}
              />
            </label>
          </div>
          <section className="inspection-photo-section" aria-label="Фото осмотра">
            <h3>
              <CameraOutlined aria-hidden="true" /> Фото осмотра
            </h3>
            <Upload
              className="inspection-photos inspection-photos-edit"
              listType="picture-card"
              accept={acceptedPhotos}
              multiple
              fileList={photoItems(draft.photoIds)}
              disabled={draftLocked}
              beforeUpload={(file, files) => {
                if (file === files[0]) uploadPhotos(files);
                return Upload.LIST_IGNORE;
              }}
              showUploadList={{
                showPreviewIcon: false,
                showDownloadIcon: false,
                removeIcon: <CloseOutlined aria-hidden="true" />,
              }}
              onPreview={showPhoto}
              onRemove={(file) => togglePhoto(file.uid, false)}
            >
              {canAddPhotos && (
                <Space direction="vertical" size={4}>
                  <PictureOutlined aria-hidden="true" />
                  <span>Добавить фото</span>
                </Space>
              )}
            </Upload>
            {canAddPhotos && (
              <>
                <input
                  ref={cameraInput}
                  type="file"
                  accept={acceptedPhotos}
                  capture="environment"
                  disabled={draftLocked}
                  hidden
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = '';
                    uploadPhotos(files);
                  }}
                />
                <Button
                  className="inspection-camera-button"
                  icon={<CameraOutlined />}
                  disabled={draftLocked}
                  onClick={() => cameraInput.current?.click()}
                >
                  Сделать снимок
                </Button>
              </>
            )}
          </section>
          {photoNotice && <Alert type="info" showIcon message={photoNotice} />}
          {kind === 'pickup' && !draft.photoIds.length && (
            <Alert
              type="warning"
              message="В осмотре нет фотографий."
              description={
                <Checkbox
                  checked={draft.acknowledgeNoPhotos}
                  disabled={draftLocked}
                  onChange={(event) => update({ acknowledgeNoPhotos: event.target.checked })}
                >
                  Подтверждаю сохранение осмотра без фото
                </Checkbox>
              }
            />
          )}
        </Space>
      )}
      <Modal
        open={!!confirming}
        title={
          confirming === 'takeover' ? 'Взять осмотр в работу?' : 'Отменить заполнение осмотра?'
        }
        okText={confirming === 'takeover' ? 'Взять в работу' : 'Отменить заполнение'}
        cancelText="Назад"
        onOk={confirmWorkAction}
        onCancel={() => setConfirming(undefined)}
      >
        {confirming === 'takeover'
          ? 'Ответственным за осмотр станете вы. Несохранённые данные другого оператора не перенесутся.'
          : 'Несохранённые изменения будут удалены.'}
      </Modal>
      <Modal
        title="Фото осмотра"
        open={!!previewUrl}
        footer={null}
        onCancel={() => setPreviewUrl(undefined)}
      >
        {previewUrl && <img src={previewUrl} alt="Фото осмотра" style={{ width: '100%' }} />}
      </Modal>
    </Space>
  );
}
