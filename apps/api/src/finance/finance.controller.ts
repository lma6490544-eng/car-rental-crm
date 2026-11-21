import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthRequest, idSchema, parse } from '../platform/security';
import { financeInput } from './finance.dto';
import { FinanceService } from './finance.service';
import { bookingSummary, funds } from './ledger';

@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}
  private read<T>(work: (c: import('pg').PoolClient) => Promise<T>) {
    return this.finance.db.transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return work(c);
    });
  }
  @Get('finance') get(@Query() raw: unknown) {
    const q = parse(
      z.object({ customerId: idSchema.optional(), bookingId: idSchema.optional() }).strict(),
      raw,
    );
    return this.read(async (c) => ({
      ...(await funds(c)),
      journal: await this.finance.journal(c, q.customerId, q.bookingId),
    }));
  }
  @Get('bookings/:id/finance') booking(@Param('id') raw: string) {
    const id = parse(idSchema, raw);
    return this.read(async (c) => ({
      summary: await bookingSummary(c, id),
      ...(await this.finance.journal(c, undefined, id)),
    }));
  }
  @Get('customers/:id/finance') customer(@Param('id') raw: string) {
    return this.read((c) => this.finance.customer(c, parse(idSchema, raw)));
  }
  @Post('financial-operations/preview') preview(@Body() raw: unknown) {
    return this.finance.preview(parse(financeInput, raw));
  }
  @Post('financial-operations') post(@Body() raw: unknown, @Req() r: AuthRequest) {
    return this.finance.post(parse(financeInput, raw), r);
  }
}
