import { METHOD_LABELS } from "../finance/index.js";
import { HttpError } from "../httpError.js";
import { transaction } from "../db/index.js";
import { audit, createPayment, todayInConakry } from "./domain.js";
import { assignAccountEmail, findSamePerson, personKey } from "./identity.js";

const METHOD_ALIASES = {
  especes: "especes",
  espèces: "especes",
  cheque: "cheque",
  chèque: "cheque",
  virement: "virement",
  vb: "virement",
  mobile: "mobile",
  pm: "mobile",
  "paiement mobile": "mobile",
  "orange money": "orange_money",
  om: "orange_money",
  marchand: "marchand",
  "paiement marchand": "marchand",
  marchant: "marchand",
  "payement marchant": "marchand",
  autre: "autre",
};

function parseAmount(cell) {
  const raw = String(cell ?? "").trim();
  if (!raw) return { amount: 0, blank: true, anomalies: [] };
  const anomalies = [];
  if (raw.includes("€") || raw.toLowerCase().includes("eur")) anomalies.push("Symbole euro : les montants sont en francs guinéens");
  const digits = raw.replace(/[^\d-]/g, "");
  if (!digits || Number.isNaN(Number(digits))) return { amount: null, blank: false, anomalies: [...anomalies, "Montant illisible"] };
  const amount = Number(digits);
  if (!Number.isInteger(amount)) anomalies.push("Le montant n'est pas un entier");
  if (amount < 0) anomalies.push("Montant négatif refusé");
  return { amount, blank: false, anomalies };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ";" || char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (char !== "\r") cell += char;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((line) => line.some((value) => String(value).trim()));
}

export async function previewImport(db, filename, text, userId) {
  const table = parseCsv(text);
  if (table.length < 2) throw new HttpError(400, "Le fichier est vide. Utilisez le modèle téléchargeable.");
  const header = table[0].map((value) => value.trim().toLowerCase());
  const expected = ["matricule", "nom", "prenom", "ecole", "niveau", "inscription", "tranche_1", "tranche_2", "tranche_3", "moyen"];
  for (const column of expected) {
    if (!header.includes(column)) throw new HttpError(400, `Colonne manquante : ${column}`);
  }
  const index = Object.fromEntries(expected.map((column) => [column, header.indexOf(column)]));
  const programs = await db.prepare("SELECT id, code, name FROM programs").all();
  const students = await db.prepare("SELECT matricule, level, last_name, first_name, status FROM students").all();
  const known = new Map(students.map((row) => [row.matricule, row]));
  const people = new Map(students.filter((row) => row.status !== "archive").map((row) => [personKey(row.last_name, row.first_name), row]));
  const seenPeople = new Set();
  const seen = new Map();
  const rows = table.slice(1).map((line, position) => {
    const get = (column) => (line[index[column]] || "").trim();
    const anomalies = [];
    const nom = get("nom");
    const prenom = get("prenom");
    const matricule = get("matricule").toUpperCase();
    const schoolRaw = get("ecole").toUpperCase();
    const level = get("niveau").toLowerCase();
    if (!nom && !prenom && !matricule) anomalies.push("Ligne vide");
    if (!nom || !prenom) anomalies.push("Nom ou prénom manquant");
    const program = programs.find((item) => item.code.toUpperCase() === schoolRaw || item.name.toUpperCase() === schoolRaw);
    if (!program) anomalies.push("Filière inconnue");
    if (!["licence", "master", "tech"].includes(level)) anomalies.push("Niveau inconnu (licence, master ou tech)");
    const parts = ["inscription", "tranche_1", "tranche_2", "tranche_3"].map((column) => {
      const parsed = parseAmount(get(column));
      anomalies.push(...parsed.anomalies);
      return { column, ...parsed };
    });
    const methodRaw = get("moyen").toLowerCase();
    const method = METHOD_ALIASES[methodRaw] || null;
    const paid = parts.reduce((total, part) => total + (part.amount > 0 ? part.amount : 0), 0);
    if (paid > 0 && !method) anomalies.push("Moyen de paiement absent ou non reconnu");
    if (matricule) {
      if (seen.has(matricule)) anomalies.push("Matricule en double dans le fichier");
      seen.set(matricule, position + 2);
      const existing = known.get(matricule);
      if (existing && existing.level !== level) anomalies.push("Le niveau ne correspond pas à la fiche déjà enregistrée");
    }
    const person = nom && prenom ? personKey(nom, prenom) : "";
    if (person) {
      const twin = people.get(person);
      if (twin && twin.matricule !== matricule) anomalies.push(`Personne déjà enregistrée (${twin.matricule}) : les versements seront ajoutés à sa fiche`);
      if (seenPeople.has(person)) anomalies.push("Personne en double dans le fichier");
      seenPeople.add(person);
    }
    return {
      line: position + 2,
      matricule,
      nom,
      prenom,
      school: program?.code || schoolRaw,
      programId: program?.id || null,
      level,
      method,
      parts,
      paid,
      anomalies: [...new Set(anomalies)],
    };
  });
  const result = await db.prepare(`
    INSERT INTO import_batches(filename, status, report_json, created_by) VALUES(?, 'apercu', ?, ?) RETURNING id
  `).run(filename || "import.csv", JSON.stringify({ rows }), userId);
  return { batchId: result.lastInsertRowid, rows };
}

export async function commitImport(db, user, batchId, decisions) {
  const batch = await db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batchId);
  if (!batch || batch.status !== "apercu") throw new HttpError(400, "Cet aperçu d'import n'est plus valable");
  const { rows } = JSON.parse(batch.report_json);
  const year = await db.prepare("SELECT * FROM academic_years WHERE active = 1").get();
  const blocked = rows.filter((row) => row.anomalies.length && decisions?.[row.line] !== "accept" && decisions?.[row.line] !== "skip");
  if (blocked.length) throw new HttpError(400, "Chaque anomalie doit être acceptée ou la ligne ignorée");

  return transaction(db, async () => {
    let created = 0;
    let payments = 0;
    let skipped = 0;
    for (const row of rows) {
      if (decisions?.[row.line] === "skip" || row.anomalies.includes("Ligne vide")) { skipped += 1; continue; }
      if (!row.programId || !row.nom) { skipped += 1; continue; }
      let student = row.matricule ? await db.prepare("SELECT * FROM students WHERE matricule = ?").get(row.matricule) : null;
      if (!student && row.prenom) {
        const twin = await findSamePerson(db, row.nom, row.prenom);
        if (twin) student = await db.prepare("SELECT * FROM students WHERE id = ?").get(twin.id);
      }
      if (!student) {
        const matricule = row.matricule || await nextFreeMatricule(db, year.label);
        const inserted = await db.prepare(`
          INSERT INTO students(matricule, last_name, first_name, program_id, academic_year_id, level, source)
          VALUES(?, ?, ?, ?, ?, ?, 'saisie') RETURNING id
        `).run(matricule, row.nom.toUpperCase(), row.prenom, row.programId, year.id, row.level);
        student = await db.prepare("SELECT * FROM students WHERE id = ?").get(inserted.lastInsertRowid);
        await assignAccountEmail(db, student);
        created += 1;
      }
      const codes = ["inscription", "tranche_1", "tranche_2", "tranche_3"];
      for (let index = 0; index < row.parts.length; index += 1) {
        const part = row.parts[index];
        if (!part.amount || part.amount <= 0) continue;
        await createPayment(db, user, {
          studentId: student.id,
          amount: part.amount,
          paidOn: todayInConakry(),
          method: row.method || "autre",
          installmentCode: codes[index],
          note: `Import CSV, ligne ${row.line}. Date réelle à confirmer.`,
          idempotencyKey: `csv-${batchId}-${row.line}-${codes[index]}`,
          dateUnconfirmed: true,
          acceptCredit: true,
          acceptDuplicateReference: true,
        }, todayInConakry());
        payments += 1;
      }
    }
    await db.prepare("UPDATE import_batches SET status = 'importe', report_json = ? WHERE id = ?").run(JSON.stringify({ rows, created, payments, skipped }), batchId);
    await audit(db, user.id, "import.csv", "import_batches", batchId, null, { created, payments, skipped });
    return { created, payments, skipped };
  });
}

async function nextFreeMatricule(db, label) {
  const year = label.slice(0, 4);
  const rows = await db.prepare("SELECT matricule FROM students WHERE matricule LIKE ?").all(`AIM-${year}-%`);
  let max = 100;
  for (const row of rows) {
    const value = Number(row.matricule.split("-").pop());
    if (value > max) max = value;
  }
  return `AIM-${year}-${String(max + 1).padStart(4, "0")}`;
}

export function csvTemplate() {
  return "\uFEFFmatricule;nom;prenom;ecole;niveau;inscription;tranche_1;tranche_2;tranche_3;moyen\n;BARRY;Aissatou;ABS;licence;1000000;4000000;;;mobile\n";
}

export { METHOD_LABELS };
