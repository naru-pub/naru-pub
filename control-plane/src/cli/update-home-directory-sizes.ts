import { db } from "@/lib/database";
import { s3Client } from "@/lib/s3";
import { getUserHomeDirectory } from "@/lib/site-urls";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";

async function calculateUserHomeDirectorySize(
  loginName: string,
): Promise<number> {
  const prefix = `${getUserHomeDirectory(loginName)}/`;

  try {
    let totalSize = 0;
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const response = await s3Client.send(command);

      if (response.Contents) {
        totalSize += response.Contents.reduce((sum, object) => {
          return sum + (object.Size || 0);
        }, 0);
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return totalSize;
  } catch (error) {
    console.error(`Failed to calculate size for user ${loginName}:`, error);
    return 0;
  }
}

async function processUserBatch(
  users: Array<{ id: string; login_name: string }>,
) {
  const batchPromises = users.map(async (user) => {
    try {
      console.log(`Processing user: ${user.login_name}`);

      const directorySize = await calculateUserHomeDirectorySize(
        user.login_name,
      );
      const now = new Date();

      // Update the users table with the calculated size and current timestamp
      await db
        .updateTable("users")
        .set({
          home_directory_size_bytes: directorySize,
          home_directory_size_bytes_updated_at: now,
        })
        .where("id", "=", user.id)
        .execute();

      console.log(`Updated ${user.login_name}: ${directorySize} bytes`);
      return { success: true, user: user.login_name, size: directorySize };
    } catch (error) {
      console.error(`Error processing user ${user.login_name}:`, error);
      return { success: false, user: user.login_name, error: error };
    }
  });

  return Promise.all(batchPromises);
}

async function updateHomeDirectorySizes() {
  console.log("Starting home directory size calculation...");

  const BATCH_SIZE = 10; // Process 10 users at a time
  const CONCURRENT_BATCHES = 3; // Run 3 batches concurrently

  try {
    // Get all users
    const users = await db
      .selectFrom("users")
      .select(["id", "login_name"])
      .execute();

    console.log(`Found ${users.length} users to process`);
    console.log(
      `Processing in batches of ${BATCH_SIZE} with ${CONCURRENT_BATCHES} concurrent batches`,
    );

    let processedCount = 0;
    let errorCount = 0;
    const startTime = Date.now();

    // Process users in batches
    for (let i = 0; i < users.length; i += BATCH_SIZE * CONCURRENT_BATCHES) {
      const batchPromises = [];

      // Create concurrent batches
      for (
        let j = 0;
        j < CONCURRENT_BATCHES && i + j * BATCH_SIZE < users.length;
        j++
      ) {
        const batchStart = i + j * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, users.length);
        const userBatch = users.slice(batchStart, batchEnd);

        batchPromises.push(processUserBatch(userBatch));
      }

      // Wait for all batches in this round to complete
      const batchResults = await Promise.all(batchPromises);

      // Process results
      for (const batchResult of batchResults) {
        for (const result of batchResult) {
          if (result.success) {
            processedCount++;
          } else {
            errorCount++;
          }
        }
      }

      const progress = Math.min(
        i + BATCH_SIZE * CONCURRENT_BATCHES,
        users.length,
      );
      const percentage = ((progress / users.length) * 100).toFixed(1);
      console.log(`Progress: ${progress}/${users.length} (${percentage}%)`);
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    console.log(`\nProcessing complete!`);
    console.log(`Duration: ${duration.toFixed(2)} seconds`);
    console.log(`Successfully processed: ${processedCount} users`);
    console.log(`Errors: ${errorCount} users`);
    console.log(
      `Average time per user: ${(duration / users.length).toFixed(2)} seconds`,
    );
  } catch (error) {
    console.error("Failed to update home directory sizes:", error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

updateHomeDirectorySizes();
