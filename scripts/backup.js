// Sauvegarde immédiate de PostgreSQL (en plus de la sauvegarde automatique quotidienne).
// Usage : npm run backup   → data/backups/africaiim_manuel_AAAA-MM-JJ_HH-MM.dump
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "data", "backups");
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
const name = `africaiim_manuel_${stamp}.dump`;
const result = spawnSync("docker", [
  "compose", "exec", "-T", "postgres",
  "sh", "-c", 'pg_dump --format=custom -U "$POSTGRES_USER" -d africaiim',
], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });

if (result.status !== 0) {
  console.error(result.stderr?.toString() || "pg_dump a échoué. PostgreSQL est-il démarré (docker compose up -d) ?");
  process.exit(1);
}
fs.writeFileSync(path.join(outDir, name), result.stdout);
console.log(`Sauvegarde : data/backups/${name} (${Math.round(result.stdout.length / 1024)} Ko)`);
