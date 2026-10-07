import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { verifyPassword, sessionToken, can, hashPassword, passwordIssue, RIGHTS, rightsOf } from "./auth/passwords.js";
import { verifyTotp, totp } from "./auth/totp.js";
import { getDb } from "./db.js";
import { seedAll } from "./seed/run.js";
import { applyIdentity, ensurePaymentControls, migrateConfirmedRules } from "./seed/migrate.js";
import { ANOMALY_LABELS } from "./seed/interpret.js";
import { HttpError } from "./httpError.js";
import { formatGnf } from "./finance/index.js";
import {
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
  issueEnrollmentReceipt,
  updateUserAccess,
  dashboard,
  lateStudents,
  listCashPayments,
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
} from "./services/domain.js";
import { renderEnrollmentPdf, renderReceiptPdf } from "./services/receiptPdf.js";
import { commitImport, csvTemplate, previewImport } from "./services/importCsv.js";
import { syncStudentsToCard } from "./services/cardSync.js";
import { attachCardPortal, isCardPortal } from "./services/cardPortal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(path.join(root, ".env"));

const db = getDb();
if (Number(db.prepare("SELECT COUNT(*) AS n FROM users").get().n) === 0) seedAll(db);
migrateConfirmedRules(db);
ensurePaymentControls(db);
applyIdentity(db);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  if (isCardPortal(req)) {
    next();
    return;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'");
  next();
});
attachCardPortal(app, loadUser);
app.use(express.json({ limit: "8mb" }));

const failures = new Map();

app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.path.startsWith("/api/") && req.path !== "/api/connexion") {
    if (req.get("x-africaiim") !== "1") {
      res.status(403).json({ error: "Requête refusée" });
      return;
    }
  }
  req.user = loadUser(req);
  next();
});

app.post("/api/connexion", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const ip = req.ip || "";
  const bucket = failures.get(email) || [];
  const recent = bucket.filter((time) => Date.now() - time < 15 * 60 * 1000);
  if (recent.length >= 8) {
    res.status(429).json({ error: "Trop de tentatives. Réessayez dans 15 minutes." });
    return;
  }
  const user = db.prepare(`
    SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE email = ? AND active = 1
  `).get(email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    recent.push(Date.now());
    failures.set(email, recent);
    db.prepare("INSERT INTO login_logs(user_id, email, success, ip) VALUES(?, ?, 0, ?)").run(user?.id ?? null, email, ip);
    res.status(401).json({ error: "Identifiants incorrects" });
    return;
  }
  if (user.totp_required) {
    if (!verifyTotp(user.totp_secret, req.body?.totp || "")) {
      recent.push(Date.now());
      failures.set(email, recent);
      db.prepare("INSERT INTO login_logs(user_id, email, success, ip) VALUES(?, ?, 0, ?)").run(user.id, email, ip);
      res.status(401).json({ error: "Code de vérification incorrect ou manquant", totpRequired: true });
      return;
    }
  }
  failures.delete(email);
  const id = sessionToken();
  const now = Date.now();
  db.prepare("INSERT INTO sessions(id, user_id, created_at, last_seen, expires_at) VALUES(?, ?, ?, ?, ?)").run(id, user.id, now, now, now + 12 * 3600 * 1000);
  db.prepare("INSERT INTO login_logs(user_id, email, success, ip) VALUES(?, ?, 1, ?)").run(user.id, email, ip);
  res.setHeader("Set-Cookie", `aim_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`);
  res.json({ user: publicUser(user) });
});

app.post("/api/deconnexion", (req, res) => {
  const id = readCookie(req, "aim_session");
  if (id) db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  res.setHeader("Set-Cookie", [
    "aim_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    "africard=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
  ]);
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
  if (process.env.DEMO_MODE !== "true") {
    res.json({ demo: false });
    return;
  }
  res.json({ demo: true, accounts: [] });
});

app.get("/api/demo/code", (req, res) => {
  if (process.env.DEMO_MODE !== "true") {
    res.status(404).json({ error: "Indisponible" });
    return;
  }
  const email = String(req.query.email || "").toLowerCase();
  const user = db.prepare("SELECT totp_secret, totp_required FROM users WHERE email = ?").get(email);
  if (!user?.totp_required) {
    res.json({ code: null });
    return;
  }
  res.json({ code: totp(user.totp_secret) });
});

app.get("/api/referentiel", requireUser, (_req, res) => res.json(catalog(db)));
app.get("/api/tableau", requireAction("dashboard.read"), (req, res) => {
  res.json(dashboard(db, readFilters(req), todayInConakry()));
});
app.get("/api/coherence", requireAction("dashboard.read"), (_req, res) => res.json(reconcile(db)));
app.get("/api/etudiants", requireAction("student.read"), (req, res) => {
  const rows = listStudents(db, {
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
app.get("/api/etudiants/:id", requireAction("student.read"), (req, res) => {
  const current = studentSituation(db, Number(req.params.id));
  const payments = db.prepare(`
    SELECT p.id, p.amount, p.paid_on, p.method, p.reference, p.installment_code, p.note, p.status,
           p.date_unconfirmed, u.full_name AS agent, r.id AS receipt_id, r.number AS receipt_number, r.print_count,
           c.reason AS cancel_reason, c.cancelled_at, c.credit_note_number
    FROM payments p
    JOIN users u ON u.id = p.received_by
    LEFT JOIN receipts r ON r.payment_id = p.id
    LEFT JOIN cancellations c ON c.payment_id = p.id
    WHERE p.student_id = ?
    ORDER BY p.paid_on, p.id
  `).all(current.student.id);
  const reminders = db.prepare("SELECT id, channel, message, created_at FROM reminders WHERE student_id = ? ORDER BY id DESC").all(current.student.id);
  const enrollment = db.prepare("SELECT id, number, created_at FROM enrollment_receipts WHERE student_id = ?").get(current.student.id);
  res.json({
    student: publicStudent(current.student),
    situation: current.situation,
    discounts: current.discounts,
    payments,
    reminders,
    enrollment,
    costume: costumeSituation(db, current.student.id),
  });
});
app.post("/api/etudiants/:id/costume", requireAction("payment.create"), (req, res) => {
  res.status(201).json(recordCostume(db, req.user, Number(req.params.id), req.body || {}));
});
app.post("/api/costumes/:id/annuler", requireAction("payment.cancel"), (req, res) => {
  res.json(cancelCostume(db, req.user, Number(req.params.id), req.body?.reason));
});
app.post("/api/etudiants", requireAction("student.write"), (req, res) => {
  const created = createStudent(db, req.user, req.body || {});
  res.status(201).json({
    student: publicStudent(created.student),
    situation: created.situation,
    enrollmentReceiptId: created.enrollmentReceiptId,
    enrollmentReceiptNumber: created.enrollmentReceiptNumber,
  });
});
app.post("/api/etudiants/:id/inscription", requireAction("receipt.read"), (req, res) => {
  const studentId = Number(req.params.id);
  const existing = db.prepare("SELECT id FROM enrollment_receipts WHERE student_id = ?").get(studentId);
  if (!existing && !can(req.user, "student.write")) throw new HttpError(403, "Vous n'avez pas le droit d'émettre un reçu d'inscription");
  const receipt = issueEnrollmentReceipt(db, req.user, studentId);
  res.status(receipt.created ? 201 : 200).json(receipt);
});
app.patch("/api/etudiants/:id", requireAction("student.write"), (req, res) => {
  const updated = updateStudent(db, req.user, Number(req.params.id), req.body || {});
  res.json({ student: publicStudent(updated.student), situation: updated.situation });
});
app.post("/api/paiements/apercu", requireAction("payment.create"), (req, res) => {
  res.json(previewPayment(db, req.body || {}));
});
app.post("/api/paiements", requireAction("payment.create"), (req, res) => {
  const result = createPayment(db, req.user, req.body || {});
  res.status(result.replay ? 200 : 201).json(result);
});
app.post("/api/paiements/:id/apercu", requireAction("payment.create"), (req, res) => {
  res.json(previewPaymentUpdate(db, Number(req.params.id), req.body || {}));
});
app.post("/api/paiements/:id/mettre-a-jour", requireAction("payment.create"), (req, res) => {
  const result = updatePayment(db, req.user, Number(req.params.id), req.body || {});
  res.status(result.replay ? 200 : 201).json(result);
});
app.post("/api/paiements/:id/annuler", requireAction("payment.cancel"), (req, res) => {
  res.json(cancelPayment(db, req.user, Number(req.params.id), req.body?.reason));
});
app.post("/api/paiements/:id/debloquer", requireUser, (req, res) => {
  res.json(unlockPayment(db, req.user, Number(req.params.id)));
});
app.get("/api/caisse/paiements", requireAction("payment.create"), (req, res) => {
  res.json({ payments: listCashPayments(db, req.query.date || null) });
});
app.get("/api/recus/:id.pdf", requireAction("receipt.read"), async (req, res) => {
  const receipt = db.prepare(`
    SELECT r.*, p.status AS payment_status FROM receipts r JOIN payments p ON p.id = r.payment_id WHERE r.id = ?
  `).get(Number(req.params.id));
  if (!receipt) throw new HttpError(404, "Reçu introuvable");
  db.prepare("UPDATE receipts SET print_count = print_count + 1 WHERE id = ?").run(receipt.id);
  const cancelled = db.prepare("SELECT * FROM cancellations WHERE payment_id = ?").get(receipt.payment_id);
  const format = req.query.format === "a5" ? "a5" : "a4";
  const pdf = await renderReceiptPdf({
    snapshot: JSON.parse(receipt.snapshot_json),
    receipt,
    school: schoolBlock(),
    format,
    cancelled: receipt.payment_status === "annule" ? cancelled : null,
    verifyUrl: `${process.env.PUBLIC_BASE_URL || ""}/v/${receipt.verify_token}`,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${receipt.number}.pdf"`);
  res.send(pdf);
});
app.get("/api/inscriptions/:id.pdf", requireAction("receipt.read"), async (req, res) => {
  const receipt = db.prepare("SELECT * FROM enrollment_receipts WHERE id = ?").get(Number(req.params.id));
  if (!receipt) throw new HttpError(404, "Reçu d'inscription introuvable");
  db.prepare("UPDATE enrollment_receipts SET print_count = print_count + 1 WHERE id = ?").run(receipt.id);
  const pdf = await renderEnrollmentPdf({
    snapshot: JSON.parse(receipt.snapshot_json),
    receipt,
    school: schoolBlock(),
    format: req.query.format === "a5" ? "a5" : "a4",
    verifyUrl: `${process.env.PUBLIC_BASE_URL || ""}/v/${receipt.verify_token}`,
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${receipt.number}.pdf"`);
  res.send(pdf);
});
app.get("/api/journal", requireAction("report.read"), (req, res) => {
  res.json(cashJournal(db, req.query.date || todayInConakry()));
});
app.get("/api/retards", requireAction("student.read"), (_req, res) => res.json({ students: lateStudents(db) }));
app.post("/api/relances", requireAction("reminder.create"), (req, res) => {
  res.status(201).json(createReminder(db, req.user, Number(req.body?.studentId), req.body?.channel || "copie"));
});
app.get("/api/audit", requireAction("audit.read"), (_req, res) => {
  res.json({
    entries: db.prepare(`
      SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.full_name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200
    `).all(),
    logins: db.prepare(`
      SELECT id, email, success, ip, created_at FROM login_logs ORDER BY id DESC LIMIT 50
    `).all(),
  });
});
app.get("/api/anomalies", requireAction("student.read"), (_req, res) => {
  const batch = db.prepare("SELECT report_json, created_at FROM import_batches WHERE status = 'importe' ORDER BY id LIMIT 1").get();
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
app.post("/api/import/apercu", requireAction("import.run"), (req, res) => {
  const text = String(req.body?.csv || "");
  res.json(previewImport(db, req.body?.filename, text, req.user.id));
});
app.post("/api/import/valider", requireAction("import.run"), (req, res) => {
  const result = commitImport(db, req.user, Number(req.body?.batchId), req.body?.decisions || {});
  syncStudentsToCard(db).catch(() => {});
  res.json(result);
});
app.post("/api/cartes/synchroniser", requireAction("student.write"), async (_req, res, next) => {
  try {
    res.json(await syncStudentsToCard(db));
  } catch (error) {
    next(error);
  }
});
app.get("/api/export/etudiants.csv", requireAction("report.read"), (req, res) => {
  const rows = listStudents(db, { yearId: numberOrNull(req.query.annee), programId: numberOrNull(req.query.filiere), level: req.query.niveau || null });
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
app.get("/api/baremes", requireUser, (_req, res) => res.json({ fees: catalog(db).fees, dues: db.prepare("SELECT code, due_on FROM installment_due_dates").all() }));
app.put("/api/baremes/:id", requireUser, (req, res) => {
  res.json(saveFeeSchedule(db, req.user, { ...req.body, id: Number(req.params.id) }));
});
app.put("/api/parametres", requireUser, (req, res) => {
  updateSettings(db, req.user, req.body || {});
  res.json({ ok: true, settings: catalog(db).settings });
});
app.get("/api/utilisateurs", requireUser, (req, res) => {
  if (!can(req.user, "user.write")) throw new HttpError(403, "Accès refusé");
  const users = db.prepare(`
    SELECT u.id, u.full_name, u.email, u.active, u.permissions_json, r.code AS role, r.label AS role_label
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active = 1 ORDER BY u.full_name
  `).all().map((row) => ({
    id: row.id,
    name: row.full_name,
    email: row.email,
    active: Boolean(row.active),
    role: row.role,
    roleLabel: row.role_label,
    rights: rightsOf(row),
  }));
  res.json({ users, rights: RIGHTS.map(([code, label]) => ({ code, label })) });
});
app.post("/api/utilisateurs", requireUser, (req, res) => {
  res.status(201).json(createUser(db, req.user, req.body || {}));
});
app.put("/api/utilisateurs/:id", requireUser, (req, res) => {
  res.json(updateUserAccess(db, req.user, Number(req.params.id), req.body || {}));
});
app.delete("/api/utilisateurs/:id", requireUser, (req, res) => {
  res.json(deactivateUser(db, req.user, Number(req.params.id)));
});
app.post("/api/compte/mot-de-passe", requireUser, (req, res) => {
  const current = String(req.body?.current || "");
  const next = String(req.body?.next || "");
  const must = Boolean(req.user.must_change_password);
  if (!must && !verifyPassword(current, req.user.password_hash)) throw new HttpError(400, "Mot de passe actuel incorrect");
  const weak = passwordIssue(next);
  if (weak) throw new HttpError(400, weak);
  if (must && verifyPassword(next, req.user.password_hash)) {
    throw new HttpError(400, "Choisissez un mot de passe différent du mot de passe provisoire");
  }
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hashPassword(next), req.user.id);
  audit(db, req.user.id, "motdepasse", "users", req.user.id, null, { changed: true, first: must });
  const fresh = db.prepare(`
    SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
  `).get(req.user.id);
  res.json({ ok: true, user: publicUser(fresh) });
});
app.get("/api/integrations/cartes", (req, res) => {
  const token = process.env.INTEGRATION_TOKEN;
  if (!token) throw new HttpError(404, "Lien cartes désactivé");
  if (req.get("authorization") !== `Bearer ${token}`) throw new HttpError(401, "Jeton refusé");
  const rows = listStudents(db, {});
  res.json({
    students: rows.map((row) => ({
      matricule: row.student.matricule,
      cardStatus: row.student.card_status,
      reste: row.situation.reste,
      status: row.situation.status,
    })),
  });
});

app.get("/v/:token", (req, res) => {
  const enrollment = db.prepare("SELECT number, snapshot_json FROM enrollment_receipts WHERE verify_token = ?").get(req.params.token);
  if (enrollment) {
    const snap = JSON.parse(enrollment.snapshot_json);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Vérification ${escapeHtml(enrollment.number)}</title>
      <link rel="stylesheet" href="/styles.css">
      <main class="verify"><p class="mark">Université AFRICAIIM</p><h1>Reçu d'inscription</h1>
      <p class="state ok">AUTHENTIQUE</p>
      <p>Numéro : <strong>${escapeHtml(enrollment.number)}</strong></p>
      <p>Étudiant : ${escapeHtml(snap.studentName)}</p>
      <p>Matricule : ${escapeHtml(snap.matricule)}</p>
      <p>École : ${escapeHtml(snap.program)}</p>
      <p class="muted">Ce document confirme l'inscription. Il ne constate pas un paiement.</p></main></html>`);
    return;
  }
  const receipt = db.prepare(`
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

app.use(express.static(path.join(root, "public")));
app.get("/{*path}", (_req, res) => {
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

function loadUser(req) {
  const id = readCookie(req, "aim_session");
  if (!id) return null;
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  const now = Date.now();
  if (!session || now > Number(session.expires_at) || now - Number(session.last_seen) > 2 * 3600 * 1000) {
    if (session) db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  if (now - Number(session.last_seen) > 60_000) db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(now, id);
  return db.prepare(`
    SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND u.active = 1
  `).get(session.user_id);
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

function schoolBlock() {
  return {
    name: setting(db, "school_name"),
    city: setting(db, "school_city"),
    address: setting(db, "school_address"),
    phone: setting(db, "school_phone"),
    email: setting(db, "school_email"),
    web: setting(db, "school_web"),
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(index + 1).trim();
  }
}

const port = Number(process.env.PORT || 4317);
const year = activeYear(db);
const control = reconcile(db);
console.log(`AfricaIIM Scolarité — http://localhost:${port}`);
console.log(`Année ${year.label} · ${control.students} étudiants · encaissé ${control.paid} GNF · cohérence ${control.ok ? "OK" : "ÉCART"}`);
app.listen(port, () => {
  syncStudentsToCard(db).then((report) => {
    const detail = report.ignored ? ` · ${report.ignored} fiche non envoyée` : "";
    console.log(`Cartes liées : ${report.sent} matricules${detail}`);
  }).catch((error) => {
    console.error(`Cartes : ${error.message}`);
  });
});
