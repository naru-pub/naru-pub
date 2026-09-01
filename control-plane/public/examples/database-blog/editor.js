export async function publishPost(owner, id, data, hasDraft) {
  await owner.batch([
    { type: "set", collection: "posts", id, data },
    ...(hasDraft ? [{ type: "delete", collection: "drafts", id }] : []),
  ]);
  return { cleanupError: null };
}
