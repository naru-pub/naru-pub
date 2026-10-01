import { CopyObjectCommand } from "@aws-sdk/client-s3";
import { listObjects } from "@/lib/board/storage";
import { s3Client } from "@/lib/s3";
import { getSiteScreenshotKey } from "@/lib/site-urls";

// Site screenshots and template previews used to live in a bucket of their
// own, served at r2-screenshots.<domain>, as <login name>.png and
// _templates/<template id>/v<n>.png. Both now live in the site bucket, as
// _screenshots/<login name>.png and _templates/<template id>/v<n>.png, served
// at r2.<domain>. This copies every object across. Copied, not moved: URLs
// already handed out, such as the icons other ActivityPub servers hold, keep
// working until the old bucket is retired. Safe to run again: it only
// overwrites its own copies.
//
//   S3_BUCKET_NAME_SCREENSHOTS=<old bucket> node dist/cli/copy-screenshots-to-site-bucket.mjs
async function main() {
  const from = process.env.S3_BUCKET_NAME_SCREENSHOTS;
  if (!from) throw new Error("S3_BUCKET_NAME_SCREENSHOTS is not set");
  const to = process.env.S3_BUCKET_NAME!;

  let copied = 0;
  for (const object of await listObjects("", from)) {
    const login = /^([^/]+)\.png$/.exec(object.key)?.[1];
    let key: string;
    if (object.key.startsWith("_templates/")) key = object.key;
    else if (login) key = getSiteScreenshotKey(login);
    else {
      console.log(`[copy-screenshots-to-site-bucket] skipping ${object.key}`);
      continue;
    }
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: to,
        // The copy source is a URL path, so each segment is encoded.
        CopySource: `${from}/${object.key.split("/").map(encodeURIComponent).join("/")}`,
        Key: key,
      }),
    );
    copied += 1;
  }
  console.log(`[copy-screenshots-to-site-bucket] ${copied} object(s) copied`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[copy-screenshots-to-site-bucket] fatal:", error);
    process.exit(1);
  });
