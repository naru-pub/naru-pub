import { db } from "@/lib/database";

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

type CloudflareApiResponse<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ message?: string }>;
};

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CloudflareCustomHostname = {
  id: string;
  hostname: string;
  status: string;
  verification_errors?: string[];
  ownership_verification?: {
    name?: string;
    type?: string;
    value?: string;
  };
  ssl?: {
    status?: string;
    validation_records?: Array<{
      status?: string;
      txt_name?: string;
      txt_value?: string;
      cname?: string;
      cname_target?: string;
      http_url?: string;
      http_body?: string;
    }>;
  };
};

export function getPlatformDomain() {
  return (process.env.NEXT_PUBLIC_DOMAIN ?? "naru.pub")
    .toLowerCase()
    .replace(/\.$/, "");
}

export function getCustomDomainTarget() {
  return (
    process.env.CUSTOM_DOMAIN_CNAME_TARGET ??
    `customers.${getPlatformDomain()}`
  )
    .toLowerCase()
    .replace(/\.$/, "");
}

export function normalizeHostname(input: string) {
  let value = input.trim().toLowerCase();

  if (!value) {
    throw new Error("도메인을 입력해주세요.");
  }

  if (value.includes("://")) {
    value = new URL(value).hostname;
  }

  value = value.replace(/\.$/, "");

  if (value.includes("/") || value.includes(":")) {
    throw new Error("도메인 이름만 입력해주세요.");
  }

  const asciiHostname = new URL(`https://${value}`).hostname
    .toLowerCase()
    .replace(/\.$/, "");

  if (!HOSTNAME_PATTERN.test(asciiHostname)) {
    throw new Error("유효한 도메인을 입력해주세요.");
  }

  const platformDomain = getPlatformDomain();
  if (
    asciiHostname === platformDomain ||
    asciiHostname.endsWith(`.${platformDomain}`)
  ) {
    throw new Error("나루 기본 도메인은 직접 등록할 수 없습니다.");
  }

  return asciiHostname;
}

function getCloudflareZoneId() {
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;

  if (!zoneId) {
    throw new Error("CLOUDFLARE_ZONE_ID is not configured.");
  }

  return zoneId;
}

function getCloudflareApiToken() {
  const token = process.env.CLOUDFLARE_USER_API_TOKEN;

  if (!token) {
    throw new Error("CLOUDFLARE_USER_API_TOKEN is not configured.");
  }

  return token;
}

async function cloudflareRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getCloudflareApiToken()}`,
      ...init.headers,
    },
  });

  const data = (await response.json()) as CloudflareApiResponse<T>;

  if (!response.ok || !data.success) {
    const message =
      data.errors
        ?.map((error) => error.message)
        .filter(Boolean)
        .join(", ") ||
      `Cloudflare API request failed with status ${response.status}.`;
    throw new CloudflareApiError(message, response.status);
  }

  return data.result;
}

export function isCloudflareHostnameActive(hostname: CloudflareCustomHostname) {
  return hostname.status === "active" && hostname.ssl?.status === "active";
}

export function toCustomDomainRow(hostname: CloudflareCustomHostname) {
  return {
    cloudflare_hostname_id: hostname.id,
    cloudflare_status: hostname.status,
    ssl_status: hostname.ssl?.status ?? null,
    ownership_verification_name: hostname.ownership_verification?.name ?? null,
    ownership_verification_type: hostname.ownership_verification?.type ?? null,
    ownership_verification_value:
      hostname.ownership_verification?.value ?? null,
    // jsonb columns: serialize to JSON text. node-postgres would otherwise
    // encode a JS array as a Postgres array literal ({...}), which is invalid
    // JSON and fails the jsonb cast.
    ssl_validation_records: hostname.ssl?.validation_records
      ? JSON.stringify(hostname.ssl.validation_records)
      : null,
    verification_errors: hostname.verification_errors
      ? JSON.stringify(hostname.verification_errors)
      : null,
    verified_at: isCloudflareHostnameActive(hostname) ? new Date() : null,
    updated_at: new Date(),
  };
}

export async function createCloudflareCustomHostname(hostname: string) {
  const zoneId = getCloudflareZoneId();

  return cloudflareRequest<CloudflareCustomHostname>(
    `/zones/${zoneId}/custom_hostnames`,
    {
      method: "POST",
      body: JSON.stringify({
        hostname,
        ssl: {
          method: "txt",
          type: "dv",
        },
      }),
    },
  );
}

export async function getCloudflareCustomHostname(customHostnameId: string) {
  const zoneId = getCloudflareZoneId();

  return cloudflareRequest<CloudflareCustomHostname>(
    `/zones/${zoneId}/custom_hostnames/${customHostnameId}`,
  );
}

export async function deleteCloudflareCustomHostname(customHostnameId: string) {
  const zoneId = getCloudflareZoneId();

  return cloudflareRequest<unknown>(
    `/zones/${zoneId}/custom_hostnames/${customHostnameId}`,
    { method: "DELETE" },
  );
}

export async function deleteCloudflareCustomHostnameIfExists(
  customHostnameId: string,
) {
  try {
    await deleteCloudflareCustomHostname(customHostnameId);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      console.warn(
        "Cloudflare custom hostname was already deleted:",
        customHostnameId,
      );
      return;
    }
    throw error;
  }
}

export async function deleteCustomDomainsForUser(userId: string) {
  const domains = await db
    .selectFrom("custom_domains")
    .select(["id", "hostname", "cloudflare_hostname_id"])
    .where("user_id", "=", userId)
    .execute();

  for (const domain of domains) {
    await deleteCloudflareCustomHostnameIfExists(domain.cloudflare_hostname_id);
    await db.deleteFrom("custom_domains").where("id", "=", domain.id).execute();
    console.log(
      `Deleted custom domain ${domain.hostname} for user ${userId} from Cloudflare`,
    );
  }
}
