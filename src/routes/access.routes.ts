import { Router } from "express";
import { z } from "zod";
import { Course, ContentItem } from "../models/index.js";
import { grantCourseAccess, readUnlockedCourseIds, clearAccessCookie } from "../lib/auth.js";
import { asyncHandler, rateLimit } from "../middleware/index.js";

export const accessRouter = Router();

/**
 * Redeem a course access code.
 *
 * No account is created — success simply adds the course id to the visitor's
 * signed access cookie.
 */
accessRouter.post(
  "/",
  rateLimit({
    scope: "access",
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: "Too many incorrect attempts. Please try again in a few minutes.",
  }),
  asyncHandler(async (req, res) => {
    const parsed = z.object({ code: z.string().min(3).max(64) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter your access code." });
      return;
    }

    const code = parsed.data.code.trim().toUpperCase();
    const course = await Course.findOne({ accessCode: code })
      .select("_id slug title published")
      .lean();

    await res.locals.recordAttempt?.(Boolean(course));

    if (!course) {
      res.status(404).json({ error: "That access code isn't valid. Check it with your instructor." });
      return;
    }

    // A correct code for a draft is the instructor's most common mix-up: they
    // share the code before pressing Publish. Say so, instead of "invalid".
    if (!course.published) {
      res.status(403).json({
        error: "This course hasn't been published yet. Ask your instructor to publish it, then try again.",
      });
      return;
    }

    await grantCourseAccess(req, res, String(course._id));
    res.json({ ok: true, slug: course.slug, title: course.title });
  }),
);

/**
 * Courses this visitor has unlocked — powers the student home page.
 * Returns an empty list rather than an error when nothing is unlocked.
 */
accessRouter.get(
  "/courses",
  asyncHandler(async (req, res) => {
    const unlocked = await readUnlockedCourseIds(req);
    if (unlocked.length === 0) {
      res.json({ courses: [] });
      return;
    }

    const courses = await Course.find({ _id: { $in: unlocked }, published: true })
      .sort({ position: 1 })
      .select("_id title slug subtitle accent")
      .lean();

    // One grouped count query instead of N per-course queries.
    const counts = await ContentItem.aggregate<{ _id: { courseId: unknown; type: string }; n: number }>([
      { $match: { courseId: { $in: courses.map((c) => c._id) } } },
      { $group: { _id: { courseId: "$courseId", type: "$type" }, n: { $sum: 1 } } },
    ]);

    const countFor = (courseId: string, type: string) =>
      counts.find((c) => String(c._id.courseId) === courseId && c._id.type === type)?.n ?? 0;

    res.json({
      courses: courses.map((c) => ({
        id: String(c._id),
        title: c.title,
        slug: c.slug,
        subtitle: c.subtitle ?? null,
        accent: c.accent,
        videoCount: countFor(String(c._id), "VIDEO"),
        docCount: countFor(String(c._id), "DOCUMENT"),
      })),
    });
  }),
);

/** Forget every unlocked course on this device. Clears only the caller's cookie. */
accessRouter.post("/reset", (_req, res) => {
  clearAccessCookie(res);
  res.json({ ok: true });
});
