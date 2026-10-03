import { reportPaymentInvariants } from "@/lib/payments/payment-invariants";

// Daily through Absurd: the rules the payment data must satisfy, reported as one
// operator event when any is broken (lib/payments/payment-invariants).
reportPaymentInvariants()
  .then((found) => {
    const rules = Object.keys(found);
    console.log(
      rules.length === 0
        ? "[check-payment-invariants] all hold"
        : `[check-payment-invariants] broken: ${rules.join(", ")}`,
    );
    process.exit(0);
  })
  .catch((error) => {
    console.error("[check-payment-invariants] fatal:", error);
    process.exit(1);
  });
