import type { Request, Response, NextFunction, RequestHandler } from "express";
import { readAdminSession, readUnlockedCourseIds, type AdminSession } from "../lib/auth.js";
import { AccessAttempt, Course } from "../models/index.js";
import { visitorFingerprint, isObjectId } from "../lib/helpers.js";
import { env } from "../config/env.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminSession;
    }
  }
}

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** Rejects anything without a valid admin cookie. */
export const requireAdmin: RequestHandler = asyncHandler(async (req, res, next) => {
  const admin = await readAdminSession(req);
  if (!admin) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  req.admin = admin;
  next();
});

/**
 * Can this request read the given course?
 *
 * An admin always can, so the instructor can preview a draft. For a student,
 * holding the code is not sufficient — the course must still be published,
 * otherwise unpublishing would fail to revoke access for everyone who had
 * already entered the code.
 */
export async function canAccessCourse(req: Request, courseId: string): Promise<boolean> {
  if (await readAdminSession(req)) return true;

  const unlocked = await readUnlockedCourseIds(req);
  if (!unlocked.includes(String(courseId))) return false;

  const course = await Course.findById(courseId).select("published").lean();
  return course?.published === true;
}

/**
 * Database-backed rate limiter.
 *
 * Deliberately not an in-memory counter: Dokploy can run more than one replica,
 * and an in-memory limit would then allow N times the intended attempts while
 * also resetting on every redeploy.
 */
export function rateLimit(opts: { scope: string; windowMs: number; max: number; message: string }): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const visitor = `${opts.scope}:${visitorFingerprint(req)}`;
    const since = new Date(Date.now() - opts.windowMs);

    const failures = await AccessAttempt.countDocuments({
      visitor,
      success: false,
      createdAt: { $gte: since },
    });

    if (failures >= opts.max) {
      res.status(429).json({ error: opts.message });
      return;
    }

    // Handlers call this to record the outcome of the attempt.
    res.locals.recordAttempt = (success: boolean) =>
      AccessAttempt.create({ visitor, success }).catch(() => {});

    next();
  });
}

/** 404 for unmatched routes — keeps the shape consistent with real errors. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "Not found." });
};

/**
 * Central error handler.
 *
 * Rejected requests are classified before falling through to 500 — a blocked
 * CORS origin or an oversized body is a client error, and reporting it as 500
 * sends anyone debugging a deploy hunting for a server fault that isn't there.
 */
export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  const message = error instanceof Error ? error.message : String(error);
  const type = (error as { type?: string })?.type;

  if (message.includes("not allowed by CORS_ORIGINS")) {
    console.warn("[api] blocked origin:", message);
    res.status(403).json({
      error: "This origin is not allowed to call the API. Add it to CORS_ORIGINS.",
    });
    return;
  }

  if (type === "entity.too.large") {
    res.status(413).json({
      error: "Request body is too large. File uploads go directly to storage, not through this endpoint.",
    });
    return;
  }

  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON." });
    return;
  }

  console.error("[api] unhandled:", message);
  res.status(500).json({
    error: env.isProd ? "Something went wrong. Please try again." : message,
  });
}

/** Rejects a malformed :id early with 404 rather than a 500 CastError. */
export function validateObjectId(param = "id"): RequestHandler {
  return (req, res, next) => {
    if (!isObjectId(req.params[param])) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    next();
  };
}
