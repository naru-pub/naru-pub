// One transaction: the post is published and its draft removed, or neither.
export function publishPost(owner, id, data, hasDraft) {
  return owner.batch([
    { type: "set", collection: "posts", id, data },
    ...(hasDraft ? [{ type: "delete", collection: "drafts", id }] : []),
  ]);
}
