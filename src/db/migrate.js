import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./index.js";

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Applique, dans l'ordre et une seule fois, les fichiers NNN_nom.sql du dossier migrations. */
export async function runMigrations(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = fs.readdirSync(folder).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  const applied = [];
  await transaction(db, async () => {
    const done = new Set((await db.prepare("SELECT version FROM schema_migrations").all()).map((row) => row.version));
    for (const file of files) {
      if (done.has(file)) continue;
      await db.exec(fs.readFileSync(path.join(folder, file), "utf8"));
      await db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(file);
      applied.push(file);
    }
  });
  return applied;
}
