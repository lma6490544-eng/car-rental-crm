import type { ScheduleEvent } from '../../contracts';

export function layoutCalendarEvents(events: ScheduleEvent[]) {
  const lanes: { start: number; end: number }[][] = [];
  const placed = [...events]
    .sort(
      (a, b) =>
        Number(a.kind === 'displaced') - Number(b.kind === 'displaced') ||
        Date.parse(a.start_at) - Date.parse(b.start_at) ||
        Date.parse(a.end_at) - Date.parse(b.end_at) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .map((event) => {
      const start = Date.parse(event.start_at),
        end = Date.parse(event.end_at);
      let lane = lanes.findIndex(
        (intervals) => !intervals.some((v) => v.start < end && start < v.end),
      );
      if (lane < 0) {
        lane = lanes.length;
        lanes.push([]);
      }
      lanes[lane].push({ start, end });
      return { ...event, lane, start, end };
    });
  const conflicts: {
    id: string;
    start: number;
    end: number;
    lane: number;
    eventIds: ScheduleEvent['id'][];
    bookingId: number | null;
  }[] = [];
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i],
        b = placed[j],
        start = Math.max(a.start, b.start),
        end = Math.min(a.end, b.end);
      if (start < end)
        conflicts.push({
          id: String(a.id) + ':' + b.id,
          start,
          end,
          lane: Math.max(a.lane, b.lane),
          eventIds: [a.id, b.id],
          bookingId: a.kind === 'displaced' ? a.booking_id : (b.booking_id ?? a.booking_id),
        });
    }
  return { events: placed, conflicts, lanes: Math.max(1, lanes.length) };
}
