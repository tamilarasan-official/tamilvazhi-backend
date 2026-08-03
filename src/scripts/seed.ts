import "../config/load-env.js";
import bcrypt from "bcryptjs";
import { AdminUser, Course } from "../models/index.js";
import { env } from "../config/env.js";

/**
 * Creates or updates the instructor account from the environment.
 *
 * Runs on every boot, so ADMIN_PASSWORD in the Dokploy environment is the
 * single source of truth: change it there, redeploy, and the login changes.
 */
export async function ensureAdminUser(): Promise<void> {
  const { email, password, name } = env.admin;
  const passwordHash = await bcrypt.hash(password, 12);

  await AdminUser.findOneAndUpdate(
    { email },
    { $set: { passwordHash, name }, $setOnInsert: { email } },
    { upsert: true, new: true },
  );

  console.log(`[seed] admin ready: ${email}`);

  if (env.admin.password === "ChangeThisPassword123!") {
    console.warn("[seed] WARNING: ADMIN_PASSWORD is still the default. Change it before going live.");
  }
}

/** Adds a starter course the first time the database is empty. */
export async function seedSampleCourse(): Promise<void> {
  if ((await Course.countDocuments()) > 0) return;

  const course = await Course.create({
    title: "Getting Started",
    slug: "getting-started",
    subtitle: "Your first course on Portal24",
    description:
      "Delete this once you have uploaded your own material. It exists so you can see how modules, videos and documents appear to students.",
    accessCode: "START24",
    published: true,
    position: 0,
    modules: [
      { title: "Introduction", position: 0 },
      { title: "Course Materials", position: 1 },
    ],
  });

  console.log(`[seed] sample course created — access code: ${course.accessCode}`);
}

/** `npm run seed` — connects, seeds, exits. Used locally and for one-off runs. */
async function runStandalone() {
  const { connectDatabase, disconnectDatabase } = await import("../db/connect.js");
  await connectDatabase();
  await ensureAdminUser();
  await seedSampleCourse();
  await disconnectDatabase();
  console.log("[seed] done.");
}

// Only self-execute when invoked directly, not when imported by the server.
const invokedDirectly =
  process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"));

if (invokedDirectly) {
  runStandalone().catch((error) => {
    console.error("[seed] failed:", error);
    process.exit(1);
  });
}
