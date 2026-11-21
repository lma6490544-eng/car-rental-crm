/** A candidate must cover the entire half-open interval. Assignments here are
 * hypothetical: this solver never reserves a vehicle. */
export type Demand = {
  id: number;
  start: number;
  end: number;
  candidates: number[];
  pool?: number[];
};
export type Availability = {
  status: 'feasible' | 'deficit' | 'unknown';
  bookingIds: number[];
  steps: number;
};
export const overlaps = (a: Pick<Demand, 'start' | 'end'>, b: Pick<Demand, 'start' | 'end'>) =>
  a.start < b.end && b.start < a.end;

export function evaluateAvailability(
  demands: Demand[],
  rootId: number,
  maxSteps = 100000,
): Availability {
  const root = demands.find((d) => d.id === rootId);
  if (!root) throw new Error('Missing root demand');
  if (
    new Set(demands.map((d) => d.id)).size !== demands.length ||
    demands.some((d) => !Number.isFinite(d.start) || !Number.isFinite(d.end) || d.start >= d.end)
  )
    throw new Error('Invalid demand intervals or identifiers');
  const component = [root],
    seen = new Set([root.id]);
  // Follow the entire connected component, including chains outside the viewport.
  for (let i = 0; i < component.length; i++) {
    const current = component[i],
      pool = new Set(current.pool ?? current.candidates);
    for (const other of demands)
      if (
        !seen.has(other.id) &&
        overlaps(current, other) &&
        (other.pool ?? other.candidates).some((v) => pool.has(v))
      ) {
        seen.add(other.id);
        component.push(other);
      }
  }
  const bookingIds = component.map((d) => d.id).sort((a, b) => a - b);
  let steps = 0;
  const assigned = new Map<number, number>();
  const search = (): Availability['status'] => {
    if (++steps > maxSteps) return 'unknown';
    if (assigned.size === component.length) return 'feasible';
    let next: Demand | undefined,
      options: number[] = [];
    for (const demand of component)
      if (!assigned.has(demand.id)) {
        const free = [...new Set(demand.candidates)].filter(
          (vehicle) =>
            !component.some(
              (other) => assigned.get(other.id) === vehicle && overlaps(demand, other),
            ),
        );
        if (!free.length) return 'deficit';
        if (!next || free.length < options.length) {
          next = demand;
          options = free;
        }
      }
    for (const vehicle of options) {
      assigned.set(next!.id, vehicle);
      const status = search();
      assigned.delete(next!.id);
      if (status !== 'deficit') return status;
    }
    return 'deficit';
  };
  // Bound recursion as well as branch count, without claiming a deficit.
  return { status: component.length > 500 ? 'unknown' : search(), bookingIds, steps };
}
