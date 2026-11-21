// Compatibility facade for existing screens; shared modules use direct imports.
export type { Customer, Vehicle, Model } from './domain/catalog';
export { bodyNames, transmissionNames } from './domain/catalogLabels';
export { useListScroll, usePolling } from './shared/hooks';
export { PollNotice } from './shared/PollNotice';
export { CommandModal } from './shared/CommandModal';
export { dateText } from './shared/formatters';
export { VehicleTags } from './features/vehicles/VehicleTags';
export { History } from './features/history/History';
