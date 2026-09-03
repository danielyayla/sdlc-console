import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 10 chars of ms time + 16 chars of randomness, Crockford base32. */
export function newUlid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = (ALPHABET[t % 32] ?? "0") + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[(bytes[i] ?? 0) % 32];
  return time + rand;
}
