// Installe un export (npm run export) dans une base PostgreSQL vide, puis contrôle chaque total.
// Usage : npm run import -- data/exports/scolarite_AAAA-MM-JJ_HH-MM.json.gz
// Tout est fait dans une seule transaction : en cas d'erreur, la base cible reste vide.
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { connect, transaction, uploadDir } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { reconcile } from "../src/services/domain.js";
import { TABLES, columnsOf, fail, insertRows, isEmpty, measure, resetIdentity } from "./lib/tables.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const source = process.argv[2];
if (!source || !fs.existsSync(source)) fail("Indiquez le fichier d'export : npm run import -- chemin/scolarite_….json.gz");
const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(source)).toString("utf8"));
if (payload.format !== "africaiim-scolarite" || payload.version !== 1) fail("Ce fichier n'est pas un export AfricaIIM Scolarité.");

const db = connect(process.env.DATABASE_URL);
try {
  await runMigrations(db);
  if (!(await isEmpty(db))) fail("La base cible contient déjà des données : import annulé, rien n'a été modifié.");

  await transaction(db, async () => {
    for (const table of TABLES) {
      const data = payload.tables[table];
      if (!data?.rows.length) continue;
      const target = new Set(await columnsOf(db, table));
      const missing = data.columns.filter((name) => !target.has(name));
      if (missing.length) throw new Error(`${table} : colonnes inconnues dans la base cible (${missing.join(", ")})`);
      await insertRows(db, table, data.columns, data.rows);
      console.log(`${table.padEnd(22)} ${data.rows.length}`);
    }
    for (const table of TABLES) await resetIdentity(db, table);
    const found = await measure(db);
    const gaps = compare(payload.expected, found);
    if (gaps.length) throw new Error(`Écarts après import :\n${gaps.join("\n")}`);
  });

  const folder = uploadDir();
  for (const [relative, content] of Object.entries(payload.files || {})) {
    const target = path.resolve(folder, relative);
    if (!target.startsWith(path.resolve(folder) + path.sep)) fail(`Chemin de pièce jointe refusé : ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(content, "base64"), { mode: 0o600 });
  }

  const report = await reconcile(db);
  console.log(`\nPièces jointes : ${Object.keys(payload.files || {}).length}`);
  console.log(`Totaux identiques à l'export · cohérence ${report.ok ? "OK" : "ÉCART"} · ${report.students} étudiants · encaissé ${report.paid} GNF · reste ${report.reste} GNF`);
  if (!report.ok) fail("La cohérence recalculée présente un écart : vérifiez avant d'ouvrir l'application.");
  console.log("\nImport terminé.");
} catch (error) {
  fail(`Import annulé : ${error.message}`);
} finally {
  await db.close();
}

function compare(expected, found) {
  const gaps = [];
  for (const [table, count] of Object.entries(expected.counts)) {
    const ok = table === "settings" ? found.counts[table] >= count : found.counts[table] === count;
    if (!ok) gaps.push(`${table} : ${count} attendues, ${found.counts[table]} trouvées`);
  }
  for (const [name, value] of Object.entries(expected.controls)) {
    if (String(found.controls[name]) !== String(value)) gaps.push(`Contrôle « ${name} » différent`);
  }
  return gaps;
}
