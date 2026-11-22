export type PhotoKind = 'pickup' | 'check_in';
export type InspectionWork = {
  id: number;
  kind: PhotoKind;
  operatorId: number;
  operatorName: string;
};
export type PrivateFile = {
  id: string;
  mime: string;
  size: number;
  status: 'pending' | 'ready' | 'failed' | 'expired' | 'deleted';
  createdAt: string;
  deleteAfter: string | null;
};
export type InspectionVersion = {
  id: number;
  vehicleId: number;
  kind: PhotoKind;
  revision: number;
  vehicleSnapshot: {
    brand: string;
    model: string;
    plate: string;
    currentMileageKm: number | null;
    nextMaintenanceDueKm: number | null;
    tankLiters: number;
  };
  mileageKm: number;
  fuelEighths: number;
  noDamage: boolean;
  damageNotes: string;
  specialNotes: string;
  noPhotosAcknowledged: boolean;
  photoIds: string[];
  createdAt: string;
};
export type AdditionalDriver = {
  fullName: string;
  passport: string;
  address: string;
  phone: string;
  license: string;
};
export type ContractVersion = {
  id: number;
  revision: number;
  status: 'pending' | 'ready' | 'failed';
  fileId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  confirmedBy: string | null;
  bookingVersion: number;
  customerVersion: number;
  securityDepositRub: string;
  additionalDriver: AdditionalDriver | null;
};
export type Checkout = {
  startedAt: string;
  hasChanges: boolean;
  issuedAt: string | null;
  actSignedAt: string | null;
  currentActSigned: boolean;
  currentContractSigned: boolean;
  contractId: number | null;
  inspectionId: number | null;
  requiredDepositRub: string | null;
  hasMoney: boolean;
  rentReceived: boolean;
  depositReceived: boolean;
};
export type ActVersion = {
  matchesCustomer: boolean;
  id: number;
  inspectionRevisionId: number;
  bookingVersion: number;
  fileId: string | null;
  status: 'pending' | 'ready' | 'failed';
  templateVersion: string;
};
export type BookingDocuments = {
  vehicle: (InspectionVersion['vehicleSnapshot'] & { hasCasco: boolean | null }) | null;
  acts: ActVersion[];
  checkout: Checkout | null;
  booking: {
    customerId: number;
    version: number;
    vehicleId: number | null;
    status: 'confirmed' | 'cancelled';
  };
  photos: PrivateFile[];
  inspections: InspectionVersion[];
  inspectionWork: InspectionWork[];
  contracts: ContractVersion[];
  customerVersion: number;
  storageConfigured: boolean;
  lessorConfigured: boolean;
  missing: string[];
};
