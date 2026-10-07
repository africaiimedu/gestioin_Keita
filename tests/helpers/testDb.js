import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const index = line.indexOf("=");
    if (index < 1 || line.trim().startsWith("#")) continue;
    const key = line.slice(0, index).trim();
    if (!process.env[key]) process.env[key] = line.slice(index + 1).trim();
  }
}

/** Base PostgreSQL de test, vidée puis recréée. Refuse toute base dont le nom ne finit pas par _test. */
export async function freshTestDb() {
  loadEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL manquant : voir .env.example");
  if (!new URL(url).pathname.endsWith("_test")) throw new Error("TEST_DATABASE_URL doit viser une base dont le nom finit par _test");
  process.env.UPLOAD_DIR = path.join(mkdtempSync(path.join(tmpdir(), "aim-")), "uploads");
  const db = connect(url);
  await db.exec("DROP SCHEMA IF EXISTS scolarite CASCADE; CREATE SCHEMA scolarite;");
  await runMigrations(db);
  return db;
}
