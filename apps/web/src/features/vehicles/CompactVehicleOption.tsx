import { Tooltip } from 'antd';
import { WarningOutlined } from '@ant-design/icons';
import { plateCanonical, platePattern } from '../../formats';

type VehicleOption = {
  id: number;
  label: string;
  modelName: string;
  plate: string;
  isReady: boolean;
  readinessReason?: string;
};
export function compactVehicleOption(v: VehicleOption) {
  const number = plateCanonical(v.plate),
    shortPlate = platePattern.test(number)
      ? number.slice(1, 4) + ' ' + number.slice(4, 6)
      : v.plate;
  return {
    value: v.id,
    label: (
      <span className="booking-vehicle-option" title={v.label}>
        <span className="booking-vehicle-model">{v.modelName}</span>
        <span className="booking-vehicle-plate">{shortPlate}</span>
        {!v.isReady && (
          <Tooltip title={'Не готов: ' + (v.readinessReason || 'причина не указана')}>
            <WarningOutlined className="booking-vehicle-warning" aria-label="Не готов к выдаче" />
          </Tooltip>
        )}
      </span>
    ),
    searchLabel: v.label + ' ' + shortPlate,
    title: v.label,
  };
}
