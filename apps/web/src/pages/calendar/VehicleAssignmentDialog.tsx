import { Modal, Select } from 'antd';
import type { BookingDetail, BookingOptions } from '../../contracts';
import { compactVehicleOption } from '../../features/vehicles/CompactVehicleOption';

export type VehicleMove = { bookingId: number; vehicleId: number; startAt: string };

export function VehicleAssignmentDialog({
  booking,
  fleet,
  disabled,
  onClose,
  onMove,
}: {
  booking: BookingDetail;
  fleet?: BookingOptions;
  disabled: boolean;
  onClose: () => void;
  onMove: (request: VehicleMove) => void;
}) {
  const b = booking;
  const assigned = fleet?.vehicles.find((vehicle) => vehicle.id === b.vehicle_id);
  const statusById = new Map<number | null, BookingDetail['vehicleOptions'][number]>(
    (b.vehicleOptions ?? []).map((v) => [v.id, v]),
  );
  const groupByModel = new Map<number | undefined, number>(
    (fleet?.models ?? []).map((m) => [m.id, m.pricingGroupId]),
  );
  const currentTariffId =
    b.terms[0]?.snapshot.periods?.[0]?.pricingGroup?.id ??
    statusById.get(b.vehicle_id)?.pricingGroupId ??
    groupByModel.get(assigned?.modelId);
  const choices = (fleet?.vehicles ?? []).map((v) => {
    const status = statusById.get(v.id),
      busy = !!status?.busy,
      notReady = !v.isReady;
    return {
      ...compactVehicleOption(v),
      pricingGroupId: status?.pricingGroupId ?? groupByModel.get(v.modelId),
      free: !busy && !notReady,
      disabled: busy || notReady,
      title: busy ? 'Занят на выбранный период' : notReady ? 'Не готов к выдаче' : undefined,
    };
  });
  const assignmentOptions = [
    {
      label: 'Тот же тариф',
      options: choices.filter((v) => v.free && v.pricingGroupId === currentTariffId),
    },
    {
      label: 'Другие автомобили',
      options: choices.filter((v) => v.free && v.pricingGroupId !== currentTariffId),
    },
    { label: 'Недоступны на эти даты', options: choices.filter((v) => !v.free) },
  ].filter((group) => group.options.length);
  return (
    <Modal
      open
      title="Выберите автомобиль"
      footer={null}
      closable={!disabled}
      maskClosable={!disabled}
      keyboard={!disabled}
      onCancel={onClose}
    >
      <Select
        aria-label="Назначаемый автомобиль"
        showSearch
        optionFilterProp="searchLabel"
        style={{ width: '100%' }}
        placeholder="Найти модель или номер"
        value={b.vehicle_id ?? undefined}
        disabled={disabled}
        onChange={(vehicleId) => {
          if (!vehicleId || vehicleId === b.vehicle_id) return;
          onClose();
          onMove({ bookingId: b.id, vehicleId, startAt: new Date(b.start_at).toISOString() });
        }}
        options={assignmentOptions}
      />
    </Modal>
  );
}
