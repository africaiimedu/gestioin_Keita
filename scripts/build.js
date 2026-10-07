// Préparation avant (re)démarrage : l'interface n'a rien à compiler, on vérifie donc ce qui peut casser
// une mise en ligne, puis on met la base à jour.
// Usage : npm run build
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
const problems = [];

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 6)) problems.push(`Node ${process.versions.node} : il faut Node 20.6 ou plus récent`);
step(`Node ${process.versions.node}`);

if (!process.env.DATABASE_URL) problems.push("DATABASE_URL manquant dans .env");
if (process.env.NODE_ENV === "production") {
  if (process.env.DEMO_MODE === "true") problems.push("DEMO_MODE doit valoir false en production");
  if (!String(process.env.PUBLIC_BASE_URL || "").startsWith("https://")) problems.push("PUBLIC_BASE_URL doit commencer par https:// en production");
}
step(`Configuration ${process.env.NODE_ENV || "development"}`);

const files = ["app.cjs", ...listJs("src"), ...listJs("public"), ...listJs("scripts")];
for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", path.join(root, file)], { encoding: "utf8" });
  if (check.status !== 0) problems.push(`${file} : ${check.stderr.trim().split("\n").slice(0, 4).join(" ")}`);
}
step(`Syntaxe de ${files.length} fichiers JavaScript`);

if (problems.length) stop();

const migrate = spawnSync(process.execPath, [path.join(root, "scripts", "migrate.js")], { encoding: "utf8", cwd: root });
process.stdout.write(migrate.stdout);
if (migrate.status !== 0) {
  problems.push(`Migrations : ${migrate.stderr.trim().split("\n").slice(-3).join(" ")}`);
  stop();
}
console.log("\nBuild terminé. Redémarrer l'application pour l'appliquer (o2switch : touch tmp/restart.txt).");

function listJs(folder) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(c|m)?js$/.test(entry.name)) out.push(relative);
    }
  };
  if (fs.existsSync(path.join(root, folder))) walk(folder);
  return out;
}

function step(label) {
  console.log(`${problems.length ? "…" : "OK"}  ${label}`);
}

function stop() {
  console.error("\nBuild arrêté :");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
