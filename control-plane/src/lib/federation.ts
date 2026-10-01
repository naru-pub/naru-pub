import { randomUUID } from "node:crypto";
import {
  Context,
  createFederation,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import { PostgresKvStore, PostgresMessageQueue } from "@fedify/postgres";
import {
  Accept,
  Activity,
  Create,
  Delete,
  Endpoints,
  Follow,
  Image,
  Note,
  Person,
  PUBLIC_COLLECTION,
  Tombstone,
  Undo,
  Update,
} from "@fedify/fedify/vocab";
import { Temporal } from "@js-temporal/polyfill";
import { sql } from "kysely";
import postgres from "postgres";
import { db } from "./database";
import { configureLogging } from "./logging";
import { getRenderedSiteUrl } from "./site-urls";

// Fire the logtape config eagerly so control-plane requests also get Fedify's
// internal logs routed to the console.
void configureLogging();

// Separate postgres.js client for Fedify's KV + queue. Kysely uses `pg`;
// @fedify/postgres uses `postgres`. Two small pools in one process is fine.
const fedifySql = postgres(
  process.env.DATABASE_URL ?? "postgres://localhost/",
  {
    max: 4,
  },
);

const KEY_ALGORITHMS = ["RSASSA-PKCS1-v1_5", "Ed25519"] as const;
type KeyAlgorithm = (typeof KEY_ALGORITHMS)[number];

// DB stores lowercased/underscored values; keep a single source of truth.
const DB_KEY_TYPE: Record<KeyAlgorithm, string> = {
  "RSASSA-PKCS1-v1_5": "rsassa-pkcs1-v1_5",
  Ed25519: "ed25519",
};

// Pin the origin so URIs in actor/activity/collection docs always use the
// public hostname — not whatever Host header the reverse proxy forwards
// (which behind Cloudflare often ends up as the container's localhost:3000).
const federationOrigin = process.env.BASE_URL ?? "http://localhost:3000";

export const federation = createFederation<void>({
  kv: new PostgresKvStore(fedifySql),
  queue: new PostgresMessageQueue(fedifySql),
  origin: federationOrigin,
});

async function buildPerson(
  ctx: Context<void>,
  identifier: string,
): Promise<Person | null> {
  const user = await db
    .selectFrom("users")
    .select(["id", "login_name", "site_rendered_at", "site_title"])
    .where("login_name", "=", identifier)
    .executeTakeFirst();
  if (!user) return null;

  // KEY_ALGORITHMS[0] is RSA, so keys[0] is always the RSA pair used for
  // legacy HTTP/Linked Data Signatures exposed via `publicKey`.
  const keys = await ctx.getActorKeyPairs(identifier);
  const siteDomain = process.env.NEXT_PUBLIC_DOMAIN ?? "naru.pub";

  // Viewport is 640x480 @ deviceScaleFactor 2 — see cli/update-screenshots.tsx.
  const icon = user.site_rendered_at
    ? new Image({
        url: new URL(getRenderedSiteUrl(identifier, user.site_rendered_at)),
        mediaType: "image/png",
        width: 1280,
        height: 960,
      })
    : undefined;

  return new Person({
    id: ctx.getActorUri(identifier),
    preferredUsername: identifier,
    name: user.site_title ?? identifier,
    url: new URL(`https://${identifier}.${siteDomain}/`),
    inbox: ctx.getInboxUri(identifier),
    outbox: ctx.getOutboxUri(identifier),
    followers: ctx.getFollowersUri(identifier),
    endpoints: new Endpoints({ sharedInbox: ctx.getInboxUri() }),
    publicKey: keys[0]?.cryptographicKey,
    assertionMethods: keys.map((k) => k.multikey),
    icon,
  });
}

federation
  .setActorDispatcher("/users/{identifier}", (ctx, identifier) =>
    buildPerson(ctx, identifier),
  )
  .setKeyPairsDispatcher(async (_ctx, identifier) => {
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", identifier)
      .executeTakeFirst();
    if (!user) return [];

    const rows = await db
      .selectFrom("user_keys")
      .select(["key_type", "private_key", "public_key"])
      .where("user_id", "=", user.id)
      .execute();

    const existing = new Map(rows.map((r) => [r.key_type, r]));
    const result: CryptoKeyPair[] = [];

    for (const algo of KEY_ALGORITHMS) {
      const dbType = DB_KEY_TYPE[algo];
      const row = existing.get(dbType);
      if (row) {
        result.push({
          publicKey: await importJwk(row.public_key as JsonWebKey, "public"),
          privateKey: await importJwk(row.private_key as JsonWebKey, "private"),
        });
      } else {
        const pair = await generateCryptoKeyPair(algo);
        await db
          .insertInto("user_keys")
          .values({
            user_id: user.id,
            key_type: dbType,
            public_key: await exportJwk(pair.publicKey),
            private_key: await exportJwk(pair.privateKey),
          })
          .onConflict((oc) => oc.columns(["user_id", "key_type"]).doNothing())
          .execute();
        result.push(pair);
      }
    }

    return result;
  })
  .mapHandle(async (_ctx, username) => {
    const user = await db
      .selectFrom("users")
      .select("login_name")
      .where("login_name", "=", username)
      .executeTakeFirst();
    return user?.login_name ?? null;
  });

/**
 * Upsert a remote actor row from a Fedify Actor object. Returns the internal
 * id so callers can reference it from followers/activities tables.
 */
async function upsertRemoteActor(actor: {
  id: URL | null;
  inboxId: URL | null;
  endpoints?: { sharedInbox: URL | null } | null;
  preferredUsername?: unknown;
  name?: unknown;
  url?: unknown;
}): Promise<string | null> {
  if (!actor.id || !actor.inboxId) return null;

  const preferredUsername =
    typeof actor.preferredUsername === "string"
      ? actor.preferredUsername
      : (actor.preferredUsername?.toString() ?? null);
  const name =
    typeof actor.name === "string"
      ? actor.name
      : (actor.name?.toString() ?? null);
  const profileUrl =
    actor.url instanceof URL
      ? actor.url.href
      : typeof actor.url === "string"
        ? actor.url
        : null;

  const row = await db
    .insertInto("remote_actors")
    .values({
      iri: actor.id.href,
      inbox_iri: actor.inboxId.href,
      shared_inbox_iri: actor.endpoints?.sharedInbox?.href ?? null,
      preferred_username: preferredUsername,
      name,
      profile_url: profileUrl,
    })
    .onConflict((oc) =>
      oc.column("iri").doUpdateSet({
        inbox_iri: actor.inboxId!.href,
        shared_inbox_iri: actor.endpoints?.sharedInbox?.href ?? null,
        preferred_username: preferredUsername,
        name,
        profile_url: profileUrl,
        fetched_at: sql`now()`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();

  return row.id;
}

federation
  .setInboxListeners("/users/{identifier}/inbox", "/inbox")
  .on(Follow, async (ctx, follow) => {
    const parsed = ctx.parseUri(follow.objectId);
    if (parsed?.type !== "actor") return;
    const identifier = parsed.identifier;

    const user = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", identifier)
      .executeTakeFirst();
    if (!user) return;

    const follower = await follow.getActor(ctx);
    if (!follower) return;

    const remoteActorId = await upsertRemoteActor(follower);
    if (remoteActorId == null) return;

    await db
      .insertInto("followers")
      .values({
        user_id: user.id,
        remote_actor_id: remoteActorId,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "remote_actor_id"]).doNothing(),
      )
      .execute();

    await ctx.sendActivity(
      { identifier },
      follower,
      new Accept({
        actor: ctx.getActorUri(identifier),
        object: follow,
      }),
    );
  })
  .on(Undo, async (ctx, undo) => {
    const object = await undo.getObject(ctx);
    if (!(object instanceof Follow)) return;

    const parsed = ctx.parseUri(object.objectId);
    if (parsed?.type !== "actor") return;
    const actorId = undo.actorId;
    if (!actorId) return;

    const user = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", parsed.identifier)
      .executeTakeFirst();
    if (!user) return;

    await db
      .deleteFrom("followers")
      .where("user_id", "=", user.id)
      .where("remote_actor_id", "in", (eb) =>
        eb
          .selectFrom("remote_actors")
          .select("id")
          .where("iri", "=", actorId.href),
      )
      .execute();
  });

federation
  .setFollowersDispatcher(
    "/users/{identifier}/followers",
    async (_ctx, identifier, cursor) => {
      const user = await db
        .selectFrom("users")
        .select("id")
        .where("login_name", "=", identifier)
        .executeTakeFirst();
      if (!user) return null;

      const pageSize = 50;
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      if (Number.isNaN(offset) || offset < 0) return null;

      const rows = await db
        .selectFrom("followers")
        .innerJoin(
          "remote_actors",
          "remote_actors.id",
          "followers.remote_actor_id",
        )
        .select([
          "remote_actors.iri as iri",
          "remote_actors.inbox_iri as inbox_iri",
          "remote_actors.shared_inbox_iri as shared_inbox_iri",
        ])
        .where("followers.user_id", "=", user.id)
        .orderBy("followers.id", "asc")
        .limit(pageSize + 1)
        .offset(offset)
        .execute();

      const hasMore = rows.length > pageSize;
      const items = rows.slice(0, pageSize).map((r) => ({
        id: new URL(r.iri),
        inboxId: new URL(r.inbox_iri),
        endpoints: r.shared_inbox_iri
          ? { sharedInbox: new URL(r.shared_inbox_iri) }
          : null,
      }));

      return {
        items,
        nextCursor: hasMore ? String(offset + pageSize) : null,
      };
    },
  )
  .setCounter(async (_ctx, identifier) => {
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", identifier)
      .executeTakeFirst();
    if (!user) return null;

    const result = await db
      .selectFrom("followers")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();

    return BigInt(result.count);
  })
  .setFirstCursor(() => "0");

async function loadActivityByIri<T extends Activity>(
  cls: { fromJsonLd: (j: unknown, o?: any) => Promise<T> },
  ctx: Parameters<Parameters<typeof federation.setOutboxDispatcher>[1]>[0],
  identifier: string,
  matchColumn: "id" | "object_iri",
  iri: string,
): Promise<T | null> {
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("login_name", "=", identifier)
    .executeTakeFirst();
  if (!user) return null;

  const row = await db
    .selectFrom("activities")
    .select("payload")
    .where("user_id", "=", user.id)
    .where(matchColumn, "=", iri)
    .executeTakeFirst();
  if (!row) return null;

  return (await cls.fromJsonLd(row.payload, {
    contextLoader: ctx.contextLoader,
    documentLoader: ctx.documentLoader,
  })) as T;
}

federation.setObjectDispatcher(
  Create,
  "/users/{identifier}/activities/{id}",
  async (ctx, { identifier, id }) => {
    const iri = ctx.getObjectUri(Create, { identifier, id }).href;
    return loadActivityByIri(Create, ctx, identifier, "id", iri);
  },
);

federation.setObjectDispatcher(
  Note,
  "/users/{identifier}/notes/{id}",
  async (ctx, { identifier, id }) => {
    const iri = ctx.getObjectUri(Note, { identifier, id }).href;
    const create = await loadActivityByIri(
      Create,
      ctx,
      identifier,
      "object_iri",
      iri,
    );
    if (!create) return null;
    const object = await create.getObject(ctx);
    return object instanceof Note ? object : null;
  },
);

federation
  .setOutboxDispatcher(
    "/users/{identifier}/outbox",
    async (ctx, identifier, cursor) => {
      const user = await db
        .selectFrom("users")
        .select("id")
        .where("login_name", "=", identifier)
        .executeTakeFirst();
      if (!user) return null;

      const pageSize = 20;
      const offset = cursor ? Number.parseInt(cursor, 10) : 0;
      if (Number.isNaN(offset) || offset < 0) return null;

      const rows = await db
        .selectFrom("activities")
        .select("payload")
        .where("user_id", "=", user.id)
        .orderBy("created_at", "desc")
        .limit(pageSize + 1)
        .offset(offset)
        .execute();

      const hasMore = rows.length > pageSize;
      const items = await Promise.all(
        rows.slice(0, pageSize).map((row) =>
          Activity.fromJsonLd(row.payload, {
            contextLoader: ctx.contextLoader,
            documentLoader: ctx.documentLoader,
          }),
        ),
      );

      return {
        items,
        nextCursor: hasMore ? String(offset + pageSize) : null,
      };
    },
  )
  .setCounter(async (_ctx, identifier) => {
    const user = await db
      .selectFrom("users")
      .select("id")
      .where("login_name", "=", identifier)
      .executeTakeFirst();
    if (!user) return null;

    const result = await db
      .selectFrom("activities")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("user_id", "=", user.id)
      .executeTakeFirstOrThrow();

    return BigInt(result.count);
  })
  .setFirstCursor(() => "0");

const QUIET_PERIOD = sql<Date>`now() - interval '10 minutes'`;
const COOLDOWN_WINDOW = sql<Date>`now() - interval '24 hours'`;

/**
 * Fire a Create(Note) to the user's followers announcing a site update.
 * Called from cron after a trailing-debounce scan. The atomic UPDATE is
 * the authoritative guard: we claim the slot only if
 *
 *   1. there's a new edit since the last activity,
 *   2. editing has been quiet for at least the trailing window, and
 *   3. the 24h cooldown has elapsed.
 *
 * Calling this on a user that doesn't qualify is a safe no-op.
 */
export async function dispatchSiteUpdate(userId: string): Promise<void> {
  const claimed = await db
    .updateTable("users")
    .set({ last_activity_sent_at: sql`now()` })
    .where("id", "=", userId)
    .where("site_updated_at", "is not", null)
    .where((eb) =>
      eb(
        "site_updated_at",
        ">",
        eb.fn.coalesce(
          "last_activity_sent_at",
          sql<Date>`'epoch'::timestamptz`,
        ),
      ),
    )
    .where("site_updated_at", "<", QUIET_PERIOD)
    .where((eb) =>
      eb.or([
        eb("last_activity_sent_at", "is", null),
        eb("last_activity_sent_at", "<", COOLDOWN_WINDOW),
      ]),
    )
    .returning("login_name")
    .executeTakeFirst();

  if (!claimed) return;

  const identifier = claimed.login_name;
  const siteDomain = process.env.NEXT_PUBLIC_DOMAIN ?? "naru.pub";
  const baseUrl = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  const ctx = federation.createContext(baseUrl, undefined);

  const siteUrl = new URL(`https://${identifier}.${siteDomain}/`);
  const actorUri = ctx.getActorUri(identifier);
  const followersUri = ctx.getFollowersUri(identifier);
  const noteId = ctx.getObjectUri(Note, {
    identifier,
    id: randomUUID(),
  });
  const activityId = ctx.getObjectUri(Create, {
    identifier,
    id: randomUUID(),
  });
  const now = Temporal.Now.instant();

  const note = new Note({
    id: noteId,
    attribution: actorUri,
    content: `<p>Updated <a href="${siteUrl.href}">${siteUrl.href}</a></p>`,
    url: siteUrl,
    published: now,
    to: PUBLIC_COLLECTION,
    cc: followersUri,
  });

  const create = new Create({
    id: activityId,
    actor: actorUri,
    object: note,
    published: now,
    to: PUBLIC_COLLECTION,
    cc: followersUri,
  });

  const payload = await create.toJsonLd({
    contextLoader: ctx.contextLoader,
  });

  await db
    .insertInto("activities")
    .values({
      id: activityId.href,
      user_id: userId,
      type: "Create",
      payload,
      object_iri: noteId.href,
    })
    .execute();

  try {
    await ctx.sendActivity({ identifier }, "followers", create);
  } catch (err) {
    console.error("[federation] sendActivity failed", err);
  }
}

/**
 * Fire an Update(Person) to the user's followers so remote instances refresh
 * their cached actor — most notably, the icon that points at the rendered
 * site screenshot. Safe to call on users with zero followers (no-op).
 */
export async function dispatchActorUpdate(userId: string): Promise<void> {
  const user = await db
    .selectFrom("users")
    .select(["login_name"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user) return;

  const identifier = user.login_name;
  const baseUrl = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  const ctx = federation.createContext(baseUrl, undefined);

  const person = await buildPerson(ctx, identifier);
  if (!person) return;

  const update = new Update({
    id: new URL(`/users/${identifier}/activities/${randomUUID()}`, baseUrl),
    actor: ctx.getActorUri(identifier),
    object: person,
    published: Temporal.Now.instant(),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(identifier),
  });

  try {
    await ctx.sendActivity({ identifier }, "followers", update);
  } catch (err) {
    console.error("[federation] dispatchActorUpdate failed", err);
  }
}

/**
 * Send a Delete(Person) to the user's followers. Must be called BEFORE the
 * users row is deleted — we need to read the user's keys and follower list,
 * both of which cascade away when the row goes.
 *
 * Keys are passed inline rather than via the key-pair dispatcher so that
 * when the worker processes the queued message, it doesn't try to re-fetch
 * a user that no longer exists.
 */
export async function dispatchActorDelete(
  userId: string,
  loginName: string,
): Promise<void> {
  const baseUrl = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  const ctx = federation.createContext(baseUrl, undefined);

  const followers = await db
    .selectFrom("followers")
    .innerJoin("remote_actors", "remote_actors.id", "followers.remote_actor_id")
    .select([
      "remote_actors.iri as iri",
      "remote_actors.inbox_iri as inbox_iri",
      "remote_actors.shared_inbox_iri as shared_inbox_iri",
    ])
    .where("followers.user_id", "=", userId)
    .execute();

  if (followers.length === 0) return;

  const recipients = followers.map((r) => ({
    id: new URL(r.iri),
    inboxId: new URL(r.inbox_iri),
    endpoints: r.shared_inbox_iri
      ? { sharedInbox: new URL(r.shared_inbox_iri) }
      : null,
  }));

  const keyPairs = await ctx.getActorKeyPairs(loginName);
  if (keyPairs.length === 0) return;
  const senderKeyPairs = keyPairs.map((kp) => ({
    keyId: kp.keyId,
    privateKey: kp.privateKey,
  }));

  const actorUri = ctx.getActorUri(loginName);
  const deleteActivity = new Delete({
    id: new URL(`/users/${loginName}/activities/${randomUUID()}`, baseUrl),
    actor: actorUri,
    object: actorUri,
    to: PUBLIC_COLLECTION,
  });

  await ctx.sendActivity(senderKeyPairs, recipients, deleteActivity);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Announce a new template post to the author's followers as a Create(Note)
 * linking to the post on the board. The note is kept in `activities`, so it
 * shows in the outbox, and its IRI on the post so deleting the post can
 * retract it.
 */
export async function dispatchTemplatePost(postId: string): Promise<void> {
  const post = await db
    .selectFrom("board_posts as p")
    .innerJoin("users as u", "u.id", "p.user_id")
    .select(["p.id", "p.title", "p.body", "p.user_id", "u.login_name"])
    .where("p.id", "=", postId)
    .where("p.kind", "=", "template")
    .where("p.deleted_at", "is", null)
    .where("p.federated_note_iri", "is", null)
    .executeTakeFirst();
  if (!post) return;

  const identifier = post.login_name;
  const baseUrl = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  const ctx = federation.createContext(baseUrl, undefined);
  const postUrl = new URL(`/board/${post.id}`, baseUrl);
  const actorUri = ctx.getActorUri(identifier);
  const followersUri = ctx.getFollowersUri(identifier);
  const noteId = ctx.getObjectUri(Note, { identifier, id: randomUUID() });
  const activityId = ctx.getObjectUri(Create, {
    identifier,
    id: randomUUID(),
  });
  const now = Temporal.Now.instant();

  const summary = post.body.replace(/\s+/g, " ").trim();
  const excerpt = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
  const content =
    `<p>새 템플릿을 공유했어요: <a href="${postUrl.href}">${escapeHtml(post.title)}</a></p>` +
    (excerpt ? `<p>${escapeHtml(excerpt)}</p>` : "");

  const note = new Note({
    id: noteId,
    attribution: actorUri,
    name: post.title,
    content,
    url: postUrl,
    published: now,
    to: PUBLIC_COLLECTION,
    cc: followersUri,
  });
  const create = new Create({
    id: activityId,
    actor: actorUri,
    object: note,
    published: now,
    to: PUBLIC_COLLECTION,
    cc: followersUri,
  });
  const payload = await create.toJsonLd({ contextLoader: ctx.contextLoader });

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto("activities")
      .values({
        id: activityId.href,
        user_id: post.user_id,
        type: "Create",
        payload,
        object_iri: noteId.href,
      })
      .execute();
    await tx
      .updateTable("board_posts")
      .set({ federated_note_iri: noteId.href })
      .where("id", "=", post.id)
      .execute();
  });

  try {
    await ctx.sendActivity({ identifier }, "followers", create);
  } catch (err) {
    console.error("[federation] dispatchTemplatePost failed", err);
  }
}

/**
 * Retract a template post's note: a Delete(Tombstone) to the author's
 * followers, and the Create dropped from the outbox.
 */
export async function dispatchNoteDelete(
  userId: string,
  noteIri: string,
): Promise<void> {
  const user = await db
    .selectFrom("users")
    .select("login_name")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user) return;

  await db
    .deleteFrom("activities")
    .where("user_id", "=", userId)
    .where("object_iri", "=", noteIri)
    .execute();

  const identifier = user.login_name;
  const baseUrl = new URL(process.env.BASE_URL ?? "http://localhost:3000");
  const ctx = federation.createContext(baseUrl, undefined);
  const deleteActivity = new Delete({
    id: new URL(`/users/${identifier}/activities/${randomUUID()}`, baseUrl),
    actor: ctx.getActorUri(identifier),
    object: new Tombstone({ id: new URL(noteIri) }),
    published: Temporal.Now.instant(),
    to: PUBLIC_COLLECTION,
    cc: ctx.getFollowersUri(identifier),
  });

  try {
    await ctx.sendActivity({ identifier }, "followers", deleteActivity);
  } catch (err) {
    console.error("[federation] dispatchNoteDelete failed", err);
  }
}
