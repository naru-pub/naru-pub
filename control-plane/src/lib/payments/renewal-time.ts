// When renewals are charged: once a day, at 09:00 KST
// (lib/payments/subscription-renewals). Kept free of server-only imports, so the
// support page and the mails can show the date a renewal will actually be
// charged, not the time of day its period happens to end.

export const RENEWAL_HOUR_KST = 9;

// Korea has no daylight saving time, so KST is always UTC+9.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function kstRenewalHourOn(kstDay: Date): number {
  return (
    Date.UTC(
      kstDay.getUTCFullYear(),
      kstDay.getUTCMonth(),
      kstDay.getUTCDate(),
      RENEWAL_HOUR_KST,
    ) - KST_OFFSET_MS
  );
}

// The last 09:00 KST at or before `now`: a renewal run charges what was due by
// then.
export function renewalCutoff(now = new Date()): Date {
  const today = kstRenewalHourOn(new Date(now.getTime() + KST_OFFSET_MS));
  return new Date(today <= now.getTime() ? today : today - DAY_MS);
}

// The first 09:00 KST at or after a renewal falls due: when it is charged.
export function renewalChargeAt(nextBillingAt: Date | string): Date {
  const due = new Date(nextBillingAt);
  const sameDay = kstRenewalHourOn(new Date(due.getTime() + KST_OFFSET_MS));
  return new Date(sameDay >= due.getTime() ? sameDay : sameDay + DAY_MS);
}
