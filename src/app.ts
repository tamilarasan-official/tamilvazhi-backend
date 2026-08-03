import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { databaseReady } from "./db/connect.js";
import { notFound, errorHandler } from "./middleware/index.js";
import { authRouter } from "./routes/auth.routes.js";
import { accessRouter } from "./routes/access.routes.js";
import { coursesRouter } from "./routes/courses.routes.js";
import { modulesRouter } from "./routes/modules.routes.js";
import { itemsRouter } from "./routes/items.routes.js";
import { uploadsRouter } from "./routes/uploads.routes.js";
import { filesRouter } from "./routes/files.routes.js";

export function createApp() {
  const app = express();

  // Dokploy puts Traefik in front of this container. Without trusting the
  // proxy, req.ip is the proxy's address and every visitor would share one
  // rate-limit bucket.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The API returns JSON and redirects only; CSP here would just interfere
      // with the redirect to object storage.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server calls arrive without an Origin
        // header — the frontend's server components do exactly this.
        if (!origin) return callback(null, true);
        if (env.cors.origins.includes(origin.replace(/\/$/, ""))) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed by CORS_ORIGINS`));
      },
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  // Only metadata is posted here — the file bytes go straight to storage.
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    const ready = databaseReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "degraded",
      database: ready ? "up" : "down",
      uptime: Math.round(process.uptime()),
    });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/access", accessRouter);
  app.use("/api/courses", coursesRouter);
  app.use("/api/modules", modulesRouter);
  app.use("/api/items", itemsRouter);
  app.use("/api/uploads", uploadsRouter);
  app.use("/api/files", filesRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
