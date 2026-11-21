import { Space, Tag } from 'antd';
import type { Vehicle } from '../../domain/catalog';
export function VehicleTags({ v }: { v: Vehicle }) {
  const remaining =
    v.nextMaintenanceDueKm === null || v.currentMileageKm === null
      ? null
      : v.nextMaintenanceDueKm - v.currentMileageKm;
  return (
    <Space size={[0, 4]} wrap>
      <Tag color={v.archivedAt ? 'default' : v.isReady ? 'green' : 'orange'}>
        {v.archivedAt ? 'Архив' : v.isReady ? 'Готов к выдаче' : 'Не готов'}
      </Tag>
      {v.needsWash && <Tag color="blue">Мойка</Tag>}
      {v.note && <Tag>Пометка</Tag>}
      {remaining === null && <Tag>Пробег / ТО неизвестны</Tag>}
      {remaining !== null && remaining <= 1000 && (
        <Tag color={remaining <= 0 ? 'red' : 'gold'}>
          {remaining <= 0 ? 'ТО требуется' : 'Скоро ТО'}
        </Tag>
      )}
    </Space>
  );
}
