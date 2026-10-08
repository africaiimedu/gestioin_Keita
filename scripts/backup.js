// Sauvegarde PostgreSQL au format pg_dump « custom » (restaurable avec pg_restore).
// Usage : npm run backup   → data/backups/africaiim_AAAA-MM-JJ_HH-MM.dump
// - Sur le poste (Docker) : pg_dump est lancé dans le conteneur postgres.
// - Sur l'hébergement (o2switch, tâche cron) : pg_dump du serveur, avec DATABASE_URL.
// BACKUP_MODE=docker|direct force le mode ; BACKUP_KEEP_DAYS (30 par défaut) fixe la conservation.
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const outDir = process.env.BACKUP_DIR || path.join(root, "data", "backups");
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
const target = path.join(outDir, `africaiim_${stamp}.dump`);
const temporary = `${target}.tmp`;

const mode = process.env.BACKUP_MODE || (hasCommand("pg_dump") ? "direct" : "docker");
const result = mode === "direct" ? directDump() : dockerDump();
if (result.status !== 0) {
  fs.rmSync(temporary, { force: true });
  console.error(result.stderr?.toString().trim() || `pg_dump a échoué (mode ${mode}).`);
  process.exit(1);
}
fs.renameSync(temporary, target);
fs.chmodSync(target, 0o600);
console.log(`Sauvegarde : ${path.relative(root, target)} (${Math.round(fs.statSync(target).size / 1024)} Ko, mode ${mode})`);
purgeOld();

function directDump() {
  const url = new URL(process.env.DATABASE_URL || fail("DATABASE_URL manquant"));
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
  };
  const schema = process.env.DB_SCHEMA || "scolarite";
  const cards = process.env.CARD_DB_SCHEMA || "cartes";
  return spawnSync("pg_dump", ["--format=custom", "--no-owner", `--schema=${schema}`, `--schema=${cards}`, `--file=${temporary}`], { env });
}

function dockerDump() {
  const result = spawnSync("docker", [
    "compose", "exec", "-T", "postgres",
    "sh", "-c", 'pg_dump --format=custom -U "$POSTGRES_USER" -d africaiim',
  ], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
  if (result.status === 0) fs.writeFileSync(temporary, result.stdout);
  return result;
}

function purgeOld() {
  const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 30);
  const limit = Date.now() - keepDays * 86_400_000;
  for (const name of fs.readdirSync(outDir)) {
    if (!/^africaiim_.*\.dump$/.test(name)) continue;
    const file = path.join(outDir, name);
    if (fs.statSync(file).mtimeMs < limit) fs.rmSync(file);
  }
}

function hasCommand(command) {
  return spawnSync(command, ["--version"]).status === 0;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
