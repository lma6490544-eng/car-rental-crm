// Historical money is seeded only in the performance harness's disposable database.
// These fixtures do not enable receipt commands before actual vehicle issuance.
const { randomUUID } = require('node:crypto');
async function operation(
  db,
  booking,
  kind,
  reason = 'Synthetic historical finance',
  reversalOf = null,
) {
  return (
    await db.query(
      "INSERT INTO financial_operations(command_id,request_hash,kind,customer_id,booking_id,actor_id,reason,reversal_of) VALUES ($1,'fixture-5.3',$2,$3,$4,$5,$6,$7) RETURNING id",
      [randomUUID(), kind, booking.customer_id, booking.id, booking.created_by, reason, reversalOf],
    )
  ).rows[0].id;
}
async function allocation(
  db,
  operationId,
  lot,
  bucket,
  bookingId,
  amount,
  fund = 'operating_cash',
) {
  await db.query(
    'INSERT INTO finance_allocations(operation_id,lot_id,bucket,booking_id,amount_rub,fund) VALUES ($1,$2,$3,$4,$5,$6)',
    [operationId, lot, bucket, bookingId, amount, fund],
  );
}
async function addTerms(db, booking, revision, snapshot, createdAt = '2054-01-01') {
  const quote = (await db.query('SELECT id FROM pricing_quotes ORDER BY id LIMIT 1')).rows[0].id;
  return (
    await db.query(
      "INSERT INTO booking_terms(booking_id,revision,quote_id,snapshot,reason,created_by,created_at) VALUES ($1,$2,$3,$4,'Synthetic revision',$5,$6) RETURNING id",
      [booking.id, revision, quote, JSON.stringify(snapshot), booking.created_by, createdAt],
    )
  ).rows[0].id;
}
async function populateFinance(db) {
  const customers = [(await db.query('SELECT id FROM customers ORDER BY id LIMIT 1')).rows[0].id];
  for (let i = 1; i < 8; i++)
    customers.push(
      (
        await db.query(
          "INSERT INTO customers(type,display_name) VALUES ('individual',$1) RETURNING id",
          ['Synthetic finance customer ' + i],
        )
      ).rows[0].id,
    );
  const bookings = (await db.query('SELECT * FROM bookings ORDER BY id')).rows;
  for (const [i, booking] of bookings.entries()) {
    booking.customer_id = customers[i % customers.length];
    await db.query('UPDATE bookings SET customer_id=$2 WHERE id=$1', [
      booking.id,
      booking.customer_id,
    ]);
    if (i === 0) {
      await db.query('DELETE FROM booking_terms WHERE booking_id=$1', [booking.id]);
      continue;
    }
    let snapshot = {
      finalTotalRub: i === 4 ? '0' : i === 5 ? '9007199254740993123' : '10000',
      periods: [
        {
          pricingGroup: { code: 'test' },
          tariffSnapshot: {
            groups: [
              { code: 'other', category: 'passenger' },
              { code: 'test', category: i % 2 ? 'minibus' : 'passenger' },
            ],
          },
        },
      ],
    };
    if (i === 1) snapshot = null;
    if (i === 2) snapshot = { finalTotalRub: null };
    if (i === 3) snapshot = {};
    // Highest revision wins even if a lower revision is inserted later and has a newer date.
    const terms = await addTerms(db, booking, 5, snapshot, '2050-01-01');
    await addTerms(db, booking, 3, { finalTotalRub: '777' }, '2054-01-01');
    const charge = await operation(db, booking, 'charge');
    await db.query(
      'INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub) VALUES ($1,$2,$3,$4)',
      [charge, booking.id, terms, '8000'],
    );
    const adjustment = await operation(db, booking, 'charge');
    await db.query(
      'INSERT INTO finance_charges(operation_id,booking_id,terms_id,amount_rub) VALUES ($1,$2,$3,$4)',
      [adjustment, booking.id, terms, '-1000'],
    );
    if (i % 7 === 0) continue; // charges without allocations; missing buckets remain zero.
    const receipt = await operation(db, booking, 'rent_payment');
    const lot = (
      await db.query(
        "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'rent',$3) RETURNING id",
        [booking.customer_id, receipt, i % 2 ? 'cash' : 'bank'],
      )
    ).rows[0].id;
    const rent = i === 5 ? '9007199254740993001' : i % 3 ? '4000' : '12000';
    await allocation(db, receipt, lot, 'rent', booking.id, rent);
    await db.query(
      'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,$3)',
      [receipt, i % 2 ? 'cash' : 'bank', rent],
    );
    await db.query(
      "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'operating_cash',$2)",
      [receipt, rent],
    );
    const refund = await operation(db, booking, 'refund');
    await allocation(db, refund, lot, 'rent', booking.id, '-333');
    await db.query(
      'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,-333)',
      [refund, i % 2 ? 'cash' : 'bank'],
    );
    await db.query(
      "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'operating_cash',-333)",
      [refund],
    );
    if (i % 4 === 0) {
      const reversal = await operation(
        db,
        booking,
        'reversal',
        'Synthetic refund compensation',
        refund,
      );
      await allocation(db, reversal, lot, 'rent', booking.id, '333');
      await db.query(
        'INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,$2,333)',
        [reversal, i % 2 ? 'cash' : 'bank'],
      );
      await db.query(
        "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'operating_cash',333)",
        [reversal],
      );
    }
    if (i % 2 === 0) {
      const deposit = await operation(db, booking, 'deposit_receipt');
      const depositLot = (
        await db.query(
          "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'deposit','cash') RETURNING id",
          [booking.customer_id, deposit],
        )
      ).rows[0].id;
      await allocation(db, deposit, depositLot, 'deposit', booking.id, '10000', 'deposit_pool');
      await db.query(
        "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'cash',10000)",
        [deposit],
      );
      await db.query(
        "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'deposit_pool',10000)",
        [deposit],
      );
    }
  }
  const prototype = bookings[0];
  for (const [i, customer] of customers.entries()) {
    // Funds originated from a booking entirely outside the requested calendar period.
    const outside = (
      await db.query(
        "INSERT INTO bookings(customer_id,start_at,end_at,target_type,target_model_id,created_by) VALUES ($1,'2040-01-01','2040-01-02','model',$2,$3) RETURNING *",
        [
          customer,
          (
            await db.query(
              'SELECT model_id FROM booking_eligible_models WHERE booking_id=$1 LIMIT 1',
              [prototype.id],
            )
          ).rows[0].model_id,
          prototype.created_by,
        ],
      )
    ).rows[0];
    const receipt = await operation(db, outside, 'rent_payment');
    const lot = (
      await db.query(
        "INSERT INTO finance_lots(customer_id,original_operation_id,origin,method) VALUES ($1,$2,'rent','bank') RETURNING id",
        [customer, receipt],
      )
    ).rows[0].id;
    await allocation(db, receipt, lot, 'credit', null, String(1000 + i));
    await db.query(
      "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'bank',$2)",
      [receipt, String(1000 + i)],
    );
    await db.query(
      "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'operating_cash',$2)",
      [receipt, String(1000 + i)],
    );
    const refund = await operation(db, outside, 'refund');
    await allocation(db, refund, lot, 'credit', null, '-100');
    await db.query(
      "INSERT INTO finance_external(operation_id,method,amount_rub) VALUES ($1,'bank',-100)",
      [refund],
    );
    await db.query(
      "INSERT INTO finance_fund_entries(operation_id,fund,amount_rub) VALUES ($1,'operating_cash',-100)",
      [refund],
    );
  }
  await db.query('ANALYZE');
}
module.exports = { populateFinance, operation, allocation, addTerms };
