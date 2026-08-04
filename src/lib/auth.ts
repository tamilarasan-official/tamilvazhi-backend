import { SignJWT, jwtVerify } from "jose";
import type { Request, Response } from "express";
import { env } from "../config/env.js";

/**
 * Two independent, stateless sessions:
 *
 *  1. ADMIN  — the instructor. Email + password, 7-day cookie.
 *  2. ACCESS — a student. No account and no password: entering a course access
 *     code mints a cookie listing the course ids they have unlocked.
 *
 * Both cookies are issued by the API on the parent domain (COOKIE_DOMAIN
 * ".yoursite.com"), so portal.yoursite.com sends them to api.yoursite.com as a
 * same-site request. That avoids third-party-cookie blocking entirely.
 */

export const ADMIN_COOKIE = "tv_admin";
export const ACCESS_COOKIE = "tv_access";

const ADMIN_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const ACCESS_MAX_AGE = 60 * 60 * 24 * 90; // 90 days — students shouldn't retype the code every visit

const key = () => new TextEncoder().encode(env.authSecret);

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: env.cookie.secure,
    sameSite: env.cookie.sameSite,
    domain: env.cookie.domain,
    path: "/",
    maxAge: maxAgeSeconds * 1000,
  } as const;
}

/* ── Admin ───────────────────────────────────────────────────────────────── */

export type AdminSession = { id: string; email: string; name: string };

export async function createAdminToken(session: AdminSession): Promise<string> {
  return new SignJWT({ email: session.email, name: session.name, role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.id)
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_MAX_AGE}s`)
    .sign(key());
}

export async function readAdminSession(req: Request): Promise<AdminSession | null> {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.role !== "admin" || !payload.sub) return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
    };
  } catch {
    return null;
  }
}

export function setAdminCookie(res: Response, token: string) {
  res.cookie(ADMIN_COOKIE, token, cookieOptions(ADMIN_MAX_AGE));
}

export function clearAdminCookie(res: Response) {
  res.clearCookie(ADMIN_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

/* ── Student access ──────────────────────────────────────────────────────── */

export async function readUnlockedCourseIds(req: Request): Promise<string[]> {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) return [];
  try {
    const { payload } = await jwtVerify(token, key());
    const courses = payload.courses;
    return Array.isArray(courses) ? courses.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** Adds a course to the visitor's unlocked set without dropping earlier ones. */
export async function grantCourseAccess(req: Request, res: Response, courseId: string) {
  const existing = await readUnlockedCourseIds(req);
  const next = Array.from(new Set([...existing, courseId]));

  const token = await new SignJWT({ courses: next, role: "student" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_MAX_AGE}s`)
    .sign(key());

  res.cookie(ACCESS_COOKIE, token, cookieOptions(ACCESS_MAX_AGE));
}

/**
 * Clearing must repeat the domain/path/sameSite the cookie was set with —
 * a mismatch leaves the original cookie in place and the "forget my courses"
 * button silently does nothing.
 */
export function clearAccessCookie(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}
