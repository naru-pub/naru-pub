// A publication spans two independent requests. Never delete the private draft
// before the public write succeeds; retrying the same ID is safe.
export async function publishPost(owner, id, data, hasDraft) {
  await owner.collection("posts").set(id, data);
  if (hasDraft) {
    try {
      await owner.collection("drafts").delete(id);
    } catch (cleanupError) {
      return { cleanupError };
    }
  }
  return { cleanupError: null };
}
