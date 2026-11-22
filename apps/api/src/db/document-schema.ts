import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bookings, bookingTerms, customers, users, vehicles } from './schema';

const id = () => integer('id').primaryKey().generatedByDefaultAsIdentity();
const time = (name: string) => timestamp(name, { withTimezone: true });

export const privateFiles = pgTable(
  'private_files',
  {
    id: uuid('id').primaryKey(),
    bookingId: integer('booking_id').references(() => bookings.id),
    customerId: integer('customer_id').references(() => customers.id),
    category: text('category').notNull(),
    inspectionKind: text('inspection_kind'),
    vehicleId: integer('vehicle_id').references(() => vehicles.id),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    checksum: text('checksum').notNull(),
    status: text('status').notNull().default('pending'),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
    deleteAfter: time('delete_after'),
    deletedAt: time('deleted_at'),
  },
  (t) => [
    index('private_files_booking').on(t.bookingId, t.category, t.createdAt),
    index('private_files_customer').on(t.customerId, t.category, t.createdAt),
    index('private_files_expiration')
      .on(t.deleteAfter)
      .where(sql`deleted_at IS NULL`),
    check(
      'private_file_owner',
      sql`(category IN ('inspection_photo','contract','inspection_act') AND booking_id IS NOT NULL AND customer_id IS NULL)
    OR (category = 'customer_document' AND customer_id IS NOT NULL AND booking_id IS NULL)`,
    ),
    check(
      'private_file_photo_context',
      sql`(category = 'inspection_photo' AND vehicle_id IS NOT NULL AND inspection_kind IS NOT NULL AND inspection_kind IN ('pickup','check_in')) OR (category <> 'inspection_photo' AND vehicle_id IS NULL AND inspection_kind IS NULL)`,
    ),
    check('private_file_status', sql`status IN ('pending','ready','failed','deleted')`),
    check(
      'private_file_expiration',
      sql`category = 'inspection_photo' OR (delete_after IS NULL AND deleted_at IS NULL)`,
    ),
    check(
      'private_file_metadata',
      sql`size > 0 AND checksum ~ '^[a-f0-9]{64}$' AND mime IN ('image/png','image/jpeg','application/pdf')`,
    ),
  ],
);

export const inspectionWork = pgTable(
  'inspection_work',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    bookingVersion: integer('booking_version').notNull(),
    kind: text('kind').notNull(),
    operatorId: integer('operator_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex('inspection_work_booking_kind').on(t.bookingId, t.kind),
    check('inspection_work_context', sql`kind IN ('pickup','check_in') AND booking_version > 0`),
  ],
);

export const inspectionRevisions = pgTable(
  'inspection_revisions',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    vehicleId: integer('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    vehicleSnapshot: jsonb('vehicle_snapshot').notNull(),
    mileageKm: integer('mileage_km').notNull(),
    fuelEighths: integer('fuel_eighths').notNull(),
    noDamage: boolean('no_damage').notNull(),
    damageNotes: text('damage_notes').notNull(),
    specialNotes: text('special_notes').notNull(),
    noPhotosAcknowledged: boolean('no_photos_acknowledged').notNull(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('inspection_booking_kind_revision').on(t.bookingId, t.kind, t.revision),
    check(
      'inspection_values',
      sql`kind IN ('pickup','check_in') AND mileage_km >= 0 AND fuel_eighths BETWEEN 0 AND 8 AND revision > 0`,
    ),
    check('inspection_damage', sql`no_damage = (length(trim(damage_notes)) = 0)`),
  ],
);

export const inspectionRevisionPhotos = pgTable(
  'inspection_revision_photos',
  {
    revisionId: integer('revision_id')
      .notNull()
      .references(() => inspectionRevisions.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => privateFiles.id),
  },
  (t) => [primaryKey({ columns: [t.revisionId, t.fileId] })],
);

export const contractVersions = pgTable(
  'contract_versions',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    termsId: integer('terms_id')
      .notNull()
      .references(() => bookingTerms.id),
    revision: integer('revision').notNull(),
    templateVersion: text('template_version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    status: text('status').notNull().default('pending'),
    fileId: uuid('file_id')
      .unique()
      .references(() => privateFiles.id),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('contract_booking_revision').on(t.bookingId, t.revision),
    check(
      'contract_version_status',
      sql`status IN ('pending','ready','failed') AND (status='ready') = (file_id IS NOT NULL) AND revision > 0`,
    ),
  ],
);

export const contractSigningConfirmations = pgTable('contract_signing_confirmations', {
  contractVersionId: integer('contract_version_id')
    .primaryKey()
    .references(() => contractVersions.id),
  actorId: integer('actor_id')
    .notNull()
    .references(() => users.id),
  confirmedAt: time('confirmed_at').notNull().defaultNow(),
});

export const inspectionActVersions = pgTable(
  'inspection_act_versions',
  {
    id: id(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    inspectionRevisionId: integer('inspection_revision_id')
      .notNull()
      .references(() => inspectionRevisions.id),
    bookingVersion: integer('booking_version').notNull(),
    customerVersion: integer('customer_version'),
    templateVersion: text('template_version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    status: text('status').notNull().default('pending'),
    fileId: uuid('file_id')
      .unique()
      .references(() => privateFiles.id),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('act_revision_template_customer').on(
      t.inspectionRevisionId,
      t.bookingVersion,
      t.templateVersion,
      t.customerVersion,
    ),
    index('act_booking_versions').on(t.bookingId, t.id),
    check(
      'act_status',
      sql`status IN ('pending','ready','failed') AND (status='ready') = (file_id IS NOT NULL)`,
    ),
  ],
);

export const bookingCheckouts = pgTable(
  'booking_checkouts',
  {
    bookingId: integer('booking_id')
      .primaryKey()
      .references(() => bookings.id),
    startedBy: integer('started_by')
      .notNull()
      .references(() => users.id),
    startedAt: time('started_at').notNull().defaultNow(),
    stoppedAt: time('stopped_at'),
    actVersionId: integer('act_version_id').references(() => inspectionActVersions.id),
    actRevisionId: integer('act_revision_id').references(() => inspectionRevisions.id),
    actSignedAt: time('act_signed_at'),
    actSignedBy: integer('act_signed_by').references(() => users.id),
    issuedAt: time('issued_at'),
    issuedBy: integer('issued_by').references(() => users.id),
    issuedVehicleId: integer('issued_vehicle_id')
      .unique()
      .references(() => vehicles.id),
    issuedContractId: integer('issued_contract_id').references(() => contractVersions.id),
  },
  () => [
    check(
      'checkout_act_signature',
      sql`num_nonnulls(act_revision_id,act_signed_at,act_signed_by) IN (0,3)`,
    ),
    check(
      'checkout_issuance',
      sql`num_nonnulls(issued_at,issued_by,issued_vehicle_id,issued_contract_id) IN (0,4)`,
    ),
    check('checkout_stop_before_issue', sql`stopped_at IS NULL OR issued_at IS NULL`),
  ],
);
