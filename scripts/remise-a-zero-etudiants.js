// Efface tous les étudiants avant le début des inscriptions : fiches, paiements, reçus, fiches d'inscription,
// costumes, relances, pièces jointes, puis côté Cartes les fiches, comptes étudiants, cartes, commandes et reçus cantine.
// Garde les comptes du personnel, les filières, les barèmes, les réglages, le menu et le journal d'audit.
// La numérotation (matricules, reçus, fiches d'inscription) repart de 1.
// Usage : node scripts/remise-a-zero-etudiants.js [--appliquer]
// Sans --appliquer, rien n'est modifié : le script montre ce qu'il effacerait. Faire « npm run backup » avant.
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, transaction, uploadDir } from "../src/db/index.js";
import { audit } from "../src/services/domain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
const apply = process.argv.includes("--appliquer");

const TABLES = [
  "cancellations",
  "payment_attachments",
  "payment_controls",
  "receipts",
  "costume_payments",
  "payments",
  "enrollment_receipts",
  "reminders",
  "discounts",
  "adjustments",
  "student_installments",
  "students",
  "import_batches",
];
const GUARDED = ["payments", "costume_payments", "receipts", "enrollment_receipts", "cancellations"];

async function counts(db) {
  const result = {};
  for (const table of [...TABLES, "document_sequences"]) {
    result[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  }
  return result;
}

function clearUploads() {
  const dir = uploadDir();
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d+$/.test(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function runCards() {
  const dir = path.resolve(process.env.CARD_APP_DIR || path.join(root, "Afrcaiim Card"));
  const python = path.join(dir, ".venv", "bin", "python");
  if (!fs.existsSync(python) || !fs.existsSync(path.join(dir, ".env"))) {
    console.log("Cartes : application absente ici, rien à effacer de ce côté.");
    return 0;
  }
  const args = ["remise_a_zero_etudiants.py", ...(apply ? ["--appliquer"] : [])];
  const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || dir, LANG: "C.UTF-8", TZ: process.env.TZ || "Africa/Conakry" };
  return spawnSync(python, args, { cwd: dir, env, stdio: "inherit" }).status ?? 1;
}

const db = connect(process.env.DATABASE_URL);
try {
  const before = await counts(db);
  console.log("Scolarité :", Object.entries(before).map(([table, n]) => `${table} ${n}`).join(" · "));
  if (!apply) {
    console.log("Aperçu seulement. Ajoutez --appliquer pour tout effacer.");
  } else {
    await transaction(db, async () => {
      for (const table of GUARDED) await db.exec(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      await db.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY`);
      for (const table of GUARDED) await db.exec(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      await db.exec("DELETE FROM document_sequences");
      await audit(db, null, "etudiants.remise_a_zero", "students", null, before, { reason: "Début des inscriptions" });
    });
    const after = await counts(db);
    const left = Object.entries(after).filter(([, n]) => n > 0);
    console.log(`Scolarité effacée${left.length ? ` (reste : ${left.map(([t, n]) => `${t} ${n}`).join(", ")})` : ""}.`);
    console.log(`Pièces jointes : ${clearUploads()} dossier(s) retiré(s).`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
if (!process.exitCode) process.exitCode = runCards();
