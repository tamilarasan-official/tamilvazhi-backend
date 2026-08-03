import { Router } from "express";
import { z } from "zod";
import { Course, ContentItem } from "../models/index.js";
import {
  buildObjectKey,
  createMultipartUpload,
  signUploadParts,
  completeMultipartUpload,
  abortMultipartUpload,
  PART_SIZE,
  partCountFor,
} from "../lib/storage.js";
import { nextItemPosition, isObjectId } from "../lib/helpers.js";
import { asyncHandler, requireAdmin } from "../middleware/index.js";

export const uploadsRouter = Router();

/**
 * Three-step direct-to-storage upload.
 *
 *   init     open a multipart upload, return presigned PUT URLs for the parts
 *   parts    sign the next batch of parts for large files
 *   complete seal the upload and record the item
 *
 * File bytes go browser -> object storage. They never traverse this process,
 * so a 3 GB lecture costs the API container nothing but a few signatures.
 */

// 100 URLs per response keeps payloads small; a 5 GB file needs 5 round trips.
const MAX_URLS_PER_REQUEST = 100;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB

uploadsRouter.use(requireAdmin);

uploadsRouter.post(
  "/init",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        moduleId: z.string(),
        fileName: z.string().min(1).max(255),
        contentType: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(MAX_FILE_BYTES),
      })
      .safeParse(req.body);

    if (!parsed.success || !isObjectId(parsed.data.moduleId)) {
      res.status(400).json({ error: parsed.success ? "Invalid module." : parsed.error.issues[0]?.message });
      return;
    }

    const course = await Course.findOne({ "modules._id": parsed.data.moduleId }).select("_id").lean();
    if (!course) {
      res.status(404).json({ error: "That module no longer exists." });
      return;
    }

    const key = buildObjectKey(String(course._id), parsed.data.fileName);
    const uploadId = await createMultipartUpload(key, parsed.data.contentType);
    const totalParts = partCountFor(parsed.data.sizeBytes);

    const firstBatch = Array.from(
      { length: Math.min(totalParts, MAX_URLS_PER_REQUEST) },
      (_, i) => i + 1,
    );

    res.json({
      key,
      uploadId,
      partSize: PART_SIZE,
      totalParts,
      urls: await signUploadParts(key, uploadId, firstBatch),
    });
  }),
);

uploadsRouter.post(
  "/parts",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        key: z.string().min(1),
        uploadId: z.string().min(1),
        partNumbers: z.array(z.number().int().min(1).max(10000)).min(1).max(MAX_URLS_PER_REQUEST),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request." });
      return;
    }

    res.json({
      urls: await signUploadParts(parsed.data.key, parsed.data.uploadId, parsed.data.partNumbers),
    });
  }),
);

uploadsRouter.post(
  "/complete",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        key: z.string().min(1),
        uploadId: z.string().min(1),
        moduleId: z.string(),
        title: z.string().min(1).max(200),
        fileName: z.string().min(1).max(255),
        contentType: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive(),
        durationSec: z.number().int().positive().nullable().optional(),
        type: z.enum(["VIDEO", "DOCUMENT"]),
        parts: z
          .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
          .min(1),
      })
      .safeParse(req.body);

    if (!parsed.success || !isObjectId(parsed.data.moduleId)) {
      res.status(400).json({ error: parsed.success ? "Invalid module." : parsed.error.issues[0]?.message });
      return;
    }

    const data = parsed.data;

    const course = await Course.findOne({ "modules._id": data.moduleId }).select("_id").lean();
    if (!course) {
      await abortMultipartUpload(data.key, data.uploadId);
      res.status(404).json({ error: "That module no longer exists." });
      return;
    }

    try {
      await completeMultipartUpload(data.key, data.uploadId, data.parts);
    } catch (error) {
      await abortMultipartUpload(data.key, data.uploadId);
      throw error;
    }

    // Note: if this write fails the object is deliberately left in place.
    // An orphan costs a few cents; discarding a just-uploaded 2 GB lecture
    // because of a transient database blip does not.
    const item = await ContentItem.create({
      courseId: course._id,
      moduleId: data.moduleId,
      title: data.title,
      type: data.type,
      storageKey: data.key,
      fileName: data.fileName,
      mimeType: data.contentType,
      sizeBytes: data.sizeBytes,
      durationSec: data.durationSec ?? null,
      position: await nextItemPosition(data.moduleId),
    });

    res.status(201).json({
      ok: true,
      item: { id: String(item._id), title: item.title, type: item.type },
    });
  }),
);

/** Called when the instructor cancels, so partial data doesn't sit and bill. */
uploadsRouter.post(
  "/abort",
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ key: z.string().min(1), uploadId: z.string().min(1) })
      .safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request." });
      return;
    }

    await abortMultipartUpload(parsed.data.key, parsed.data.uploadId);
    res.json({ ok: true });
  }),
);
