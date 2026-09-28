import "server-only";
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/*
 * Password hashing with node:crypto scrypt. The stored string names its own parameters,
 * "scrypt$16384$8$1$<salt>$<key>" (salt and key base64url), so they can be raised later and old
 * hashes still verify.
 */
const N = 16384, R = 8, P = 1, KEY_LEN = 64, SALT_LEN = 16;

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password.normalize("NFC"), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time check against a stored hash. A malformed hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltS, keyS] = stored.split("$");
  const cost = Number(n), block = Number(r), par = Number(p);
  if (alg !== "scrypt" || !saltS || !keyS || ![cost, block, par].every((x) => Number.isInteger(x) && x > 0)) return false;
  if (cost > 1 << 20 || block > 32 || par > 16) return false; // refuse parameters that would stall the server
  const expected = Buffer.from(keyS, "base64url");
  if (expected.length < 16) return false;
  const key = await scrypt(password, Buffer.from(saltS, "base64url"), expected.length, { N: cost, r: block, p: par, maxmem: 256 * cost * block + (1 << 20) });
  return timingSafeEqual(key, expected);
}

let dummy: Promise<string> | null = null;
/** Spend the time of a real check when there is no account, so response time does not reveal which emails exist. */
export async function burnPasswordCheck(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(12).toString("hex"));
  await verifyPassword(password, await dummy);
  return false;
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export type PasswordProblem = "too_short" | "too_long" | "common" | "same_as_email";

// Lowercased. Shorter ones already fail the length rule; these are the ten-plus-character favourites
// of leaked lists, plus local and product words.
const COMMON = new Set([
  "1234567890", "0123456789", "0987654321", "9876543210", "1122334455", "1234512345", "1111111111", "0000000000",
  "12345678910", "123456789a", "a123456789", "1234567890a", "123456789q", "1q2w3e4r5t", "1q2w3e4r5t6y", "q1w2e3r4t5",
  "qwertyuiop", "qwerty1234", "qwerty12345", "qwerty123456", "asdfghjkl1", "asdfghjkl;", "zxcvbnm123", "1qaz2wsx3edc",
  "qazwsxedc123", "zaq12wsxcde", "password12", "password123", "password1234", "password12345", "passw0rd123", "p@ssw0rd123",
  "p@ssword123", "iloveyou12", "iloveyou123", "princess12", "sunshine12", "football12", "baseball12", "welcome123",
  "welcome1234", "letmein123", "admin12345", "administrator", "changeme123", "trustno1234", "abc1234567", "abcd123456",
  "abcdefghij", "aaaaaaaaaa", "superman12", "starwars12", "michael123", "computer12", "internet12", "whatever12",
  "pakistan123", "pakistan786", "pakistan1947", "pakistanzindabad", "lahore1234", "karachi123", "islamabad1",
  "allahuakbar", "bismillah1", "bismillah786", "mashallah1", "alhamdulillah", "subhanallah", "muhammad786", "786786786786",
  "tabayyun123", "tabayyun1234", "teenpehr123", "newspaper1", "news123456",
]);

/** null when the password is acceptable, else what is wrong with it (the UI words each case). */
export function passwordProblem(password: string, email?: string | null): PasswordProblem | null {
  const p = password.normalize("NFC");
  if ([...p].length < PASSWORD_MIN_LENGTH) return "too_short";
  if (p.length > PASSWORD_MAX_LENGTH) return "too_long";
  const lower = p.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(lower)) return "common";
  if (email) {
    const e = email.trim().toLowerCase();
    if (lower === e || lower === e.split("@")[0]) return "same_as_email";
  }
  return null;
}
