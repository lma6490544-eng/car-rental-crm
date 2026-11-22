import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseService } from './database.service';
import { HealthController } from './health.controller';
import { SessionGuard } from './platform/http';
import { CommandsService } from './platform/commands.service';
import { AuthController } from './identity/auth.controller';
import { UsersController } from './identity/users.controller';
import { OperationsController } from './identity/operations.controller';
import { CatalogService } from './catalog/catalog.service';
import { CustomersController } from './catalog/customers.controller';
import { VehiclesController, ReferenceController } from './catalog/vehicles.controller';
import { PricingController } from './pricing/pricing.controller';
import { SchedulingController } from './scheduling/scheduling.controller';
import { SchedulingService } from './scheduling/scheduling.service';
import { TechnicalBlockService } from './scheduling/technical-block.service';
import { BookingService } from './scheduling/booking.service';
import { BookingQueryService } from './scheduling/booking-query.service';
import { CalendarService } from './scheduling/calendar.service';
import { FinanceController } from './finance/finance.controller';
import { FinanceService } from './finance/finance.service';
import { DocumentsController } from './documents/documents.controller';
import { DocumentsQueryService } from './documents/documents-query.service';
import { ContractsService } from './documents/contracts.service';
import { InspectionsService } from './documents/inspections.service';
import { PrivateFilesService } from './documents/private-files.service';
import { PrivateStorage } from './documents/private-storage';
import { DocumentPrintService } from './documents/document-print.service';
import { ActsService } from './documents/acts.service';
import { CheckoutService } from './documents/checkout.service';
import { DocumentWorker } from './documents/document-worker';
import { DocumentSchemaGuard } from './documents/document-schema.guard';
import { AccountingEmailWorker } from './scheduling/accounting-email.worker';

@Module({
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    OperationsController,
    CustomersController,
    VehiclesController,
    ReferenceController,
    PricingController,
    SchedulingController,
    FinanceController,
    DocumentsController,
  ],
  providers: [
    DatabaseService,
    CommandsService,
    CatalogService,
    SchedulingService,
    TechnicalBlockService,
    BookingService,
    BookingQueryService,
    CalendarService,
    FinanceService,
    ContractsService,
    DocumentsQueryService,
    InspectionsService,
    PrivateFilesService,
    PrivateStorage,
    DocumentWorker,
    AccountingEmailWorker,
    CheckoutService,
    ActsService,
    DocumentPrintService,
    DocumentSchemaGuard,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
