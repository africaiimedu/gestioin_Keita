import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Op } from "sequelize";
import { can, hashPassword, normalizeRights, passwordIssue } from "../auth/passwords.js";
import { pgCode, uploadDir, transaction } from "../db/index.js";
import {
  INSTALLMENT_LABELS,
  METHOD_LABELS,
  STATUS_LABELS,
  amountInWords,
  assertGnf,
  computeSituation,
  officialInstallments,
  formatGnf,
  previewSituation,
  recoveryRate,
  REGISTRATION_FEES,
  registrationFee,
} from "../finance/index.js";
import { HttpError } from "../httpError.js";
import { pushStudentToCard } from "./cardSync.js";
import { assignAccountEmail, refuseSamePerson } from "./identity.js";

const METHODS = new Set(Object.keys(METHOD_LABELS));
const INSTALLMENTS = ["inscription", "tranche_1", "tranche_2", "tranche_3"];
const LEVELS = new Set(["licence", "master", "tech", "bachelor", "bachelor_1", "bachelor_2", "bachelor_3", "master_1", "master_2"]);
const OFFER_LEVELS = new Set(["bachelor_1", "bachelor_2", "bachelor_3", "master_1", "master_2"]);
const CASH_LABEL = "Paiement comptant";
const SCHOLAR_LABEL = "Bourse";
const UNIQUE_VIOLATION = "23505";

function isScholar(discounts) {
  return discounts.some((item) => item.label === SCHOLAR_LABEL || (item.mode === "pourcentage" && Number(item.value) === 100));
}

/** Remise fixe quand toute l'année est payée en une fois. Le Master n'en a pas. */
export const CASH_DISCOUNT = 1_200_000;

export function cashDiscountFor(level) {
  const code = String(level || "");
  return code.startsWith("licence") || code.startsWith("bachelor") ? CASH_DISCOUNT : 0;
}

function cashOffer(current, amount) {
  const discount = cashDiscountFor(current.student.level);
  if (isScholar(current.discounts) || current.situation.paid > 0) {
    return { discounts: current.discounts, amount, apply: false };
  }
  const already = current.discounts.some((item) => item.label === CASH_LABEL);
  if (already) return { discounts: current.discounts, amount, apply: false, reduced: current.situation.due };
  if (!discount) return { discounts: current.discounts, amount, apply: false };
  const reduced = Math.max(0, current.tuition - discount);
  if (amount < reduced) return { discounts: current.discounts, amount, apply: false, reduced };
  return { discounts: current.discounts, amount, apply: true, reduced };
}

function payableRoom(current, offer) {
  if (offer.apply) return Math.max(0, offer.reduced - current.situation.paid);
  return Math.max(0, current.situation.reste);
}

/** Le montant saisi est enregistré tel quel : jamais réduit en silence, refusé s'il dépasse le reste à payer. */
function overpayMessage(typed, room, offer = {}) {
  if (room <= 0) return "Cet étudiant n'a plus rien à payer. Le versement n'a pas été enregistré.";
  const discount = offer.apply ? `, remise de ${formatGnf(CASH_DISCOUNT)} comprise pour un paiement en une fois` : "";
  return `Le montant saisi (${formatGnf(typed)}) est supérieur au montant à payer (${formatGnf(room)}${discount}). Le versement n'a pas été enregistré.`;
}

export function todayInConakry(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Conakry" }).format(now);
}

export async function setting(db, key) {
  return (await db.models.Setting.findByPk(key, { raw: true }))?.value ?? null;
}

export async function audit(db, userId, action, entity, entityId, before, after) {
  await db.models.AuditLog.create({
    user_id: userId ?? null,
    action,
    entity,
    entity_id: entityId == null ? null : String(entityId),
    before_json: before ? JSON.stringify(before) : null,
    after_json: after ? JSON.stringify(after) : null,
  }, { returning: ["id"] });
}

export async function costumePrice(db) {
  return Math.max(0, Number((await setting(db, "costume_price")) || 0));
}

export const COSTUME_MAX = 20;

/** Prix (nombre de costumes × prix unitaire), versé et reste. Un versement lié à un paiement annulé ne compte plus. */
export async function costumeSituation(db, studentId, quantityOverride = null) {
  const unitPrice = await costumePrice(db);
  const row = await db.prepare("SELECT costume_quantity FROM students WHERE id = ?").get(studentId);
  const quantity = quantityOverride || Math.max(1, Number(row?.costume_quantity || 1));
  const price = unitPrice * quantity;
  const entries = (await db.prepare(`
    SELECT c.id, c.amount, c.paid_on, c.method, c.note, c.status, c.cancel_reason, c.payment_id,
           r.number AS receipt_number, r.id AS receipt_id, p.status AS payment_status
    FROM costume_payments c
    LEFT JOIN payments p ON p.id = c.payment_id
    LEFT JOIN receipts r ON r.payment_id = c.payment_id
    WHERE c.student_id = ?
    ORDER BY c.paid_on, c.id
  `).all(studentId)).map((row) => ({
    ...row,
    counted: row.status === "valide" && (row.payment_id == null || row.payment_status === "valide"),
  }));
  const paid = entries.filter((row) => row.counted).reduce((sum, row) => sum + row.amount, 0);
  const reste = Math.max(0, price - paid);
  let status = "non_paye";
  if (!price) status = "non_fixe";
  else if (reste === 0) status = "paye";
  else if (paid > 0) status = "partiel";
  const labels = { non_fixe: "Prix non fixé", paye: "Payé", partiel: "Partiellement payé", non_paye: "Non payé" };
  return { unitPrice, quantity, price, paid, reste, status, statusLabel: labels[status], entries };
}

function costumeQuantityOf(value) {
  if (value == null || value === "") return null;
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > COSTUME_MAX) {
    throw new HttpError(400, `Le nombre de costumes doit être compris entre 1 et ${COSTUME_MAX}`);
  }
  return quantity;
}

/** Nombre de costumes retenu : celui choisi, sinon celui que le montant paie exactement (2 × prix = 2 costumes). */
function costumeQuantityFor(costume, amount, requested) {
  if (requested) return requested;
  const total = costume.paid + amount;
  if (!costume.unitPrice || total <= costume.price || total % costume.unitPrice !== 0) return costume.quantity;
  return Math.min(COSTUME_MAX, total / costume.unitPrice);
}

/** Situation du costume pour ce versement ; avec write, le nombre de costumes est enregistré sur la fiche. */
async function costumeFor(db, studentId, amount, requestedQuantity, { write = false } = {}) {
  const current = await costumeSituation(db, studentId);
  const quantity = costumeQuantityFor(current, amount, costumeQuantityOf(requestedQuantity));
  if (quantity === current.quantity) return current;
  const next = await costumeSituation(db, studentId, quantity);
  if (next.unitPrice && next.paid > next.price) {
    throw new HttpError(400, `${formatGnf(next.paid)} sont déjà versés pour les costumes : il en faut au moins ${Math.ceil(next.paid / next.unitPrice)}.`);
  }
  if (write) await db.prepare("UPDATE students SET costume_quantity = ? WHERE id = ?").run(quantity, studentId);
  return next;
}

function costumeAmountOf(value) {
  if (value == null || value === "") return 0;
  const amount = Number(String(value).replace(/[^\d]/g, "") || 0);
  assertGnf(amount, "Costume");
  return amount;
}

function assertCostumeRoom(costume, amount) {
  if (amount <= 0) return;
  if (!costume.price) throw new HttpError(400, "Le prix du costume n'est pas encore fixé dans les paramètres");
  if (amount > costume.reste) {
    const several = costume.quantity > 1 ? `les ${costume.quantity} costumes` : "le costume";
    const message = costume.reste <= 0
      ? `${several[0].toUpperCase()}${several.slice(1)} ${costume.quantity > 1 ? "sont" : "est"} déjà entièrement payé${costume.quantity > 1 ? "s" : ""}. Pour un costume de plus, augmentez le nombre de costumes.`
      : `Le montant du costume (${formatGnf(amount)}) est supérieur au reste à payer pour ${several} (${formatGnf(costume.reste)}). Pour plusieurs costumes, choisissez le nombre de costumes. Le versement n'a pas été enregistré.`;
    throw new HttpError(400, message, { code: "AMOUNT_TOO_HIGH", reste: costume.reste });
  }
}

export async function recordCostume(db, user, studentId, input, asOf = todayInConakry()) {
  if (!can(user, "payment.create")) throw new HttpError(403, "Vous n'avez pas le droit d'enregistrer un paiement");
  const amount = costumeAmountOf(input.amount);
  if (amount <= 0) throw new HttpError(400, "Indiquez le montant versé pour le costume");
  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn || "") ? input.paidOn : asOf;
  if (paidOn > asOf) throw new HttpError(400, "La date de paiement ne peut pas être dans le futur");
  if (input.method && !METHODS.has(input.method)) throw new HttpError(400, "Moyen de paiement inconnu");
  return transaction(db, async () => {
    const student = await db.prepare("SELECT id, matricule FROM students WHERE id = ?").get(Number(studentId));
    if (!student) throw new HttpError(404, "Étudiant introuvable");
    assertCostumeRoom(await costumeFor(db, student.id, amount, input.quantity, { write: true }), amount);
    const inserted = await db.prepare(`
      INSERT INTO costume_payments(student_id, payment_id, amount, paid_on, method, note, received_by)
      VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(student.id, input.paymentId || null, amount, paidOn, input.method || null, clean(input.note), user.id);
    await audit(db, user.id, "costume.verser", "costume_payments", inserted.lastInsertRowid, null, { matricule: student.matricule, amount, paidOn, paymentId: input.paymentId || null });
    return costumeSituation(db, student.id);
  });
}

export async function cancelCostume(db, user, entryId, reason) {
  if (!can(user, "payment.cancel")) throw new HttpError(403, "Seul l'admin ou le super admin peut annuler un versement");
  const text = String(reason || "").trim();
  if (text.length < 5) throw new HttpError(400, "Le motif d'annulation est obligatoire (au moins 5 caractères)");
  return transaction(db, async () => {
    const entry = await db.prepare("SELECT * FROM costume_payments WHERE id = ?").get(Number(entryId));
    if (!entry) throw new HttpError(404, "Versement de costume introuvable");
    if (entry.payment_id) throw new HttpError(400, "Ce versement figure sur un reçu : annulez le paiement dans Encaissement");
    if (entry.status === "annule") throw new HttpError(400, "Ce versement est déjà annulé");
    await db.prepare("UPDATE costume_payments SET status = 'annule', cancel_reason = ? WHERE id = ?").run(text, entry.id);
    await audit(db, user.id, "costume.annuler", "costume_payments", entry.id, { status: "valide", amount: entry.amount }, { status: "annule", reason: text });
    return costumeSituation(db, entry.student_id);
  });
}

async function yearById(db, yearId) {
  if (yearId) return db.prepare("SELECT * FROM academic_years WHERE id = ?").get(yearId);
  return db.prepare("SELECT * FROM academic_years WHERE active = 1").get();
}

export async function activeYear(db) {
  const year = await yearById(db);
  if (!year) throw new HttpError(500, "Aucune année académique active");
  return year;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

/** Charge en six requêtes tout ce qu'il faut pour calculer la situation de plusieurs étudiants. */
async function loadLedger(db, students) {
  const ids = students.map((student) => student.id);
  const [fees, dues, overrides, discounts, adjustments, payments] = await Promise.all([
    db.prepare("SELECT * FROM fee_schedules").all(),
    db.prepare("SELECT academic_year_id, code, due_on FROM installment_due_dates").all(),
    db.prepare("SELECT student_id, code, amount, due_on FROM student_installments WHERE student_id = ANY(?)").all(ids),
    db.prepare("SELECT id, student_id, label, mode, value, reason FROM discounts WHERE student_id = ANY(?) ORDER BY id").all(ids),
    db.prepare("SELECT id, student_id, amount, reason FROM adjustments WHERE student_id = ANY(?) ORDER BY id").all(ids),
    db.prepare(`
      SELECT id, student_id, amount, paid_on AS "paidOn", status, installment_code AS "installmentCode",
             method, reference, note, date_unconfirmed AS "dateUnconfirmed", received_by AS "receivedBy", created_at AS "createdAt"
      FROM payments WHERE student_id = ANY(?) ORDER BY student_id, paid_on, id
    `).all(ids),
  ]);
  const strip = (rows) => rows.map(({ student_id: _ignored, ...rest }) => rest);
  return {
    fees: new Map(fees.map((fee) => [`${fee.program_id}:${fee.academic_year_id}:${fee.level}`, fee])),
    dues: groupBy(dues, "academic_year_id"),
    overrides: groupBy(overrides, "student_id"),
    discounts: groupBy(discounts, "student_id"),
    adjustments: groupBy(adjustments, "student_id"),
    payments: groupBy(payments, "student_id"),
    strip,
  };
}

function planFrom(student, ledger) {
  const fee = ledger.fees.get(`${student.program_id}:${student.academic_year_id}:${student.level}`);
  if (!fee) throw new HttpError(400, "Aucun barème pour cette filière et cette année. L'administrateur doit le créer.");
  const dues = new Map((ledger.dues.get(student.academic_year_id) || []).map((row) => [row.code, row.due_on]));
  const overrides = ledger.overrides.get(student.id) || [];
  const overrideMap = new Map(overrides.map((row) => [row.code, row]));
  const base = {
    inscription: fee.registration_amount,
    tranche_1: fee.installment_1,
    tranche_2: fee.installment_2,
    tranche_3: fee.installment_3,
  };
  const registration = registrationFee(student.level);
  const installments = INSTALLMENTS.map((code) => ({
    code,
    label: INSTALLMENT_LABELS[code],
    amount: (overrideMap.has(code) ? overrideMap.get(code).amount : base[code]) + (code === "inscription" ? registration : 0),
    dueOn: overrideMap.get(code)?.due_on || dues.get(code),
  })).filter((item) => item.amount > 0);
  return { tuition: fee.tuition_amount + registration, registration, installments, custom: overrides.length > 0 };
}

function bundleFrom(student, ledger, asOf) {
  const { tuition, installments } = planFrom(student, ledger);
  const discounts = ledger.strip(ledger.discounts.get(student.id) || []);
  const adjustments = ledger.strip(ledger.adjustments.get(student.id) || []);
  const payments = ledger.strip(ledger.payments.get(student.id) || []);
  const situation = computeSituation({ tuition, discounts, adjustments, installments, payments, asOf });
  return { tuition, discounts, adjustments, payments, installments, situation };
}

const STUDENT_SELECT = `
  SELECT s.*, p.code AS program_code, p.name AS program_name, y.label AS year_label
  FROM students s
  JOIN programs p ON p.id = s.program_id
  JOIN academic_years y ON y.id = s.academic_year_id
`;

export async function studentSituation(db, studentId, asOf = todayInConakry()) {
  const student = await db.prepare(`${STUDENT_SELECT} WHERE s.id = ?`).get(studentId);
  if (!student) throw new HttpError(404, "Étudiant introuvable");
  return { student, ...bundleFrom(student, await loadLedger(db, [student]), asOf), asOf };
}

async function refreshCard(db, student, situation) {
  const threshold = Number((await setting(db, "card_threshold")) || "5000000");
  let card = "active";
  if (student.status === "suspendu" || student.status === "archive") card = "suspended";
  else if (situation.status === "en_retard" && situation.reste >= threshold) card = "limited";
  await db.prepare("UPDATE students SET card_status = ? WHERE id = ?").run(card, student.id);
  return card;
}

export async function listStudents(db, filters, asOf = todayInConakry()) {
  const year = await yearById(db, filters.yearId);
  if (!year) return [];
  const students = await db.prepare(`
    ${STUDENT_SELECT}
    WHERE s.academic_year_id = ?
      AND (?::int IS NULL OR s.program_id = ?)
      AND (?::text IS NULL OR s.status = ?)
  `).all(year.id, filters.programId ?? null, filters.programId ?? null, filters.studentStatus ?? null, filters.studentStatus ?? null);
  const ledger = await loadLedger(db, students);
  const query = (filters.q || "").trim().toLowerCase();
  const family = {
    bachelor: ["bachelor", "bachelor_1", "bachelor_2", "bachelor_3"],
    master: ["master", "master_1", "master_2"],
  }[filters.level];
  return students
    .map((student) => ({ student, situation: bundleFrom(student, ledger, asOf).situation }))
    .filter((row) => {
      if (family && !family.includes(row.student.level)) return false;
      if (!family && filters.level && row.student.level !== filters.level) return false;
      if (filters.paymentStatus && row.situation.status !== filters.paymentStatus) return false;
      if (!query) return true;
      const blob = `${row.student.matricule} ${row.student.last_name} ${row.student.first_name}`.toLowerCase();
      return blob.includes(query);
    })
    .sort((a, b) => a.student.last_name.localeCompare(b.student.last_name, "fr") || a.student.first_name.localeCompare(b.student.first_name, "fr"));
}

export async function dashboard(db, filters, asOf = todayInConakry()) {
  const rows = await listStudents(db, {
    yearId: filters.yearId,
    programId: filters.programId,
    level: filters.level,
  }, asOf);
  const from = filters.from || "0000-01-01";
  const to = filters.to || "9999-12-31";
  const populationIds = new Set(rows.map((row) => row.student.id));
  const payments = (await db.prepare(`
    SELECT p.*, u.full_name AS agent_name, s.program_id, pr.name AS program_name
    FROM payments p
    JOIN users u ON u.id = p.received_by
    JOIN students s ON s.id = p.student_id
    JOIN programs pr ON pr.id = s.program_id
    WHERE p.status = 'valide'
  `).all()).filter((payment) => {
    if (!populationIds.has(payment.student_id)) return false;
    if (payment.paid_on < from || payment.paid_on > to) return false;
    if (filters.method && payment.method !== filters.method) return false;
    if (filters.agentId && payment.received_by !== filters.agentId) return false;
    return true;
  });

  const due = rows.reduce((total, row) => total + row.situation.due, 0);
  const reste = rows.reduce((total, row) => total + row.situation.reste, 0);
  const credit = rows.reduce((total, row) => total + row.situation.credit, 0);
  const paidAll = rows.reduce((total, row) => total + row.situation.paid, 0);
  const paidFiltered = payments.reduce((total, payment) => total + payment.amount, 0);
  const counts = { solde: 0, partiel: 0, aucun_paiement: 0, en_retard: 0, trop_percu: 0 };
  for (const row of rows) counts[row.situation.status] += 1;

  const byProgram = new Map();
  for (const row of rows) {
    const key = row.student.program_name;
    if (!byProgram.has(key)) byProgram.set(key, { program: key, paid: 0, reste: 0, due: 0, students: 0 });
    const bucket = byProgram.get(key);
    bucket.paid += row.situation.paid;
    bucket.reste += row.situation.reste;
    bucket.due += row.situation.due;
    bucket.students += 1;
  }

  const byMethod = new Map();
  for (const payment of payments) {
    byMethod.set(payment.method, (byMethod.get(payment.method) || 0) + payment.amount);
  }
  const byMonth = new Map();
  for (const payment of payments) {
    const month = payment.paid_on.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + payment.amount);
  }
  const aging = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  for (const row of rows) {
    if (row.situation.agingBucket) aging[row.situation.agingBucket] += row.situation.overdueAmount;
  }
  const forecast = new Map();
  for (const row of rows) {
    for (const item of row.situation.plan) {
      const uncovered = item.amount - (row.situation.covered[item.code] || 0);
      if (uncovered <= 0 || item.dueOn < asOf) continue;
      const month = item.dueOn.slice(0, 7);
      forecast.set(month, (forecast.get(month) || 0) + uncovered);
    }
  }
  const debtors = [...rows]
    .filter((row) => row.situation.reste > 0)
    .sort((a, b) => b.situation.reste - a.situation.reste)
    .slice(0, 8)
    .map((row) => ({
      id: row.student.id,
      matricule: row.student.matricule,
      name: `${row.student.last_name} ${row.student.first_name}`.trim(),
      program: row.student.program_name,
      reste: row.situation.reste,
      status: row.situation.status,
    }));

  const control = paidAll + reste - credit === due;
  return {
    asOf,
    students: rows.length,
    due,
    paid: paidFiltered,
    paidAll,
    reste,
    credit,
    rate: recoveryRate(filters.method || filters.agentId || filters.from ? paidFiltered : paidAll, due),
    counts,
    byProgram: [...byProgram.values()],
    byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, label: METHOD_LABELS[method], amount })),
    byMonth: [...byMonth.entries()].sort().map(([month, amount]) => ({ month, amount })),
    aging,
    forecast: [...forecast.entries()].sort().map(([month, amount]) => ({ month, amount })),
    debtors,
    controlOk: control,
    filteredPayments: Boolean(filters.method || filters.agentId || filters.from || filters.to),
  };
}

export async function reconcile(db, asOf = todayInConakry()) {
  const rows = await listStudents(db, {}, asOf);
  const sqlPaidByStudent = new Map((await db.prepare(`
    SELECT student_id, SUM(amount) AS total FROM payments WHERE status = 'valide' GROUP BY student_id
  `).all()).map((row) => [row.student_id, row.total]));
  const gaps = [];
  let due = 0;
  let paid = 0;
  let reste = 0;
  let credit = 0;
  for (const row of rows) {
    due += row.situation.due;
    paid += row.situation.paid;
    reste += row.situation.reste;
    credit += row.situation.credit;
    if ((sqlPaidByStudent.get(row.student.id) || 0) !== row.situation.paid) {
      gaps.push({ matricule: row.student.matricule, message: "La somme SQL des paiements diffère du total calculé" });
    }
  }
  const sqlAll = (await db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS total
    FROM payments p JOIN students s ON s.id = p.student_id
    WHERE p.status = 'valide' AND s.academic_year_id = (SELECT id FROM academic_years WHERE active = 1)
  `).get()).total;
  if (sqlAll !== paid) gaps.push({ matricule: "*", message: "Le total général SQL diffère de la somme des étudiants" });
  if (paid + reste - credit !== due) gaps.push({ matricule: "*", message: "Payé + reste − crédit n'est pas égal aux frais dus" });
  return { ok: gaps.length === 0, gaps, due, paid, reste, credit, students: rows.length };
}

function assertCanPay(student) {
  if (student.status === "archive") throw new HttpError(400, "Cet étudiant est archivé. Réactivez la fiche avant d'encaisser.");
  if (student.status === "suspendu") throw new HttpError(400, "Cet étudiant est suspendu. Seule la direction ou l'administrateur peut lever la suspension.");
}

export async function previewPayment(db, input, asOf = todayInConakry()) {
  assertGnf(input.amount, "Montant");
  if (input.amount <= 0) throw new HttpError(400, "Le montant doit être supérieur à zéro");
  const current = await studentSituation(db, input.studentId, asOf);
  const warnings = [];
  if (isScholar(current.discounts)) throw new HttpError(400, "Cet étudiant est boursier : aucun frais de scolarité à encaisser");
  const costumeAmount = costumeAmountOf(input.costumeAmount);
  let costume = await costumeSituation(db, current.student.id);
  try {
    costume = await costumeFor(db, current.student.id, costumeAmount, input.costumeQuantity);
    assertCostumeRoom(costume, costumeAmount);
  } catch (error) {
    warnings.push(error.message);
  }
  costume.today = costumeAmount;
  costume.resteAfter = Math.max(0, costume.reste - costumeAmount);
  if (input.paidOn && input.paidOn > asOf) warnings.push("La date est dans le futur");
  if (input.reference) {
    const duplicate = await db.prepare(`
      SELECT id FROM payments WHERE reference = ? AND status = 'valide' AND length(trim(reference)) > 0 LIMIT 1
    `).get(input.reference.trim());
    if (duplicate) warnings.push("Cette référence a déjà été utilisée");
  }
  const offer = cashOffer(current, input.amount);
  const room = payableRoom(current, offer);
  if (offer.amount > room) {
    warnings.push(overpayMessage(input.amount, room, offer));
    return {
      warnings,
      before: current.situation,
      after: current.situation,
      recordedAmount: 0,
      limited: true,
      refused: true,
      student: publicStudent(current.student),
      costume,
    };
  }
  const discounts = offer.apply
    ? [...current.discounts, { mode: "fixe", value: CASH_DISCOUNT, label: CASH_LABEL }]
    : offer.discounts;
  if (offer.apply) warnings.push(`Remise de ${formatGnf(CASH_DISCOUNT)} : toute la scolarité est payée en une fois`);
  const preview = previewSituation({
    tuition: current.tuition,
    discounts,
    adjustments: current.adjustments,
    installments: current.installments,
    payments: current.payments,
    asOf,
  }, {
    amount: offer.amount,
    paidOn: input.paidOn || asOf,
    installmentCode: input.installmentCode || null,
  });
  return { warnings, ...preview, recordedAmount: offer.amount, limited: false, refused: false, student: publicStudent(current.student), costume };
}

/** Aperçu d'une mise à jour : mêmes montants que le nouveau reçu, sans rien enregistrer. */
export async function previewPaymentUpdate(db, paymentId, input = {}, asOf = todayInConakry()) {
  const payment = await db.prepare("SELECT * FROM payments WHERE id = ?").get(Number(paymentId));
  if (!payment) throw new HttpError(404, "Paiement introuvable");
  if (payment.status !== "valide") throw new HttpError(400, "Seul un paiement encore valide peut être mis à jour");
  const receipt = await db.prepare("SELECT number, snapshot_json FROM receipts WHERE payment_id = ?").get(payment.id);
  let snapshot = null;
  if (receipt?.snapshot_json) {
    try { snapshot = JSON.parse(receipt.snapshot_json); } catch { snapshot = null; }
  }
  const current = await studentSituation(db, payment.student_id, asOf);
  const valid = current.payments.filter((item) => item.status === "valide");
  const typed = Number(input.amount);
  const asked = Number.isFinite(typed) && typed > 0 ? Math.trunc(typed) : 0;
  const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn || "") ? input.paidOn : payment.paid_on;
  const lastAmount = Number(snapshot?.amount ?? payment.amount);
  const base = {
    receiptNumber: receipt?.number || null,
    studentName: `${current.student.last_name} ${current.student.first_name}`.trim(),
    matricule: current.student.matricule,
    lastAmount,
    due: current.situation.due,
    paidBefore: current.situation.paid,
    cashDiscount: false,
    costume: await costumeSituation(db, payment.student_id),
  };
  if (asked <= 0) {
    return {
      ...base,
      todayAmount: 0,
      paidAfter: current.situation.paid,
      reste: current.situation.reste,
      credit: current.situation.credit,
      seal: current.situation.reste <= 0 ? "PAYÉ" : "ACOMPTE REÇU",
    };
  }
  const offer = cashOffer(current, asked);
  const discountsAfter = offer.apply
    ? [...current.discounts, { mode: "fixe", value: CASH_DISCOUNT, label: CASH_LABEL }]
    : offer.discounts;
  const priced = {
    tuition: current.tuition,
    discounts: discountsAfter,
    adjustments: current.adjustments,
    installments: current.installments,
    payments: valid,
    asOf,
  };
  const probe = previewSituation(priced, { amount: offer.amount, paidOn });
  const room = payableRoom(current, offer);
  if (offer.amount > room) {
    return {
      ...base,
      due: probe.before.due,
      todayAmount: 0,
      paidBefore: probe.before.paid,
      paidAfter: probe.before.paid,
      reste: probe.before.reste,
      credit: probe.before.credit,
      seal: probe.before.reste <= 0 ? "PAYÉ" : "ACOMPTE REÇU",
      cashDiscount: Boolean(offer.apply),
      limited: true,
      refused: true,
      limitedMessage: overpayMessage(asked, room, offer),
    };
  }
  return {
    ...base,
    due: probe.after.due,
    todayAmount: offer.amount,
    paidBefore: probe.before.paid,
    paidAfter: probe.after.paid,
    reste: probe.after.reste,
    credit: probe.after.credit,
    seal: probe.after.reste <= 0 ? "PAYÉ" : "ACOMPTE REÇU",
    cashDiscount: Boolean(offer.apply),
    limited: false,
    refused: false,
    limitedMessage: "",
  };
}

function publicStudent(student) {
  return {
    id: student.id,
    matricule: student.matricule,
    lastName: student.last_name,
    firstName: student.first_name,
    name: `${student.last_name} ${student.first_name}`.trim(),
    program: student.program_name,
    programCode: student.program_code,
    level: student.level,
    year: student.year_label,
    phone: student.phone,
    email: student.email,
    accountEmail: student.account_email,
    guardianName: student.guardian_name,
    guardianPhone: student.guardian_phone,
    status: student.status,
    cardStatus: student.card_status,
    source: student.source,
    legacyNumber: student.legacy_number,
  };
}

export function presentSituation(situation) {
  return {
    ...situation,
    dueLabel: undefined,
    statusLabel: STATUS_LABELS[situation.status],
  };
}

export async function nextDocumentNumber(db, kind, year) {
  const row = await db.prepare(`
    INSERT INTO document_sequences(kind, year, last_number) VALUES(?, ?, 1)
    ON CONFLICT(kind, year) DO UPDATE SET last_number = document_sequences.last_number + 1
    RETURNING last_number
  `).get(kind, year);
  return Number(row.last_number);
}

export async function createPayment(db, user, input, asOf = todayInConakry()) {
  if (!can(user, "payment.create")) throw new HttpError(403, "Vous n'avez pas le droit d'enregistrer un paiement");
  assertGnf(input.amount, "Montant");
  if (input.amount <= 0) throw new HttpError(400, "Le montant doit être supérieur à zéro");
  if (!METHODS.has(input.method)) throw new HttpError(400, "Moyen de paiement inconnu");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn || "")) throw new HttpError(400, "Date de paiement invalide");
  if (input.paidOn > asOf) throw new HttpError(400, "La date de paiement ne peut pas être dans le futur");
  if (input.installmentCode && !INSTALLMENTS.includes(input.installmentCode)) throw new HttpError(400, "Tranche inconnue");
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8) throw new HttpError(400, "Validation incomplète. Rechargez la page et recommencez.");

  return transaction(db, async () => {
    const existing = await db.prepare("SELECT * FROM payments WHERE idempotency_key = ?").get(key);
    if (existing) {
      const sameStudent = existing.student_id === Number(input.studentId);
      const sameAmount = existing.amount === input.amount || existing.amount < input.amount;
      if (!sameStudent || !sameAmount) {
        throw new HttpError(409, "Cette validation a déjà servi pour un autre paiement. Rechargez la page.");
      }
      const receipt = await db.prepare("SELECT * FROM receipts WHERE payment_id = ?").get(existing.id);
      return { replay: true, paymentId: existing.id, receiptId: receipt?.id, receiptNumber: receipt?.number };
    }
    let current = await studentSituation(db, Number(input.studentId), asOf);
    assertCanPay(current.student);
    if (isScholar(current.discounts)) {
      throw new HttpError(400, "Cet étudiant est boursier : aucun frais de scolarité à encaisser");
    }
    const offer = cashOffer(current, input.amount);
    const room = payableRoom(current, offer);
    if (offer.amount > room && !input.acceptCredit) {
      throw new HttpError(400, overpayMessage(input.amount, room, offer), { code: "AMOUNT_TOO_HIGH", reste: room });
    }
    const costumeAmount = costumeAmountOf(input.costumeAmount);
    const costumeBefore = await costumeFor(db, current.student.id, costumeAmount, input.costumeQuantity, { write: true });
    assertCostumeRoom(costumeBefore, costumeAmount);
    if (offer.apply) {
      await db.prepare(`
        INSERT INTO discounts(student_id, label, mode, value, reason, approved_by)
        VALUES(?, ?, 'fixe', ?, ?, ?)
      `).run(current.student.id, CASH_LABEL, CASH_DISCOUNT, "Toute la scolarité payée en une fois", user.id);
      current = await studentSituation(db, current.student.id, asOf);
    }
    const amount = offer.amount;
    const reference = (input.reference || "").trim();
    if (reference) {
      const duplicate = await db.prepare(`
        SELECT id FROM payments WHERE reference = ? AND status = 'valide' LIMIT 1
      `).get(reference);
      if (duplicate && !input.acceptDuplicateReference) {
        throw new HttpError(409, "Cette référence existe déjà. Confirmez s'il ne s'agit pas d'un doublon.", { code: "DUPLICATE_REFERENCE" });
      }
    }
    const inserted = await db.prepare(`
      INSERT INTO payments(
        student_id, amount, paid_on, date_unconfirmed, method, reference, installment_code, note, idempotency_key, received_by
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(
      current.student.id,
      amount,
      input.paidOn,
      input.dateUnconfirmed ? 1 : 0,
      input.method,
      reference || null,
      input.installmentCode || null,
      (input.note || "").trim() || null,
      key,
      user.id,
    );
    const paymentId = inserted.lastInsertRowid;
    await db.prepare("INSERT INTO payment_controls(payment_id) VALUES (?)").run(paymentId);
    if (costumeAmount > 0) {
      await recordCostume(db, user, current.student.id, { amount: costumeAmount, paidOn: input.paidOn, method: input.method, paymentId, note: "Versé avec la scolarité" }, asOf);
    }
    const after = await studentSituation(db, current.student.id, asOf);
    const atThisPayment = computeSituation({
      tuition: after.tuition,
      discounts: after.discounts,
      adjustments: after.adjustments,
      installments: after.installments,
      payments: after.payments.filter((payment) => payment.paidOn < input.paidOn || (payment.paidOn === input.paidOn && payment.id <= paymentId)),
      asOf,
    });
    const earlier = await db.prepare(`
      SELECT p.amount, p.paid_on, p.method, r.number AS receipt_number
      FROM payments p LEFT JOIN receipts r ON r.payment_id = p.id
      WHERE p.student_id = ? AND p.status = 'valide' AND p.id <> ?
        AND (p.paid_on < ?::date OR (p.paid_on = ?::date AND p.id < ?))
      ORDER BY p.paid_on, p.id
    `).all(current.student.id, paymentId, input.paidOn, input.paidOn, paymentId);
    const year = Number(input.paidOn.slice(0, 4));
    const seq = await nextDocumentNumber(db, "REC", year);
    const number = `REC-${year}-${String(seq).padStart(6, "0")}`;
    const token = crypto.randomBytes(24).toString("base64url");
    const snapshot = {
      history: earlier.map((item) => ({
        paidOn: String(item.paid_on).slice(0, 10),
        amount: item.amount,
        methodLabel: METHOD_LABELS[item.method] || item.method,
        receiptNumber: item.receipt_number || null,
      })),
      studentName: `${current.student.last_name} ${current.student.first_name}`.trim(),
      matricule: current.student.matricule,
      program: current.student.program_name,
      level: current.student.level,
      year: current.student.year_label,
      amount,
      amountInWords: amountInWords(amount),
      costume: costumeBefore.price > 0 ? {
        unitPrice: costumeBefore.unitPrice,
        quantity: costumeBefore.quantity,
        price: costumeBefore.price,
        paidBefore: costumeBefore.paid,
        today: costumeAmount,
        paidAfter: costumeBefore.paid + costumeAmount,
        reste: Math.max(0, costumeBefore.reste - costumeAmount),
      } : null,
      method: input.method,
      methodLabel: METHOD_LABELS[input.method],
      reference: reference || null,
      installment: input.installmentCode || null,
      installmentLabel: input.installmentCode ? INSTALLMENT_LABELS[input.installmentCode] : "Affectation à la plus ancienne tranche impayée",
      paidOn: input.paidOn,
      recordedAt: new Date().toISOString(),
      agentName: user.full_name,
      due: atThisPayment.due,
      paidAfter: atThisPayment.paid,
      resteAfter: atThisPayment.reste,
      creditAfter: atThisPayment.credit,
      status: atThisPayment.status,
      statusLabel: STATUS_LABELS[atThisPayment.status],
    };
    const receipt = await db.prepare(`
      INSERT INTO receipts(payment_id, number, year, seq, verify_token, snapshot_json)
      VALUES(?, ?, ?, ?, ?, ?) RETURNING id
    `).run(paymentId, number, year, seq, token, JSON.stringify(snapshot));
    if (input.attachment?.dataBase64) await saveAttachment(db, paymentId, input.attachment);
    const card = await refreshCard(db, current.student, after.situation);
    await audit(db, user.id, "paiement.creer", "payments", paymentId, null, { ...snapshot, card });
    return {
      replay: false,
      paymentId,
      receiptId: receipt.lastInsertRowid,
      receiptNumber: number,
      before: current.situation,
      after: after.situation,
      costume: snapshot.costume,
      card,
    };
  });
}

async function saveAttachment(db, paymentId, attachment) {
  const raw = String(attachment.dataBase64);
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  const mime = match ? match[1] : (attachment.mime || "application/octet-stream");
  const b64 = match ? match[2] : raw;
  if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) {
    throw new HttpError(400, "La pièce jointe doit être une image ou un PDF");
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length > 2_000_000) throw new HttpError(400, "La pièce jointe dépasse 2 Mo");
  const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1].replace("jpeg", "jpg");
  const safeName = `justificatif-${paymentId}.${ext}`;
  const dir = path.join(uploadDir(), String(paymentId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safeName), buffer);
  await db.prepare(`
    INSERT INTO payment_attachments(payment_id, filename, stored_path, mime) VALUES(?, ?, ?, ?)
  `).run(paymentId, safeName, path.join(String(paymentId), safeName), mime);
}

export async function updatePayment(db, user, paymentId, input, asOf = todayInConakry()) {
  if (!can(user, "payment.create")) throw new HttpError(403, "Vous n'avez pas le droit de mettre un paiement à jour");
  const key = String(input.idempotencyKey || "").trim();
  if (key.length < 8) throw new HttpError(400, "Validation incomplète. Rechargez la page et recommencez.");
  const already = await db.prepare("SELECT id, student_id FROM payments WHERE idempotency_key = ?").get(key);
  if (already) {
    const receipt = await db.prepare("SELECT id, number FROM receipts WHERE payment_id = ?").get(already.id);
    const after = await studentSituation(db, already.student_id, asOf);
    return { replay: true, paymentId: already.id, receiptId: receipt?.id, receiptNumber: receipt?.number, after: after.situation };
  }
  const payment = await db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  if (!payment) throw new HttpError(404, "Paiement introuvable");
  if (payment.status !== "valide") throw new HttpError(400, "Seul un paiement encore valide peut recevoir un versement supplémentaire");
  const note = [input.note, input.reason].map((value) => String(value || "").trim()).filter(Boolean).join(" — ");
  return transaction(db, async () => {
    const created = await createPayment(db, user, {
      studentId: payment.student_id,
      amount: input.amount,
      paidOn: input.paidOn,
      method: input.method,
      reference: input.reference,
      costumeAmount: input.costumeAmount,
      costumeQuantity: input.costumeQuantity,
      note,
      idempotencyKey: key,
      acceptCredit: input.acceptCredit,
      acceptDuplicateReference: input.acceptDuplicateReference,
    }, asOf);
    await audit(db, user.id, "paiement.ajouter", "payments", created.paymentId, { keptPaymentId: paymentId, keptAmount: payment.amount }, { amount: input.amount, receiptNumber: created.receiptNumber });
    return { ...created, keptPaymentId: paymentId, keptAmount: payment.amount };
  });
}

export async function cancelPayment(db, user, paymentId, reason, asOf = todayInConakry()) {
  if (!can(user, "payment.cancel")) throw new HttpError(403, "Seul l'admin ou le super admin peut annuler un paiement");
  const clean = String(reason || "").trim();
  if (clean.length < 5) throw new HttpError(400, "Le motif d'annulation est obligatoire (au moins 5 caractères)");
  return transaction(db, async () => {
    const payment = await db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
    if (!payment) throw new HttpError(404, "Paiement introuvable");
    if (payment.status === "annule") throw new HttpError(400, "Ce paiement est déjà annulé");
    const control = await ensurePaymentControl(db, paymentId);
    if (control.cancel_used >= 1) throw new HttpError(400, "Ce paiement a déjà été annulé une fois");
    await db.prepare("UPDATE payment_controls SET cancel_used = 1 WHERE payment_id = ?").run(paymentId);
    await db.prepare("UPDATE payments SET status = 'annule' WHERE id = ?").run(paymentId);
    const year = Number(todayInConakry().slice(0, 4));
    const seq = await nextDocumentNumber(db, "AVO", year);
    const creditNote = `AVO-${year}-${String(seq).padStart(6, "0")}`;
    await db.prepare(`
      INSERT INTO cancellations(payment_id, reason, cancelled_by, credit_note_number) VALUES(?, ?, ?, ?)
    `).run(paymentId, clean, user.id, creditNote);
    const after = await studentSituation(db, payment.student_id, asOf);
    await refreshCard(db, after.student, after.situation);
    await audit(db, user.id, "paiement.annuler", "payments", paymentId, { status: "valide", amount: payment.amount }, { status: "annule", reason: clean, creditNote });
    return { creditNote, situation: after.situation };
  });
}

async function ensurePaymentControl(db, paymentId) {
  await db.prepare("INSERT INTO payment_controls(payment_id) VALUES (?) ON CONFLICT(payment_id) DO NOTHING").run(paymentId);
  return db.prepare("SELECT * FROM payment_controls WHERE payment_id = ?").get(paymentId);
}

function editAllowed(control) {
  return control.updates_used < 1 || control.unlocked === 1;
}

function isOfficeAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

export async function unlockPayment(db, user, paymentId) {
  if (!isOfficeAdmin(user)) throw new HttpError(403, "Seul un administrateur peut débloquer une modification");
  return transaction(db, async () => {
    const payment = await db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
    if (!payment) throw new HttpError(404, "Paiement introuvable");
    if (payment.status !== "valide") throw new HttpError(400, "Un paiement annulé ne peut pas être débloqué");
    const control = await ensurePaymentControl(db, paymentId);
    if (editAllowed(control)) throw new HttpError(400, "Ce paiement peut encore être modifié");
    await db.prepare("UPDATE payment_controls SET unlocked = 1 WHERE payment_id = ?").run(paymentId);
    await audit(db, user.id, "paiement.debloquer", "payments", paymentId, { unlocked: 0 }, { unlocked: 1 });
    return { unlocked: true };
  });
}

export async function listCashPayments(db, date = null) {
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "Date invalide");
  return (await db.prepare(`
    SELECT p.id, p.student_id, p.amount, p.paid_on, p.method, p.reference, p.note, p.status,
           s.matricule, s.last_name, s.first_name,
           r.id AS receipt_id, r.number AS receipt_number,
           COALESCE((SELECT SUM(k.amount) FROM costume_payments k WHERE k.payment_id = p.id AND k.status = 'valide'), 0) AS costume_amount,
           COALESCE(c.updates_used, 0) AS updates_used,
           COALESCE(c.cancel_used, 0) AS cancel_used,
           COALESCE(c.unlocked, 0) AS unlocked
    FROM payments p
    JOIN students s ON s.id = p.student_id
    LEFT JOIN receipts r ON r.payment_id = p.id
    LEFT JOIN payment_controls c ON c.payment_id = p.id
    WHERE ?::date IS NULL OR p.paid_on = ?::date
    ORDER BY p.paid_on DESC, p.id DESC
  `).all(date, date)).map((row) => ({
    ...row,
    name: `${row.last_name} ${row.first_name}`.trim(),
    canUpdate: row.status === "valide" && (row.updates_used < 1 || row.unlocked === 1),
    canCancel: row.status === "valide" && row.cancel_used < 1,
    locked: row.status === "valide" && row.updates_used >= 1 && row.unlocked !== 1,
  }));
}

/** Une ligne par étudiant : l'historique complet de ses versements, du plus ancien au plus récent. */
export async function listCashStudents(db, asOf = todayInConakry()) {
  const payments = await listCashPayments(db);
  const groups = new Map();
  for (const payment of payments) {
    if (!groups.has(payment.student_id)) groups.set(payment.student_id, []);
    groups.get(payment.student_id).push(payment);
  }
  const students = groups.size
    ? await db.prepare(`${STUDENT_SELECT} WHERE s.id IN (SELECT DISTINCT student_id FROM payments)`).all()
    : [];
  const ledger = await loadLedger(db, students);
  const rows = students.map((student) => {
    const history = groups.get(student.id).slice().reverse();
    const valid = history.filter((item) => item.status === "valide");
    const last = valid.at(-1) || null;
    const withReceipt = valid.filter((item) => item.receipt_id).at(-1) || null;
    const situation = bundleFrom(student, ledger, asOf).situation;
    return {
      studentId: student.id,
      name: `${student.last_name} ${student.first_name}`.trim(),
      matricule: student.matricule,
      program: student.program_name,
      level: student.level,
      history,
      count: valid.length,
      cancelled: history.length - valid.length,
      tuitionPaid: valid.reduce((sum, item) => sum + item.amount, 0),
      costumePaid: valid.reduce((sum, item) => sum + Number(item.costume_amount || 0), 0),
      due: situation.due,
      reste: situation.reste,
      status: situation.status,
      statusLabel: STATUS_LABELS[situation.status],
      lastPaymentId: last?.id || null,
      lastPaidOn: (last || history.at(-1)).paid_on,
      lastSortId: (last || history.at(-1)).id,
      receiptId: withReceipt?.receipt_id || null,
      receiptNumber: withReceipt?.receipt_number || null,
    };
  });
  rows.sort((a, b) => String(b.lastPaidOn).localeCompare(String(a.lastPaidOn)) || b.lastSortId - a.lastSortId);
  const totals = {
    students: rows.length,
    payments: rows.reduce((sum, row) => sum + row.count, 0),
    cancelled: rows.reduce((sum, row) => sum + row.cancelled, 0),
    tuition: rows.reduce((sum, row) => sum + row.tuitionPaid, 0),
    costume: rows.reduce((sum, row) => sum + row.costumePaid, 0),
  };
  return { students: rows, totals };
}

export async function cashJournal(db, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new HttpError(400, "Date invalide");
  const rows = await db.prepare(`
    SELECT p.id, p.amount, p.method, p.reference, p.paid_on, p.date_unconfirmed, p.note,
           s.matricule, s.last_name, s.first_name, u.full_name AS agent, r.number AS receipt
    FROM payments p
    JOIN students s ON s.id = p.student_id
    JOIN users u ON u.id = p.received_by
    LEFT JOIN receipts r ON r.payment_id = p.id
    WHERE p.paid_on = ? AND p.status = 'valide'
    ORDER BY p.id
  `).all(date);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const sqlTotal = (await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_on = ? AND status = 'valide'
  `).get(date)).total;
  if (sqlTotal !== total) throw new HttpError(500, "Écart de caisse : le total affiché ne correspond pas à la somme des paiements");
  const byMethod = new Map();
  const byAgent = new Map();
  for (const row of rows) {
    byMethod.set(row.method, (byMethod.get(row.method) || 0) + row.amount);
    byAgent.set(row.agent, (byAgent.get(row.agent) || 0) + row.amount);
  }
  return {
    date,
    total,
    controlOk: true,
    count: rows.length,
    unconfirmed: rows.filter((row) => row.date_unconfirmed === 1).length,
    byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, label: METHOD_LABELS[method], amount })),
    byAgent: [...byAgent.entries()].map(([agent, amount]) => ({ agent, amount })),
    rows,
  };
}

export function reminderMessage(student, situation) {
  const name = `${student.first_name} ${student.last_name}`.trim();
  return `Bonjour, AfricaIIM vous informe que la scolarité de ${name} (${student.matricule}) présente un reste de ${formatGnf(situation.reste)}. Merci de régulariser auprès de la scolarité.`;
}

export async function createReminder(db, user, studentId, channel, asOf = todayInConakry()) {
  if (!can(user, "reminder.create")) throw new HttpError(403, "Vous n'avez pas le droit d'enregistrer une relance");
  const current = await studentSituation(db, studentId, asOf);
  if (current.situation.reste <= 0) throw new HttpError(400, "Cet étudiant n'a pas de reste à payer");
  const allowed = new Set(["copie", "email", "whatsapp", "sms"]);
  if (!allowed.has(channel)) throw new HttpError(400, "Canal de relance inconnu");
  const message = reminderMessage(current.student, current.situation);
  return transaction(db, async () => {
    const reminder = await db.models.Reminder.create({ student_id: studentId, channel, message, created_by: user.id });
    await audit(db, user.id, "relance", "reminders", reminder.id, null, { channel, studentId });
    return { id: reminder.id, message, channel };
  });
}

export async function lateStudents(db, asOf = todayInConakry()) {
  return (await listStudents(db, {}, asOf))
    .filter((row) => row.situation.status === "en_retard")
    .map((row) => ({
      student: publicStudent(row.student),
      situation: row.situation,
      message: reminderMessage(row.student, row.situation),
    }));
}

function parseMoney(value) {
  if (value == null || value === "") return 0;
  const digits = String(value).replace(/[^\d]/g, "");
  if (!digits) return 0;
  const amount = Number(digits);
  assertGnf(amount, "Versement");
  return amount;
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

export async function createStudent(db, user, input) {
  if (!can(user, "student.write")) throw new HttpError(403, "Vous n'avez pas le droit de créer une fiche");
  const last = String(input.lastName || "").trim();
  const first = String(input.firstName || "").trim();
  if (last.length < 2 || first.length < 2) throw new HttpError(400, "Le nom et le prénom sont obligatoires");
  if (!LEVELS.has(input.level)) throw new HttpError(400, "Niveau inconnu");
  const scholarship = truthy(input.scholarship);
  const paymentAmount = parseMoney(input.paymentAmount);
  if (!scholarship && input.paymentAmount != null && String(input.paymentAmount).trim() === "") {
    throw new HttpError(400, "Indiquez le versement du jour. Mettez 0 s'il n'y a aucun versement.");
  }
  if (scholarship && paymentAmount > 0) throw new HttpError(400, "Un boursier ne verse aucun frais de scolarité");
  const costumeAmount = costumeAmountOf(input.costumeAmount);
  const costumeQuantity = costumeQuantityOf(input.costumeQuantity);
  if ((paymentAmount > 0 || costumeAmount > 0) && !METHODS.has(input.method)) throw new HttpError(400, "Choisissez le moyen de paiement");
  const typedMatricule = matriculeOf(input.matricule, { optional: true });
  const year = await activeYear(db);
  const program = await db.prepare("SELECT * FROM programs WHERE id = ?").get(Number(input.programId));
  if (!program) throw new HttpError(400, "Filière inconnue");
  const paidOn = todayInConakry();
  const created = await transaction(db, async () => {
    await refuseSamePerson(db, last, first);
    const matricule = typedMatricule || await nextMatricule(db, year.label, program);
    await refuseTakenMatricule(db, matricule);
    const result = await db.prepare(`
      INSERT INTO students(matricule, last_name, first_name, program_id, academic_year_id, level, phone, email, guardian_name, guardian_phone, source, costume_quantity)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'saisie', ?) RETURNING id
    `).run(matricule, last.toUpperCase(), first, program.id, year.id, input.level, clean(input.phone), clean(input.email), clean(input.guardianName), clean(input.guardianPhone), costumeQuantity || 1);
    const studentId = result.lastInsertRowid;
    await assignAccountEmail(db, { id: studentId, first_name: first, last_name: last });
    await audit(db, user.id, "etudiant.creer", "students", studentId, null, { matricule, last, first, level: input.level, scholarship });
    if (scholarship) {
      await db.prepare(`
        INSERT INTO discounts(student_id, label, mode, value, reason, approved_by)
        VALUES(?, ?, 'pourcentage', 100, ?, ?)
      `).run(studentId, SCHOLAR_LABEL, "Étudiant boursier : aucun frais de scolarité", user.id);
    }
    if (paymentAmount > 0) {
      await createPayment(db, user, {
        studentId,
        amount: paymentAmount,
        paidOn,
        method: input.method,
        idempotencyKey: `fiche-${matricule}`,
        note: "Versement du jour à l'inscription",
        costumeAmount,
        costumeQuantity,
      }, paidOn);
    } else if (costumeAmount > 0) {
      await recordCostume(db, user, studentId, { amount: costumeAmount, quantity: costumeQuantity, paidOn, method: input.method, note: "Versé à l'inscription" }, paidOn);
    }
    const current = await studentSituation(db, studentId, paidOn);
    await refreshCard(db, current.student, current.situation);
    return studentSituation(db, studentId, paidOn);
  });
  pushStudentToCard(created.student).catch(() => {});
  return created;
}

const MATRICULE_FORMAT = /^[A-Z0-9][A-Z0-9-]{2,30}$/;

function matriculeOf(value, { optional = false } = {}) {
  const matricule = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!matricule && optional) return null;
  if (!MATRICULE_FORMAT.test(matricule)) {
    throw new HttpError(400, "Le matricule doit compter de 3 à 31 caractères : lettres, chiffres et tirets (ex. UA26AT0001).");
  }
  return matricule;
}

async function refuseTakenMatricule(db, matricule, exceptId = null) {
  const other = await db.prepare(`
    SELECT matricule, last_name, first_name FROM students WHERE upper(matricule) = ? AND id <> COALESCE(?::int, 0)
  `).get(matricule, exceptId);
  if (other) throw new HttpError(409, `Le matricule ${matricule} est déjà attribué à ${other.last_name} ${other.first_name}.`);
}

/** Matricule proposé pour une nouvelle fiche : la scolarité peut le remplacer. */
export async function suggestMatricule(db, programId) {
  const year = await activeYear(db);
  const program = programId
    ? await db.prepare("SELECT * FROM programs WHERE id = ?").get(Number(programId))
    : await db.prepare("SELECT * FROM programs ORDER BY id LIMIT 1").get();
  if (!program) throw new HttpError(400, "École inconnue");
  return nextMatricule(db, year.label, program);
}

export async function changeMatricule(db, user, studentId, value) {
  if (!can(user, "student.write")) throw new HttpError(403, "Vous n'avez pas le droit de modifier cette fiche");
  const matricule = matriculeOf(value);
  const result = await transaction(db, async () => {
    const before = await db.prepare("SELECT * FROM students WHERE id = ?").get(Number(studentId));
    if (!before) throw new HttpError(404, "Étudiant introuvable");
    if (before.matricule === matricule) return { previous: null, situation: await studentSituation(db, before.id) };
    await refuseTakenMatricule(db, matricule, before.id);
    await db.prepare("UPDATE students SET matricule = ? WHERE id = ?").run(matricule, before.id);
    await audit(db, user.id, "etudiant.matricule", "students", before.id, { matricule: before.matricule }, { matricule });
    return { previous: before.matricule, situation: await studentSituation(db, before.id) };
  });
  const card = result.previous && result.situation.student.status !== "archive"
    ? await pushStudentToCard(result.situation.student, { previous: result.previous })
    : null;
  return { ...result.situation, previousMatricule: result.previous, card };
}

export async function setCostumeQuantity(db, user, studentId, value) {
  if (!can(user, "payment.create")) throw new HttpError(403, "Vous n'avez pas le droit de modifier le costume");
  const quantity = costumeQuantityOf(value);
  if (!quantity) throw new HttpError(400, "Indiquez le nombre de costumes");
  return transaction(db, async () => {
    const student = await db.prepare("SELECT id FROM students WHERE id = ?").get(Number(studentId));
    if (!student) throw new HttpError(404, "Étudiant introuvable");
    const before = await costumeSituation(db, student.id);
    if (quantity === before.quantity) return before;
    const after = await costumeFor(db, Number(studentId), 0, quantity, { write: true });
    await audit(db, user.id, "costume.nombre", "students", studentId, { quantity: before.quantity }, { quantity });
    return after;
  });
}

const MATRICULE_SCHOOL_CODES = { ABS: "ABS", TECH: "AT", DROIT: "ADSP", SUP: "ASC", EXPERTISE: "AEC", CARRIERE: "ACB" };

export function matriculePrefix(yearLabel, program) {
  const school = MATRICULE_SCHOOL_CODES[String(program?.code || "").toUpperCase()]
    || String(program?.code || "AIM").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `UA${String(yearLabel || "").slice(2, 4)}${school}`;
}

/** UA + deux chiffres de l'année + code de l'école + numéro à 4 chiffres, propre à chaque école et chaque année. */
export async function nextMatricule(db, yearLabel, program) {
  const prefix = matriculePrefix(yearLabel, program);
  const rows = await db.prepare("SELECT matricule FROM students WHERE upper(matricule) LIKE ?").all(`${prefix}%`);
  let max = 0;
  for (const row of rows) {
    const rest = String(row.matricule).toUpperCase().slice(prefix.length);
    if (/^\d{4,6}$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function clean(value) {
  const text = String(value || "").trim();
  return text || null;
}

export async function updateStudent(db, user, studentId, input) {
  if (!can(user, "student.write")) throw new HttpError(403, "Vous n'avez pas le droit de modifier cette fiche");
  if (input.status && !can(user, "student.status")) {
    throw new HttpError(403, "Seul l'admin ou le super admin change le statut d'un étudiant");
  }
  const updated = await transaction(db, async () => {
    const before = await db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
    if (!before) throw new HttpError(404, "Étudiant introuvable");
    const status = input.status || before.status;
    if (!["actif", "suspendu", "archive"].includes(status)) throw new HttpError(400, "Statut inconnu");
    if (before.status === "archive" && status !== "archive") await refuseSamePerson(db, before.last_name, before.first_name, before.id);
    await db.prepare(`
      UPDATE students SET phone = ?, email = ?, guardian_name = ?, guardian_phone = ?, status = ? WHERE id = ?
    `).run(clean(input.phone), clean(input.email), clean(input.guardianName), clean(input.guardianPhone), status, studentId);
    const current = await studentSituation(db, studentId);
    await refreshCard(db, current.student, current.situation);
    await audit(db, user.id, "etudiant.modifier", "students", studentId, { status: before.status }, { status });
    return studentSituation(db, studentId);
  });
  if (updated.student.status !== "archive") pushStudentToCard(updated.student).catch(() => {});
  return updated;
}

function moneyInput(value, label) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  const amount = digits ? Number(digits) : Number.NaN;
  assertGnf(amount, label);
  return amount;
}

export async function saveFeeSchedule(db, user, input) {
  if (!can(user, "fee.write")) throw new HttpError(403, "La scolarité (admin) ou le super admin modifie le barème");
  return transaction(db, async () => {
    const current = await db.prepare("SELECT * FROM fee_schedules WHERE id = ?").get(Number(input.id));
    if (!current) throw new HttpError(404, "Barème introuvable");
    if (!OFFER_LEVELS.has(current.level)) {
      throw new HttpError(400, "Les barèmes Licence, Master et Tech Ingénieur déjà appliqués ne se modifient pas ici");
    }
    let registration;
    let installment1;
    let installment2;
    let installment3;
    if (input.tuition != null) {
      const tuitionOnly = moneyInput(input.tuition, "Frais annuels");
      if (tuitionOnly <= 0) throw new HttpError(400, "Le total des frais doit être supérieur à zéro");
      const parts = officialInstallments(tuitionOnly);
      registration = parts[0].amount;
      installment1 = parts[1].amount;
      installment2 = parts[2].amount;
      installment3 = 0;
    } else {
      registration = moneyInput(input.registration, "Échéance");
      installment1 = moneyInput(input.installment1, "Échéance");
      installment2 = moneyInput(input.installment2, "Échéance");
      installment3 = moneyInput(input.installment3 ?? 0, "Échéance");
      if ([registration, installment1, installment2, installment3].some((value) => value < 0)) {
        throw new HttpError(400, "Une échéance ne peut pas être négative");
      }
    }
    const tuition = registration + installment1 + installment2 + installment3;
    if (tuition <= 0) throw new HttpError(400, "Le total des frais doit être supérieur à zéro");
    await db.prepare(`
      INSERT INTO fee_schedule_history(fee_schedule_id, snapshot_json, changed_by) VALUES(?, ?, ?)
    `).run(current.id, JSON.stringify(current), user.id);
    await db.prepare(`
      UPDATE fee_schedules
      SET tuition_amount = ?, registration_amount = ?, installment_1 = ?, installment_2 = ?, installment_3 = ?
      WHERE id = ?
    `).run(tuition, registration, installment1, installment2, installment3, current.id);
    await audit(db, user.id, "bareme.modifier", "fee_schedules", current.id, current, { tuition });
    return db.prepare("SELECT * FROM fee_schedules WHERE id = ?").get(current.id);
  });
}

export async function updateSettings(db, user, input) {
  if (!can(user, "settings.write")) throw new HttpError(403, "Seul l'admin ou le super admin modifie les paramètres");
  const allowed = ["school_name", "school_city", "school_address", "school_phone", "school_email", "school_web", "card_threshold", "costume_price"];
  const { Setting } = db.models;
  await transaction(db, async () => {
    for (const key of allowed) {
      if (input[key] == null) continue;
      if (key === "card_threshold" || key === "costume_price") {
        const value = Number(String(input[key]).replace(/[\s.]/g, ""));
        assertGnf(value, key === "costume_price" ? "Prix du costume" : "Seuil");
        if (value < 0) throw new HttpError(400, "Le montant ne peut pas être négatif");
        await Setting.upsert({ key, value: String(value) });
      } else {
        await Setting.update({ value: String(input[key]).trim() }, { where: { key } });
      }
    }
    await audit(db, user.id, "parametres", "settings", null, null, input);
  });
}

const STAFF_DOMAIN = "univ-africaiim.com";

export function staffEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || parts[1] !== STAFF_DOMAIN || /[^a-z0-9._-]/.test(parts[0])) {
    throw new HttpError(400, "L'e-mail du compte doit se terminer par @univ-africaiim.com");
  }
  return email;
}

function roleCodeForRights(codes) {
  const elevated = ["user.write", "fee.write", "settings.write", "payment.cancel", "audit.read", "import.run", "student.status"];
  return codes.some((code) => elevated.includes(code)) ? "admin" : "gestionnaire";
}

/** Compte avec le code de son rôle à plat (user.role = "admin", …), comme le reste de l'application l'attend. */
export function accountOf(instance) {
  if (!instance) return undefined;
  const { role, ...user } = instance.get({ plain: true });
  return { ...user, role: role?.code ?? null };
}

async function loadAccount(db, userId) {
  const { Role, User } = db.models;
  return accountOf(await User.findByPk(userId, { include: { model: Role, as: "role", attributes: ["code"] } }));
}

async function activeSuperAdmins(db) {
  const { Role, User } = db.models;
  return User.count({ where: { active: 1 }, include: { model: Role, as: "role", where: { code: "super_admin" } } });
}

export async function createUser(db, actor, input) {
  if (actor.role !== "super_admin") throw new HttpError(403, "Seul le super admin peut créer un compte");
  const email = staffEmail(input.email);
  const name = String(input.fullName || "").trim();
  const password = String(input.password || "");
  if (name.length < 3) throw new HttpError(400, "Le nom est obligatoire");
  const weak = passwordIssue(password);
  if (weak) throw new HttpError(400, weak);
  const rights = normalizeRights(input.rights);
  if (!rights.length) throw new HttpError(400, "Cochez au moins une partie de l'application");
  const roleCode = input.superAdmin ? "super_admin" : roleCodeForRights(rights);
  const { Role, User } = db.models;
  const role = await Role.findOne({ where: { code: roleCode }, raw: true });
  if (!role) throw new HttpError(400, "Rôle inconnu");
  try {
    return await transaction(db, async () => {
      const user = await User.create({
        role_id: role.id,
        full_name: name,
        email,
        password_hash: hashPassword(password),
        permissions_json: input.superAdmin ? null : JSON.stringify(rights),
        must_change_password: 1,
        active: 1,
      });
      await audit(db, actor.id, "utilisateur.creer", "users", user.id, null, { email, role: roleCode, rights });
      return { id: user.id };
    });
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new HttpError(400, "Cet e-mail est déjà utilisé");
    throw error;
  }
}

export async function updateUserAccess(db, actor, userId, input) {
  if (!can(actor, "user.write")) throw new HttpError(403, "Vous n'avez pas le droit de gérer les comptes");
  const rights = normalizeRights(input.rights);
  if (!input.superAdmin && !rights.length) throw new HttpError(400, "Cochez au moins une partie de l'application");
  if (input.superAdmin && actor.role !== "super_admin") {
    throw new HttpError(403, "Seul le super admin peut donner tous les droits");
  }
  const password = String(input.password || "");
  if (password) {
    const weak = passwordIssue(password);
    if (weak) throw new HttpError(400, weak);
  }
  return transaction(db, async () => {
    const target = await loadAccount(db, userId);
    if (!target) throw new HttpError(404, "Compte introuvable");
    if (target.id === actor.id) throw new HttpError(400, "Modifiez un autre compte. Votre mot de passe se change dans « Mon compte ».");
    if (target.role === "super_admin" && actor.role !== "super_admin") {
      throw new HttpError(403, "Seul le super admin modifie un super admin");
    }
    if (target.role === "super_admin" && !input.superAdmin && (await activeSuperAdmins(db)) <= 1) {
      throw new HttpError(400, "Le dernier super admin doit garder tous les droits");
    }
    const { Role, Session, User } = db.models;
    const roleCode = input.superAdmin ? "super_admin" : roleCodeForRights(rights);
    const role = await Role.findOne({ where: { code: roleCode }, raw: true });
    const name = String(input.fullName ?? target.full_name).trim();
    if (name.length < 3) throw new HttpError(400, "Le nom est obligatoire");
    const email = input.email == null ? target.email : staffEmail(input.email);
    const taken = await User.findOne({ where: { email, id: { [Op.ne]: target.id } }, attributes: ["id"], raw: true });
    if (taken) throw new HttpError(400, "Cet e-mail est déjà utilisé");
    await User.update(
      { full_name: name, email, role_id: role.id, permissions_json: input.superAdmin ? null : JSON.stringify(rights) },
      { where: { id: target.id } },
    );
    if (password) {
      await User.update({ password_hash: hashPassword(password), must_change_password: 1 }, { where: { id: target.id } });
      await Session.destroy({ where: { user_id: target.id } });
    }
    await audit(db, actor.id, "utilisateur.modifier", "users", target.id,
      { name: target.full_name, email: target.email, role: target.role },
      { name, email, role: roleCode, rights, passwordReset: Boolean(password) });
    return { id: target.id };
  });
}

export async function deactivateUser(db, actor, userId) {
  if (!can(actor, "user.write")) throw new HttpError(403, "Vous n'avez pas le droit de gérer les comptes");
  return transaction(db, async () => {
    const target = await loadAccount(db, userId);
    if (!target) throw new HttpError(404, "Compte introuvable");
    if (target.id === actor.id) throw new HttpError(400, "Vous ne pouvez pas supprimer votre propre compte");
    if (!target.active) throw new HttpError(400, "Ce compte est déjà retiré");
    if (target.role === "super_admin" && actor.role !== "super_admin") {
      throw new HttpError(403, "Seul le super admin peut retirer un super admin");
    }
    if (target.role === "super_admin" && (await activeSuperAdmins(db)) <= 1) {
      throw new HttpError(400, "Le dernier super admin ne peut pas être supprimé");
    }
    await db.models.User.update({ active: 0 }, { where: { id: target.id } });
    await db.models.Session.destroy({ where: { user_id: target.id } });
    await audit(db, actor.id, "utilisateur.retirer", "users", target.id, { email: target.email, active: 1 }, { active: 0 });
    return { id: target.id, active: 0 };
  });
}

export async function catalog(db) {
  const { AcademicYear, Program, Setting } = db.models;
  const [programs, years, settings, fees, agents] = await Promise.all([
    Program.findAll({ attributes: ["id", "code", "name"], order: [["name", "ASC"]], raw: true }),
    AcademicYear.findAll({ attributes: ["id", "label", "active"], order: [["label", "DESC"]], raw: true }),
    Setting.findAll({ raw: true }),
    db.prepare(`
      SELECT f.*, p.name AS program_name, y.label AS year_label
      FROM fee_schedules f
      JOIN programs p ON p.id = f.program_id
      JOIN academic_years y ON y.id = f.academic_year_id
      ORDER BY p.name, f.level
    `).all(),
    db.prepare(`
      SELECT u.id, u.full_name, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 ORDER BY u.full_name
    `).all(),
  ]);
  return {
    programs,
    years,
    methods: Object.entries(METHOD_LABELS).map(([code, label]) => ({ code, label })),
    levels: [
      { code: "bachelor", label: "Bachelor" },
      { code: "master", label: "Master" },
    ],
    statuses: Object.entries(STATUS_LABELS).map(([code, label]) => ({ code, label })),
    settings: Object.fromEntries(settings.map((row) => [row.key, row.value])),
    fees,
    agents,
    registrationFees: REGISTRATION_FEES,
    cashDiscount: CASH_DISCOUNT,
    hypotheses: [
      `Les frais d'inscription s'ajoutent à la scolarité : ${formatGnf(REGISTRATION_FEES.bachelor)} en Licence et Bachelor, ${formatGnf(REGISTRATION_FEES.master)} en Master. Ils sont dus en entier au premier versement, le 5 octobre, pour tous les étudiants, y compris ceux déjà enregistrés.`,
      "Répartition de la scolarité : 20 % le 5 octobre, 40 % le 5 décembre, 40 % le 5 mars.",
      "Nouvelles fiches : Bachelor 1, 2 et 3, Master 1 et Master 2. Le tarif de départ est 24 000 000, 27 000 000 et 28 000 000. Chaque école se règle dans Tarifs.",
      `En Licence et Bachelor, un paiement de tous les frais annuels en une fois (scolarité et inscription) ouvre une remise de ${formatGnf(CASH_DISCOUNT)} sur ce total. Le Master n'a pas de remise.`,
      "Un étudiant boursier ne paie ni la scolarité ni les frais d'inscription.",
      "Les fiches déjà enregistrées gardent leur barème (Licence 25 000 000, Master 30 000 000, Tech 37 000 000).",
      "L'admin de la scolarité peut modifier ces montants. Les paiements déjà enregistrés ne changent pas.",
    ],
  };
}

export { publicStudent, METHODS, INSTALLMENTS };
