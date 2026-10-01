import SubscriptionCallback from "../SubscriptionCallback";

export default async function SubscriptionCallbackPage({
  params,
}: {
  params: Promise<{ registration: string }>;
}) {
  const { registration } = await params;
  return <SubscriptionCallback registrationId={registration} />;
}
