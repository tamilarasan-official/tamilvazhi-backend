import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { env } from "../config/env.js";
import { Course, ContentItem } from "../models/index.js";

/**
 * A salted hash of client IP + user agent.
 *
 * Used for rate limiting and download counts. The raw IP is never stored: the
 * instructor doesn't need it, and a course portal shouldn't accumulate an
 * identifiable record of which student watched what.
 */
export function visitorFingerprint(req: Request): string {
  const ip =
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-real-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.ip ||
    "unknown";
  const ua = (req.headers["user-agent"] as string) ?? "";
  return createHash("sha256").update(`${env.authSecret}:${ip}:${ua}`).digest("hex").slice(0, 32);
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Human-friendly codes: no 0/O/1/I, so students don't mistype what they're told. */
export function generateAccessCode(length = 7): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export async function uniqueSlug(base: string): Promise<string> {
  const root = base || "course";
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    if (!(await Course.exists({ slug: candidate }))) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

export async function uniqueAccessCode(): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const code = generateAccessCode();
    if (!(await Course.exists({ accessCode: code }))) return code;
  }
  return generateAccessCode(10);
}

/** Next position value for an ordered list, so new items append to the end. */
export async function nextItemPosition(moduleId: string): Promise<number> {
  const last = await ContentItem.findOne({ moduleId }).sort({ position: -1 }).select("position").lean();
  return (last?.position ?? -1) + 1;
}

/** Guards against a malformed id reaching Mongoose and throwing a CastError. */
export function isObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
}
