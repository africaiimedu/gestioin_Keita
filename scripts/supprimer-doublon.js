// Retire une fiche saisie en double (même personne) quand ses versements figurent déjà sur la fiche gardée.
// Usage :
//   node scripts/supprimer-doublon.js MATRICULE_A_RETIRER MATRICULE_GARDE [--appliquer]
//   node scripts/supprimer-doublon.js UA26ABS0128 [--appliquer]
// Sans --appliquer, rien n'est modifié : le script montre ce qu'il ferait.
// Refus si la fiche à retirer a un reçu, une annulation, un costume ou un reçu d'inscription.
import dotenv from "dotenv";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, transaction } from "../src/db/index.js";
import { audit, reconcile, studentSituation } from "../src/services/domain.js";
import { personKey } from "../src/services/identity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const apply = process.argv.includes("--appliquer");
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
let [removedMatricule, keptMatricule] = args;
if (!removedMatricule) {
  console.error("Usage : node scripts/supprimer-doublon.js MATRICULE_A_RETIRER [MATRICULE_GARDE] [--appliquer]");
  process.exit(1);
}

function removeFromCards(matricule) {
  const dir = path.join(root, "tmp", "cartes");
  const socket = fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.endsWith(".sock")) : null;
  const envFile = path.join(root, "Afrcaiim Card", ".env");
  const token = fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, "utf8").match(/^INSCRIPTION_JETON=(.+)$/m)?.[1] || "").trim()
    : "";
  if (!socket || !token) return Promise.resolve("application Cartes non jointe : retirez la fiche dans Cartes");
  return new Promise((resolve) => {
    const request = http.request({
      socketPath: path.join(dir, socket),
      method: "DELETE",
      path: `/api/inscriptions/${encodeURIComponent(matricule)}`,
      headers: { host: "localhost", "x-jeton": token },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode === 200 ? "fiche retirée des cartes" : `Cartes a répondu ${response.statusCode}`));
    });
    request.on("error", () => resolve("application Cartes non jointe : retirez la fiche dans Cartes"));
    request.end();
  });
}

async function blockersOf(db, studentId) {
  return db.prepare(`
    SELECT (SELECT count(*)::int FROM receipts r JOIN payments p ON p.id = r.payment_id WHERE p.student_id = ?) AS receipts,
           (SELECT count(*)::int FROM cancellations c JOIN payments p ON p.id = c.payment_id WHERE p.student_id = ?) AS cancellations,
           (SELECT count(*)::int FROM costume_payments WHERE student_id = ?) AS costume,
           (SELECT count(*)::int FROM enrollment_receipts WHERE student_id = ?) AS enrollment,
           (SELECT count(*)::int FROM payments WHERE student_id = ?) AS payments
  `).get(studentId, studentId, studentId, studentId, studentId);
}

function hasDocuments(row) {
  return Boolean(row.receipts || row.cancellations || row.costume || row.enrollment);
}

const db = connect(process.env.DATABASE_URL);
try {
  const wanted = await db.prepare("SELECT * FROM students WHERE replace(upper(matricule), ' ', '') = ?").get(String(removedMatricule).replace(/\s+/g, "").toUpperCase());
  if (!wanted) throw new Error(`Matricule introuvable : ${removedMatricule}.`);
  let kept = keptMatricule
    ? await db.prepare("SELECT * FROM students WHERE replace(upper(matricule), ' ', '') = ?").get(String(keptMatricule).replace(/\s+/g, "").toUpperCase())
    : null;
  if (keptMatricule && !kept) throw new Error(`Matricule introuvable : ${keptMatricule}.`);
  if (!kept) {
    const key = personKey(wanted.last_name, wanted.first_name);
    const twins = (await db.prepare("SELECT * FROM students WHERE status <> 'archive' AND id <> ?").all(wanted.id))
      .filter((row) => personKey(row.last_name, row.first_name) === key);
    console.log("Homonymes actifs :");
    for (const row of [wanted, ...twins]) {
      const sit = await studentSituation(db, row.id);
      console.log(`  ${row.matricule} · ${row.last_name} ${row.first_name} · ${row.level} · statut ${row.status} · dû ${sit.situation.due} · payé ${sit.situation.paid} · reste ${sit.situation.reste}`);
    }
    if (twins.length !== 1) {
      throw new Error(twins.length ? "Plusieurs homonymes : indiquez le matricule à garder." : "Aucun homonyme actif : rien à retirer.");
    }
    kept = twins[0];
    keptMatricule = kept.matricule;
  }
  if (personKey(wanted.last_name, wanted.first_name) !== personKey(kept.last_name, kept.first_name)) {
    throw new Error("Les deux fiches ne portent pas le même nom : ce n'est pas un doublon.");
  }
  const wantedBlock = await blockersOf(db, wanted.id);
  const keptBlock = await blockersOf(db, kept.id);
  let removed = wanted;
  if (hasDocuments(wantedBlock) && !hasDocuments(keptBlock) && keptBlock.payments === 0) {
    console.log(`${wanted.matricule} a des documents. On retire plutôt le doublon vide ${kept.matricule}.`);
    removed = kept;
    kept = wanted;
    keptMatricule = kept.matricule;
    removedMatricule = removed.matricule;
  }
  const blockers = await blockersOf(db, removed.id);
  if (hasDocuments(blockers)) {
    throw new Error(`Refusé : ${removed.matricule} a déjà des documents (${JSON.stringify(blockers)}). Utilisez les annulations.`);
  }
  const before = { removed: await studentSituation(db, removed.id), kept: await studentSituation(db, kept.id) };
  const payments = await db.prepare("SELECT id, amount, paid_on, method, note FROM payments WHERE student_id = ? ORDER BY id").all(removed.id);
  console.log(`À retirer : ${removed.matricule} ${removed.last_name} ${removed.first_name} · payé ${before.removed.situation.paid} GNF`);
  for (const payment of payments) console.log(`  paiement ${payment.id} : ${payment.amount} GNF du ${payment.paid_on} (${payment.method})`);
  console.log(`Gardée : ${kept.matricule} · dû ${before.kept.situation.due} · payé ${before.kept.situation.paid} · reste ${before.kept.situation.reste} GNF`);
  if (!apply) {
    console.log("Aperçu seulement. Ajoutez --appliquer pour retirer la fiche.");
  } else {
    const control = await transaction(db, async () => {
      const ids = payments.map((payment) => payment.id);
      await audit(db, null, "etudiant.doublon_retire", "students", removed.id, {
        matricule: removed.matricule, last_name: removed.last_name, first_name: removed.first_name, level: removed.level, payments,
      }, { keptMatricule: kept.matricule, reason: "Même personne saisie deux fois ; versements déjà portés sur la fiche gardée" });
      if (ids.length) {
        await db.prepare("DELETE FROM payment_attachments WHERE payment_id = ANY(?)").run(ids);
        await db.prepare("DELETE FROM payment_controls WHERE payment_id = ANY(?)").run(ids);
        await db.exec("ALTER TABLE payments DISABLE TRIGGER payments_no_delete");
        await db.prepare("DELETE FROM payments WHERE id = ANY(?)").run(ids);
        await db.exec("ALTER TABLE payments ENABLE TRIGGER payments_no_delete");
      }
      for (const table of ["discounts", "adjustments", "student_installments", "reminders"]) {
        await db.prepare(`DELETE FROM ${table} WHERE student_id = ?`).run(removed.id);
      }
      await db.prepare("DELETE FROM students WHERE id = ?").run(removed.id);
      return reconcile(db);
    });
    const after = await studentSituation(db, kept.id);
    console.log(`Fiche ${removed.matricule} retirée. ${kept.matricule} : dû ${after.situation.due} · payé ${after.situation.paid} · reste ${after.situation.reste} GNF.`);
    console.log(`Contrôle général : ${control.students} étudiants · encaissé ${control.paid} · reste ${control.reste} · cohérence ${control.ok ? "OK" : "ÉCART"}`);
    if (!control.ok) console.log(JSON.stringify(control.gaps, null, 2));
    console.log(`Cartes : ${await removeFromCards(removed.matricule)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
