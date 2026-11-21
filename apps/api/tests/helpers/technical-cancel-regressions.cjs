const assert = require('node:assert/strict');

module.exports = async function technicalCancelRegressions({
  t,
  contexts,
  snapshot,
  normalized,
  tables,
  financialTables,
  errorCode,
}) {
  const scenario = async ({ db, controller: c, request, makeBooking, cars }) => {
    const transcript = [];
    const money = await snapshot(db, financialTables);
    for (const count of [0, 1, 2]) {
      const day = 1 + count * 7;
      const bookings = [];
      for (let index = 0; index < count; index++)
        bookings.push(
          await makeBooking(
            'cancel-fixture-' + count + '-' + index,
            new Date(Date.UTC(2060, 0, day + index, 7)).toISOString(),
            cars[0],
            index === 1,
          ),
        );
      const body = {
        vehicleId: cars[0],
        startAt: new Date(Date.UTC(2060, 0, day, 9)).toISOString(),
        endAt: new Date(Date.UTC(2060, 0, day + Math.max(count, 1), 6)).toISOString(),
        reason: 'Исходная причина блока',
      };
      const preview = await c.previewTechnical({
        vehicleId: body.vehicleId,
        startAt: body.startAt,
        endAt: body.endAt,
      });
      assert.equal(preview.conflicts.length, count);
      const block = await c.technical(
        {
          ...body,
          conflictsToken: preview.token,
          displaceBookings: preview.conflicts.map((row) => ({
            id: row.booking_id,
            expectedVersion: row.booking_version,
          })),
        },
        request('cancel-create-' + count),
      );
      const input = { expectedVersion: block.version, reason: '  Отмена ремонта  ' };
      const req = request('cancel-command-' + count);
      const unchangedTables = [
        'bookings',
        'booking_terms',
        'booking_eligible_models',
        'booking_risks',
        'pricing_quotes',
        ...financialTables,
      ];
      const unchanged = await snapshot(db, unchangedTables);
      const assignments = async () =>
        (await db.pool.query("SELECT * FROM schedule_blocks WHERE kind='assignment' ORDER BY id"))
          .rows;
      const displaced = async () =>
        (
          await db.pool.query(
            "SELECT * FROM audit_logs WHERE action='bookings.displaced' ORDER BY id",
          )
        ).rows;
      const assignmentsBefore = await assignments();
      const displacedBefore = await displaced();
      const before = await snapshot(db);
      for (const reason of [undefined, '', ' ', 123, 'x'.repeat(1001)])
        assert.throws(
          () =>
            c.cancelTechnical(
              String(block.id),
              { ...input, reason },
              request('invalid-cancel-reason'),
            ),
          errorCode('VALIDATION_ERROR', 400),
        );
      assert.throws(() => c.cancelTechnical('0', input, req), errorCode('VALIDATION_ERROR', 400));
      for (const id of [block.id, 2147483647])
        await assert.rejects(
          c.cancelTechnical(
            String(id),
            { ...input, expectedVersion: 999 },
            request('stale-cancel-' + id),
          ),
          errorCode('VERSION_CONFLICT'),
        );
      const activeAssignment = assignmentsBefore.find((row) => row.retired_at === null);
      assert.ok(activeAssignment);
      await assert.rejects(
        c.cancelTechnical(
          String(activeAssignment.id),
          { ...input, expectedVersion: activeAssignment.version },
          request('wrong-cancel-kind'),
        ),
        errorCode('VERSION_CONFLICT'),
      );
      const revoked = request('revoked-cancel');
      revoked.auth.tokenHash = 'revoked';
      await assert.rejects(
        c.cancelTechnical(String(block.id), input, revoked),
        errorCode('UNAUTHENTICATED', 401),
      );
      assert.deepEqual(await snapshot(db), before, 'all rejected cancellations preserve every row');
      if (count === 2)
        for (const table of ['audit_logs', 'outbox_jobs']) {
          const field = table === 'audit_logs' ? 'action' : 'kind';
          await db.pool.query(
            'CREATE FUNCTION reject_cancel_stage10() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.' +
              field +
              "='schedule.cancelled' THEN RAISE EXCEPTION 'technical cancel injected failure'; END IF; RETURN NEW; END $$",
          );
          await db.pool.query(
            'CREATE TRIGGER reject_cancel_stage10 BEFORE INSERT ON ' +
              table +
              ' FOR EACH ROW EXECUTE FUNCTION reject_cancel_stage10()',
          );
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              await assert.rejects(
                c.cancelTechnical(String(block.id), input, req),
                /technical cancel injected failure/,
              );
              assert.deepEqual(
                await snapshot(db),
                before,
                'retirement, version, audit, outbox, command key and finance roll back',
              );
            }
          } finally {
            await db.pool.query('DROP TRIGGER reject_cancel_stage10 ON ' + table);
            await db.pool.query('DROP FUNCTION reject_cancel_stage10()');
          }
        }
      const window = {
        from: body.startAt,
        to: new Date(Date.parse(body.endAt) + 86400000).toISOString(),
      };
      const calendarBefore = await c.calendar(window);
      const cancelled = await c.cancelTechnical(String(block.id), input, req);
      const saved = (await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [block.id]))
        .rows[0];
      assert.deepEqual(cancelled, saved, 'full row is returned');
      assert.ok(cancelled.retired_at);
      assert.equal(cancelled.version, block.version + 1);
      assert.deepEqual(
        { ...cancelled, retired_at: null, version: block.version },
        block,
        'only retired_at and version change; original reason remains',
      );
      const committed = await snapshot(db);
      const retry = await c.cancelTechnical(String(block.id), input, req);
      assert.deepEqual(retry, JSON.parse(JSON.stringify(cancelled)));
      await assert.rejects(
        c.cancelTechnical(String(block.id), { ...input, reason: 'Другая причина' }, req),
        errorCode('IDEMPOTENCY_KEY_REUSED'),
      );
      for (const expectedVersion of [block.version, cancelled.version])
        await assert.rejects(
          c.cancelTechnical(
            String(block.id),
            { ...input, expectedVersion },
            request('cancel-again-' + count + '-' + expectedVersion),
          ),
          (e) =>
            errorCode('VERSION_CONFLICT')(e) &&
            e.getResponse().message === 'Блокировка изменилась. Обновите данные.',
        );
      const revokedRetry = request('cancel-command-' + count);
      revokedRetry.auth.tokenHash = 'revoked';
      await assert.rejects(
        c.cancelTechnical(String(block.id), input, revokedRetry),
        errorCode('UNAUTHENTICATED', 401),
      );
      assert.deepEqual(
        await snapshot(db),
        committed,
        'retries and rejected repeats add no effects',
      );
      assert.deepEqual(
        await snapshot(db, unchangedTables),
        unchanged,
        'bookings, versions, terms, quotes, risks and financial rows stay unchanged',
      );
      assert.deepEqual(
        await assignments(),
        assignmentsBefore,
        'no assignment is restored or rewritten',
      );
      assert.deepEqual(await displaced(), displacedBefore, 'displacement history remains intact');
      const audit = (
        await db.pool.query(
          "SELECT details FROM audit_logs WHERE entity_type='schedule_block' AND entity_id=$1 AND action='schedule.cancelled'",
          [block.id],
        )
      ).rows;
      assert.deepEqual(audit, [{ details: { reason: 'Отмена ремонта' } }]);
      const jobs = (
        await db.pool.query('SELECT kind,payload FROM outbox_jobs WHERE business_key=$1', [
          'schedule.cancelled:' + block.id + ':' + cancelled.version,
        ])
      ).rows;
      assert.deepEqual(jobs, [
        { kind: 'schedule.cancelled', payload: { id: block.id, version: cancelled.version } },
      ]);
      const calendar = await c.calendar(window);
      assert.equal(
        calendar.events.filter((row) => row.kind === 'technical').length,
        calendarBefore.events.filter((row) => row.kind === 'technical').length - 1,
      );
      for (const booking of bookings) {
        assert.ok(
          calendar.events.some((row) => row.kind === 'displaced' && row.booking_id === booking.id),
        );
        assert.ok(
          !calendar.events.some(
            (row) => row.kind === 'assignment' && row.booking_id === booking.id,
          ),
        );
        assert.ok(calendar.unassignedBookings.some((row) => row.id === booking.id));
        const problem = calendar.problems.find((row) => row.id === booking.id);
        assert.ok(problem.problemReasons.includes('Требуется замена автомобиля'));
        assert.equal(
          problem.availability.status,
          'feasible',
          'availability is recalculated while replacement is still required',
        );
      }
      transcript.push({
        cancelled: normalized(cancelled),
        retry: normalized(retry),
        calendar: normalized(calendar),
        state: await snapshot(db, tables, true),
      });
    }
    assert.deepEqual(await snapshot(db, financialTables), money);
    return transcript;
  };
  await t.test(
    'technical cancellation matches frozen command for zero, one and multiple displacements, retries and rollback',
    async () => {
      assert.deepEqual(await scenario(contexts[1]), await scenario(contexts[0]));
    },
  );

  await t.test(
    'edit versus cancellation of one technical block commits exactly one version change',
    async () => {
      const { db, controller: c, request, cars } = contexts[1];
      for (const cancelFirst of [true, false]) {
        const day = cancelFirst ? 1 : 5;
        const body = {
          vehicleId: cars[0],
          startAt: new Date(Date.UTC(2062, 0, day)).toISOString(),
          endAt: new Date(Date.UTC(2062, 0, day + 1)).toISOString(),
          reason: 'Race block',
        };
        const block = await c.technical(body, request('edit-cancel-create-' + day));
        const cancel = () =>
          c.cancelTechnical(
            String(block.id),
            { expectedVersion: block.version, reason: 'Cancel race' },
            request('edit-cancel-' + day),
          );
        const edit = () =>
          c.updateTechnical(
            String(block.id),
            {
              ...body,
              endAt: new Date(Date.UTC(2062, 0, day + 2)).toISOString(),
              expectedVersion: block.version,
            },
            request('edit-race-' + day),
          );
        const results = await Promise.allSettled(
          cancelFirst ? [cancel(), edit()] : [edit(), cancel()],
        );
        assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
        assert.ok(
          errorCode('VERSION_CONFLICT')(results.find((row) => row.status === 'rejected').reason),
        );
        const saved = (await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [block.id]))
          .rows[0];
        assert.equal(saved.version, block.version + 1);
        assert.deepEqual(saved, results.find((row) => row.status === 'fulfilled').value);
      }
    },
  );

  await t.test(
    'cancellation versus assignment uses current availability without automatic restoration',
    async () => {
      const { db, controller: c, request, cars, makeBooking } = contexts[1];
      for (const cancelFirst of [true, false]) {
        const day = cancelFirst ? 1 : 5;
        const booking = await makeBooking(
          'cancel-assign-booking-' + day,
          new Date(Date.UTC(2063, 0, day, 7)).toISOString(),
          cars[0],
        );
        const body = {
          vehicleId: cars[0],
          startAt: booking.start_at.toISOString(),
          endAt: booking.end_at.toISOString(),
          reason: 'Before cancellation race',
        };
        const preview = await c.previewTechnical({
          vehicleId: body.vehicleId,
          startAt: body.startAt,
          endAt: body.endAt,
        });
        const block = await c.technical(
          {
            ...body,
            conflictsToken: preview.token,
            displaceBookings: [{ id: booking.id, expectedVersion: booking.version }],
          },
          request('cancel-assign-block-' + day),
        );
        const current = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id]))
          .rows[0];
        const cancel = () =>
          c.cancelTechnical(
            String(block.id),
            { expectedVersion: block.version, reason: 'Release constraint' },
            request('cancel-assign-' + day),
          );
        const assign = () =>
          c.assignment(
            String(booking.id),
            { expectedVersion: current.version, vehicleId: cars[0] },
            request('assign-after-cancel-' + day),
          );
        const results = await Promise.allSettled(
          cancelFirst ? [cancel(), assign()] : [assign(), cancel()],
        );
        const cancelResult = results[cancelFirst ? 0 : 1];
        const assignResult = results[cancelFirst ? 1 : 0];
        assert.equal(cancelResult.status, 'fulfilled');
        const retired = (
          await db.pool.query('SELECT * FROM schedule_blocks WHERE id=$1', [block.id])
        ).rows[0];
        assert.equal(retired.version, block.version + 1);
        assert.ok(retired.retired_at);
        const saved = (await db.pool.query('SELECT * FROM bookings WHERE id=$1', [booking.id]))
          .rows[0];
        const active = (
          await db.pool.query(
            'SELECT * FROM schedule_blocks WHERE booking_id=$1 AND retired_at IS NULL',
            [booking.id],
          )
        ).rows;
        assert.equal(saved.status, 'confirmed');
        if (assignResult.status === 'fulfilled') {
          assert.equal(saved.version, current.version + 1);
          assert.equal(active.length, 1);
          assert.equal(active[0].vehicle_id, cars[0]);
        } else {
          assert.ok(errorCode('VEHICLE_ASSIGNMENT_CONFLICT')(assignResult.reason));
          assert.equal(saved.version, current.version);
          assert.equal(active.length, 0);
        }
      }
    },
  );
};
