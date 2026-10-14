// Corrige le prénom d'un étudiant dans la Scolarité, puis dans sa fiche carte.
// Usage : node scripts/corriger-prenom.js NOM "Prénom actuel" "Nouveau prénom" [--appliquer]
// Sans --appliquer, rien n'est modifié : le script montre ce qu'il ferait.
import dotenv from "dotenv";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, transaction } from "../src/db/index.js";
import { ficheCarte } from "../src/services/cardSync.js";
import { audit } from "../src/services/domain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const [lastName, oldFirst, newFirst] = process.argv.slice(2).filter((arg) => !arg.startsWith("--")).map((arg) => arg.trim());
const apply = process.argv.includes("--appliquer");
if (!lastName || !oldFirst || !newFirst || oldFirst === newFirst) {
  console.error('Usage : node scripts/corriger-prenom.js NOM "Prénom actuel" "Nouveau prénom" [--appliquer]');
  process.exit(1);
}

function pushToCards(payload) {
  const dir = path.join(root, "tmp", "cartes");
  const socket = fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.endsWith(".sock")) : null;
  const envFile = path.join(root, "Afrcaiim Card", ".env");
  const token = fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, "utf8").match(/^INSCRIPTION_JETON=(.+)$/m)?.[1] || "").trim()
    : "";
  if (!socket || !token) return Promise.resolve("application Cartes non jointe : corrigez le prénom dans Cartes");
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const request = http.request({
      socketPath: path.join(dir, socket),
      method: "POST",
      path: "/api/inscriptions",
      headers: { host: "localhost", "x-jeton": token, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode === 200 ? "fiche carte mise à jour" : `Cartes a répondu ${response.statusCode}`));
    });
    request.on("error", () => resolve("application Cartes non jointe : corrigez le prénom dans Cartes"));
    request.end(body);
  });
}

const db = connect(process.env.DATABASE_URL);
try {
  const rows = await db.prepare(`
    SELECT s.*, p.name AS program_name FROM students s JOIN programs p ON p.id = s.program_id
    WHERE lower(trim(s.last_name)) = lower(?) AND lower(trim(s.first_name)) = lower(?)
  `).all(lastName, oldFirst);
  if (rows.length !== 1) throw new Error(`${rows.length} fiche(s) trouvée(s) pour ${lastName} ${oldFirst} : il en faut exactement une.`);
  const student = rows[0];
  const fiche = ficheCarte({ ...student, first_name: newFirst });
  if (!fiche.ok) throw new Error(fiche.error);
  console.log(`Fiche ${student.matricule} : ${student.last_name} ${student.first_name} → ${student.last_name} ${newFirst}`);
  if (!apply) {
    console.log("Aperçu seulement. Ajoutez --appliquer pour corriger.");
  } else {
    await transaction(db, async () => {
      await db.prepare("UPDATE students SET first_name = ? WHERE id = ?").run(newFirst, student.id);
      await audit(db, null, "etudiant.prenom_corrige", "students", student.id, { first_name: student.first_name }, { first_name: newFirst });
    });
    console.log("Scolarité : prénom corrigé.");
    console.log(`Cartes : ${await pushToCards(fiche.payload)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
