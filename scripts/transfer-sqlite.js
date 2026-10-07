// Transfert unique des données de l'ancienne base SQLite vers PostgreSQL, avec contrôle des totaux.
// Usage : npm run transfert -- [chemin/vers/scolarite.sqlite]
// Le fichier SQLite n'est jamais modifié. La base PostgreSQL cible doit être vide.
import fs from "node:fs";
import dotenv from "dotenv";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { connect, transaction } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrate.js";
import { reconcile } from "../src/services/domain.js";
import { TABLES, fail, isEmpty, resetIdentity } from "./lib/tables.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const source = path.resolve(process.argv[2] || path.join(root, "data", "scolarite.sqlite"));
if (!fs.existsSync(source)) fail(`Fichier SQLite introuvable : ${source}`);
const sqlite = new DatabaseSync(source, { readOnly: true });
const pg = connect(process.env.DATABASE_URL);

try {
  await runMigrations(pg);
  if (!(await isEmpty(pg))) fail("La base PostgreSQL contient déjà des données : transfert annulé, rien n'a été modifié.");

  const copied = {};
  await transaction(pg, async () => {
    for (const table of TABLES) copied[table] = await copyTable(table);
    for (const table of TABLES) await resetIdentity(pg, table);
  });

  const checks = await verify(copied);
  const report = await reconcile(pg);
  console.log("");
  for (const check of checks) console.log(`${check.ok ? "OK    " : "ÉCART "} ${check.label}`);
  console.log(`\nCohérence recalculée : ${report.ok ? "OK" : "ÉCART"} · ${report.students} étudiants · encaissé ${report.paid} GNF · reste ${report.reste} GNF`);
  if (!report.ok || checks.some((check) => !check.ok)) fail("Des écarts ont été trouvés : vérifiez avant d'utiliser la nouvelle base.");
  console.log("\nTransfert terminé. Le fichier SQLite d'origine est intact.");
} finally {
  sqlite.close();
  await pg.close();
}

async function copyTable(table) {
  if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return 0;
  const target = new Set((await pg.prepare(`
    SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?
  `).all(table)).map((row) => row.column_name));
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name).filter((name) => target.has(name));
  const rows = sqlite.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  const conflict = table === "settings" ? " ON CONFLICT (key) DO UPDATE SET value = excluded.value" : "";
  const sql = `INSERT INTO ${table}(${columns.join(", ")}) VALUES(${columns.map(() => "?").join(", ")})${conflict}`;
  for (const row of rows) {
    const values = columns.map((name) => convert(table, name, row[name]));
    await pg.prepare(sql).run(...values);
  }
  console.log(`${table.padEnd(22)} ${rows.length}`);
  return rows.length;
}

function convert(table, column, value) {
  if (value == null) return null;
  if (table === "users" && column === "email") return String(value).trim().toLowerCase();
  if (table === "payment_attachments" && column === "stored_path") {
    const marker = `${path.sep}uploads${path.sep}`;
    const index = String(value).lastIndexOf(marker);
    return index >= 0 ? String(value).slice(index + marker.length) : value;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

async function verify(copied) {
  const checks = [];
  for (const table of TABLES) {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    const before = Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const after = (await pg.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
    const expected = table === "settings" ? after >= before : before === after && copied[table] === before;
    checks.push({ ok: expected, label: `${table} : ${before} → ${after} lignes` });
  }
  const sums = [
    ["Paiements validés", "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'valide'"],
    ["Paiements annulés", "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'annule'"],
    ["Costumes validés", "SELECT COALESCE(SUM(amount), 0) AS total FROM costume_payments WHERE status = 'valide'"],
  ];
  for (const [label, sql] of sums) {
    const hasTable = !sql.includes("costume_payments") || sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'costume_payments'").get();
    const before = hasTable ? Number(sqlite.prepare(sql).get().total) : 0;
    const after = (await pg.prepare(sql).get()).total;
    checks.push({ ok: before === after, label: `${label} : ${before} → ${after} GNF` });
  }
  const perStudent = "SELECT student_id, SUM(amount) AS total FROM payments WHERE status = 'valide' GROUP BY student_id ORDER BY student_id";
  const a = JSON.stringify(sqlite.prepare(perStudent).all().map((row) => [Number(row.student_id), Number(row.total)]));
  const b = JSON.stringify((await pg.prepare(perStudent).all()).map((row) => [row.student_id, row.total]));
  checks.push({ ok: a === b, label: "Total payé de chaque étudiant identique" });
  const numbers = "SELECT number FROM receipts ORDER BY number";
  const ra = JSON.stringify(sqlite.prepare(numbers).all().map((row) => row.number));
  const rb = JSON.stringify((await pg.prepare(numbers).all()).map((row) => row.number));
  checks.push({ ok: ra === rb, label: "Numéros de reçus identiques" });
  return checks;
}

