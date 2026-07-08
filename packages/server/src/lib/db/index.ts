/**
 * SQLite database layer (bun:sqlite).
 *
 * STATUS: scaffold. Schema + CRUD lands in M3.
 *
 * WAL gotchas (verified — see AGENTS.md / plan):
 *   - WAL mode creates two sidecar files: `<db>-wal` and `<db>-shm`.
 *   - In Docker, mount the DIRECTORY (./data), not the single .db file —
 *     otherwise the sidecar files land outside the volume and you lose
 *     durability on restart.
 *   - For a single Bun process this is safe. If you ever scale to multiple
 *     processes sharing one .db, keep WAL + set busy_timeout.
 */
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";

let dbInstance: Database | null = null;

/**
 * Open (or return) the singleton SQLite database.
 *
 * Applies safe defaults:
 *   - `journal_mode = WAL`   — durability without blocking readers
 *   - `synchronous = NORMAL` — safe under WAL, much faster than FULL
 *   - `busy_timeout = 5000`  — wait 5s on lock contention before SQLITE_BUSY
 */
export function getDb(dataDir: string = "./data"): Database {
  if (dbInstance) return dbInstance;

  // Ensure the data directory exists (recursive).
  mkdirSync(dataDir, { recursive: true });

  const dbPath = `${dataDir}/notify-bus.db`;
  const db = new Database(dbPath, { create: true });

  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA busy_timeout = 5000;");
  // Foreign keys ON — routes reference channels.
  db.run("PRAGMA foreign_keys = ON;");

  dbInstance = db;
  return db;
}

/** Close the DB (mainly for tests / graceful shutdown). */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
