const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { DatabaseService } = require('../dist/database.service');
const { SchedulingService } = require('../dist/scheduling/scheduling.service');
const { BookingService } = require('../dist/scheduling/booking.service');
const { CalendarService } = require('../dist/scheduling/calendar.service');
const { FinanceController } = require('../dist/finance/finance.controller');
const { FinanceService } = require('../dist/finance/finance.service');
const { CheckoutService } = require('../dist/documents/checkout.service');
const { CommandsService } = require('../dist/platform/commands.service');
const { ruleSets } = require('../dist/pricing/rules');
const { AccountingEmailWorker } = require('../dist/scheduling/accounting-email.worker');
const {
  accountingEmailKind,
  accountingMessage,
  getAccountingEmailStatus,
  queueAccountingEmail,
} = require('../dist/scheduling/accounting-email');

test('The test runner keeps SMTP disabled even with an app password', (t) => {
  const previousPassword = process.env.ACCOUNTING_SMTP_APP_PASSWORD;
  t.after(() => {
    if (previousPassword === undefined) delete process.env.ACCOUNTING_SMTP_APP_PASSWORD;
    else process.env.ACCOUNTING_SMTP_APP_PASSWORD = previousPassword;
  });
  process.env.ACCOUNTING_SMTP_APP_PASSWORD = 'test-only';
  const worker = new AccountingEmailWorker();
  const schedule = t.mock.method(worker, 'schedule', () => {});
  worker.onApplicationBootstrap();
  assert.equal(schedule.mock.callCount(), 0);
});

test('Accounting email uses the confirmed total for mixed rates and discounted days', () => {
  const message = accountingMessage({
    bookingId: 1,
    company: 'ООО «21 век»',
    startAt: new Date('2080-01-12T22:00:00Z'),
    endAt: new Date('2080-01-16T22:00:00Z'),
    brand: 'Ford',
    model: 'Ford Transit',
    plate: 'E 696 CA 198',
    calculation: {
      finalTotalRub: '8000',
      dayLines: [
        { amountRub: '4100' },
        { amountRub: '4500' },
        { amountRub: '0', nonBillable: true },
      ],
    },
  });
  assert.equal(
    message.text.replace(/\u00a0/g, ' '),
    'ООО «21 век» с 13.01 по 17.01 1 день по 4 100 ₽ + 1 день по 4 500 ₽, итого 8 000 ₽\nАвтомобиль: Ford Transit, гос. № E 696 CA 198',
  );
});

test('Accounting email is queued transactionally and sent once for the current assignment', async (t) => {
  const database = 'crm_accounting_test_' + randomBytes(8).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  const admin = new Pool({ connectionString: url.toString() });
  let db;
  t.after(async () => {
    if (db) await db.pool.end();
    assert.match(database, /^crm_accounting_test_[a-f0-9]{16}$/);
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${database}"`);
  url.pathname = '/' + database;
  process.env.DATABASE_URL = url.toString();
  db = new DatabaseService();
  await migrate(drizzle(db.pool), { migrationsFolder: path.resolve(__dirname, '../drizzle') });

  const insertId = async (sql, params) => (await db.pool.query(sql, params)).rows[0].id;
  const actor = await insertId(
    "INSERT INTO users(full_name,login,password_hash,role) VALUES ('Mail','mail','unused','manager') RETURNING id",
  );
  await db.pool.query(
    "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,'accounting-test',now()+interval '1 hour')",
    [actor],
  );
  const company = await insertId(
    "INSERT INTO customers(type,display_name,inn) VALUES ('company','ООО «21 век»','1234567890') RETURNING id",
  );
  const individual = await insertId(
    "INSERT INTO customers(type,display_name) VALUES ('individual','Клиент') RETURNING id",
  );
  const brand = await insertId("INSERT INTO vehicle_brands(name) VALUES ('Ford') RETURNING id");
  const model = await insertId(
    "INSERT INTO vehicle_models(brand_id,name,pricing_group_id) SELECT $1,'Transit',id FROM pricing_groups WHERE tariff_code='economy' RETURNING id",
    [brand],
  );
  const addVehicle = (plate) =>
    insertId(
      "INSERT INTO vehicles(model_id,plate,year,body_type) VALUES ($1,$2,2020,'sedan') RETURNING id",
      [model, plate],
    );
  const firstVehicle = await addVehicle('FIRST');
  const secondVehicle = await addVehicle('E 696 CA 198');
  await addVehicle('THIRD');
  const start = '2080-01-13T00:00:00Z';
  const quote = await insertId(
    "INSERT INTO pricing_quotes(created_by,confirmed_by,confirmed_at,expires_at,version,input,snapshot,confirmed_overrides) VALUES ($1,$1,now(),'2099-01-01',2,'{}',$2,'[]') RETURNING id",
    [
      actor,
      {
        operationKind: 'initial',
        ruleVersion: ruleSets.at(-1).version,
        startAt: start,
        contractDays: 4,
        overrides: { customDailyRateRub: '4100' },
        finalTotalRub: '16400',
        dayLines: Array.from({ length: 4 }, () => ({ amountRub: '4100' })),
      },
    ],
  );

  const scheduling = new SchedulingService(db, new CommandsService(db));
  const bookingService = new BookingService(scheduling);
  const calendar = new CalendarService(db, scheduling);
  const loadCalendar = () =>
    calendar.get({ from: '2080-01-12T00:00:00Z', to: '2080-01-18T00:00:00Z' });
  const request = () => ({
    headers: { 'idempotency-key': randomUUID() },
    requestId: randomUUID(),
    auth: { user: { id: actor }, tokenHash: 'accounting-test' },
  });
  const addBooking = (customer, requestAccountingEmail, vehicleId) =>
    bookingService.create(
      {
        customer: { existingId: customer },
        target: vehicleId ? { type: 'vehicle', id: vehicleId } : { type: 'model', id: model },
        quoteId: quote,
        reason: 'Accounting test',
        requestAccountingEmail,
      },
      request(),
    );
  const declined = await addBooking(company, false, firstVehicle);
  const personal = await addBooking(individual, true);
  assert.equal(declined.accountingEmailRequested, undefined);
  assert.equal(personal.accountingEmailRequested, undefined);
  const statuses = async () =>
    (
      await db.pool.query('SELECT status FROM outbox_jobs WHERE kind=$1', [accountingEmailKind])
    ).rows.map((row) => row.status);
  assert.deepEqual(await statuses(), []);
  await assert.rejects(
    db.transaction(async (client) => {
      await queueAccountingEmail(client, declined.id);
      throw new Error('abort booking');
    }),
    /abort booking/,
  );
  assert.deepEqual(await statuses(), []);
  const booking = await addBooking(company, true);
  const bookingId = booking.id;
  assert.equal(booking.accountingEmailRequested, undefined);
  assert.deepEqual(await statuses(), []);
  assert.deepEqual(await getAccountingEmailStatus(db.pool, bookingId), {
    status: 'none',
    canRequest: false,
    isCompany: true,
    sentAt: null,
  });
  assert.deepEqual(await getAccountingEmailStatus(db.pool, declined.id), {
    status: 'none',
    canRequest: true,
    isCompany: true,
    sentAt: null,
  });
  const initialCalendar = await loadCalendar();
  assert.equal(
    initialCalendar.unassignedBookings.find((entry) => entry.id === bookingId)
      .accountingEmailUnsent,
    true,
  );
  assert.equal(
    initialCalendar.unassignedBookings.find((entry) => entry.id === personal.id)
      .accountingEmailUnsent,
    undefined,
  );
  await assert.rejects(
    bookingService.requestAccountingEmail(request(), bookingId, booking.version),
    (error) => error.getResponse().code === 'ACCOUNTING_EMAIL_UNAVAILABLE',
  );

  // A pending request from before assignment IDs were stored must not send.
  await db.pool.query('INSERT INTO outbox_jobs(business_key,kind,payload) VALUES ($1,$2,$3)', [
    accountingEmailKind + ':' + bookingId,
    accountingEmailKind,
    { bookingId },
  ]);

  const sent = [];
  const transport = { sendMail: async (message) => sent.push(message) };
  const worker = new AccountingEmailWorker(db);
  await worker.run(transport);
  assert.equal(sent.length, 0);

  const assigned = await bookingService.assign(
    { expectedVersion: booking.version, vehicleId: secondVehicle, reason: 'Assignment' },
    request(),
    bookingId,
  );
  await worker.run(transport);
  assert.equal(sent.length, 0);
  assert.deepEqual(await getAccountingEmailStatus(db.pool, bookingId), {
    status: 'none',
    canRequest: true,
    isCompany: true,
    sentAt: null,
  });
  assert.equal(
    (await loadCalendar()).events.find((event) => event.booking_id === bookingId)
      .accountingEmailUnsent,
    true,
  );
  const queued = await bookingService.requestAccountingEmail(
    request(),
    bookingId,
    assigned.version,
  );
  assert.equal(queued.accountingEmailRequested, true);
  assert.deepEqual(
    await bookingService.requestAccountingEmail(request(), bookingId, assigned.version),
    { id: bookingId },
  );
  assert.deepEqual(await statuses(), ['pending']);
  const warn = t.mock.method(worker.logger, 'warn', () => {});
  await worker.run({
    sendMail: async () => {
      throw Object.assign(new Error('internal SMTP details'), {
        code: 'EMESSAGE',
        command: 'DATA',
        responseCode: 554,
        response: '554 spam rejected with private details',
      });
    },
  });
  assert.deepEqual(await statuses(), ['failed']);
  assert.deepEqual(warn.mock.calls[0].arguments, [
    `Accounting email for booking ${bookingId}: failed (EMESSAGE, DATA, SMTP 554, spam policy)`,
  ]);
  assert.deepEqual(await getAccountingEmailStatus(db.pool, bookingId), {
    status: 'failed',
    canRequest: true,
    isCompany: true,
    sentAt: null,
  });
  const retried = await bookingService.requestAccountingEmail(
    request(),
    bookingId,
    assigned.version,
  );
  assert.equal(retried.accountingEmailRequested, true);
  await Promise.all([worker.run(transport), worker.run(transport)]);
  assert.deepEqual(await statuses(), ['done']);
  const sentStatus = await getAccountingEmailStatus(db.pool, bookingId);
  const {
    rows: [sentJob],
  } = await db.pool.query('SELECT payload FROM outbox_jobs WHERE business_key=$1', [
    accountingEmailKind + ':' + bookingId,
  ]);
  assert.deepEqual(sentStatus, {
    status: 'done',
    canRequest: false,
    isCompany: true,
    sentAt: new Date(sentJob.payload.sentAt).toISOString(),
  });
  assert.equal(
    (await loadCalendar()).events.find((event) => event.booking_id === bookingId)
      .accountingEmailUnsent,
    undefined,
  );
  await db.pool.query("UPDATE outbox_jobs SET payload=payload-'sentAt' WHERE business_key=$1", [
    accountingEmailKind + ':' + bookingId,
  ]);
  assert.deepEqual(await getAccountingEmailStatus(db.pool, bookingId), sentStatus);
  assert.deepEqual(
    await bookingService.requestAccountingEmail(request(), bookingId, assigned.version),
    { id: bookingId },
  );
  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text.replace(/\u00a0/g, ' '),
    'ООО «21 век» с 13.01 по 17.01 4 дня по 4 100 ₽ = 16 400 ₽\nАвтомобиль: Ford Transit, гос. № E 696 CA 198',
  );
  assert.match(sent[0].subject, /Данные для счёта по брони/);
  assert.equal(sent[0].attachments, undefined);
  const fourthVehicle = await addVehicle('FOURTH');
  const queuedOnCreate = await addBooking(company, true, fourthVehicle);
  assert.equal(queuedOnCreate.accountingEmailRequested, true);

  await t.test(
    'bank invoice receipts before checkout share the ledger, calendar and contract totals',
    async () => {
      const financeService = new FinanceService(db, scheduling.commands);
      const finance = new FinanceController(financeService);
      const checkout = new CheckoutService(scheduling.commands);
      const base = {
        bookingId,
        customerId: company,
        expectedVersion: assigned.version,
        amountRub: '6000',
        expectedCoverageRub: '0',
        paidOn: '2020-04-06',
        reference: '72',
      };
      const view = () => finance.booking(String(bookingId));
      const calendarPayment = async () =>
        (await loadCalendar()).events.find((event) => event.booking_id === bookingId)
          .invoicePayment;
      assert.equal((await view()).invoicePayment.status, 'unpaid');
      assert.equal((await calendarPayment()).status, 'unpaid');
      await assert.rejects(
        finance.invoiceReceipt(
          {
            ...base,
            bookingId: personal.id,
            customerId: individual,
            expectedVersion: personal.version,
          },
          request(),
        ),
        (error) => error.getResponse().code === 'INVOICE_RECEIPT_UNAVAILABLE',
      );
      const requests = [request(), request()];
      const race = await Promise.allSettled(
        requests.map((command) => finance.invoiceReceipt(base, command)),
      );
      const winner = race.findIndex((outcome) => outcome.status === 'fulfilled');
      assert.ok(winner >= 0);
      const rejected = race[1 - winner];
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.reason.getResponse().code, 'INVOICE_BALANCE_CHANGED');
      assert.deepEqual(await finance.invoiceReceipt(base, requests[winner]), race[winner].value);
      const partial = {
        status: 'partial',
        priceRub: '16400',
        receivedRub: '6000',
        remainingRub: '10400',
      };
      const beforeCheckout = await view();
      assert.deepEqual(beforeCheckout.invoicePayment, partial);
      assert.deepEqual(await calendarPayment(), partial);
      assert.equal(beforeCheckout.summary.paymentsAllowed, false);
      assert.equal(beforeCheckout.items.length, 1);
      assert.equal(beforeCheckout.items[0].reason, 'Поступление по счёту от 06.04.2020 · № 72');
      assert.deepEqual(beforeCheckout.items[0].external, [{ method: 'bank', amountRub: '6000' }]);
      assert.deepEqual(beforeCheckout.items[0].funds, []);
      assert.equal(await db.transaction((client) => checkout.state(client, bookingId)), null);
      await assert.rejects(
        bookingService.cancel(
          { expectedVersion: assigned.version, reason: 'Payment exists' },
          request(),
          bookingId,
        ),
        (error) => error.getResponse().code === 'CHECKOUT_HAS_MONEY',
      );
      await assert.rejects(
        bookingService.assign(
          { expectedVersion: assigned.version, vehicleId: null, reason: 'Payment exists' },
          request(),
          bookingId,
        ),
        (error) => error.getResponse().code === 'CHECKOUT_HAS_MONEY',
      );
      assert.deepEqual(await calendarPayment(), partial);
      await assert.rejects(
        finance.invoiceReceipt({ ...base, expectedCoverageRub: '6000' }, request()),
        (error) => error.getResponse().code === 'INVOICE_RECEIPT_ALREADY_POSTED',
      );
      await assert.rejects(
        finance.invoiceReceipt(
          { ...base, expectedCoverageRub: '6000', reference: '73', amountRub: '10401' },
          request(),
        ),
        (error) => error.getResponse().code === 'INVOICE_RECEIPT_EXCEEDS_BALANCE',
      );
      await checkout.start(request(), bookingId, assigned.version);
      const checkoutState = await db.transaction((client) => checkout.state(client, bookingId));
      assert.equal(checkoutState.hasMoney, true);
      assert.equal(checkoutState.rentReceived, true);
      assert.equal((await view()).summary.debtRub, '10400');
      const remainder = await finance.invoiceReceipt(
        {
          ...base,
          expectedCoverageRub: '6000',
          reference: '73',
          amountRub: '10400',
        },
        request(),
      );
      const paid = { ...partial, status: 'paid', receivedRub: '16400', remainingRub: '0' };
      assert.deepEqual((await view()).invoicePayment, paid);
      assert.deepEqual(await calendarPayment(), paid);
      await finance.post(
        { kind: 'reversal', operationId: remainder.id, reason: 'Проверка исправления' },
        request(),
      );
      assert.deepEqual((await view()).invoicePayment, partial);
      assert.deepEqual(await calendarPayment(), partial);
    },
  );
});
