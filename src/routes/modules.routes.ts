import { Router } from "express";
import { z } from "zod";
import { Course, ContentItem } from "../models/index.js";
import { deleteObjects } from "../lib/storage.js";
import { asyncHandler, requireAdmin, validateObjectId } from "../middleware/index.js";
import { isObjectId } from "../lib/helpers.js";

export const modulesRouter = Router();

/**
 * Modules are embedded subdocuments of Course, so every operation here is an
 * update against the parent course rather than its own collection.
 */

modulesRouter.post(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ courseId: z.string(), title: z.string().min(1).max(200) })
      .safeParse(req.body);

    if (!parsed.success || !isObjectId(parsed.data.courseId)) {
      res.status(400).json({ error: "Give the module a name." });
      return;
    }

    const course = await Course.findById(parsed.data.courseId);
    if (!course) {
      res.status(404).json({ error: "Course not found." });
      return;
    }

    const position = course.modules.reduce((max, m) => Math.max(max, m.position), -1) + 1;
    course.modules.push({ title: parsed.data.title.trim(), description: null, position });
    await course.save();

    const created = course.modules[course.modules.length - 1];
    res.status(201).json({ ok: true, module: { id: String(created._id), title: created.title } });
  }),
);

modulesRouter.patch(
  "/:id",
  requireAdmin,
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        position: z.number().int().min(0).optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid changes." });
      return;
    }

    const course = await Course.findOne({ "modules._id": req.params.id });
    if (!course) {
      res.status(404).json({ error: "Module not found." });
      return;
    }

    const mod = course.modules.id(req.params.id);
    if (!mod) {
      res.status(404).json({ error: "Module not found." });
      return;
    }

    if (parsed.data.title !== undefined) mod.title = parsed.data.title.trim();
    if (parsed.data.description !== undefined) mod.description = parsed.data.description;
    if (parsed.data.position !== undefined) mod.position = parsed.data.position;
    await course.save();

    res.json({ ok: true });
  }),
);

modulesRouter.delete(
  "/:id",
  requireAdmin,
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const course = await Course.findOne({ "modules._id": req.params.id });
    if (!course) {
      res.status(404).json({ error: "Module not found." });
      return;
    }

    const items = await ContentItem.find({ moduleId: req.params.id }).select("storageKey").lean();
    const keys = items.map((i) => i.storageKey);

    await ContentItem.deleteMany({ moduleId: req.params.id });
    course.modules.pull({ _id: req.params.id });
    await course.save();

    deleteObjects(keys).catch((e) => console.error("[api] orphaned objects:", e));

    res.json({ ok: true, removedFiles: keys.length });
  }),
);
