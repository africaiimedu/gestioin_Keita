import crypto from "node:crypto";
import { can } from "../auth/passwords.js";
import { transaction } from "../db/index.js";
import { amountInWords, assertGnf } from "../finance/index.js";
import { HttpError } from "../httpError.js";
import { audit, nextDocumentNumber, setting, todayInConakry } from "./domain.js";

export const EXPENSE_CATEGORIES = [
  ["fournitures", "Fournitures et matériel"],
  ["transport", "Transport et déplacements"],
  ["salaires", "Salaires et primes"],
  ["entretien", "Entretien et réparations"],
  ["evenements", "Événements et cérémonies"],
  ["services", "Services et prestations"],
  ["avance", "Avance remboursable"],
  ["autre", "Autre dépense"],
];
const CATEGORY_LABELS = Object.fromEntries(EXPENSE_CATEGORIES);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(value, label, min, max) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  if (clean.length < min) throw new HttpError(400, `${label} : ${min} caractères au minimum`);
  if (clean.length > max) throw new HttpError(400, `${label} : ${max} caractères au maximum`);
  return clean;
}

function present(row) {
  return {
    ...row,
    amount: Number(row.amount),
    categoryLabel: CATEGORY_LABELS[row.category] || CATEGORY_LABELS.autre,
    amountInWords: amountInWords(Number(row.amount)),
  };
}

async function defaultCity(db) {
  const city = String((await setting(db, "school_city")) || "").split(",")[0].trim();
  return city || "Conakry";
}

export async function expenseDefaults(db, user) {
  return {
    city: await defaultCity(db),
    giverName: user?.full_name || "",
    today: todayInConakry(),
    categories: EXPENSE_CATEGORIES.map(([code, label]) => ({ code, label })),
  };
}

export async function listExpenses(db, filters = {}) {
  const today = todayInConakry();
  const monthStart = `${today.slice(0, 8)}01`;
  const from = DAY.test(filters.from || "") ? filters.from : monthStart;
  const to = DAY.test(filters.to || "") ? filters.to : today;
  const where = ["e.issued_on BETWEEN ? AND ?"];
  const params = [from, to];
  if (CATEGORY_LABELS[filters.category]) {
    where.push("e.category = ?");
    params.push(filters.category);
  }
  if (["valide", "annule"].includes(filters.status)) {
    where.push("e.status = ?");
    params.push(filters.status);
  } else if (filters.status === "a_remettre") {
    where.push("e.status = 'valide' AND e.handed_at IS NULL");
  } else if (filters.status === "remis") {
    where.push("e.status = 'valide' AND e.handed_at IS NOT NULL");
  }
  const q = String(filters.q || "").trim().toLowerCase();
  if (q) {
    where.push("(lower(e.number) LIKE ? OR lower(e.receiver_name) LIKE ? OR lower(e.giver_name) LIKE ? OR lower(e.reason) LIKE ?)");
    params.push(...Array(4).fill(`%${q}%`));
  }
  const [rows, totals] = await Promise.all([
    db.prepare(`
      SELECT e.*, u.full_name AS created_by_name, h.full_name AS handed_by_name
      FROM expenses e LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users h ON h.id = e.handed_by
      WHERE ${where.join(" AND ")}
      ORDER BY e.issued_on DESC, e.id DESC
      LIMIT 500
    `).all(...params),
    db.prepare(`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status = 'valide' AND issued_on = ?), 0) AS today,
        COUNT(*) FILTER (WHERE status = 'valide' AND issued_on = ?) AS today_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'valide' AND issued_on >= ?), 0) AS month,
        COUNT(*) FILTER (WHERE status = 'valide' AND issued_on >= ?) AS month_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'valide' AND handed_at IS NULL), 0) AS pending,
        COUNT(*) FILTER (WHERE status = 'valide' AND handed_at IS NULL) AS pending_count
      FROM expenses WHERE issued_on <= ?
    `).get(today, today, monthStart, monthStart, today),
  ]);
  const expenses = rows.map(present);
  const valid = expenses.filter((row) => row.status === "valide");
  const byCategory = EXPENSE_CATEGORIES
    .map(([code, label]) => {
      const items = valid.filter((row) => row.category === code);
      return { code, label, count: items.length, amount: items.reduce((sum, row) => sum + row.amount, 0) };
    })
    .filter((item) => item.count)
    .sort((a, b) => b.amount - a.amount);
  return {
    from,
    to,
    expenses,
    summary: {
      today: Number(totals.today),
      todayCount: Number(totals.today_count),
      month: Number(totals.month),
      monthCount: Number(totals.month_count),
      pending: Number(totals.pending),
      pendingCount: Number(totals.pending_count),
      period: valid.reduce((sum, row) => sum + row.amount, 0),
      periodCount: valid.length,
      cancelledCount: expenses.length - valid.length,
    },
    byCategory,
  };
}

export async function createExpense(db, user, input) {
  if (!can(user, "expense.write")) throw new HttpError(403, "Vous n'avez pas le droit d'enregistrer une dépense");
  const amount = Number(input.amount);
  assertGnf(amount, "Montant");
  if (amount <= 0) throw new HttpError(400, "Le montant doit être supérieur à zéro");
  const category = CATEGORY_LABELS[input.category] ? input.category : "autre";
  const fields = {
    receiver_name: text(input.receiverName, "Nom de la personne qui reçoit", 3, 120),
    receiver_position: text(input.receiverPosition, "Poste occupé", 2, 80),
    giver_name: text(input.giverName || user.full_name, "Nom de la personne qui remet", 3, 120),
    reason: text(input.reason, "Motif", 3, 300),
    city: text(input.city || (await defaultCity(db)), "Ville", 2, 60),
  };
  const issuedOn = todayInConakry();
  const year = Number(issuedOn.slice(0, 4));
  return transaction(db, async () => {
    const seq = await nextDocumentNumber(db, "DEC", year);
    const number = `DEC-${year}-${String(seq).padStart(6, "0")}`;
    const row = await db.prepare(`
      INSERT INTO expenses(number, year, seq, issued_on, city, receiver_name, receiver_position, giver_name, amount, reason, category, verify_token, created_by)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(number, year, seq, issuedOn, fields.city, fields.receiver_name, fields.receiver_position, fields.giver_name,
      amount, fields.reason, category, crypto.randomBytes(24).toString("base64url"), user.id);
    await audit(db, user.id, "depense.creation", "expenses", row.id, null, { number, amount, category, receiver: fields.receiver_name });
    return { expense: present({ ...row, created_by_name: user.full_name }) };
  });
}

export async function cancelExpense(db, user, id, reason) {
  if (!can(user, "payment.cancel")) throw new HttpError(403, "Seul l'admin ou le super admin peut annuler une décharge");
  const why = text(reason, "Motif d'annulation", 5, 300);
  return transaction(db, async () => {
    const before = await db.prepare("SELECT * FROM expenses WHERE id = ? FOR UPDATE").get(id);
    if (!before) throw new HttpError(404, "Décharge introuvable");
    if (before.status === "annule") throw new HttpError(409, "Cette décharge est déjà annulée");
    const row = await db.prepare(`
      UPDATE expenses SET status = 'annule', cancel_reason = ?, cancelled_by = ?, cancelled_at = (now() AT TIME ZONE 'UTC')
      WHERE id = ? RETURNING *
    `).get(why, user.id, id);
    await audit(db, user.id, "depense.annulation", "expenses", id, { status: before.status }, { status: "annule", reason: why });
    return { expense: present(row) };
  });
}

export async function markExpenseHanded(db, user, id) {
  if (!can(user, "expense.write")) throw new HttpError(403, "Vous n'avez pas le droit de modifier une dépense");
  return transaction(db, async () => {
    const before = await db.prepare("SELECT * FROM expenses WHERE id = ? FOR UPDATE").get(id);
    if (!before) throw new HttpError(404, "Décharge introuvable");
    if (before.status === "annule") throw new HttpError(409, "Cette décharge est annulée : l'argent ne peut pas être marqué remis");
    if (before.handed_at) throw new HttpError(409, "L'argent de cette décharge est déjà marqué remis");
    const row = await db.prepare(`
      UPDATE expenses SET handed_at = (now() AT TIME ZONE 'UTC'), handed_by = ?
      WHERE id = ? RETURNING *
    `).get(user.id, id);
    await audit(db, user.id, "depense.remise", "expenses", id, { handed_at: null }, { handed_at: row.handed_at, number: row.number });
    return { expense: present({ ...row, handed_by_name: user.full_name }) };
  });
}

export async function expenseForPrint(db, id) {
  const row = await db.prepare(`
    UPDATE expenses e SET print_count = e.print_count + 1
    FROM users u WHERE u.id = e.created_by AND e.id = ?
    RETURNING e.*, u.full_name AS created_by_name,
      (SELECT h.full_name FROM users h WHERE h.id = e.handed_by) AS handed_by_name
  `).get(id);
  if (!row) throw new HttpError(404, "Décharge introuvable");
  return present(row);
}

export async function expenseByToken(db, token) {
  const row = await db.prepare("SELECT * FROM expenses WHERE verify_token = ?").get(String(token || ""));
  return row ? present(row) : null;
}
