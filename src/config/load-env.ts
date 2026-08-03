/**
 * Loads .env for local development.
 *
 * Must be imported FIRST in every entrypoint, before anything that reads
 * `env` — config/env.ts validates at module-evaluation time, and ES modules
 * evaluate in import order.
 *
 * In production this is a no-op: Dokploy injects real environment variables and
 * dotenv never overwrites values that are already set.
 */
import { config } from "dotenv";

config();
