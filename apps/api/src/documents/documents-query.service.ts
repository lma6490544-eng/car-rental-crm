import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database.service';
import { ActsService } from './acts.service';
import { bookingContext, vehicleSnapshot } from './booking-documents';
import { checkoutState } from './checkout-state';
import { ContractsService } from './contracts.service';
import { listInspectionWork } from './inspection-work';
import { InspectionsService } from './inspections.service';
import { PrivateFilesService } from './private-files.service';

@Injectable()
export class DocumentsQueryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly contracts: ContractsService,
    private readonly inspections: InspectionsService,
    private readonly files: PrivateFilesService,
    private readonly acts: ActsService,
  ) {}

  get(bookingId: number) {
    return this.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const booking = await bookingContext(c, bookingId, false);
      const returned = booking.status === 'completed' || booking.status === 'completed_early';
      const contract = await this.contracts.latest(c, bookingId);
      return {
        booking,
        vehicle:
          booking.vehicleId === null
            ? null
            : await vehicleSnapshot(c, booking.vehicleId, false, returned),
        checkout: await checkoutState(c, bookingId),
        photos: await this.files.bookingPhotos(c, bookingId),
        inspections: await this.inspections.list(c, bookingId),
        inspectionWork: await listInspectionWork(c, bookingId, booking.version),
        acts: await this.acts.list(c, bookingId),
        contracts: contract ? [contract] : [],
        ...(await this.contracts.prerequisites(c, booking.customerId)),
      };
    });
  }
}
