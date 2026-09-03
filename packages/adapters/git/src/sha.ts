import { createHash } from "node:crypto";

/** git's blob object id for content: sha1("blob <len>\0" + content). */
export function blobSha(content: string | Buffer): string {
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}
