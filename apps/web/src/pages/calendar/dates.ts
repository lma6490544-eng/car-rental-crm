export {
  DAY_MS as DAY,
  moscowMinuteToIso as iso,
  moscowDateTimeInput as local,
} from '../../shared/moscowTime';
export const scaleWidth = (value: number) => (value === 3 ? 384 : value === 2 ? 192 : 96);
export const PAST_DAYS = 15;
