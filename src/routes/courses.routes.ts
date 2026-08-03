import { Router } from "express";
import { z } from "zod";
import { Course, ContentItem, DownloadEvent } from "../models/index.js";
import { deleteObjects } from "../lib/storage.js";
import { uniqueSlug, uniqueAccessCode, slugify } from "../lib/helpers.js";
import { asyncHandler, requireAdmin, canAccessCourse, validateObjectId } from "../middleware/index.js";

export const coursesRouter = Router();

/* ── Student-facing ──────────────────────────────────────────────────────── */

/**
 * Full course tree for the student viewer.
 *
 * Gated by canAccessCourse, which also enforces the published flag — so
 * unpublishing revokes access for students who already redeemed the code.
 */
coursesRouter.get(
  "/slug/:slug",
  asyncHandler(async (req, res) => {
    const course = await Course.findOne({ slug: req.params.slug }).lean();
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    if (!(await canAccessCourse(req, String(course._id)))) {
      res.status(403).json({ error: "Access code required.", slug: course.slug });
      return;
    }

    const items = await ContentItem.find({ courseId: course._id }).sort({ position: 1 }).lean();

    const modules = [...course.modules]
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        id: String(m._id),
        title: m.title,
        description: m.description ?? null,
        items: items
          .filter((i) => String(i.moduleId) === String(m._id))
          .map((i) => ({
            id: String(i._id),
            title: i.title,
            description: i.description ?? null,
            type: i.type,
            fileName: i.fileName,
            mimeType: i.mimeType,
            sizeBytes: i.sizeBytes,
            durationSec: i.durationSec ?? null,
            downloadable: i.downloadable,
          })),
      }));

    res.json({
      course: {
        id: String(course._id),
        title: course.title,
        slug: course.slug,
        subtitle: course.subtitle ?? null,
        description: course.description ?? null,
        accent: course.accent,
        modules,
      },
    });
  }),
);

/* ── Admin ───────────────────────────────────────────────────────────────── */

/** Dashboard listing with per-course counts and overall storage totals. */
coursesRouter.get(
  "/",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const courses = await Course.find().sort({ position: 1 }).lean();

    const stats = await ContentItem.aggregate<{
      _id: { courseId: unknown; type: string };
      n: number;
      bytes: number;
    }>([
      { $group: { _id: { courseId: "$courseId", type: "$type" }, n: { $sum: 1 }, bytes: { $sum: "$sizeBytes" } } },
    ]);

    const pick = (courseId: string, type: string) =>
      stats.find((s) => String(s._id.courseId) === courseId && s._id.type === type);

    const [totalFiles, totalDownloads] = await Promise.all([
      ContentItem.countDocuments(),
      DownloadEvent.countDocuments(),
    ]);

    res.json({
      courses: courses.map((c) => {
        const id = String(c._id);
        const video = pick(id, "VIDEO");
        const doc = pick(id, "DOCUMENT");
        return {
          id,
          title: c.title,
          slug: c.slug,
          subtitle: c.subtitle ?? null,
          accessCode: c.accessCode,
          published: c.published,
          updatedAt: c.updatedAt,
          videoCount: video?.n ?? 0,
          docCount: doc?.n ?? 0,
          sizeBytes: (video?.bytes ?? 0) + (doc?.bytes ?? 0),
        };
      }),
      totals: {
        files: totalFiles,
        downloads: totalDownloads,
        storageBytes: stats.reduce((sum, s) => sum + s.bytes, 0),
      },
    });
  }),
);

/** Single course for the admin editor, including per-item download counts. */
coursesRouter.get(
  "/:id",
  requireAdmin,
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.params.id).lean();
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    const items = await ContentItem.find({ courseId: course._id }).sort({ position: 1 }).lean();

    res.json({
      course: {
        id: String(course._id),
        title: course.title,
        slug: course.slug,
        subtitle: course.subtitle ?? null,
        description: course.description ?? null,
        accessCode: course.accessCode,
        published: course.published,
        modules: [...course.modules]
          .sort((a, b) => a.position - b.position)
          .map((m) => ({
            id: String(m._id),
            title: m.title,
            items: items
              .filter((i) => String(i.moduleId) === String(m._id))
              .map((i) => ({
                id: String(i._id),
                title: i.title,
                type: i.type,
                fileName: i.fileName,
                sizeBytes: i.sizeBytes,
                durationSec: i.durationSec ?? null,
                downloadable: i.downloadable,
                downloadCount: i.downloadCount ?? 0,
              })),
          })),
      },
    });
  }),
);

const createSchema = z.object({
  title: z.string().min(2, "Give the course a title.").max(200),
  subtitle: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  accent: z.string().max(20).optional(),
});

coursesRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid course." });
      return;
    }

    const last = await Course.findOne().sort({ position: -1 }).select("position").lean();

    const course = await Course.create({
      title: parsed.data.title.trim(),
      subtitle: parsed.data.subtitle?.trim() || null,
      description: parsed.data.description?.trim() || null,
      accent: parsed.data.accent || "indigo",
      slug: await uniqueSlug(slugify(parsed.data.title)),
      accessCode: await uniqueAccessCode(),
      position: (last?.position ?? -1) + 1,
      modules: [{ title: "Module 1", position: 0 }],
    });

    res.status(201).json({
      ok: true,
      course: {
        id: String(course._id),
        title: course.title,
        slug: course.slug,
        accessCode: course.accessCode,
      },
    });
  }),
);

const patchSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  subtitle: z.string().max(200).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  accent: z.string().max(20).optional(),
  published: z.boolean().optional(),
  regenerateAccessCode: z.boolean().optional(),
});

coursesRouter.patch(
  "/:id",
  requireAdmin,
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid changes." });
      return;
    }

    const { regenerateAccessCode, ...fields } = parsed.data;
    const update: Record<string, unknown> = { ...fields };
    if (typeof fields.title === "string") update.title = fields.title.trim();

    // Rotating the code immediately locks out everyone holding the old one —
    // that is the point of the button.
    if (regenerateAccessCode) update.accessCode = await uniqueAccessCode();

    const course = await Course.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    res.json({
      ok: true,
      course: {
        id: String(course._id),
        title: course.title,
        published: course.published,
        accessCode: course.accessCode,
      },
    });
  }),
);

coursesRouter.delete(
  "/:id",
  requireAdmin,
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const course = await Course.findById(req.params.id).select("_id").lean();
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    // Collect storage keys before removing the rows that point at them.
    const items = await ContentItem.find({ courseId: course._id }).select("storageKey").lean();
    const keys = items.map((i) => i.storageKey);

    await ContentItem.deleteMany({ courseId: course._id });
    await DownloadEvent.deleteMany({ courseId: course._id });
    await Course.findByIdAndDelete(course._id);

    // Best-effort: the database is already consistent, so a storage hiccup here
    // leaves paid-for bytes behind rather than a broken catalogue.
    deleteObjects(keys).catch((e) => console.error("[api] orphaned objects:", e));

    res.json({ ok: true, removedFiles: keys.length });
  }),
);
