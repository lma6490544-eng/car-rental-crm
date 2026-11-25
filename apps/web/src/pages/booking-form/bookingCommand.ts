import type { Customer } from '../../catalog';
import type { BookingPreview } from '../../contracts';
import type { BookingFormMode, BookingFormValues, BookingInitial } from './types';
import { clean, type buildBookingDraft } from './bookingDraft';
type Draft = ReturnType<typeof buildBookingDraft>;
export function buildBookingCommand(
  v: BookingFormValues,
  selected: Customer | undefined,
  preview: BookingPreview,
  target: Draft['target'],
  pricing: NonNullable<Draft['draft']>['pricing'],
  manual: boolean,
  initial?: BookingInitial,
  mode: BookingFormMode = 'booking',
) {
  const details = v.details ?? {};
  const data = {
    type: v.type,
    displayName:
      v.type === 'company'
        ? clean(v.displayName)
        : [details.lastName, details.firstName, details.middleName]
            .map(clean)
            .filter(Boolean)
            .join(' '),
    phone: v.phone,
    email: v.email ?? '',
    inn: v.type === 'company' ? (v.inn ?? '') : '',
    details,
  };
  const warning = preview.availability?.status !== 'feasible' ? preview.availability : undefined;
  return {
    target,
    pricing,
    previewToken: preview.previewToken,
    confirmedOverrides: manual ? preview.calculation.overridesToConfirm : [],
    reason:
      clean(v.unassignedReason) ||
      (initial?.bookingId ? 'Редактирование условий брони' : 'Создание брони'),
    ...(mode === 'terms'
      ? initial?.vehicleId && target?.type !== 'vehicle'
        ? { vehicleId: initial.vehicleId }
        : {}
      : {
          customer: selected
            ? { existingId: selected.id, expectedVersion: selected.version, data }
            : { new: data },
        }),
    ...(warning
      ? {
          riskAcceptance: {
            token: warning.token,
            ...(clean(v.unassignedReason) ? { reason: clean(v.unassignedReason) } : {}),
          },
        }
      : {}),
    ...(initial?.bookingId ? { expectedVersion: initial.version } : {}),
  };
}
