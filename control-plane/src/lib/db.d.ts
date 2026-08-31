import type { ColumnType } from "kysely";

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface EmailVerificationTokens {
  created_at: Generated<Timestamp>;
  email: string;
  expires_at: Timestamp;
  id: string;
  user_id: number;
}

export interface PasswordResetTokens {
  created_at: Generated<Timestamp>;
  email: string;
  expires_at: Timestamp;
  id: string;
  user_id: number;
}

export interface AccountDeletionTokens {
  created_at: Generated<Timestamp>;
  email: string;
  expires_at: Timestamp;
  id: string;
  user_id: number;
}

export interface HomeDirectoryExports {
  id: Generated<number>;
  user_id: number;
  status: Generated<string>;
  r2_key: string | null;
  size_bytes: number | null;
  download_expires_at: Timestamp | null;
  error_message: string | null;
  created_at: Generated<Timestamp>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

export interface HomeDirectorySizeHistory {
  id: Generated<number>;
  recorded_at: Generated<Timestamp>;
  size_bytes: number;
  user_id: number | null;
}

export interface GithubDeployTargets {
  id: Generated<number>;
  user_id: number;
  github_repository: string;
  github_ref: string;
  target_prefix: Generated<string>;
  delete_removed_files: Generated<boolean>;
  enabled: Generated<boolean>;
  last_manifest: unknown | null;
  last_github_sha: string | null;
  last_deployed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface GithubDeployments {
  id: string;
  target_id: number;
  user_id: number;
  status: Generated<string>;
  github_repository: string;
  github_ref: string;
  github_sha: string;
  target_prefix: string;
  upload_prefix: string;
  delete_removed_files: boolean;
  manifest: unknown;
  deleted_paths: unknown;
  error_message: string | null;
  expires_at: Timestamp;
  created_at: Generated<Timestamp>;
  finalized_at: Timestamp | null;
}

export interface Pageviews {
  id: Generated<number>;
  user_id: number;
  timestamp: Generated<Timestamp>;
  path: Generated<string>;
  ip: string;
  referrer: string | null;
  user_agent: string | null;
}

export interface PageviewDailyStats {
  user_id: number;
  date: ColumnType<Date, Date | string, Date | string>;
  views: Generated<number>;
  unique_visitors: Generated<number>;
}

export interface EditDailyStats {
  user_id: number;
  date: ColumnType<Date, Date | string, Date | string>;
  edit_count: Generated<number>;
}

export interface CustomDomains {
  cloudflare_hostname_id: string;
  cloudflare_status: string;
  id: Generated<number>;
  user_id: number;
  hostname: string;
  ownership_verification_name: string | null;
  ownership_verification_type: string | null;
  ownership_verification_value: string | null;
  ssl_status: string | null;
  ssl_validation_records: unknown | null;
  verification_errors: unknown | null;
  verified_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface Sessions {
  expires_at: Timestamp;
  id: string;
  user_id: number;
}

export interface Users {
  created_at: Generated<Timestamp>;
  discoverable: Generated<boolean>;
  email: string | null;
  email_verified_at: Timestamp | null;
  home_directory_size_bytes: Generated<number | null>;
  home_directory_size_bytes_updated_at: Timestamp | null;
  id: Generated<number>;
  last_activity_sent_at: Timestamp | null;
  login_name: string;
  password_hash: string;
  site_rendered_at: Timestamp | null;
  site_title: string | null;
  site_updated_at: Timestamp | null;
  supporter_comp: Generated<boolean>;
  supporter_until: Timestamp | null;
  toss_customer_key: string | null;
}

export interface Subscriptions {
  id: Generated<number>;
  user_id: number;
  plan: Generated<string>;
  billing_interval: string;
  amount: number;
  status: string;
  toss_customer_key: string;
  toss_billing_key: string | null;
  current_period_start: Timestamp | null;
  current_period_end: Timestamp | null;
  next_billing_at: Timestamp | null;
  renewal_notice_sent_at: Timestamp | null;
  payment_grace_notice_sent_at: Timestamp | null;
  failed_charge_count: Generated<number>;
  charging_started_at: Timestamp | null;
  canceled_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface Payments {
  id: Generated<number>;
  attempt_key: string | null;
  user_id: number;
  subscription_id: number | null;
  toss_payment_key: string | null;
  order_id: string;
  amount: number;
  status: string;
  paid_at: Timestamp | null;
  period_start: Timestamp | null;
  period_end: Timestamp | null;
  raw: unknown | null;
  created_at: Generated<Timestamp>;
}

export interface UserKeys {
  user_id: number;
  key_type: string;
  private_key: unknown;
  public_key: unknown;
  created_at: Generated<Timestamp>;
}

export interface Followers {
  id: Generated<number>;
  user_id: number;
  remote_actor_id: number;
  created_at: Generated<Timestamp>;
}

export interface RemoteActors {
  id: Generated<number>;
  iri: string;
  inbox_iri: string;
  shared_inbox_iri: string | null;
  preferred_username: string | null;
  name: string | null;
  profile_url: string | null;
  fetched_at: Generated<Timestamp>;
  created_at: Generated<Timestamp>;
}

export interface Activities {
  id: string;
  user_id: number;
  type: string;
  payload: unknown;
  object_iri: string | null;
  created_at: Generated<Timestamp>;
}

export interface SiteDataCollections {
  id: Generated<number>;
  user_id: number;
  name: string;
  read_access: Generated<string>;
  write_access: Generated<string>;
}

export interface SiteDataDocuments {
  collection_id: number;
  id: string;
  data: unknown;
  size_bytes: number;
  updated_at: Generated<Timestamp>;
}

export interface SiteDataClients {
  id: string;
  user_id: number;
  redirect_uri: string;
  collection_ids: number[];
  created_at: Generated<Timestamp>;
}
export interface SiteDataAccessTokens {
  hash: string;
  client_id: string;
  session_id: string;
  collection_ids: number[];
  expires_at: Timestamp;
}
export interface SiteDataAuthCodes extends SiteDataAccessTokens {
  challenge: string;
}
export interface SiteDataRateLimits {
  user_id: number;
  key: string;
  window_start: Timestamp;
  count: number;
}
export interface DB {
  site_data_clients: SiteDataClients;
  site_data_access_tokens: SiteDataAccessTokens;
  site_data_auth_codes: SiteDataAuthCodes;
  site_data_rate_limits: SiteDataRateLimits;
  site_data_collections: SiteDataCollections;
  site_data_documents: SiteDataDocuments;
  account_deletion_tokens: AccountDeletionTokens;
  activities: Activities;
  custom_domains: CustomDomains;
  edit_daily_stats: EditDailyStats;
  email_verification_tokens: EmailVerificationTokens;
  followers: Followers;
  github_deploy_targets: GithubDeployTargets;
  github_deployments: GithubDeployments;
  home_directory_exports: HomeDirectoryExports;
  home_directory_size_history: HomeDirectorySizeHistory;
  pageview_daily_stats: PageviewDailyStats;
  pageviews: Pageviews;
  password_reset_tokens: PasswordResetTokens;
  payments: Payments;
  remote_actors: RemoteActors;
  sessions: Sessions;
  subscriptions: Subscriptions;
  user_keys: UserKeys;
  users: Users;
}
