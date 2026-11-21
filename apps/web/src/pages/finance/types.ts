import type { FinancialSummary as Summary } from '../../contracts';
import type { FinancialOperation } from '../../contracts';
export type Source = {
  lotId: number;
  originalOperationId: number;
  origin: string;
  method: string;
  bucket: string;
  fund: string | null;
  bookingId: number | null;
  availableRub: string;
};
export type CustomerFinance = {
  sources: Source[];
  bookings: Summary[];
  items: FinancialOperation[];
};
export type MoneyEditorProps = {
  customerId?: number;
  bookingId?: number;
  data?: CustomerFinance;
  onDone: () => void;
  onClose: () => void;
  onLock?: (v: boolean) => void;
  initialKind?: string;
  operationId?: number;
};
