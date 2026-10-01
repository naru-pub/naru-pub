import type { ColumnType } from "kysely";

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

// node-postgres returns bigint (int8) columns as strings, since they can exceed
// Number.MAX_SAFE_INTEGER.
export type Int8 = ColumnType<string, string | number, string | number>;

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
  metadata: Generated<unknown>;
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
  github_repository_id: string | null;
  github_ref: string;
  target_prefix: Generated<string>;
  delete_removed_files: Generated<boolean>;
  enabled: Generated<boolean>;
  deploy_generation: Generated<number>;
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
  github_repository_id: string | null;
  github_ref: string;
  github_sha: string;
  target_prefix: string;
  upload_prefix: string;
  delete_removed_files: boolean;
  manifest: unknown;
  deleted_paths: unknown;
  uploaded_paths: Generated<unknown>;
  deploy_generation: Generated<number>;
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
  id: Generated<string>;
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

export interface PaymentEvents {
  id: Generated<string>;
  created_at: Generated<Timestamp>;
  kind: string;
  user_id: number | null;
  payment_id: string | null;
  subscription_id: string | null;
  summary: string;
  emailed_at: Timestamp | null;
}

export interface TossWebhookDeliveries {
  id: Generated<string>;
  received_at: Generated<Timestamp>;
  event_type: string;
  transmission_id: string | null;
  retried_count: number | null;
  subject: string | null;
  toss_status: string | null;
  outcome: string;
  http_status: number;
  duration_ms: number;
  payload: string | null;
}

export interface RetiredBillingKeys {
  id: Generated<string>;
  billing_key: string;
  retired_at: Generated<Timestamp>;
  attempts: Generated<number>;
  last_attempted_at: Timestamp | null;
  last_error: string | null;
}

export interface Payments {
  id: Generated<string>;
  attempt_key: string | null;
  user_id: number;
  subscription_id: string | null;
  toss_payment_key: string | null;
  toss_flow: string | null;
  toss_mid: string | null;
  toss_payment_type: string | null;
  toss_method: string | null;
  toss_currency: string | null;
  toss_approved_at: Timestamp | null;
  toss_receipt_url: string | null;
  toss_api_version: string | null;
  order_id: string;
  amount: number;
  status: string;
  paid_at: Timestamp | null;
  period_start: Timestamp | null;
  period_end: Timestamp | null;
  refunded_amount: Generated<number>;
  refunded_at: Timestamp | null;
  last_reconciled_at: Timestamp | null;
  reconciliation_error: string | null;
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
  created_at: Generated<Timestamp>;
  collection_id: number;
  id: string;
  data: unknown;
  size_bytes: number;
  updated_at: Generated<Timestamp>;
  version: Generated<number>;
}

export interface SiteDataClients {
  token_lifetime_seconds: Generated<number>;
  id: string;
  user_id: number;
  redirect_uri: string;
  collection_ids: number[];
  created_at: Generated<Timestamp>;
}
export interface SiteDataGrant {
  hash: string;
  client_id: string;
  session_id: string;
  collection_ids: number[];
  expires_at: Timestamp;
}
export interface SiteDataAccessTokens extends SiteDataGrant {
  issued_at: Generated<Timestamp>;
  lifetime_seconds: number;
}
export interface SiteDataAuthCodes extends SiteDataGrant {
  token_lifetime_seconds: Generated<number>;
  challenge: string;
}
export interface SiteDataRateLimits {
  user_id: number;
  key: string;
  window_start: Timestamp;
  count: number;
}
export interface SiteDataFiles {
  id: string;
  user_id: number;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  status: Generated<string>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}
export interface SupporterFeatureUses {
  user_id: number;
  feature: string;
  first_used_at: Generated<Timestamp>;
  last_used_at: Generated<Timestamp>;
}

export interface BoardPosts {
  // gen_random_uuid(), generated by the database.
  id: Generated<string>;
  user_id: number;
  kind: "site" | "template" | "question" | "chat";
  title: string;
  body: Generated<string>;
  reply_count: Generated<number>;
  like_count: Generated<number>;
  last_reply_at: Timestamp | null;
  last_reply_user_id: number | null;
  activity_at: Generated<Timestamp>;
  solved_reply_id: Int8 | null;
  federated_note_iri: string | null;
  created_at: Generated<Timestamp>;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface BoardReplies {
  id: Generated<Int8>;
  post_id: string;
  parent_id: Int8 | null;
  user_id: number;
  depth: number;
  // Written only by the raw insert in lib/board/replies.ts.
  path: ColumnType<string[], never, never>;
  body: string;
  like_count: Generated<number>;
  created_at: Generated<Timestamp>;
  edited_at: Timestamp | null;
  deleted_at: Timestamp | null;
}

export interface BoardPostLikes {
  post_id: string;
  user_id: number;
  created_at: Generated<Timestamp>;
}

export interface BoardReplyLikes {
  reply_id: Int8;
  user_id: number;
  created_at: Generated<Timestamp>;
}

export interface BoardNotifications {
  id: Generated<Int8>;
  user_id: number;
  reply_id: Int8;
  reason: "reply_to_post" | "reply_to_reply";
  read_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface BoardTemplates {
  id: Generated<Int8>;
  post_id: string;
  user_id: number;
  slug: string;
  license: "cc-by-4.0" | "cc-by-sa-4.0" | "cc0-1.0";
  latest_version_id: Int8 | null;
  apply_count: Generated<number>;
}

export interface BoardTemplateCollection {
  name: string;
  read_access: string;
  write_access: string;
}

export interface BoardTemplateVersions {
  id: Generated<Int8>;
  template_id: Int8;
  version: number;
  source_path: string;
  file_count: number;
  size_bytes: Int8;
  data_collections: ColumnType<
    BoardTemplateCollection[],
    string | undefined,
    string
  >;
  changelog: string | null;
  preview_rendered_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface BoardTemplateFiles {
  version_id: Int8;
  path: string;
  size_bytes: Int8;
  content_type: string;
}

export interface BoardTemplateApplications {
  id: Generated<Int8>;
  version_id: Int8 | null;
  user_id: number;
  created_at: Generated<Timestamp>;
}

export interface DB {
  board_notifications: BoardNotifications;
  board_post_likes: BoardPostLikes;
  board_posts: BoardPosts;
  board_replies: BoardReplies;
  board_reply_likes: BoardReplyLikes;
  board_template_applications: BoardTemplateApplications;
  board_template_files: BoardTemplateFiles;
  board_template_versions: BoardTemplateVersions;
  board_templates: BoardTemplates;
  site_data_clients: SiteDataClients;
  site_data_access_tokens: SiteDataAccessTokens;
  site_data_auth_codes: SiteDataAuthCodes;
  site_data_rate_limits: SiteDataRateLimits;
  site_data_collections: SiteDataCollections;
  site_data_documents: SiteDataDocuments;
  site_data_files: SiteDataFiles;
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
  payment_events: PaymentEvents;
  payments: Payments;
  remote_actors: RemoteActors;
  retired_billing_keys: RetiredBillingKeys;
  sessions: Sessions;
  subscriptions: Subscriptions;
  supporter_feature_uses: SupporterFeatureUses;
  toss_webhook_deliveries: TossWebhookDeliveries;
  user_keys: UserKeys;
  users: Users;
}
