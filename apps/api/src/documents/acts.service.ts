import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { CommandsService } from '../platform/commands.service';
import { AuthRequest, audit, fail } from '../platform/security';
import { lockBooking } from './booking-documents';
import { configuredLessor } from './contracts.service';
import { actTemplateVersion } from './act-pdf';
import type { ActSnapshot } from './act-pdf';
import { PrivateStorage } from './private-storage';
import { assertInspectionIdle } from './inspection-work';
import { actCustomerSigner, actMatchesCustomer } from './act-customer';

type ActVersion = {
  id: number;
  inspectionRevisionId: number;
  bookingVersion: number;
  matchesCustomer: boolean;
  fileId: string | null;
  status: 'pending' | 'ready' | 'failed';
  templateVersion: string;
};

@Injectable()
export class ActsService {
  private readonly lessor = configuredLessor();

  constructor(
    private readonly commands: CommandsService,
    private readonly storage: PrivateStorage,
  ) {}

  async list(c: PoolClient, bookingId: number) {
    return (
      await c.query<ActVersion>(
        `SELECT a.id,a.inspection_revision_id AS "inspectionRevisionId",a.booking_version AS "bookingVersion",
       a.file_id AS "fileId",a.status,a.template_version AS "templateVersion",
       COALESCE(${actMatchesCustomer},false) AS "matchesCustomer"
       FROM inspection_act_versions a JOIN inspection_revisions i ON i.id=a.inspection_revision_id
       JOIN bookings b ON b.id=a.booking_id JOIN customers u ON u.id=b.customer_id
       WHERE a.booking_id=$1 AND NOT EXISTS (
         SELECT 1 FROM inspection_act_versions newer JOIN inspection_revisions ni ON ni.id=newer.inspection_revision_id
         WHERE newer.booking_id=a.booking_id AND newer.id>a.id AND ni.kind=i.kind
       ) ORDER BY a.id DESC`,
        [bookingId],
      )
    ).rows;
  }

  generate(
    request: AuthRequest,
    bookingId: number,
    inspectionRevisionId: number,
    expectedVersion: number,
  ) {
    return this.commands.run(
      request,
      'acts.generate',
      { bookingId, inspectionRevisionId, expectedVersion },
      async (c) => {
        const booking = await lockBooking(c, bookingId, expectedVersion);
        const revision = (
          await c.query<
            Pick<
              ActSnapshot,
              | 'kind'
              | 'vehicle'
              | 'mileageKm'
              | 'fuelEighths'
              | 'noDamage'
              | 'damageNotes'
              | 'specialNotes'
            > & { vehicleId: number; createdAt: Date }
          >(
            `SELECT kind,vehicle_id AS "vehicleId",vehicle_snapshot AS vehicle,mileage_km AS "mileageKm",
         fuel_eighths AS "fuelEighths",no_damage AS "noDamage",damage_notes AS "damageNotes",
         special_notes AS "specialNotes",created_at AS "createdAt"
         FROM inspection_revisions i WHERE id=$1 AND booking_id=$2 AND NOT EXISTS (
           SELECT 1 FROM inspection_revisions newer WHERE newer.booking_id=i.booking_id AND newer.kind=i.kind AND newer.revision>i.revision
         )`,
            [inspectionRevisionId, bookingId],
          )
        ).rows[0];
        if (!revision || revision.vehicleId !== booking.vehicleId)
          fail(422, 'INSPECTION_REQUIRED', 'Выберите осмотр назначенного автомобиля.');
        await assertInspectionIdle(c, bookingId, booking.version, revision.kind);
        const lessor = this.lessor;
        if (!lessor || !this.storage.configured)
          fail(
            503,
            'CONTRACT_CONFIGURATION_REQUIRED',
            'Настройте реквизиты арендодателя и приватное хранилище.',
          );
        const customer = (
          await c.query<{ display_name: string; signer: string; version: number }>(
            `SELECT u.display_name, ${actCustomerSigner} AS signer, u.version
         FROM customers u WHERE u.id=$1 FOR SHARE`,
            [booking.customerId],
          )
        ).rows[0]!;
        const existing = (
          await c.query<{ id: number }>(
            `SELECT a.id FROM (
               SELECT id,customer_version,snapshot FROM inspection_act_versions
               WHERE inspection_revision_id=$1 AND booking_version=$2 AND template_version=$3
               ORDER BY id DESC LIMIT 1
             ) a JOIN customers u ON u.id=$4
             WHERE ${actMatchesCustomer}`,
            [inspectionRevisionId, booking.version, actTemplateVersion, booking.customerId],
          )
        ).rows[0];
        if (existing) return existing;
        const { createdAt, vehicleId, ...details } = revision;
        const snapshot: ActSnapshot = {
          ...details,
          inspectedAt: createdAt.toISOString(),
          customerName: customer.display_name,
          customerSigner: customer.signer,
          lessor,
        };
        const { id } = (
          await c.query<{ id: number }>(
            `INSERT INTO inspection_act_versions(booking_id,inspection_revision_id,booking_version,customer_version,template_version,snapshot,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
            [
              bookingId,
              inspectionRevisionId,
              booking.version,
              customer.version,
              actTemplateVersion,
              JSON.stringify(snapshot),
              request.auth!.user.id,
            ],
          )
        ).rows[0]!;
        await c.query(
          "INSERT INTO outbox_jobs(business_key,kind,payload) VALUES($1,'act.render',$2)",
          ['act-render:' + id, JSON.stringify({ versionId: id, fileId: randomUUID() })],
        );
        await audit(
          c,
          request.auth!.user.id,
          'booking',
          'acts.generated',
          bookingId,
          request.requestId,
          { id, inspectionRevisionId, vehicleId },
        );
        return { id };
      },
      false,
    );
  }

  retry(request: AuthRequest, bookingId: number, id: number) {
    return this.commands.run(
      request,
      'acts.retry',
      { bookingId, id },
      async (c) => {
        const job = await c.query(
          "UPDATE outbox_jobs SET status='pending',attempts=0,next_attempt_at=now(),lease_until=NULL WHERE business_key=$1 AND kind='act.render' AND status='failed'",
          ['act-render:' + id],
        );
        const result = await c.query(
          "UPDATE inspection_act_versions SET status='pending' WHERE id=$1 AND booking_id=$2 AND status='failed'",
          [id, bookingId],
        );
        if (!job.rowCount || !result.rowCount)
          fail(409, 'ACT_RETRY_UNAVAILABLE', 'Повтор доступен для акта с ошибкой.');
        return { id };
      },
      false,
    );
  }
}
