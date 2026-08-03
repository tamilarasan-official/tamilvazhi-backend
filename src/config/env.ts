/**
 * Environment configuration, validated once at boot.
 *
 * The server refuses to start on a missing required value rather than failing
 * later inside a request — a misconfigured deploy should be obvious in the
 * Dokploy logs within a second, not on the instructor's first upload.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. Set it in the Dokploy "Environment" tab (or .env locally).`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

function num(name: string, fallback: number): number {
  const parsed = Number(optional(name, String(fallback)));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const authSecret = required("AUTH_SECRET");
if (authSecret.length < 32) {
  throw new Error(
    'AUTH_SECRET must be at least 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
  );
}

/** Origins allowed to call this API with credentials. */
const corsOrigins = optional("CORS_ORIGINS", "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

const sameSiteRaw = optional("COOKIE_SAMESITE", "lax").toLowerCase();
const sameSite: "lax" | "none" | "strict" =
  sameSiteRaw === "none" ? "none" : sameSiteRaw === "strict" ? "strict" : "lax";

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProd: process.env.NODE_ENV === "production",
  port: num("PORT", 4000),

  mongoUri: required("MONGODB_URI"),

  authSecret,

  admin: {
    email: optional("ADMIN_EMAIL", "instructor@example.com").toLowerCase(),
    password: optional("ADMIN_PASSWORD", "ChangeThisPassword123!"),
    name: optional("ADMIN_NAME", "Course Instructor"),
  },

  cors: { origins: corsOrigins },

  cookie: {
    /**
     * Set to the parent domain (".yoursite.com") so a cookie issued by
     * api.yoursite.com is sent by portal.yoursite.com. Leave blank for
     * localhost — browsers reject Domain attributes on bare hostnames.
     */
    domain: optional("COOKIE_DOMAIN") || undefined,
    sameSite,
    /** SameSite=None is only honoured on secure cookies. */
    secure: optional("COOKIE_SECURE", process.env.NODE_ENV === "production" ? "true" : "false") === "true" || sameSite === "none",
  },

  s3: {
    endpoint: required("S3_ENDPOINT"),
    region: optional("S3_REGION", "auto"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: optional("S3_FORCE_PATH_STYLE", "false") === "true",
  },

  signedUrlTtl: num("SIGNED_URL_TTL", 21600),

  /** Where to send a student who hits a gated file link directly. */
  frontendUrl: optional("FRONTEND_URL", corsOrigins[0] ?? "http://localhost:3000"),
};
