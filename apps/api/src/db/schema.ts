import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

const recordId = () => integer('id').primaryKey().generatedByDefaultAsIdentity();
const time = (name: string) => timestamp(name, { withTimezone: true });
const rub = () => bigint('amount_rub', { mode: 'bigint' }).notNull();
export const users = pgTable(
  'users',
  {
    id: recordId(),
    fullName: text('full_name').notNull(),
    login: text('login').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull().default('manager'),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  () => [
    check('users_role_check', sql.raw("role IN ('admin', 'manager')")),
    check('users_login_check', sql.raw("login ~ '^[a-z0-9][a-z0-9._-]{2,63}$'")),
  ],
);
export const sessions = pgTable(
  'sessions',
  {
    id: recordId(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: time('created_at').notNull().defaultNow(),
    expiresAt: time('expires_at').notNull(),
    revokedAt: time('revoked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
);
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: recordId(),
    actorId: integer('actor_id').references(() => users.id),
    action: text('action').notNull(),
    entityId: integer('entity_id'),
    entityType: text('entity_type')
      .$type<
        | 'user'
        | 'customer'
        | 'vehicle'
        | 'pricing_quote'
        | 'booking'
        | 'schedule_block'
        | 'financial_operation'
      >()
      .notNull(),
    requestId: uuid('request_id').notNull(),
    details: jsonb('details').notNull().default({}),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_entity_idx').on(t.entityType, t.entityId, t.createdAt, t.id),
    check(
      'audit_entity_type',
      sql.raw(
        "entity_type IN ('user','customer','vehicle','pricing_quote','booking','schedule_block','financial_operation')",
      ),
    ),
  ],
);
export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: recordId(),
    actorId: integer('actor_id')
      .notNull()
      .references(() => users.id),
    command: text('command').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('idempotency_actor_command_key').on(t.actorId, t.command, t.key)],
);
export const outboxJobs = pgTable(
  'outbox_jobs',
  {
    id: recordId(),
    businessKey: text('business_key').notNull().unique(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: time('next_attempt_at').notNull().defaultNow(),
    leaseUntil: time('lease_until'),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [index('outbox_due_idx').on(t.status, t.nextAttemptAt)],
);
export const loginLimits = pgTable('login_limits', {
  key: text('key').primaryKey(),
  attempts: integer('attempts').notNull(),
  expiresAt: time('expires_at').notNull(),
});

export const pricingGroups = pgTable('pricing_groups', {
  id: recordId(),
  name: text('name').notNull().unique(),
  tariffCode: text('tariff_code').unique(),
});
export const vehicleBrands = pgTable(
  'vehicle_brands',
  {
    id: recordId(),
    name: text('name').notNull().unique(),
  },
  (t) => [uniqueIndex('brand_normalized_name').on(sql`lower(trim(${t.name}))`)],
);
export const vehicleModels = pgTable(
  'vehicle_models',
  {
    id: recordId(),
    brandId: integer('brand_id')
      .notNull()
      .references(() => vehicleBrands.id),
    name: text('name').notNull(),
    pricingGroupId: integer('pricing_group_id')
      .notNull()
      .references(() => pricingGroups.id),
  },
  (t) => [
    uniqueIndex('model_brand_name').on(t.brandId, t.name),
    uniqueIndex('model_normalized_name').on(t.brandId, sql`lower(trim(${t.name}))`),
  ],
);
export const equivalenceGroups = pgTable('equivalence_groups', {
  id: recordId(),
  name: text('name').notNull().unique(),
});
export const equivalenceGroupModels = pgTable(
  'equivalence_group_models',
  {
    groupId: integer('group_id')
      .notNull()
      .references(() => equivalenceGroups.id),
    modelId: integer('model_id')
      .notNull()
      .references(() => vehicleModels.id),
  },
  (t) => [uniqueIndex('equivalence_membership').on(t.groupId, t.modelId)],
);
export const customers = pgTable(
  'customers',
  {
    id: recordId(),
    type: text('type').notNull(),
    displayName: text('display_name').notNull(),
    phone: text('phone').notNull().default(''),
    email: text('email').notNull().default(''),
    inn: text('inn').notNull().default(''),
    details: jsonb('details').notNull().default({}),
    isBlocked: boolean('is_blocked').notNull().default(false),
    blockedReason: text('blocked_reason').notNull().default(''),
    version: integer('version').notNull().default(1),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  () => [
    check('customer_type', sql.raw("type IN ('individual','company')")),
    check('customer_block_reason', sql.raw('NOT is_blocked OR length(trim(blocked_reason))>0')),
    check('customer_name', sql.raw('length(trim(display_name))>0')),
  ],
);
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: recordId(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    text: text('text').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    resolvedBy: integer('resolved_by').references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
    resolvedAt: time('resolved_at'),
  },
  (t) => [index('notes_customer').on(t.customerId)],
);
export const vehicles = pgTable(
  'vehicles',
  {
    id: recordId(),
    modelId: integer('model_id')
      .notNull()
      .references(() => vehicleModels.id),
    plate: text('plate').notNull().unique(),
    vin: text('vin').unique(),
    year: integer('year').notNull(),
    bodyType: text('body_type').notNull(),
    transmission: text('transmission'),
    currentMileageKm: integer('current_mileage_km'),
    nextMaintenanceDueKm: integer('next_maintenance_due_km'),
    isReady: boolean('is_ready').notNull().default(true),
    readinessReason: text('readiness_reason').notNull().default(''),
    needsWash: boolean('needs_wash').notNull().default(false),
    issueNotes: text('issue_notes').notNull().default(''),
    archivedAt: time('archived_at'),
    version: integer('version').notNull().default(1),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('vehicles_model').on(t.modelId),
    check(
      'vehicle_body',
      sql.raw("body_type IN ('sedan','hatchback','compact_van','cargo_minibus')"),
    ),
    check(
      'vehicle_transmission',
      sql.raw("transmission IS NULL OR transmission IN ('automatic','manual')"),
    ),
    check(
      'vehicle_mileage',
      sql.raw(
        '(current_mileage_km IS NULL OR current_mileage_km>=0) AND (next_maintenance_due_km IS NULL OR next_maintenance_due_km>=0)',
      ),
    ),
    check('vehicle_year', sql.raw('year BETWEEN 1900 AND 2100')),
    check('vehicle_readiness', sql.raw('is_ready OR length(trim(readiness_reason))>0')),
  ],
);

export const vehicleServiceRecords = pgTable(
  'vehicle_service_records',
  {
    id: recordId(),
    vehicleId: integer('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    performedOn: text('performed_on').notNull(),
    procedure: text('procedure').notNull(),
    mileageKm: integer('mileage_km'),
    note: text('note').notNull().default(''),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('vehicle_service_history').on(t.vehicleId, t.performedOn),
    check('service_mileage', sql.raw('mileage_km IS NULL OR mileage_km>=0')),
  ],
);

export const pricingQuotes = pgTable(
  'pricing_quotes',
  {
    id: recordId(),
    baseQuoteId: integer('base_quote_id').references((): AnyPgColumn => pricingQuotes.id),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    confirmedBy: integer('confirmed_by').references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
    expiresAt: time('expires_at').notNull(),
    confirmedAt: time('confirmed_at'),
    version: integer('version').notNull().default(1),
    input: jsonb('input').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    confirmedOverrides: jsonb('confirmed_overrides'),
  },
  (t) => [
    index('pricing_quotes_created').on(t.createdAt, t.id),
    check('pricing_quote_version', sql.raw('version > 0')),
    check(
      'pricing_quote_confirmation',
      sql.raw(
        '(confirmed_at IS NULL AND confirmed_by IS NULL AND confirmed_overrides IS NULL AND version=1) OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_overrides IS NOT NULL AND version=2)',
      ),
    ),
  ],
);

export const bookings = pgTable(
  'bookings',
  {
    id: recordId(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    status: text('status').notNull().default('confirmed'),
    version: integer('version').notNull().default(1),
    startAt: time('start_at').notNull(),
    endAt: time('end_at').notNull(),
    targetType: text('target_type').notNull(),
    targetVehicleId: integer('target_vehicle_id').references(() => vehicles.id),
    targetModelId: integer('target_model_id').references(() => vehicleModels.id),
    targetBrandId: integer('target_brand_id').references(() => vehicleBrands.id),
    targetGroupId: integer('target_group_id').references(() => equivalenceGroups.id),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('bookings_period').on(t.startAt, t.endAt),
    check('booking_period', sql.raw('end_at > start_at')),
    check('booking_status', sql.raw("status IN ('confirmed','cancelled')")),
    check('booking_version', sql.raw('version > 0')),
    check(
      'booking_target',
      sql.raw(
        "(target_type='vehicle' AND target_vehicle_id IS NOT NULL AND target_model_id IS NULL AND target_brand_id IS NULL AND target_group_id IS NULL) OR (target_type='model' AND target_model_id IS NOT NULL AND target_vehicle_id IS NULL AND target_brand_id IS NULL AND target_group_id IS NULL) OR (target_type='brand' AND target_brand_id IS NOT NULL AND target_vehicle_id IS NULL AND target_model_id IS NULL AND target_group_id IS NULL) OR (target_type='equivalence_group' AND target_group_id IS NOT NULL AND target_vehicle_id IS NULL AND target_model_id IS NULL AND target_brand_id IS NULL)",
      ),
    ),
  ],
);

export const bookingEligibleModels = pgTable(
  'booking_eligible_models',
  {
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    modelId: integer('model_id')
      .notNull()
      .references(() => vehicleModels.id),
  },
  (t) => [uniqueIndex('booking_model_unique').on(t.bookingId, t.modelId)],
);

export const bookingTerms = pgTable(
  'booking_terms',
  {
    id: recordId(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    revision: integer('revision').notNull(),
    quoteId: integer('quote_id')
      .notNull()
      .references(() => pricingQuotes.id),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason').notNull(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('booking_terms_revision').on(t.bookingId, t.revision)],
);

// Only planned intervals belong here. Future actual usages remain separate.
// The GiST exclusion constraint is maintained in the SQL migration.
export const scheduleBlocks = pgTable(
  'schedule_blocks',
  {
    id: recordId(),
    vehicleId: integer('vehicle_id')
      .notNull()
      .references(() => vehicles.id),
    bookingId: integer('booking_id').references(() => bookings.id),
    kind: text('kind').notNull(),
    startAt: time('start_at').notNull(),
    endAt: time('end_at').notNull(),
    reason: text('reason').notNull(),
    retiredAt: time('retired_at'),
    version: integer('version').notNull().default(1),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('schedule_period', sql.raw('end_at > start_at')),
    check(
      'schedule_source',
      sql.raw(
        "(kind='assignment' AND booking_id IS NOT NULL) OR (kind='technical' AND booking_id IS NULL)",
      ),
    ),
    check('schedule_reason', sql.raw('length(trim(reason))>0')),
    uniqueIndex('one_current_assignment')
      .on(t.bookingId)
      .where(sql`retired_at IS NULL AND booking_id IS NOT NULL`),
  ],
);

export const bookingRisks = pgTable(
  'booking_risks',
  {
    id: recordId(),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason').notNull(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  () => [check('risk_reason', sql.raw('length(trim(reason))>0'))],
);

export const financialOperations = pgTable(
  'financial_operations',
  {
    id: recordId(),
    commandId: text('command_id').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    kind: text('kind').notNull(),
    customerId: integer('customer_id').references(() => customers.id),
    bookingId: integer('booking_id').references(() => bookings.id),
    actorId: integer('actor_id').references(() => users.id),
    reason: text('reason').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
    reversalOf: integer('reversal_of')
      .unique()
      .references((): AnyPgColumn => financialOperations.id),
  },
  (t) => [
    index('finance_customer_date').on(t.customerId, t.id),
    index('finance_booking').on(t.bookingId),
    check(
      'finance_kind',
      sql.raw(
        "kind IN ('charge','rent_payment','deposit_receipt','to_credit','credit_use','refund','initial','reversal')",
      ),
    ),
  ],
);
export const financeFunds = pgTable(
  'finance_funds',
  {
    id: text('id').primaryKey(),
    version: integer('version').notNull().default(1),
  },
  () => [check('finance_fund_name', sql.raw("id IN ('operating_cash','deposit_pool')"))],
);
export const financeFundEntries = pgTable(
  'finance_fund_entries',
  {
    id: recordId(),
    operationId: integer('operation_id')
      .notNull()
      .references(() => financialOperations.id),
    fund: text('fund')
      .notNull()
      .references(() => financeFunds.id),
    amountRub: rub(),
    isInitial: boolean('is_initial').notNull().default(false),
  },
  (t) => [
    index('finance_fund_entries_fund').on(t.fund),
    uniqueIndex('one_initial_per_fund')
      .on(t.fund)
      .where(sql`is_initial`),
  ],
);
export const financeExternal = pgTable(
  'finance_external',
  {
    id: recordId(),
    operationId: integer('operation_id')
      .notNull()
      .references(() => financialOperations.id),
    method: text('method').notNull(),
    amountRub: rub(),
  },
  () => [
    check('finance_external_method', sql.raw("method IN ('cash','bank')")),
    check('finance_external_nonzero', sql.raw('amount_rub<>0')),
  ],
);
export const financeCharges = pgTable(
  'finance_charges',
  {
    id: recordId(),
    operationId: integer('operation_id')
      .notNull()
      .unique()
      .references(() => financialOperations.id),
    bookingId: integer('booking_id')
      .notNull()
      .references(() => bookings.id),
    termsId: integer('terms_id')
      .notNull()
      .references(() => bookingTerms.id),
    amountRub: rub(),
  },
  (t) => [
    index('finance_charge_booking').on(t.bookingId),
    check('finance_charge_nonzero', sql.raw('amount_rub<>0')),
  ],
);
export const financeLots = pgTable(
  'finance_lots',
  {
    id: recordId(),
    customerId: integer('customer_id')
      .notNull()
      .references(() => customers.id),
    originalOperationId: integer('original_operation_id')
      .notNull()
      .unique()
      .references(() => financialOperations.id),
    origin: text('origin').notNull(),
    method: text('method').notNull(),
  },
  (t) => [
    index('finance_lots_customer').on(t.customerId),
    check('finance_lot_origin', sql.raw("origin IN ('rent','deposit')")),
    check(
      'finance_lot_method',
      sql.raw("method IN ('cash','bank') AND (origin<>'deposit' OR method='cash')"),
    ),
  ],
);
export const financeAllocations = pgTable(
  'finance_allocations',
  {
    id: recordId(),
    operationId: integer('operation_id')
      .notNull()
      .references(() => financialOperations.id),
    lotId: integer('lot_id')
      .notNull()
      .references(() => financeLots.id),
    bucket: text('bucket').notNull(),
    fund: text('fund').references(() => financeFunds.id),
    bookingId: integer('booking_id').references(() => bookings.id),
    amountRub: rub(),
  },
  (t) => [
    index('finance_allocation_source').on(t.lotId, t.bucket, t.bookingId),
    index('finance_allocation_booking').on(t.bookingId),
    check(
      'finance_allocation_bucket',
      sql.raw(
        "(bucket='credit' AND booking_id IS NULL) OR (bucket IN ('rent','deposit') AND booking_id IS NOT NULL)",
      ),
    ),
    check('finance_allocation_nonzero', sql.raw('amount_rub<>0')),
  ],
);
