export function canStartSupportPurchase(input: {
  supporterComp: boolean;
  supporterUntil: Date | string | null;
  hasActiveSubscription: boolean;
  now?: Date;
}): boolean {
  if (input.supporterComp || input.hasActiveSubscription) return false;
  if (!input.supporterUntil) return true;
  return new Date(input.supporterUntil) <= (input.now ?? new Date());
}
