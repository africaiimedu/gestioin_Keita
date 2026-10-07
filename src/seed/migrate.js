import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.js";
import { newTotpSecret } from "../auth/totp.js";
import { DUE_DATES, OFFER_PLANS, PROGRAMS } from "./legacy.js";
import { officialInstallments } from "../finance/index.js";
import { transaction } from "../db.js";

const VERSION = "2026-10-20-40-40";

/**
 * Met à jour une base déjà remplie : 20 % / 40 % / 40 %, trois dates,
 * et les trois comptes demandés. Ne s'exécute qu'une fois.
 */
export function ensurePaymentControls(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_controls (
      payment_id INTEGER PRIMARY KEY REFERENCES payments(id),
      updates_used INTEGER NOT NULL DEFAULT 0,
      cancel_used INTEGER NOT NULL DEFAULT 0,
      unlocked INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function migrateConfirmedRules(db) {
  const current = db.prepare("SELECT value FROM settings WHERE key = 'schedule_version'").get()?.value;
  if (current === VERSION) return;
  const schedules = db.prepare("SELECT id, tuition_amount FROM fee_schedules").all();
  if (schedules.length === 0) return;

  transaction(db, () => {

  const updateFee = db.prepare(`
    UPDATE fee_schedules
    SET registration_amount = ?, installment_1 = ?, installment_2 = ?, installment_3 = 0
    WHERE id = ?
  `);
  const history = db.prepare(`
    INSERT INTO fee_schedule_history(fee_schedule_id, snapshot_json, changed_by)
    VALUES(?, ?, (SELECT id FROM users WHERE email = 'admin@africaiim.gn'))
  `);
  for (const schedule of schedules) {
    const before = db.prepare("SELECT * FROM fee_schedules WHERE id = ?").get(schedule.id);
    const parts = officialInstallments(schedule.tuition_amount);
    history.run(schedule.id, JSON.stringify(before));
    updateFee.run(parts[0].amount, parts[1].amount, parts[2].amount, schedule.id);
  }

  const year = db.prepare("SELECT id FROM academic_years WHERE active = 1").get();
  if (year) {
    const upsertDue = db.prepare(`
      INSERT INTO installment_due_dates(academic_year_id, code, due_on) VALUES(?, ?, ?)
      ON CONFLICT(academic_year_id, code) DO UPDATE SET due_on = excluded.due_on
    `);
    for (const [code, due] of Object.entries(DUE_DATES)) upsertDue.run(year.id, code, due);
    db.prepare("DELETE FROM installment_due_dates WHERE code = 'tranche_3'").run();
  }

  db.exec("DROP TRIGGER IF EXISTS payments_immutable");
  db.prepare("UPDATE payments SET installment_code = NULL WHERE idempotency_key LIKE 'pdf-%'").run();
  db.exec(`
    CREATE TRIGGER payments_immutable
    BEFORE UPDATE ON payments
    FOR EACH ROW
    WHEN NOT (
      OLD.status = 'valide'
      AND NEW.status = 'annule'
      AND OLD.amount = NEW.amount
      AND OLD.student_id = NEW.student_id
      AND OLD.paid_on = NEW.paid_on
      AND OLD.method = NEW.method
      AND IFNULL(OLD.reference, '') = IFNULL(NEW.reference, '')
      AND IFNULL(OLD.installment_code, '') = IFNULL(NEW.installment_code, '')
      AND OLD.idempotency_key = NEW.idempotency_key
      AND OLD.received_by = NEW.received_by
      AND OLD.date_unconfirmed = NEW.date_unconfirmed
    )
    BEGIN
      SELECT RAISE(ABORT, 'Un paiement validé ne peut pas être modifié');
    END
  `);

  const ensureRole = db.prepare(`
    INSERT INTO roles(code, label) VALUES(?, ?)
    ON CONFLICT(code) DO UPDATE SET label = excluded.label
  `);
  ensureRole.run("super_admin", "Super admin");
  ensureRole.run("admin", "Admin");
  ensureRole.run("gestionnaire", "Gestionnaire");

  const ensureUser = db.prepare(`
    INSERT INTO users(role_id, full_name, email, password_hash, totp_secret, totp_required, active)
    VALUES((SELECT id FROM roles WHERE code = ?), ?, ?, ?, ?, ?, 1)
    ON CONFLICT(email) DO UPDATE SET
      role_id = excluded.role_id,
      full_name = excluded.full_name,
      active = 1,
      totp_required = excluded.totp_required
  `);
  ensureUser.run("super_admin", "Super admin AfricaIIM", "superadmin@africaiim.gn", hashPassword("Super-2026!"), newTotpSecret(), 1);
  ensureUser.run("admin", "Admin scolarité", "admin@africaiim.gn", hashPassword("Admin-2026!"), newTotpSecret(), 1);
  ensureUser.run("gestionnaire", "Gestionnaire scolarité", "gestionnaire@africaiim.gn", hashPassword("Gestion-2026!"), null, 0);

  db.prepare(`
    UPDATE users SET active = 0
    WHERE email IN (
      'comptable@africaiim.gn', 'scolarite1@africaiim.gn', 'scolarite2@africaiim.gn',
      'direction@africaiim.gn', 'auditeur@africaiim.gn',
      'superadmin@africaiim.gn', 'admin@africaiim.gn', 'gestionnaire@africaiim.gn'
    )
  `).run();

  db.prepare(`
    INSERT INTO settings(key, value) VALUES('schedule_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(VERSION);
  });
}

/** Noms officiels des écoles, domaine des e-mails, et compte admin. Idempotent. */
export function applyIdentity(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  if (!columns.some((column) => column.name === "permissions_json")) {
    db.exec("ALTER TABLE users ADD COLUMN permissions_json TEXT");
  }

  const renameEmail = db.prepare("UPDATE users SET email = ? WHERE email = ?");
  const known = [
    ["gestionnaire@africaiim.gn", "gestionnaire@univ-africaiim.com"],
    ["admin@africaiim.gn", "admin@univ-africaiim.com"],
    ["superadmin@africaiim.gn", "superadmin@univ-africaiim.com"],
    ["comptable@africaiim.gn", "comptable@univ-africaiim.com"],
    ["scolarite1@africaiim.gn", "scolarite1@univ-africaiim.com"],
    ["scolarite2@africaiim.gn", "scolarite2@univ-africaiim.com"],
    ["direction@africaiim.gn", "direction@univ-africaiim.com"],
    ["auditeur@africaiim.gn", "auditeur@univ-africaiim.com"],
  ];
  for (const [from, to] of known) {
    const source = db.prepare("SELECT id FROM users WHERE email = ?").get(from);
    const taken = db.prepare("SELECT id FROM users WHERE email = ?").get(to);
    if (source && !taken) renameEmail.run(to, from);
  }
  for (const row of db.prepare("SELECT id, email FROM users WHERE email LIKE '%@africaiim.gn'").all()) {
    const next = `${row.email.split("@")[0]}@univ-africaiim.com`;
    const taken = db.prepare("SELECT id FROM users WHERE email = ?").get(next);
    if (!taken) renameEmail.run(next, row.email);
  }

  const rename = db.prepare("UPDATE programs SET name = ? WHERE code = ?");
  for (const program of PROGRAMS) rename.run(program.name, program.code);

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }

  const email = "jtoupou@univ-africaiim.com";
  const joseph = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const ready = db.prepare("SELECT value FROM settings WHERE key = 'identity_joseph'").get()?.value === "1";
  const initialPassword = () => {
    if (process.env.SUPER_ADMIN_INITIAL_PASSWORD) return process.env.SUPER_ADMIN_INITIAL_PASSWORD;
    const generated = `Aim-${randomBytes(6).toString("base64url")}9!`;
    console.log(`Mot de passe initial de ${email} : ${generated}`);
    return generated;
  };
  if (!joseph) {
    db.prepare(`
      INSERT INTO users(role_id, full_name, email, password_hash, totp_secret, totp_required, permissions_json, must_change_password, active)
      VALUES((SELECT id FROM roles WHERE code = 'super_admin'), 'Joseph Toupou', ?, ?, NULL, 0, NULL, 0, 1)
    `).run(email, hashPassword(initialPassword()));
  } else if (!ready) {
    db.prepare(`
      UPDATE users
      SET full_name = 'Joseph Toupou',
          role_id = (SELECT id FROM roles WHERE code = 'super_admin'),
          password_hash = ?,
          totp_secret = NULL,
          totp_required = 0,
          permissions_json = NULL,
          must_change_password = 0,
          active = 1
      WHERE email = ?
    `).run(hashPassword(initialPassword()), email);
  } else {
    db.prepare(`
      UPDATE users
      SET full_name = 'Joseph Toupou',
          role_id = (SELECT id FROM roles WHERE code = 'super_admin'),
          active = 1
      WHERE email = ?
    `).run(email);
  }
  if (!ready) {
    db.prepare("UPDATE users SET active = 0 WHERE email != ?").run(email);
    db.prepare("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users WHERE email = ?)").run(email);
  }
  db.prepare(`
    INSERT INTO settings(key, value) VALUES('identity_joseph', '1')
    ON CONFLICT(key) DO UPDATE SET value = '1'
  `).run();

  db.prepare(`
    UPDATE settings SET value = 'Université AFRICAIIM'
    WHERE key = 'school_name'
  `).run();

  const replacePlaceholder = (key, value) => {
    const current = db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
    if (current == null || current.includes("compléter") || current === "Conakry, République de Guinée") {
      db.prepare(`
        INSERT INTO settings(key, value) VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    }
  };
  replacePlaceholder("school_city", "Conakry, Guinée");
  replacePlaceholder("school_address", "Le Choix de l'Excellence");
  replacePlaceholder("school_phone", "(00224) 620 11 13 13");
  replacePlaceholder("school_email", "contact@univ-africaiim.com");
  replacePlaceholder("school_web", "www.universite-africaiim.com");

  widenCatalog(db);
  ensureOfferSchedules(db);
}

const STUDENT_TABLE = `
CREATE TABLE students_new (
  id INTEGER PRIMARY KEY,
  matricule TEXT NOT NULL UNIQUE,
  legacy_number INTEGER,
  last_name TEXT NOT NULL,
  first_name TEXT NOT NULL,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  level TEXT NOT NULL CHECK (level IN ('licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2')),
  phone TEXT,
  email TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'suspendu', 'archive')),
  photo_path TEXT,
  card_status TEXT NOT NULL DEFAULT 'active' CHECK (card_status IN ('active', 'limited', 'suspended')),
  source TEXT NOT NULL DEFAULT 'saisie' CHECK (source IN ('pdf', 'saisie', 'demo')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const FEE_TABLE = `
CREATE TABLE fee_schedules_new (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id),
  academic_year_id INTEGER NOT NULL REFERENCES academic_years(id),
  level TEXT NOT NULL CHECK (level IN ('licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2')),
  tuition_amount INTEGER NOT NULL CHECK (tuition_amount > 0),
  registration_amount INTEGER NOT NULL CHECK (registration_amount >= 0),
  installment_1 INTEGER NOT NULL CHECK (installment_1 >= 0),
  installment_2 INTEGER NOT NULL CHECK (installment_2 >= 0),
  installment_3 INTEGER NOT NULL CHECK (installment_3 >= 0),
  registration_included INTEGER NOT NULL DEFAULT 1 CHECK (registration_included IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (program_id, academic_year_id, level),
  CHECK (registration_amount + installment_1 + installment_2 + installment_3 = tuition_amount)
)`;

const PAYMENT_TABLE = `
CREATE TABLE payments_new (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_on TEXT NOT NULL,
  date_unconfirmed INTEGER NOT NULL DEFAULT 0 CHECK (date_unconfirmed IN (0, 1)),
  method TEXT NOT NULL CHECK (method IN ('especes', 'cheque', 'virement', 'mobile', 'orange_money', 'marchand', 'autre')),
  reference TEXT,
  installment_code TEXT CHECK (installment_code IS NULL OR installment_code IN ('inscription', 'tranche_1', 'tranche_2', 'tranche_3')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'annule')),
  idempotency_key TEXT NOT NULL UNIQUE,
  received_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function tableSql(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql || "";
}

function widenTable(db, name, createSql, extraSql) {
  const columns = db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TABLE IF EXISTS ${name}_new`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${name}_new(${columns.join(", ")}) SELECT ${columns.join(", ")} FROM ${name}`);
    db.exec(`DROP TABLE ${name}`);
    db.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
    if (extraSql) db.exec(extraSql);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction déjà close */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function widenCatalog(db) {
  if (!tableSql(db, "students").includes("'bachelor_1'")) {
    widenTable(db, "students", STUDENT_TABLE, "CREATE INDEX IF NOT EXISTS idx_students_name ON students(last_name, first_name)");
  }
  if (!tableSql(db, "fee_schedules").includes("'bachelor_1'")) {
    widenTable(db, "fee_schedules", FEE_TABLE, "");
  }
  if (!tableSql(db, "payments").includes("'marchand'")) {
    widenTable(db, "payments", PAYMENT_TABLE, `
      CREATE INDEX IF NOT EXISTS idx_payments_student ON payments(student_id);
      CREATE INDEX IF NOT EXISTS idx_payments_paid_on ON payments(paid_on);
      CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
      CREATE TRIGGER payments_immutable
      BEFORE UPDATE ON payments
      FOR EACH ROW
      WHEN NOT (
        OLD.status = 'valide'
        AND NEW.status = 'annule'
        AND OLD.amount = NEW.amount
        AND OLD.student_id = NEW.student_id
        AND OLD.paid_on = NEW.paid_on
        AND OLD.method = NEW.method
        AND IFNULL(OLD.reference, '') = IFNULL(NEW.reference, '')
        AND IFNULL(OLD.installment_code, '') = IFNULL(NEW.installment_code, '')
        AND OLD.idempotency_key = NEW.idempotency_key
        AND OLD.received_by = NEW.received_by
        AND OLD.date_unconfirmed = NEW.date_unconfirmed
      )
      BEGIN
        SELECT RAISE(ABORT, 'Un paiement validé ne peut pas être modifié');
      END;
      CREATE TRIGGER payments_no_delete
      BEFORE DELETE ON payments
      BEGIN
        SELECT RAISE(ABORT, 'Un paiement ne peut pas être supprimé');
      END;
    `);
  }
}

export function ensureOfferSchedules(db) {
  const year = db.prepare("SELECT id FROM academic_years WHERE active = 1").get();
  if (!year) return;
  const insert = db.prepare(`
    INSERT INTO fee_schedules(
      program_id, academic_year_id, level, tuition_amount, registration_amount,
      installment_1, installment_2, installment_3, registration_included
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(program_id, academic_year_id, level) DO NOTHING
  `);
  const programs = db.prepare("SELECT id FROM programs").all();
  for (const program of programs) {
    for (const [level, plan] of Object.entries(OFFER_PLANS)) {
      insert.run(program.id, year.id, level, plan.tuition, plan.parts[0], plan.parts[1], plan.parts[2], plan.parts[3]);
    }
  }
}
