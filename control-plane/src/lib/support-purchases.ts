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

export function canStartOneTimePurchase(input: SupportPurchaseState): boolean {
  if (input.supporterComp || input.subscriptionStatus === "scheduled") {
    return false;
  }
  return (
    input.subscriptionStatus === "active" ||
    input.subscriptionStatus === "canceled" ||
    !hasPaidTime(input)
  );
}

export function scheduledRecurringStart(
  supporterUntil: Date | string | null,
  now = new Date(),
): Date | null {
  if (!supporterUntil) return null;
  const paidThrough = new Date(supporterUntil);
  return paidThrough > now ? paidThrough : null;
}
