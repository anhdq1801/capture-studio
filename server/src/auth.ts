import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Env, JwtPayload } from "./types";
import { getUserByEmail, insertUser, newId, nowIso } from "./db";

type Vars = { userId: string; userEmail: string };
export type AppEnv = { Bindings: Env; Variables: Vars };

const PBKDF2_ITERATIONS = 100_000;
const JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

function toBase64Url(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const str = atob(padded);
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
  return bytes;
}

// ---- Password hashing (PBKDF2 via WebCrypto — no native bcrypt binding needed in Workers) ----

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveBits(password, salt);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(key))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = fromBase64Url(parts[2]);
  const expected = fromBase64Url(parts[3]);
  const actual = new Uint8Array(await deriveBits(password, salt, iterations));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS
): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
}

// ---- JWT (HS256) ----

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(payload: { sub: string; email: string }, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const full: JwtPayload = { ...payload, iat, exp: iat + JWT_TTL_SECONDS };
  const encHeader = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(full)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(encSig),
    new TextEncoder().encode(`${encHeader}.${encPayload}`)
  );
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encPayload))) as JwtPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---- Auth middleware ----

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", payload.sub);
  c.set("userEmail", payload.email);
  await next();
}

// ---- Routes: POST /auth/signup, POST /auth/login ----

export const authRoutes = new Hono<AppEnv>();

type AuthBody = { email?: string; password?: string };

authRoutes.post("/signup", async (c) => {
  const body = await c.req.json<AuthBody>().catch(() => ({}) as AuthBody);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!isValidEmail(email)) return c.json({ error: "Invalid email" }, 400);
  if (password.length < 8) return c.json({ error: "Password must be at least 8 characters" }, 400);

  if (await getUserByEmail(c.env, email)) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const id = newId();
  await insertUser(c.env, {
    id,
    email,
    passwordHash: await hashPassword(password),
    createdAt: nowIso(),
  });
  const token = await signJwt({ sub: id, email }, c.env.JWT_SECRET);
  return c.json({ token, email });
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json<AuthBody>().catch(() => ({}) as AuthBody);
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  const user = await getUserByEmail(c.env, email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "Invalid email or password" }, 401);
  }
  const token = await signJwt({ sub: user.id, email: user.email }, c.env.JWT_SECRET);
  return c.json({ token, email: user.email });
});
