import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from "mongoose";

/**
 * Data model.
 *
 * Only METADATA lives here — video and document bytes are in object storage.
 * A content item document is roughly 400 bytes, so 300 videos plus 500
 * documents is well under 1 MB of database.
 *
 * Modelling choice: modules are EMBEDDED in the course (a handful per course,
 * always read together, never queried on their own), while content items are a
 * SEPARATE collection (there can be hundreds, and they're updated, reordered
 * and deleted individually — embedding them would rewrite the whole course
 * document on every edit and eventually approach the 16 MB document ceiling).
 */

/* ── Admin ───────────────────────────────────────────────────────────────── */

const adminUserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type AdminUserDoc = HydratedDocument<InferSchemaType<typeof adminUserSchema>>;
export const AdminUser = mongoose.model("AdminUser", adminUserSchema);

/* ── Course (with embedded modules) ──────────────────────────────────────── */

const moduleSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    position: { type: Number, default: 0 },
  },
  { _id: true, timestamps: false },
);

const courseSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    subtitle: { type: String, default: null },
    description: { type: String, default: null },

    /**
     * Students type this to unlock the course. Stored in plain text on
     * purpose — the instructor must be able to read it back to share it with
     * the class. It is a share token, not a credential.
     */
    accessCode: { type: String, required: true, unique: true, uppercase: true, index: true },

    accent: { type: String, default: "indigo" },
    published: { type: Boolean, default: false, index: true },
    position: { type: Number, default: 0 },

    modules: { type: [moduleSchema], default: [] },
  },
  { timestamps: true },
);

export type CourseDoc = HydratedDocument<InferSchemaType<typeof courseSchema>>;
export const Course = mongoose.model("Course", courseSchema);

/* ── Content items ───────────────────────────────────────────────────────── */

const contentItemSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true, index: true },
    /** _id of the embedded module subdocument this item belongs to. */
    moduleId: { type: Schema.Types.ObjectId, required: true, index: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, default: null },
    type: { type: String, enum: ["VIDEO", "DOCUMENT"], required: true },

    /** Object key in the bucket, e.g. "courses/<courseId>/<rand>-lecture-01.mp4" */
    storageKey: { type: String, required: true, unique: true },
    fileName: { type: String, required: true },
    mimeType: { type: String, required: true },
    /**
     * Plain Number: JavaScript integers are exact to 2^53 (9 PB), so no BigInt
     * dance is needed for file sizes.
     */
    sizeBytes: { type: Number, required: true },
    durationSec: { type: Number, default: null },

    downloadable: { type: Boolean, default: true },
    position: { type: Number, default: 0 },
    downloadCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

contentItemSchema.index({ moduleId: 1, position: 1 });

export type ContentItemDoc = HydratedDocument<InferSchemaType<typeof contentItemSchema>>;
export const ContentItem = mongoose.model("ContentItem", contentItemSchema);

/* ── Ephemeral collections ───────────────────────────────────────────────── */

/**
 * Rate-limit ledger for access-code and login attempts.
 * The TTL index lets MongoDB expire old rows itself — no cleanup job.
 */
const accessAttemptSchema = new Schema({
  visitor: { type: String, required: true, index: true },
  success: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 },
});

export const AccessAttempt = mongoose.model("AccessAttempt", accessAttemptSchema);

/** Download log, kept for 180 days so the instructor can see what gets used. */
const downloadEventSchema = new Schema({
  itemId: { type: Schema.Types.ObjectId, ref: "ContentItem", required: true, index: true },
  courseId: { type: Schema.Types.ObjectId, ref: "Course", required: true },
  kind: { type: String, default: "download" },
  /** Salted hash of IP + user agent — never a raw client IP. */
  visitor: { type: String, default: null },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 },
});

export const DownloadEvent = mongoose.model("DownloadEvent", downloadEventSchema);
