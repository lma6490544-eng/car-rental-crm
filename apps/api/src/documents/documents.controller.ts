import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { raw } from 'express';
import type { Response } from 'express';
import { BinaryUpload } from '../platform/http';
import { AuthRequest, fail, idSchema, parse } from '../platform/security';
import { ActsService } from './acts.service';
import { CheckoutService } from './checkout.service';
import { RentalReturnService } from './rental-return.service';
import {
  returnCorrection,
  returnDamage,
  returnInspection,
  returnReview,
} from './rental-return.dto';
import { ContractsService } from './contracts.service';
import {
  actInput,
  cancelInspectionInput,
  checkoutInput,
  contractInput,
  fileId,
  inspectionInput,
  inspectionKind,
  issueInput,
  signActInput,
  signInput,
  startInspectionInput,
  stopCheckoutInput,
} from './document.dto';
import { InspectionsService } from './inspections.service';
import { DocumentsQueryService } from './documents-query.service';
import { DocumentSchemaGuard } from './document-schema.guard';
import { DocumentPrintService } from './document-print.service';
import { PrivateFilesService } from './private-files.service';
import { uploadLimit } from './private-storage';

const readBinary = raw({ limit: uploadLimit, inflate: false, type: () => true });
async function uploadedBytes(request: AuthRequest, response: Response) {
  try {
    await new Promise<void>((resolve, reject) =>
      readBinary(request, response, (error: unknown) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 413)
      fail(413, 'FILE_TOO_LARGE', 'Максимальный размер файла — 8 МБ.');
    fail(400, 'FILE_READ_FAILED', 'Не удалось прочитать файл.');
  }
  const body: unknown = request.body;
  if (!Buffer.isBuffer(body) || !body.length) fail(400, 'FILE_REQUIRED', 'Выберите файл.');
  return body;
}

@Controller()
@UseGuards(DocumentSchemaGuard)
export class DocumentsController {
  private readonly customerDocumentUploadsEnabled =
    process.env.CRM_CUSTOMER_DOCUMENT_UPLOADS_ENABLED === 'true';

  constructor(
    private readonly documents: DocumentsQueryService,
    private readonly inspections: InspectionsService,
    private readonly contracts: ContractsService,
    private readonly files: PrivateFilesService,
    private readonly checkout: CheckoutService,
    private readonly rentalReturn: RentalReturnService,
    private readonly acts: ActsService,
    private readonly print: DocumentPrintService,
  ) {}

  @Get('bookings/:id/documents')
  list(@Param('id') rawId: string) {
    return this.documents.get(parse(idSchema, rawId));
  }

  @Get('bookings/:id/return')
  getReturn(@Param('id') id: string) {
    return this.rentalReturn.get(parse(idSchema, id));
  }

  @Post('bookings/:id/return/start')
  startReturn(@Req() request: AuthRequest, @Param('id') id: string) {
    return this.rentalReturn.start(request, parse(idSchema, id));
  }

  @Get('customers/:id/rental-history')
  customerRentalHistory(@Param('id') id: string) {
    return this.rentalReturn.list('customers', parse(idSchema, id));
  }

  @Get('vehicles/:id/rental-history')
  vehicleRentalHistory(@Param('id') id: string) {
    return this.rentalReturn.list('vehicles', parse(idSchema, id));
  }

  @Post('bookings/:id/return/inspection')
  saveReturn(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.save(r, parse(idSchema, id), parse(returnInspection, body));
  }

  @Post('bookings/:id/return/review')
  reviewReturn(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.review(r, parse(idSchema, id), parse(returnReview, body), false);
  }

  @Post('bookings/:id/return/confirm')
  confirmReturn(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.review(r, parse(idSchema, id), parse(returnReview, body), true);
  }

  @Post('bookings/:id/return/correction-preview')
  reviewCorrection(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.correct(r, parse(idSchema, id), parse(returnCorrection, body), false);
  }

  @Post('bookings/:id/return/correct')
  correctReturn(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.correct(r, parse(idSchema, id), parse(returnCorrection, body), true);
  }

  @Post('bookings/:id/return/damage')
  chargeReturnDamage(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.rentalReturn.chargeDamage(r, parse(idSchema, id), parse(returnDamage, body));
  }

  @Post('bookings/:id/checkout/start')
  startCheckout(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.checkout.start(
      r,
      parse(idSchema, id),
      parse(checkoutInput, body).expectedBookingVersion,
    );
  }
  @Post('bookings/:id/checkout/stop')
  stopCheckout(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.checkout.stop(r, parse(idSchema, id), parse(stopCheckoutInput, body));
  }

  @Post('bookings/:id/checkout/sign-act')
  signAct(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(signActInput, body);
    return this.checkout.signAct(
      r,
      parse(idSchema, id),
      input.expectedBookingVersion,
      input.inspectionRevisionId,
      input.actVersionId,
    );
  }
  @Post('bookings/:id/checkout/issue')
  issue(@Req() r: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.checkout.issue(r, parse(idSchema, id), parse(issueInput, body));
  }

  @Post('bookings/:id/inspections/:kind/start')
  startInspection(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    const input = parse(startInspectionInput, body);
    return this.inspections.start(
      request,
      parse(idSchema, id),
      parse(inspectionKind, kind),
      input.expectedBookingVersion,
      input.replaceWorkId,
    );
  }

  @Post('bookings/:id/inspections/:kind/cancel')
  cancelInspection(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    const input = parse(cancelInspectionInput, body);
    return this.inspections.cancel(
      request,
      parse(idSchema, id),
      parse(inspectionKind, kind),
      input.expectedBookingVersion,
      input.workId,
    );
  }

  @Post('bookings/:id/inspections/:kind')
  inspect(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Body() body: unknown,
  ) {
    return this.inspections.save(
      request,
      parse(idSchema, id),
      parse(inspectionKind, kind),
      parse(inspectionInput, body),
    );
  }

  @Post('bookings/:id/inspection-photos/:kind/:version')
  @BinaryUpload()
  async uploadPhoto(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Param('version') version: string,
  ) {
    return this.files.upload(
      request,
      {
        bookingId: parse(idSchema, id),
        kind: parse(inspectionKind, kind),
        expectedBookingVersion: parse(idSchema, version),
      },
      request.headers['content-type']!,
      await uploadedBytes(request, response),
    );
  }

  @Get('bookings/:id/inspection-photos/:file')
  async photo(@Param('id') id: string, @Param('file') rawFile: string) {
    const file = parse(fileId, rawFile);
    const { bytes, mime } = await this.files.download(
      { bookingId: parse(idSchema, id) },
      file,
      'inspection_photo',
    );
    return new StreamableFile(bytes, {
      type: mime,
      disposition:
        'attachment; filename="inspection.' + (mime === 'image/png' ? 'png' : 'jpg') + '"',
    });
  }

  @Get('customer-document-settings')
  customerDocumentSettings() {
    return { uploadsEnabled: this.customerDocumentUploadsEnabled };
  }

  @Get('customers/:id/private-documents')
  customerFiles(@Param('id') id: string) {
    return this.files.customerDocuments(parse(idSchema, id));
  }

  @Post('customers/:id/private-documents')
  @BinaryUpload()
  async uploadCustomerFile(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
    @Param('id') id: string,
  ) {
    if (!this.customerDocumentUploadsEnabled)
      fail(403, 'CUSTOMER_DOCUMENT_UPLOAD_DISABLED', 'Загрузка документов клиента отключена.');
    return this.files.upload(
      request,
      { customerId: parse(idSchema, id) },
      request.headers['content-type']!,
      await uploadedBytes(request, response),
    );
  }

  @Get('customers/:id/private-documents/:file')
  async customerFile(@Param('id') id: string, @Param('file') rawFile: string) {
    const file = parse(fileId, rawFile);
    const { bytes, mime } = await this.files.download(
      { customerId: parse(idSchema, id) },
      file,
      'customer_document',
    );
    const extension = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    return new StreamableFile(bytes, {
      type: mime,
      disposition: 'attachment; filename="document.' + extension + '"',
    });
  }

  @Post('bookings/:id/contracts')
  create(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.contracts.create(request, parse(idSchema, id), parse(contractInput, body));
  }

  @Post('bookings/:id/contracts/:version/retry')
  retry(@Req() request: AuthRequest, @Param('id') id: string, @Param('version') version: string) {
    return this.contracts.retry(request, parse(idSchema, id), parse(idSchema, version));
  }

  @Post('bookings/:id/contracts/:version/sign')
  sign(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    return this.contracts.sign(
      request,
      parse(idSchema, id),
      parse(idSchema, version),
      parse(signInput, body).expectedBookingVersion,
    );
  }

  @Post('bookings/:id/acts')
  generateAct(@Req() request: AuthRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(actInput, body);
    return this.acts.generate(
      request,
      parse(idSchema, id),
      input.inspectionRevisionId,
      input.expectedBookingVersion,
    );
  }

  @Post('bookings/:id/acts/:version/retry')
  retryAct(
    @Req() request: AuthRequest,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    return this.acts.retry(request, parse(idSchema, id), parse(idSchema, version));
  }

  @Get('bookings/:id/acts/:version/pdf')
  async printAct(@Param('id') id: string, @Param('version') version: string) {
    const bookingId = parse(idSchema, id);
    const bytes = await this.print.act(bookingId, parse(idSchema, version));
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: 'inline; filename="inspection-act-' + bookingId + '.pdf"',
    });
  }

  @Get('bookings/:id/contracts/:version/pdf')
  async printContract(@Param('id') id: string, @Param('version') version: string) {
    const bookingId = parse(idSchema, id);
    const bytes = await this.print.contract(bookingId, parse(idSchema, version));
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: 'inline; filename="contract-' + bookingId + '.pdf"',
    });
  }

  @Get('bookings/:id/act-files/:file')
  async act(@Param('id') rawId: string, @Param('file') rawFile: string) {
    const id = parse(idSchema, rawId);
    const result = await this.files.download(
      { bookingId: id },
      parse(fileId, rawFile),
      'inspection_act',
    );
    return new StreamableFile(result.bytes, {
      type: result.mime,
      disposition: 'inline; filename="inspection-act-' + id + '.pdf"',
    });
  }

  @Get('bookings/:id/contract-files/:file')
  async contract(@Param('id') rawId: string, @Param('file') rawFile: string) {
    const id = parse(idSchema, rawId);
    const result = await this.files.download({ bookingId: id }, parse(fileId, rawFile), 'contract');
    return new StreamableFile(result.bytes, {
      type: result.mime,
      disposition: 'inline; filename="contract-' + id + '.pdf"',
    });
  }
}
