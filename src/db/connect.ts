import mongoose from "mongoose";
import { env } from "../config/env.js";

/**
 * Connects to MongoDB and keeps the process honest about the connection state.
 *
 * Mongoose buffers commands while disconnected, which turns a dead database
 * into slow, silently-hanging requests. bufferCommands:false makes them fail
 * fast so the health check goes red and Dokploy can restart the container.
 */
export async function connectDatabase(): Promise<void> {
  mongoose.set("strictQuery", true);
  mongoose.set("bufferCommands", false);

  mongoose.connection.on("connected", () => console.log("[db] connected"));
  mongoose.connection.on("disconnected", () => console.warn("[db] disconnected"));
  mongoose.connection.on("error", (err) => console.error("[db] error:", err.message));

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    maxPoolSize: 20,
  });

  // Index creation is async; awaiting it here means the first request can rely
  // on the unique constraints (slug, accessCode) actually being enforced.
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init()));
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}

export function databaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}
