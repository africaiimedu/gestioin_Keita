// Applique les migrations en attente sans démarrer le serveur (mise en ligne, mise à jour).
// Usage : npm run migrate
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const db = connect(process.env.DATABASE_URL);
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Migrations appliquées : ${applied.join(", ")}` : "Base déjà à jour.");
  const done = await db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
  for (const row of done) console.log(`  ${row.version}`);
} finally {
  await db.close();
}
