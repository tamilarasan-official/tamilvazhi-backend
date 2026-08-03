import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { AdminUser } from "../models/index.js";
import { createAdminToken, setAdminCookie, clearAdminCookie, readAdminSession } from "../lib/auth.js";
import { asyncHandler, rateLimit, requireAdmin } from "../middleware/index.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

/** A bcrypt hash of nothing in particular — see the timing note below. */
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.qMQaiJnHZWZH9YPTNq/i0i.HHqMNRhO";

authRouter.post(
  "/login",
  rateLimit({
    scope: "login",
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: "Too many failed attempts. Please try again in 15 minutes.",
  }),
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid email and password." });
      return;
    }

    const email = parsed.data.email.toLowerCase().trim();
    const user = await AdminUser.findOne({ email });

    // Always run a bcrypt comparison, even when the account doesn't exist, so
    // response time doesn't reveal which email addresses are registered.
    const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);

    if (!user || !ok) {
      await res.locals.recordAttempt?.(false);
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    await res.locals.recordAttempt?.(true);
    user.lastLoginAt = new Date();
    await user.save();

    const token = await createAdminToken({
      id: String(user._id),
      email: user.email,
      name: user.name,
    });
    setAdminCookie(res, token);

    res.json({ ok: true, admin: { email: user.email, name: user.name } });
  }),
);

authRouter.post("/logout", (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

/** The frontend calls this from server components to decide what to render. */
authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const admin = await readAdminSession(req);
    if (!admin) {
      res.status(401).json({ error: "Not signed in." });
      return;
    }
    res.json({ admin });
  }),
);

/** Lets the instructor change their own password without a redeploy. */
authRouter.post(
  "/password",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(10, "Use at least 10 characters.").max(200),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request." });
      return;
    }

    const user = await AdminUser.findById(req.admin!.id);
    if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      res.status(401).json({ error: "Current password is incorrect." });
      return;
    }

    user.passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
    await user.save();

    res.json({
      ok: true,
      note: "Update ADMIN_PASSWORD in your deployment environment too — the seed re-applies it on restart.",
    });
  }),
);
