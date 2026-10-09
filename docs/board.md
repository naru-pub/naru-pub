# Board (게시판)

A message board with threaded replies at `/board`, where people share their
sites and templates. A template is a snapshot of a folder from someone's site
that anyone can apply to their own site in one step. The home page (`/`) has
a board card with three pills: 템플릿 / 사이트 자랑 (selected to start),
questions, and chat. Each shows its six newest posts, with templates and
showcased sites combined as pictures, and questions and chat as a list.
Below them come the ads, the usage notice, and 최근 업데이트된, which shows
the 24 most recently updated sites. `/sites` lists all of them, 48 per page.

Every board row is keyed by a UUIDv7 (`uuid_v7()`), so `/board/<id>` and reply
addresses can't be guessed or walked in order, while ids still sort by creation
time — reply threads order by their id path. Posts made before migration
`1790824144110` keep the random v4 ids they were published with. Template files
and previews live under `_templates/<template id>/`; the template that existed
before that migration was copied once from its old number's prefix.

Code: `control-plane/src/lib/board/` (logic), `src/app/(main)/board/` (pages),
`src/app/(main)/api/board/` (JSON routes). Schema: migration
`1790738983442_add_board`.

## Behaviour

- **Four kinds of post**: `site` (사이트 자랑), `template`, `question`, `chat`
  (잡담). A `site` post shows the author's current site screenshot. A
  `template` post carries files.
- **Plain text.** Posts and replies are never parsed as HTML or Markdown. A
  blank line starts a new paragraph, and web addresses become links
  (`BoardText`).
- **Writing needs a verified email.** Reading doesn't, and neither does
  applying a template, since that only writes to your own site.
- **Replies nest five levels deep** (`depth` 0–4). A reply to a reply at the
  last level is attached as that reply's sibling, but the person being
  answered is still notified.
- **Deletes are soft.** A deleted reply that still has live replies under it
  stays in the tree as "[삭제된 답글]". Otherwise it disappears.
- **Moderation**: authors edit and delete their own posts and replies. Admins
  (`PAYMENT_OPERATOR_USERS`, the same people who run `/admin`) can delete
  anyone's. Nobody else can.
- **Hourly limits** per user: 10 posts, 60 replies, 20 template applications.
  They are counted from the rows' `created_at`, so no counter table is needed.
- **Notifications**: a new reply notifies the post's author and the author of
  the reply it answers, at most once each, and never the person writing it.
  Opening the thread marks them read. They are listed at `/board/notifications`.
- **Fediverse**: publishing a template post sends a Create(Note) to the
  author's followers, linking to the post, and adds it to their outbox
  (`dispatchTemplatePost`). Deleting the post sends Delete(Tombstone) and
  removes the note from the outbox. Replies from the fediverse are not
  received.

## Templates

- **A template is the files the author checks.** The share form shows the
  whole site with nothing checked, and folders start collapsed. The
  template's root is the deepest folder holding every checked file, so
  checking `hello-world/index.html` shares `index.html` from the root
  `hello-world/`. Its name (for example `alice/hello-world`), which is also
  the default folder when someone applies it, is filled in from that folder.
  `/.backup/` is hidden and refused. Only file types the upload route accepts
  are allowed. The limits are 200 files and 20 MiB, so publishing and
  applying each fit in one request of R2 copies.
- **Publishing takes a snapshot.** The files are copied to
  `_templates/<template_id>/v<version>/` in the site bucket. Login names match
  `^[a-z0-9]+(-[a-z0-9]+)*$`, so no one's site can collide with that prefix.
  Later edits to the author's site don't change the template. "새 버전
  올리기" (publish a new version) on the edit page takes another snapshot,
  starting with the previous version's files checked.
- **Licenses**: new templates require explicit CC0 1.0 consent; the server
  always stores CC0. Authors dedicate their own contributions and retain
  applicable third-party license notices. Existing templates keep their
  original license, including when publishing new versions.
- **Collections**: an author can attach some of their own site-data
  collections. Only each collection's name and permissions travel with the
  template, never its documents. Applying creates them empty, but only for
  someone with the database feature. A name the person already uses is left
  alone.
- **Applying** is two calls:
  1. `apply/plan` reports which files would be created or overwritten, and
     writes nothing.
  2. `apply` works the plan out again on the server. With backup on (the
     default), it first copies each file it will overwrite into
     `.backup/<Seoul time>/`. Then it copies the template's files in, creates
     the collections, and records the application. Nothing undoes an
     application; the backup folder is where the originals are.
- **`apply_count`** counts distinct people, not applications.
- **Previews** show the snapshot, never the author's live site. Publishing
  sends a Postgres `NOTIFY` on `board_template_published`. The cron process,
  which runs in the jobs image where Chromium is, listens for it and runs
  `update-screenshots --templates` straight away. That run serves each
  version's stored files from a loopback web server inside the container,
  screenshots it, and uploads it to the site bucket as
  `_templates/<id>/v<n>.png`, beside the version's files. (Site screenshots
  are in the same bucket, as `_screenshots/<login name>.png`.) The 15-minute
  screenshot run also picks up anything missed. A version that still has no
  preview after a day is no longer tried. `update-screenshots --templates --force` renders every live
  version again.
- **Deletion**: deleting a template post removes its R2 files and previews.
  The database rows stay, so the record of who applied it is kept. Deleting an
  account also removes that user's `_templates/` objects and their site
  screenshot.

## Routes

| page                                | what                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| `/board`                            | list; `?kind=`, `?sort=activity\|new\|applied`, `?page=` |
| `/board/new`                        | compose; `?kind=`                                        |
| `/board/[postId]`                   | post, template panel and apply dialog, reply tree        |
| `/board/[postId]/edit`              | edit; publish a new template version                     |
| `/board/[postId]/replies/[replyId]` | a reply and everything under it (permalink)              |
| `/board/notifications`              | my reply notifications                                   |

Every API route takes JSON only, including DELETE, and refuses cross-origin
requests (`readJson`):

- `POST /api/board/posts`
- `PATCH`/`DELETE /api/board/posts/[id]`
- `POST /api/board/posts/[id]/replies`, `PUT`/`DELETE …/like`, `POST …/solve`
- `PATCH`/`DELETE /api/board/replies/[id]`, `PUT`/`DELETE …/like`
- `POST /api/board/templates/[id]/versions`
- `POST /api/board/template-versions/[id]/apply/plan`, `POST …/apply`
- `POST /api/board/notifications/read`

## Tests

`pnpm test:board` runs `src/lib/board/__tests__` against a throwaway
PostgreSQL cluster migrated to the latest schema. R2 is replaced by an
in-memory bucket in these tests.

## Not built yet

- A live preview of the exact snapshot. It would need a separate preview
  address served by the edge Worker, so a template's HTML never runs on the
  control plane's origin.
- Per-thread subscriptions, reports, and a moderator list separate from the
  payment operators.
- Receiving replies from the fediverse.
