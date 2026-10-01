import SubscriptionCallback from "./SubscriptionCallback";

// Callbacks for registrations prepared before they had ids. Confirm accepts
// these only while the subscription has no registration id of its own.
export default function LegacySubscriptionCallbackPage() {
  return <SubscriptionCallback registrationId={null} />;
}
