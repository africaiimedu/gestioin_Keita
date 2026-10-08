import { HttpError } from "../httpError.js";

export const ACCOUNT_DOMAIN = "univ-africaiim.com";
const VALID_NAME = /^[A-Za-zÀ-ÖØ-öø-ÿ'’\- ]{2,80}$/;

function words(value, { keepHyphen = false } = {}) {
  const plain = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "");
  return plain
    .split(keepHyphen ? /[^a-z0-9-]+/ : /[^a-z0-9]+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter(Boolean);
}

/** Même personne : mêmes mots dans le nom et les prénoms, sans tenir compte des accents, de la casse ni de l'ordre. */
export function personKey(lastName, firstName) {
  return [...words(lastName), ...words(firstName)].sort().join(" ");
}

function shortest(list) {
  const meaningful = list.filter((word) => word.replace(/-/g, "").length >= 3);
  const pool = meaningful.length ? meaningful : list;
  return pool.reduce((best, word) => (word.length < best.length ? word : best));
}

/** prenom.nom : le prénom le plus court (hors particules d'une ou deux lettres) et le nom le plus court. */
export function accountBase(firstName, lastName) {
  if (!VALID_NAME.test(String(firstName || "").trim()) || !VALID_NAME.test(String(lastName || "").trim())) return "";
  const first = words(firstName, { keepHyphen: true });
  const last = words(lastName, { keepHyphen: true });
  if (!first.length || !last.length) return "";
  return `${shortest(first)}.${shortest(last)}`;
}

export function accountAddress(base, rank = 1) {
  return `${base}${rank > 1 ? rank : ""}@${ACCOUNT_DOMAIN}`;
}

export async function findSamePerson(db, lastName, firstName, exceptId = null) {
  const key = personKey(lastName, firstName);
  if (!key) return null;
  const rows = await db.prepare(`
    SELECT id, matricule, last_name, first_name FROM students WHERE status <> 'archive' AND id <> COALESCE(?::int, 0) ORDER BY id
  `).all(exceptId);
  return rows.find((row) => personKey(row.last_name, row.first_name) === key) || null;
}

export async function refuseSamePerson(db, lastName, firstName, exceptId = null) {
  const twin = await findSamePerson(db, lastName, firstName, exceptId);
  if (!twin) return;
  throw new HttpError(409, `${twin.last_name} ${twin.first_name} est déjà enregistré(e) sous le matricule ${twin.matricule}. Une personne ne peut pas être enregistrée deux fois : pour un nouveau versement, ouvrez sa fiche puis « Mettre à jour le paiement ».`);
}

/** Attribue l'adresse du compte étudiant ; à appeler dans une transaction (verrou d'écriture). */
export async function assignAccountEmail(db, student) {
  const base = accountBase(student.first_name, student.last_name);
  if (!base) return null;
  if (student.account_email && student.account_email.replace(/\d*@.*$/, "") === base) return student.account_email;
  const taken = new Set((await db.prepare(`
    SELECT account_email FROM students WHERE account_email LIKE ? AND id <> ?
  `).all(`${base}%@${ACCOUNT_DOMAIN}`, student.id)).map((row) => row.account_email));
  let rank = 1;
  while (taken.has(accountAddress(base, rank))) rank += 1;
  const email = accountAddress(base, rank);
  await db.prepare("UPDATE students SET account_email = ? WHERE id = ?").run(email, student.id);
  return email;
}

export async function ensureAccountEmails(db) {
  const missing = await db.prepare(`
    SELECT id, first_name, last_name, account_email FROM students WHERE account_email IS NULL ORDER BY id
  `).all();
  let assigned = 0;
  for (const student of missing) {
    if (await assignAccountEmail(db, student)) assigned += 1;
  }
  return assigned;
}
