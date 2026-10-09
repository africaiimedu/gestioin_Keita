import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import express from "express";
import { Op } from "sequelize";
import { verifyPassword, sessionToken, can, hashPassword, passwordIssue, RIGHTS, rightsOf } from "./auth/passwords.js";
import { verifyTotp, totp } from "./auth/totp.js";
import { closeDb, getDb, transaction } from "./db/index.js";
import { ensureAccountEmails } from "./services/identity.js";
import { runMigrations } from "./db/migrate.js";
import { seedAll } from "./seed/run.js";
import { applyIdentity } from "./seed/migrate.js";
import { ANOMALY_LABELS } from "./seed/interpret.js";
import { HttpError } from "./httpError.js";
import { formatGnf } from "./finance/index.js";
import {
  accountOf,
  activeYear,
  audit,
  cancelCostume,
  cancelPayment,
  cashJournal,
  costumeSituation,
  recordCostume,
  catalog,
  createPayment,
  createReminder,
  createStudent,
  createUser,
  deactivateUser,
  updateUserAccess,
  dashboard,
  lateStudents,
  listCashPayments,
  listCashStudents,
  listStudents,
  previewPayment,
  previewPaymentUpdate,
  unlockPayment,
  publicStudent,
  reconcile,
  saveFeeSchedule,
  setting,
  studentSituation,
  todayInConakry,
  updatePayment,
  updateSettings,
  updateStudent,
  changeMatricule,
  setCostumeQuantity,
  suggestMatricule,
} from "./services/domain.js";
import { cancelExpense, createExpense, expenseByToken, expenseDefaults, expenseForPrint, listExpenses, markExpenseHanded } from "./services/expenses.js";
import { renderDischargePdf, renderReceiptPdf } from "./services/receiptPdf.js";
import { commitImport, csvTemplate, previewImport } from "./services/importCsv.js";
import { syncStudentsToCard } from "./services/cardSync.js";
import { attachCardPortal, isCardPortal } from "./services/cardPortal.js";
import { startEmbeddedCards } from "./services/cardRuntime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const db = getDb();
const { LoginLog, Role, Session, User } = db.models;
await runMigrations(db);
if ((await User.count()) === 0) {
  if (process.env.NODE_ENV === "production") {
    console.error("Base vide : installez les données avec « npm run import -- fichier » avant de démarrer.");
    process.exit(1);
  }
  await seedAll(db);
}
await applyIdentity(db);
const newAccounts = await transaction(db, () => ensureAccountEmails(db));
if (newAccounts) console.log(`Comptes étudiants : ${newAccounts} adresses attribuées`);

// Le mode démonstration (comptes et codes à 6 chiffres affichés) ne s'ouvre jamais en production.
const DEMO = process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production";
const SESSION_HOURS = 12;
const IDLE_MS = 2 * 3600 * 1000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MINUTES = 15;
const withRole = { model: Role, as: "role", attributes: ["code", "label"] };

const app = express();
app.disable("x-powered-by");
// Derrière le proxy HTTPS de l'hébergeur (o2switch : Apache + Passenger), req.secure et req.ip
// ne sont fiables que si TRUST_PROXY est défini.
if (process.env.TRUST_PROXY) app.set("trust proxy", trustProxy(process.env.TRUST_PROXY));
app.use(compression({ filter: (req, res) => !isCardPortal(req) && compression.filter(req, res) }));
app.use((req, res, next) => {
  if (isCardPortal(req)) {
    next();
    return;
  }
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'");
  next();
});
app.get("/api/sante", async (_req, res) => {
  try {
    await db.prepare("SELECT 1").get();
    res.json({ ok: true, base: "postgresql" });
  } catch {
    res.status(503).json({ ok: false });
  }
});
attachCardPortal(app, loadUser, {
  renameMatricule: async (user, previous, next) => {
    const student = await db.prepare("SELECT id FROM students WHERE upper(matricule) = ?")
      .get(String(previous).replace(/\s+/g, "").toUpperCase());
    if (!student) return null;
    const result = await changeMatricule(db, user, student.id, next);
    return result.card && result.card.ok === false ? "carte" : "synchro";
  },
});
app.use(express.json({ limit: "8mb" }));

app.use(async (req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path.startsWith("/api/") && req.path !== "/api/connexion") {
    if (req.get("x-africaiim") !== "1") {
      res.status(403).json({ error: "Requête refusée" });
      return;
    }
  }
  req.user = await loadUser(req);
  next();
});

app.post("/api/connexion", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const ip = req.ip || "";
  if ((await recentFailures(email)) >= MAX_FAILURES) {
    res.status(429).json({ error: `Trop de tentatives. Réessayez dans ${FAILURE_WINDOW_MINUTES} minutes.` });
    return;
  }
  const user = accountOf(await User.findOne({ where: { email, active: 1 }, include: withRole }));
  if (!user || !verifyPassword(password, user.password_hash)) {
    await LoginLog.create({ user_id: user?.id ?? null, email, success: 0, ip });
    res.status(401).json({ error: "Identifiants incorrects" });
    return;
  }
  if (user.totp_required) {
    if (!verifyTotp(user.totp_secret, req.body?.totp || "")) {
      await LoginLog.create({ user_id: user.id, email, success: 0, ip });
      res.status(401).json({ error: "Code de vérification incorrect ou manquant", totpRequired: true });
      return;
    }
  }
  const id = sessionToken();
  const now = Date.now();
  await Session.create({ id, user_id: user.id, created_at: now, last_seen: now, expires_at: now + SESSION_HOURS * 3600 * 1000 });
  await LoginLog.create({ user_id: user.id, email, success: 1, ip });
  res.setHeader("Set-Cookie", cookie(req, "aim_session", id, SESSION_HOURS * 3600));
  res.json({ user: publicUser(user) });
});

app.post("/api/deconnexion", async (req, res) => {
  const id = readCookie(req, "aim_session");
  if (id) await Session.destroy({ where: { id } });
  res.setHeader("Set-Cookie", [cookie(req, "aim_session", "", 0), cookie(req, "africard", "", 0)]);
  res.json({ ok: true });
});

app.get("/api/moi", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  res.json({ user: publicUser(req.user) });
});

app.get("/api/demo", (req, res) => {
  if (!DEMO) {
    res.json({ demo: false });
    return;
  }
  res.json({ demo: true, accounts: [] });
});

app.get("/api/demo/code", async (req, res) => {
  if (!DEMO) {
    res.status(404).json({ error: "Indisponible" });
    return;
  }
  const email = String(req.query.email || "").toLowerCase();
  const user = await User.findOne({ where: { email }, attributes: ["totp_secret", "totp_required"], raw: true });
  if (!user?.totp_required) {
    res.json({ code: null });
    return;
  }
  res.json({ code: totp(user.totp_secret) });
});

app.get("/api/referentiel", requireUser, async (_req, res) => res.json(await catalog(db)));
app.get("/api/tableau", requireAction("dashboard.read"), async (req, res) => {
  res.json(await dashboard(db, readFilters(req), todayInConakry()));
});
app.get("/api/coherence", requireAction("dashboard.read"), async (_req, res) => res.json(await reconcile(db)));
app.get("/api/etudiants", requireAction("student.read"), async (req, res) => {
  const rows = await listStudents(db, {
    q: req.query.q,
    yearId: numberOrNull(req.query.annee),
    programId: numberOrNull(req.query.filiere),
    level: req.query.niveau || null,
    paymentStatus: req.query.statut || null,
    studentStatus: req.query.fiche || null,
  });
  res.json({
    students: rows.map((row) => ({ ...publicStudent(row.student), situation: row.situation })),
  });
});
app.get("/api/etudiants/prochain-matricule", requireAction("student.write"), async (req, res) => {
  res.json({ matricule: await suggestMatricule(db, req.query.ecole) });
});
app.get("/api/etudiants/:id", requireAction("student.read"), async (req, res) => {
  const current = await studentSituation(db, Number(req.params.id));
  const [payments, reminders, costume] = await Promise.all([
    db.prepare(`
      SELECT p.id, p.amount, p.paid_on, p.method, p.reference, p.installment_code, p.note, p.status,
             p.date_unconfirmed, u.full_name AS agent, r.id AS receipt_id, r.number AS receipt_number, r.print_count,
             c.reason AS cancel_reason, c.cancelled_at, c.credit_note_number
      FROM payments p
      JOIN users u ON u.id = p.received_by
      LEFT JOIN receipts r ON r.payment_id = p.id
      LEFT JOIN cancellations c ON c.payment_id = p.id
      WHERE p.student_id = ?
      ORDER BY p.paid_on, p.id
    `).all(current.student.id),
    db.prepare("SELECT id, channel, message, created_at FROM reminders WHERE student_id = ? ORDER BY id DESC").all(current.student.id),
    costumeSituation(db, current.student.id),
  ]);
  res.json({
    student: publicStudent(current.student),
    situation: current.situation,
    discounts: current.discounts,
    payments,
    reminders,
    costume,
  });
});
app.post("/api/etudiants/:id/costume", requireAction("payment.create"), async (req, res) => {
  res.status(201).json(await recordCostume(db, req.user, Number(req.params.id), req.body || {}));
});
app.put("/api/etudiants/:id/costume-nombre", requireAction("payment.create"), async (req, res) => {
  res.json(await setCostumeQuantity(db, req.user, Number(req.params.id), req.body?.quantity));
});
app.put("/api/etudiants/:id/matricule", requireAction("student.write"), async (req, res) => {
  res.json(await changeMatricule(db, req.user, Number(req.params.id), req.body?.matricule));
});
app.post("/api/costumes/:id/annuler", requireAction("payment.cancel"), async (req, res) => {
  res.json(await cancelCostume(db, req.user, Number(req.params.id), req.body?.reason));
});
app.post("/api/etudiants", requireAction("student.write"), async (req, res) => {
  const created = await createStudent(db, req.user, req.body || {});
  res.status(201).json({
    student: publicStudent(created.student),
    situation: created.situation,
  });
});
app.patch("/api/etudiants/:id", requireAction("student.write"), async (req, res) => {
  const updated = await updateStudent(db, req.user, Number(req.params.id), req.body || {});
  res.json({ student: publicStudent(updated.student), situation: updated.situation });
});
app.post("/api/paiements/apercu", requireAction("payment.create"), async (req, res) => {
  res.json(await previewPayment(db, req.body || {}));
});
app.post("/api/paiements", requireAction("payment.create"), async (req, res) => {
  const result = await createPayment(db, req.user, { ...req.body, acceptCredit: false });
  res.status(result.replay ? 200 : 201).json(result);
});
app.post("/api/paiements/:id/apercu", requireAction("payment.create"), async (req, res) => {
  res.json(await previewPaymentUpdate(db, Number(req.params.id), req.body || {}));
});
app.post("/api/paiements/:id/mettre-a-jour", requireAction("payment.create"), async (req, res) => {
  const result = await updatePayment(db, req.user, Number(req.params.id), { ...req.body, acceptCredit: false });
  res.status(result.replay ? 200 : 201).json(result);
});
app.post("/api/paiements/:id/annuler", requireAction("payment.cancel"), async (req, res) => {
  res.json(await cancelPayment(db, req.user, Number(req.params.id), req.body?.reason));
});
app.post("/api/paiements/:id/debloquer", requireUser, async (req, res) => {
  res.json(await unlockPayment(db, req.user, Number(req.params.id)));
});
app.get("/api/caisse/paiements", requireAction("payment.create"), async (req, res) => {
  res.json({ payments: await listCashPayments(db, req.query.date || null) });
});
app.get("/api/caisse/etudiants", requireAction("payment.create"), async (_req, res) => {
  res.json(await listCashStudents(db));
});
app.get("/api/recus/:id.pdf", requireAction("receipt.read"), async (req, res) => {
  const receipt = await db.prepare(`
    UPDATE receipts r SET print_count = r.print_count + 1
    FROM payments p
    WHERE p.id = r.payment_id AND r.id = ?
    RETURNING r.*, p.status AS payment_status
  `).get(Number(req.params.id));
  if (!receipt) throw new HttpError(404, "Reçu introuvable");
  const cancelled = await db.prepare("SELECT * FROM cancellations WHERE payment_id = ?").get(receipt.payment_id);
  const replacedBy = receipt.payment_status === "valide" ? await db.prepare(`
    SELECT r2.number, p2.paid_on AS "paidOn"
    FROM payments p
    JOIN payments p2 ON p2.student_id = p.student_id AND p2.status = 'valide'
      AND (p2.paid_on > p.paid_on OR (p2.paid_on = p.paid_on AND p2.id > p.id))
    JOIN receipts r2 ON r2.payment_id = p2.id
    WHERE p.id = ?
    ORDER BY p2.paid_on DESC, p2.id DESC LIMIT 1
  `).get(receipt.payment_id) : null;
  const format = req.query.format === "a5" ? "a5" : "a4";
  const pdf = await renderReceiptPdf({
    snapshot: JSON.parse(receipt.snapshot_json),
    receipt,
    school: await schoolBlock(),
    format,
    cancelled: receipt.payment_status === "annule" ? cancelled : null,
    replacedBy,
    verifyUrl: `${process.env.PUBLIC_BASE_URL || ""}/v/${receipt.verify_token}`,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${receipt.number}.pdf"`);
  res.send(pdf);
});
app.get("/api/depenses", requireAction("expense.write"), async (req, res) => {
  const [list, defaults] = await Promise.all([
    listExpenses(db, { from: req.query.du, to: req.query.au, q: req.query.q, category: req.query.categorie, status: req.query.statut }),
    expenseDefaults(db, req.user),
  ]);
  res.json({ ...list, defaults });
});
app.post("/api/depenses", requireAction("expense.write"), async (req, res) => {
  res.status(201).json(await createExpense(db, req.user, req.body || {}));
});
app.post("/api/depenses/:id/remis", requireAction("expense.write"), async (req, res) => {
  res.json(await markExpenseHanded(db, req.user, Number(req.params.id)));
});
app.post("/api/depenses/:id/annuler", requireAction("expense.write"), async (req, res) => {
  res.json(await cancelExpense(db, req.user, Number(req.params.id), req.body?.reason));
});
app.get("/api/depenses/:id.pdf", requireAction("expense.write"), async (req, res) => {
  const expense = await expenseForPrint(db, Number(req.params.id));
  const pdf = await renderDischargePdf({
    expense,
    school: await schoolBlock(),
    verifyUrl: `${process.env.PUBLIC_BASE_URL || ""}/v/${expense.verify_token}`,
  });
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${expense.number}.pdf"`);
  res.send(pdf);
});
app.get("/api/journal", requireAction("report.read"), async (req, res) => {
  res.json(await cashJournal(db, req.query.date || todayInConakry()));
});
app.get("/api/retards", requireAction("student.read"), async (_req, res) => res.json({ students: await lateStudents(db) }));
app.post("/api/relances", requireAction("reminder.create"), async (req, res) => {
  res.status(201).json(await createReminder(db, req.user, Number(req.body?.studentId), req.body?.channel || "copie"));
});
app.get("/api/audit", requireAction("audit.read"), async (_req, res) => {
  const [entries, logins] = await Promise.all([
    db.prepare(`
      SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.full_name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200
    `).all(),
    db.prepare(`
      SELECT id, email, success, ip, created_at FROM login_logs ORDER BY id DESC LIMIT 50
    `).all(),
  ]);
  res.json({ entries, logins });
});
app.get("/api/anomalies", requireAction("student.read"), async (_req, res) => {
  const batch = await db.prepare("SELECT report_json, created_at FROM import_batches WHERE status = 'importe' ORDER BY id LIMIT 1").get();
  const report = batch ? JSON.parse(batch.report_json) : { rows: [] };
  res.json({
    labels: ANOMALY_LABELS,
    createdAt: batch?.created_at || null,
    rows: (report.rows || []).filter((row) => row.anomalies?.length),
  });
});
app.get("/api/import/modele.csv", requireAction("import.run"), (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(csvTemplate());
});
app.post("/api/import/apercu", requireAction("import.run"), async (req, res) => {
  const text = String(req.body?.csv || "");
  res.json(await previewImport(db, req.body?.filename, text, req.user.id));
});
app.post("/api/import/valider", requireAction("import.run"), async (req, res) => {
  const result = await commitImport(db, req.user, Number(req.body?.batchId), req.body?.decisions || {});
  syncStudentsToCard(db).catch(() => {});
  res.json(result);
});
app.post("/api/cartes/synchroniser", requireAction("student.write"), async (_req, res) => {
  res.json(await syncStudentsToCard(db));
});
app.get("/api/export/etudiants.csv", requireAction("report.read"), async (req, res) => {
  const rows = await listStudents(db, { yearId: numberOrNull(req.query.annee), programId: numberOrNull(req.query.filiere), level: req.query.niveau || null });
  const header = ["Matricule", "Nom", "Prénom", "Filière", "Niveau", "Frais dus", "Total payé", "Reste", "Crédit", "Statut"];
  const lines = [header.join(";")];
  let due = 0;
  let paid = 0;
  let reste = 0;
  let credit = 0;
  for (const row of rows) {
    due += row.situation.due;
    paid += row.situation.paid;
    reste += row.situation.reste;
    credit += row.situation.credit;
    lines.push([
      row.student.matricule,
      row.student.last_name,
      row.student.first_name,
      row.student.program_name,
      row.student.level,
      row.situation.due,
      row.situation.paid,
      row.situation.reste,
      row.situation.credit,
      row.situation.statusLabel,
    ].join(";"));
  }
  lines.push(["", "", "", "", "TOTAUX RECALCULÉS", due, paid, reste, credit, ""].join(";"));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.send(`\uFEFF${lines.join("\n")}`);
});
app.get("/api/baremes", requireUser, async (_req, res) => {
  const [current, dues] = await Promise.all([
    catalog(db),
    db.prepare("SELECT code, due_on FROM installment_due_dates").all(),
  ]);
  res.json({ fees: current.fees, dues });
});
app.put("/api/baremes/:id", requireUser, async (req, res) => {
  res.json(await saveFeeSchedule(db, req.user, { ...req.body, id: Number(req.params.id) }));
});
app.put("/api/parametres", requireUser, async (req, res) => {
  await updateSettings(db, req.user, req.body || {});
  res.json({ ok: true, settings: (await catalog(db)).settings });
});
app.get("/api/utilisateurs", requireUser, async (req, res) => {
  if (!can(req.user, "user.write")) throw new HttpError(403, "Accès refusé");
  const rows = await User.findAll({
    where: { active: 1 },
    attributes: ["id", "full_name", "email", "active", "permissions_json"],
    include: withRole,
    order: [["full_name", "ASC"]],
  });
  const users = rows.map((row) => {
    const account = accountOf(row);
    return {
      id: account.id,
      name: account.full_name,
      email: account.email,
      active: Boolean(account.active),
      role: account.role,
      roleLabel: row.role?.label ?? null,
      rights: rightsOf(account),
    };
  });
  res.json({ users, rights: RIGHTS.map(([code, label]) => ({ code, label })) });
});
app.post("/api/utilisateurs", requireUser, async (req, res) => {
  res.status(201).json(await createUser(db, req.user, req.body || {}));
});
app.put("/api/utilisateurs/:id", requireUser, async (req, res) => {
  res.json(await updateUserAccess(db, req.user, Number(req.params.id), req.body || {}));
});
app.delete("/api/utilisateurs/:id", requireUser, async (req, res) => {
  res.json(await deactivateUser(db, req.user, Number(req.params.id)));
});
app.post("/api/compte/mot-de-passe", requireUser, async (req, res) => {
  const current = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  const must = Boolean(req.user.must_change_password);
  if (!must && !verifyPassword(current, req.user.password_hash)) throw new HttpError(400, "Mot de passe actuel incorrect");
  const weak = passwordIssue(next);
  if (weak) throw new HttpError(400, weak);
  if (must && verifyPassword(next, req.user.password_hash)) {
    throw new HttpError(400, "Choisissez un mot de passe différent du mot de passe provisoire");
  }
  await User.update({ password_hash: hashPassword(next), must_change_password: 0 }, { where: { id: req.user.id } });
  await audit(db, req.user.id, "motdepasse", "users", req.user.id, null, { changed: true, first: must });
  const fresh = accountOf(await User.findByPk(req.user.id, { include: withRole }));
  res.json({ ok: true, user: publicUser(fresh) });
});
app.get("/api/integrations/cartes", async (req, res) => {
  const token = process.env.INTEGRATION_TOKEN;
  if (!token) throw new HttpError(404, "Lien cartes désactivé");
  if (req.get("authorization") !== `Bearer ${token}`) throw new HttpError(401, "Jeton refusé");
  const rows = await listStudents(db, {});
  res.json({
    students: rows.map((row) => ({
      matricule: row.student.matricule,
      cardStatus: row.student.card_status,
      reste: row.situation.reste,
      status: row.situation.status,
    })),
  });
});

app.get("/v/:token", async (req, res) => {
  const expense = await expenseByToken(db, req.params.token);
  if (expense) {
    const cancelled = expense.status === "annule";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Vérification ${escapeHtml(expense.number)}</title>
      <link rel="stylesheet" href="/styles.css">
      <main class="verify"><p class="mark">Université AFRICAIIM</p><h1>Décharge de responsabilité financière</h1>
      <p class="state ${cancelled ? "bad" : "ok"}">${cancelled ? "ANNULÉE" : "AUTHENTIQUE"}</p>
      <p>Numéro : <strong>${escapeHtml(expense.number)}</strong></p>
      <p>Montant : <strong>${escapeHtml(formatGnf(expense.amount))}</strong></p>
      <p>Date : ${escapeHtml(expense.issued_on)}</p>
      <p>Reçu par : ${escapeHtml(expense.receiver_name)}</p>
      ${cancelled ? "" : `<p>Argent : <strong>${expense.handed_at ? "remis" : "pas encore remis"}</strong></p>`}
      <p class="muted">Aucune autre donnée n'est affichée sur cette page.</p></main></html>`);
    return;
  }
  const receipt = await db.prepare(`
    SELECT r.number, r.snapshot_json, p.status, c.cancelled_at
    FROM receipts r JOIN payments p ON p.id = r.payment_id
    LEFT JOIN cancellations c ON c.payment_id = p.id
    WHERE r.verify_token = ?
  `).get(req.params.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!receipt) {
    res.status(404).send("<!doctype html><meta charset='utf-8'><title>Reçu</title><p>Reçu introuvable.</p>");
    return;
  }
  const snap = JSON.parse(receipt.snapshot_json);
  const state = receipt.status === "annule" ? "ANNULÉ" : "AUTHENTIQUE";
  res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Vérification ${escapeHtml(receipt.number)}</title>
    <link rel="stylesheet" href="/styles.css">
    <main class="verify"><p class="mark">AfricaIIM</p><h1>Vérification de reçu</h1>
    <p class="state ${receipt.status === "annule" ? "bad" : "ok"}">${state}</p>
    <p>Numéro : <strong>${escapeHtml(receipt.number)}</strong></p>
    <p>Montant : <strong>${escapeHtml(formatGnf(snap.amount))}</strong></p>
    <p>Date : ${escapeHtml(snap.paidOn)}</p>
    <p>Étudiant : ${escapeHtml(snap.studentName)} · ${escapeHtml(snap.matricule)}</p>
    <p class="muted">Aucune autre donnée personnelle n'est affichée sur cette page.</p></main></html>`);
});

// Les fichiers de l'interface ne sont pas versionnés dans leur nom : cache court, revalidé par ETag,
// et la page d'accueil toujours redemandée pour qu'une mise en ligne soit visible tout de suite.
app.use(express.static(path.join(root, "public"), {
  maxAge: "1h",
  setHeaders: (res, file) => {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
  },
}));
app.get("/{*path}", (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(root, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...(error.details || {}) });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Erreur interne. Aucun paiement partiel n'a été enregistré." });
});

function requireUser(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Connexion requise" });
    return;
  }
  next();
}

function requireAction(action) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Connexion requise" });
      return;
    }
    if (!can(req.user, action)) {
      res.status(403).json({ error: "Accès refusé pour votre rôle" });
      return;
    }
    next();
  };
}

async function loadUser(req) {
  const id = readCookie(req, "aim_session");
  if (!id) return null;
  const session = await Session.findByPk(id, { raw: true });
  const now = Date.now();
  if (!session || now > session.expires_at || now - session.last_seen > IDLE_MS) {
    if (session) await Session.destroy({ where: { id } });
    return null;
  }
  if (now - session.last_seen > 60_000) await Session.update({ last_seen: now }, { where: { id } });
  return accountOf(await User.findOne({ where: { id: session.user_id, active: 1 }, include: withRole })) || null;
}

/** Échecs depuis la dernière connexion réussie, sur la fenêtre de blocage. Partagé entre les processus. */
async function recentFailures(email) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS n FROM login_logs
    WHERE email = ? AND success = 0
      AND created_at > (now() AT TIME ZONE 'UTC') - make_interval(mins => ?)
      AND created_at > COALESCE(
        (SELECT MAX(created_at) FROM login_logs WHERE email = ? AND success = 1), '-infinity'::timestamp)
  `).get(email, FAILURE_WINDOW_MINUTES, email);
  return row.n;
}

function cookie(req, name, value, maxAge) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`;
}

function trustProxy(value) {
  if (value === "true") return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

async function purgeExpiredSessions() {
  const now = Date.now();
  await Session.destroy({ where: { [Op.or]: [{ expires_at: { [Op.lt]: now } }, { last_seen: { [Op.lt]: now - IDLE_MS } }] } });
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.full_name,
    email: user.email,
    role: user.role,
    totp: Boolean(user.totp_required),
    mustChangePassword: Boolean(user.must_change_password),
    rights: rightsOf(user),
  };
}

function readFilters(req) {
  return {
    yearId: numberOrNull(req.query.annee),
    programId: numberOrNull(req.query.filiere),
    level: req.query.niveau || null,
    from: req.query.du || null,
    to: req.query.au || null,
    method: req.query.moyen || null,
    agentId: numberOrNull(req.query.agent),
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

async function schoolBlock() {
  const keys = ["school_name", "school_city", "school_address", "school_phone", "school_email", "school_web"];
  const [name, city, address, phone, email, web] = await Promise.all(keys.map((key) => setting(db, key)));
  return { name, city, address, phone, email, web };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}


const port = Number(process.env.PORT || 4317);
const year = await activeYear(db);
const control = await reconcile(db);
console.log(`AfricaIIM Scolarité — http://localhost:${port}`);
console.log(`Année ${year.label} · ${control.students} étudiants · encaissé ${control.paid} GNF · cohérence ${control.ok ? "OK" : "ÉCART"}`);
await purgeExpiredSessions();
setInterval(() => purgeExpiredSessions().catch((error) => console.error(`Sessions : ${error.message}`)), 3600 * 1000).unref();
startEmbeddedCards();
const server = app.listen(port, () => {
  syncStudentsToCard(db).then((report) => {
    const detail = report.ignored ? ` · ${report.ignored} fiche non envoyée` : "";
    console.log(`Cartes liées : ${report.sent} matricules${detail}`);
  }).catch((error) => {
    console.error(`Cartes : ${error.message}`);
  });
});

function shutdown(signal) {
  console.log(`${signal} reçu : arrêt propre.`);
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
