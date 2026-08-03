import { Router } from "express";
import { z } from "zod";
import { ContentItem, DownloadEvent } from "../models/index.js";
import { deleteObject } from "../lib/storage.js";
import { asyncHandler, requireAdmin, validateObjectId } from "../middleware/index.js";
import { isObjectId } from "../lib/helpers.js";

export const itemsRouter = Router();

itemsRouter.use(requireAdmin);

itemsRouter.patch(
  "/:id",
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        description: z.string().max(5000).nullable().optional(),
        downloadable: z.boolean().optional(),
        position: z.number().int().min(0).optional(),
        moduleId: z.string().optional(),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid changes." });
      return;
    }
    if (parsed.data.moduleId && !isObjectId(parsed.data.moduleId)) {
      res.status(400).json({ error: "Invalid module." });
      return;
    }

    const updated = await ContentItem.findByIdAndUpdate(req.params.id, parsed.data, { new: true });
    if (!updated) {
      res.status(404).json({ error: "Item not found." });
      return;
    }

    res.json({ ok: true });
  }),
);

itemsRouter.delete(
  "/:id",
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const item = await ContentItem.findById(req.params.id).select("storageKey").lean();
    if (!item) {
      res.status(404).json({ error: "Item not found." });
      return;
    }

    await ContentItem.findByIdAndDelete(req.params.id);
    await DownloadEvent.deleteMany({ itemId: req.params.id });

    deleteObject(item.storageKey).catch((e) => console.error("[api] orphaned object:", e));

    res.json({ ok: true });
  }),
);

/**
 * Persists a drag-and-drop reorder.
 *
 * bulkWrite rather than a transaction: MongoDB transactions require a replica
 * set, and a self-hosted single-node deployment isn't one. Position updates are
 * independent and idempotent, so a partial apply is harmless and simply
 * re-sends on the next reorder.
 */
itemsRouter.post(
  "/reorder",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        items: z
          .array(z.object({ id: z.string(), position: z.number().int().min(0) }))
          .max(500),
      })
      .safeParse(req.body);

    if (!parsed.success || parsed.data.items.some((i) => !isObjectId(i.id))) {
      res.status(400).json({ error: "Invalid order." });
      return;
    }
    if (parsed.data.items.length === 0) {
      res.json({ ok: true });
      return;
    }

    await ContentItem.bulkWrite(
      parsed.data.items.map((i) => ({
        updateOne: { filter: { _id: i.id }, update: { $set: { position: i.position } } },
      })),
    );

    res.json({ ok: true });
  }),
);
