// Export complet de la scolarité dans un seul fichier, pour l'installer sur un autre serveur (o2switch).
// Usage : npm run export   → data/exports/scolarite_AAAA-MM-JJ_HH-MM.json.gz
// Le fichier contient des données personnelles et financières : le garder hors de Git et le supprimer après usage.
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { connect, uploadDir } from "../src/db/index.js";
import { TABLES, columnsOf, measure } from "./lib/tables.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const db = connect(process.env.DATABASE_URL);
try {
  const tables = {};
  for (const table of TABLES) {
    const columns = await columnsOf(db, table);
    const rows = await db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`).all();
    tables[table] = { columns, rows: rows.map((row) => columns.map((name) => row[name])) };
  }
  const migrations = (await db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).map((row) => row.version);
  const files = readUploads(uploadDir());
  const payload = {
    format: "africaiim-scolarite",
    version: 1,
    exportedAt: new Date().toISOString(),
    migrations,
    expected: await measure(db),
    tables,
    files,
  };
  const outDir = path.join(root, "data", "exports");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
  const target = path.join(outDir, `scolarite_${stamp}.json.gz`);
  fs.writeFileSync(target, zlib.gzipSync(JSON.stringify(payload)), { mode: 0o600 });
  console.log(`Export : ${path.relative(root, target)} (${Math.round(fs.statSync(target).size / 1024)} Ko)`);
  for (const table of TABLES) console.log(`${table.padEnd(22)} ${tables[table].rows.length}`);
  console.log(`pièces jointes          ${Object.keys(files).length}`);
  console.log("\nCe fichier contient des données personnelles : ne pas l'envoyer par e-mail ni le mettre sur Git.");
} finally {
  await db.close();
}

function readUploads(folder) {
  const files = {};
  if (!fs.existsSync(folder)) return files;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[path.relative(folder, full).split(path.sep).join("/")] = fs.readFileSync(full).toString("base64");
    }
  };
  walk(folder);
  return files;
}
