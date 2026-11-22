import { Injectable } from '@nestjs/common';
import { recordContractSignature } from './document-signing';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { guardCheckoutChange } from './checkout-state';
import { documentReadiness } from '../catalog/catalog.dto';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import type { Calculation } from '../pricing/calculate';
import { lockBooking, vehicleSnapshot } from './booking-documents';
import type { VehicleSnapshot } from './booking-documents';
import { lessorInput } from './document.dto';
import type { ContractInput, Lessor } from './document.dto';
import { PrivateStorage } from './private-storage';

type CustomerSnapshot = {
  type: 'individual' | 'company';
  displayName: string;
  phone: string;
  email: string;
  inn: string;
  details: Record<string, string>;
  version: number;
};
export type ContractSnapshot = {
  bookingVersion: number;
  vehicle: VehicleSnapshot;
  customer: CustomerSnapshot;
  lessor: Lessor;
  additionalDriver: ContractInput['additionalDriver'];
  securityDepositRub: string;
  casco: boolean | null;
  terms: Calculation;
  includedVatRub: string;
  issuedOn: string;
};
type ContractSummary = {
  id: number;
  revision: number;
  templateVersion: string;
  status: 'pending' | 'ready' | 'failed';
  fileId: string | null;
  createdAt: Date;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  bookingVersion: number;
  customerVersion: number;
  securityDepositRub: string;
  additionalDriver: ContractSnapshot['additionalDriver'];
};

export function configuredLessor() {
  try {
    const config: unknown = JSON.parse(process.env.CRM_LESSOR_JSON ?? '{}');
    const parsed = lessorInput.safeParse(config);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

@Injectable()
export class ContractsService {
  private readonly lessor = configuredLessor();

  constructor(
    private readonly commands: CommandsService,
    private readonly storage: PrivateStorage,
  ) {}

  async latest(c: PoolClient, bookingId: number) {
    return (
      await c.query<ContractSummary>(
        `SELECT v.id,v.revision,v.template_version AS "templateVersion",v.status,v.file_id AS "fileId",
       v.created_at AS "createdAt",s.confirmed_at AS "confirmedAt",u.full_name AS "confirmedBy",
       (v.snapshot->>'bookingVersion')::int AS "bookingVersion",
       (v.snapshot->'customer'->>'version')::int AS "customerVersion",
       v.snapshot->>'securityDepositRub' AS "securityDepositRub",
       v.snapshot->'additionalDriver' AS "additionalDriver"
       FROM contract_versions v LEFT JOIN contract_signing_confirmations s ON v.id=s.contract_version_id
       LEFT JOIN users u ON u.id=s.actor_id WHERE v.booking_id=$1 ORDER BY v.revision DESC LIMIT 1`,
        [bookingId],
      )
    ).rows[0];
  }

  async prerequisites(c: PoolClient, customerId: number) {
    const customer = await this.customer(c, customerId, false);
    return {
      customerVersion: customer.version,
      missing: documentReadiness(customer.type, customer.details, customer.inn, customer.phone)
        .missing,
      storageConfigured: this.storage.configured,
      lessorConfigured: !!this.lessor,
    };
  }

  private async customer(c: PoolClient, customerId: number, lock: boolean) {
    const row = (
      await c.query<Omit<CustomerSnapshot, 'details'> & { details: unknown }>(
        'SELECT type,display_name AS "displayName",phone,email,inn,details,version FROM customers WHERE id=$1' +
          (lock ? ' FOR SHARE' : ''),
        [customerId],
      )
    ).rows[0]!;
    const details = Object.fromEntries(
      Object.entries(typeof row.details === 'object' && row.details ? row.details : {}).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      ),
    );
    return { ...row, details };
  }

  create(request: AuthRequest, bookingId: number, input: ContractInput) {
    return this.commands.run(
      request,
      'contracts.create',
      { bookingId, ...input },
      async (c) => {
        const booking = await lockBooking(c, bookingId, input.expectedBookingVersion);
        if (!(await guardCheckoutChange(c, bookingId, true)))
          fail(422, 'CHECKOUT_REQUIRED', 'Начните оформление договора в карточке брони.');
        const previous = await this.latest(c, bookingId);
        if ((previous?.id ?? null) !== input.expectedContractVersionId)
          fail(
            409,
            'CONTRACT_VERSION_CONFLICT',
            'Версия договора изменилась. Сверьте актуальную редакцию.',
          );
        const customer = await this.customer(c, booking.customerId, true);
        if (customer.version !== input.expectedCustomerVersion)
          fail(
            409,
            'CUSTOMER_VERSION_CONFLICT',
            'Реквизиты клиента изменились. Сверьте актуальные данные.',
          );
        const lessor = this.lessor;
        if (!lessor || !this.storage.configured)
          fail(
            503,
            'CONTRACT_CONFIGURATION_REQUIRED',
            'Настройте реквизиты арендодателя и приватное хранилище.',
          );
        const readiness = documentReadiness(
          customer.type,
          customer.details,
          customer.inn,
          customer.phone,
        );
        if (!readiness.ready)
          fail(
            422,
            'CUSTOMER_DETAILS_REQUIRED',
            'Заполните реквизиты клиента для договора.',
            readiness,
          );
        const vehicle = await vehicleSnapshot(c, booking.vehicleId);
        const terms = (
          await c.query<{ id: number; snapshot: Calculation }>(
            'SELECT id,snapshot FROM booking_terms WHERE booking_id=$1 ORDER BY revision DESC LIMIT 1',
            [bookingId],
          )
        ).rows[0];
        if (!terms) fail(422, 'TERMS_REQUIRED', 'Сохраните условия брони.');
        const templateVersion = customer.type + '-v1';
        const snapshot: ContractSnapshot = {
          bookingVersion: booking.version,
          customer: {
            ...customer,
            displayName:
              customer.type === 'individual'
                ? [
                    customer.details.lastName,
                    customer.details.firstName,
                    customer.details.middleName,
                  ]
                    .map((part) => part?.trim())
                    .filter(Boolean)
                    .join(' ')
                : customer.displayName,
          },
          lessor,
          vehicle,
          terms: terms.snapshot,
          additionalDriver: input.additionalDriver,
          securityDepositRub: input.securityDepositRub,
          casco: vehicle.hasCasco ?? null,
          includedVatRub: terms.snapshot.includedVatRub,
          issuedOn: new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(
            new Date(),
          ),
        };
        const { id } = (
          await c.query<{ id: number }>(
            `INSERT INTO contract_versions(booking_id,terms_id,revision,template_version,snapshot,created_by)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              bookingId,
              terms.id,
              (previous?.revision ?? 0) + 1,
              templateVersion,
              JSON.stringify(snapshot),
              request.auth!.user.id,
            ],
          )
        ).rows[0]!;
        await c.query(
          "INSERT INTO outbox_jobs(business_key,kind,payload) VALUES($1,'contract.render',$2)",
          ['contract-render:' + id, JSON.stringify({ versionId: id, fileId: randomUUID() })],
        );
        await audit(
          c,
          request.auth!.user.id,
          'booking',
          'contracts.created',
          bookingId,
          request.requestId,
          { versionId: id },
        );
        return { id };
      },
      false,
    );
  }

  retry(request: AuthRequest, bookingId: number, id: number) {
    return this.commands.run(
      request,
      'contracts.retry',
      { bookingId, id },
      async (c) => {
        const result = await c.query(
          "UPDATE contract_versions SET status='pending' WHERE id=$1 AND booking_id=$2 AND status='failed' RETURNING id",
          [id, bookingId],
        );
        if (!result.rowCount)
          fail(409, 'CONTRACT_RETRY_UNAVAILABLE', 'Повтор доступен для договора с ошибкой.');
        const job = await c.query(
          "UPDATE outbox_jobs SET status='pending',attempts=0,next_attempt_at=now(),lease_until=NULL WHERE business_key=$1 AND kind='contract.render' AND status='failed'",
          ['contract-render:' + id],
        );
        if (!job.rowCount)
          fail(409, 'CONTRACT_RETRY_UNAVAILABLE', 'Задание изменилось. Обновите карточку.');
        await audit(
          c,
          request.auth!.user.id,
          'booking',
          'contracts.retried',
          bookingId,
          request.requestId,
          { versionId: id },
        );
        return { id };
      },
      false,
    );
  }

  sign(request: AuthRequest, bookingId: number, id: number, expectedBookingVersion: number) {
    return this.commands.run(
      request,
      'contracts.sign',
      { bookingId, id, expectedBookingVersion },
      async (c) => {
        const booking = await lockBooking(c, bookingId, expectedBookingVersion);
        await guardCheckoutChange(c, bookingId, true);
        const current = await this.latest(c, bookingId);
        const customer = await this.customer(c, booking.customerId, true);
        if (
          current?.id !== id ||
          current.bookingVersion !== expectedBookingVersion ||
          current.customerVersion !== customer.version
        )
          fail(
            409,
            'CONTRACT_VERSION_CONFLICT',
            'Подтвердите подписание актуальной версии договора.',
          );
        if (current.status !== 'ready')
          fail(422, 'DOCUMENTS_NOT_READY', 'Дождитесь готовности PDF договора.');
        await recordContractSignature(c, request, bookingId, id);
        return { id };
      },
      false,
    );
  }
}
