import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

/**
 * S3-compatible storage adapter (Cloudflare R2, MinIO, Backblaze B2, AWS S3).
 *
 * The browser uploads and downloads DIRECTLY against the bucket using
 * presigned URLs. File bytes never pass through this API process, which is
 * what stops a 3 GB lecture upload from exhausting the container's memory and
 * keeps student video streaming off your server's bandwidth bill entirely.
 */

let client: S3Client | null = null;

export function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region: env.s3.region,
      endpoint: env.s3.endpoint,
      forcePathStyle: env.s3.forcePathStyle,
      credentials: {
        accessKeyId: env.s3.accessKeyId,
        secretAccessKey: env.s3.secretAccessKey,
      },
    });
  }
  return client;
}

const bucket = () => env.s3.bucket;

/** Strip anything that would make an object key awkward or unsafe. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 120) || "file";
}

export function buildObjectKey(courseId: string, fileName: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `courses/${courseId}/${unique}-${sanitizeFileName(fileName)}`;
}

/* ── Multipart upload ────────────────────────────────────────────────────── */

/** 10 MB parts: with the 10 000-part limit that allows files up to 100 GB. */
export const PART_SIZE = 10 * 1024 * 1024;

export const partCountFor = (sizeBytes: number) =>
  Math.max(1, Math.ceil(sizeBytes / PART_SIZE));

export async function createMultipartUpload(key: string, contentType: string) {
  const out = await s3().send(
    new CreateMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType || "application/octet-stream",
    }),
  );
  if (!out.UploadId) throw new Error("Storage did not return an upload id");
  return out.UploadId;
}

export async function signUploadParts(
  key: string,
  uploadId: string,
  partNumbers: number[],
): Promise<{ partNumber: number; url: string }[]> {
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        s3(),
        new UploadPartCommand({ Bucket: bucket(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: 60 * 60 * 6 },
      ),
    })),
  );
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  await s3().send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
}

export async function abortMultipartUpload(key: string, uploadId: string) {
  try {
    await s3().send(new AbortMultipartUploadCommand({ Bucket: bucket(), Key: key, UploadId: uploadId }));
  } catch {
    // Best-effort: an orphaned part is cheap and expires under the bucket's
    // lifecycle rule. Never let cleanup failure surface as a user-facing error.
  }
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * Short-lived URL for playback or download.
 *
 * `attachment` is what makes a browser save the file to the student's device
 * (Downloads on desktop, Files/Photos on mobile) with the original filename,
 * instead of navigating to it.
 */
export async function signDownloadUrl(opts: {
  key: string;
  fileName: string;
  contentType?: string;
  disposition: "inline" | "attachment";
  ttlSeconds?: number;
}): Promise<string> {
  const safeName = sanitizeFileName(opts.fileName);

  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: bucket(),
      Key: opts.key,
      ResponseContentDisposition: `${opts.disposition}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
      ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    }),
    { expiresIn: opts.ttlSeconds ?? env.signedUrlTtl },
  );
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

export async function deleteObjects(keys: string[]) {
  if (keys.length === 0) return;
  // DeleteObjects accepts at most 1000 keys per call.
  for (let i = 0; i < keys.length; i += 1000) {
    await s3().send(
      new DeleteObjectsCommand({
        Bucket: bucket(),
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
      }),
    );
  }
}
