import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

// Billing keys are stored encrypted (billing_keys.key_ciphertext): a copy of
// the database alone cannot charge anyone's card. AES-256-GCM under
// BILLING_KEY_ENCRYPTION_KEY, 32 random bytes in base64, which lives only in
// the server's environment. Losing it loses every stored key — the supporters
// would have to register their cards again — so it is kept backed up apart
// from the database.

const VERSION = "v1";
const AAD = Buffer.from("naru billing key");

function encryptionKey(): Buffer {
  const raw = process.env.BILLING_KEY_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, "base64") : null;
  if (!key || key.length !== 32) {
    throw new Error(
      "BILLING_KEY_ENCRYPTION_KEY must be 32 random bytes in base64",
    );
  }
  return key;
}

export function encryptBillingKey(billingKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([
    cipher.update(billingKey, "utf8"),
    cipher.final(),
  ]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
}

export function decryptBillingKey(ciphertext: string): string {
  const [version, payload] = ciphertext.split(".", 2);
  if (version !== VERSION || !payload) {
    throw new Error("Unknown billing key ciphertext format");
  }
  const bytes = Buffer.from(payload, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

// How a key is found without decrypting every row: the webhook names a key,
// and Toss replays an authKey's key on a retried issue.
export function hashBillingKey(billingKey: string): string {
  return createHash("sha256").update(billingKey).digest("hex");
}

// Enough of a key to tell two apart on an admin page.
export function billingKeyHint(billingKey: string): string {
  return billingKey.length <= 8
    ? "••••"
    : `${billingKey.slice(0, 4)}••••${billingKey.slice(-4)}`;
}
