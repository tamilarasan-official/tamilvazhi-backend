import "./config/load-env.js";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase, disconnectDatabase } from "./db/connect.js";
import { ensureAdminUser } from "./scripts/seed.js";

async function main() {
  await connectDatabase();

  // Idempotent, and runs on every boot so a password change in the Dokploy
  // environment takes effect on redeploy without a manual step.
  await ensureAdminUser();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[api] listening on :${env.port} (${env.nodeEnv})`);
    console.log(`[api] allowed origins: ${env.cors.origins.join(", ") || "(none)"}`);
  });

  // Dokploy sends SIGTERM on redeploy; finish in-flight requests before exiting
  // so an instructor mid-upload doesn't get a failed part.
  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("[api] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
