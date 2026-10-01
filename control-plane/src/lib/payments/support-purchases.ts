type SupportPurchaseState = {
  supporterComp: boolean;
  supporterUntil: Date | string | null;
  subscriptionStatus: string | null;
  now?: Date;
};

function hasPaidTime(input: SupportPurchaseState): boolean {
  return (
    input.supporterUntil != null &&
    new Date(input.supporterUntil) > (input.now ?? new Date())
  );
}

export function canStartRecurringPurchase(
  input: SupportPurchaseState,
): boolean {
  return (
    !input.supporterComp &&
    input.subscriptionStatus !== "active" &&
    input.subscriptionStatus !== "scheduled"
  );
}

// Not beside a recurring plan that charges or may again (active, scheduled,
// past due): the supporter cancels it first. Paid time left over from a
// canceled plan can be extended.
export function canStartOneTimePurchase(input: SupportPurchaseState): boolean {
  if (
    input.supporterComp ||
    input.subscriptionStatus === "active" ||
    input.subscriptionStatus === "scheduled" ||
    input.subscriptionStatus === "past_due"
  ) {
    return false;
  }
  return input.subscriptionStatus === "canceled" || !hasPaidTime(input);
}

export function scheduledRecurringStart(
  supporterUntil: Date | string | null,
  now = new Date(),
): Date | null {
  if (!supporterUntil) return null;
  const paidThrough = new Date(supporterUntil);
  return paidThrough > now ? paidThrough : null;
}
