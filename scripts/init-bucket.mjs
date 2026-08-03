/**
 * Creates the bucket if missing and applies the CORS rules the browser needs
 * for direct multipart uploads.
 *
 * The ExposeHeaders entry is the one that catches people out: without ETag
 * exposed, the browser can read the upload response but not the part ETag, and
 * completing a multipart upload becomes impossible.
 *
 *   node scripts/init-bucket.mjs
 *
 * Note: Cloudflare R2 ignores PutBucketCors via the S3 API on some plans — if
 * this prints a CORS warning, paste the same rule into the R2 dashboard under
 * Settings → CORS policy.
 */
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";

// Load .env without adding a dependency.
try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!process.env[match[1]]) process.env[match[1]] = value;
  }
} catch {
  // No .env file — rely on the real environment (this is the case in Dokploy).
}

const bucket = process.env.S3_BUCKET;
// The bucket must allow the FRONTEND's origin — that is where the upload and
// playback requests originate from, not this API.
const origins = (process.env.CORS_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
const origin = origins[0];

if (!bucket) {
  console.error("S3_BUCKET is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const client = new S3Client({
  region: process.env.S3_REGION || "auto",
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const corsRules = [
  {
    AllowedOrigins: Array.from(new Set([...origins, "http://localhost:3000"])),
    AllowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    MaxAgeSeconds: 3600,
  },
];

async function main() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`[storage] bucket "${bucket}" already exists`);
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[storage] created bucket "${bucket}"`);
  }

  try {
    await client.send(
      new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: corsRules } }),
    );
    console.log(`[storage] CORS applied for origin ${origin}`);
  } catch (error) {
    console.warn(
      `[storage] could not set CORS automatically (${error.name}). Apply this rule in your provider's dashboard:\n` +
        JSON.stringify(corsRules, null, 2),
    );
  }

  console.log("[storage] ready.");
}

main().catch((error) => {
  console.error("[storage] failed:", error.message);
  process.exit(1);
});
