import { z } from 'zod';
import type { PoolClient } from 'pg';
import { calculate } from '../pricing/calculate';
import { quoteInput } from '../pricing/pricing.dto';
import { ruleSets } from '../pricing/rules';
import { fail, hash, parse } from '../platform/security';
import type { Target } from './scheduling.service';

export const bookingPricing = z
  .object({
    startAt: z.iso.datetime({ offset: true }),
    contractDays: z.number().int().min(1).max(3660),
    dailyMileagePackageKm: z.union([z.literal(100), z.literal(250), z.literal(400)]),
    overrides: quoteInput.shape.overrides,
    nonBillableDays: quoteInput.shape.nonBillableDays,
  })
  .strict();

export async function previewBooking(
  c: PoolClient,
  target: Target,
  pricing: z.infer<typeof bookingPricing>,
  models: number[],
  actor: number,
  assignedModel?: number,
) {
  const groups = (
    await c.query(
      'SELECT DISTINCT p.id,p.name,p.tariff_code AS code FROM vehicle_models m JOIN pricing_groups p ON p.id=m.pricing_group_id WHERE m.id=ANY($1::int[]) ORDER BY p.id',
      [models],
    )
  ).rows;
  let group = groups.length === 1 ? groups[0] : undefined;
  if (groups.length > 1 && assignedModel !== undefined) {
    const { rows } = await c.query<{ pricing_group_id: number }>(
      'SELECT pricing_group_id FROM vehicle_models WHERE id=$1',
      [assignedModel],
    );
    group = groups.find((candidate) => candidate.id === rows[0]?.pricing_group_id);
  }
  if (!group)
    fail(
      422,
      'TARIFF_AMBIGUOUS',
      'У выбранной марки или группы несколько тарифов. Уточните модель или автомобиль.',
    );
  if (!group.code)
    fail(422, 'TARIFF_NOT_CONFIGURED', 'Для выбранного автомобиля тариф ещё не настроен.');
  const input = parse(quoteInput, {
    ...pricing,
    operationKind: 'initial',
    pricingGroupId: group.id,
  });
  const now = Date.now(),
    rules = ruleSets.findLast(
      (r) =>
        Date.parse(r.effectiveFrom) <= now && (!r.effectiveTo || Date.parse(r.effectiveTo) > now),
    );
  if (!rules) fail(422, 'TARIFF_NOT_FOUND', 'Нет действующего прайса.');
  const calculation = calculate(input, rules, group, undefined, actor);
  const previewToken = hash(
    JSON.stringify({
      target,
      input,
      models: [...models].sort((a, b) => a - b),
      group: group.id,
      rule: rules.version,
      total: calculation.finalTotalRub,
      limit: calculation.effectiveMileageLimitKm,
    }),
  );
  return { calculation, previewToken, input };
}
