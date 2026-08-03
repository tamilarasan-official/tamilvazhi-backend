import { Router } from "express";
import { ContentItem, DownloadEvent } from "../models/index.js";
import { signDownloadUrl } from "../lib/storage.js";
import { visitorFingerprint } from "../lib/helpers.js";
import { asyncHandler, canAccessCourse, validateObjectId } from "../middleware/index.js";
import { env } from "../config/env.js";

export const filesRouter = Router();

/**
 * Signed URL for playback (or for opening a document in a new tab).
 *
 * The browser then talks to object storage directly, so HTTP range requests —
 * seeking and buffering in a video — never round-trip through this API.
 */
filesRouter.get(
  "/:id/url",
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const item = await ContentItem.findById(req.params.id).lean();
    if (!item) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    if (!(await canAccessCourse(req, String(item.courseId)))) {
      res.status(403).json({ error: "Access code required." });
      return;
    }

    const wantsAttachment = req.query.mode === "download";
    if (wantsAttachment && !item.downloadable) {
      res.status(403).json({ error: "Downloads are disabled for this item." });
      return;
    }

    const url = await signDownloadUrl({
      key: item.storageKey,
      fileName: item.fileName,
      contentType: item.mimeType,
      disposition: wantsAttachment ? "attachment" : "inline",
    });

    res.set("Cache-Control", "no-store").json({ url, expiresIn: env.signedUrlTtl });
  }),
);

/**
 * The student download link.
 *
 * Redirects to a presigned URL carrying `Content-Disposition: attachment`,
 * which is what makes phones and desktops save the file locally under its
 * original name instead of opening it in a viewer.
 */
filesRouter.get(
  "/:id/download",
  validateObjectId(),
  asyncHandler(async (req, res) => {
    const item = await ContentItem.findById(req.params.id).lean();
    if (!item) {
      res.status(404).json({ error: "Not found." });
      return;
    }

    if (!(await canAccessCourse(req, String(item.courseId)))) {
      // A browser follows this link directly, so send it somewhere useful
      // rather than returning bare JSON.
      res.redirect(302, `${env.frontendUrl}/access`);
      return;
    }

    if (!item.downloadable) {
      res.status(403).json({ error: "Downloads are disabled for this item." });
      return;
    }

    const url = await signDownloadUrl({
      key: item.storageKey,
      fileName: item.fileName,
      contentType: item.mimeType,
      disposition: "attachment",
      ttlSeconds: 60 * 60, // the download starts at once; an hour is generous
    });

    // Fire-and-forget: never make the student wait on analytics.
    Promise.all([
      DownloadEvent.create({
        itemId: item._id,
        courseId: item.courseId,
        kind: "download",
        visitor: visitorFingerprint(req),
      }),
      ContentItem.updateOne({ _id: item._id }, { $inc: { downloadCount: 1 } }),
    ]).catch(() => {});

    res.redirect(307, url);
  }),
);
