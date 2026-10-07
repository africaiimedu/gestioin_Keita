import { hashPassword } from "../auth/passwords.js";
import { newTotpSecret } from "../auth/totp.js";
import { ensureOfferSchedules } from "./migrate.js";
import { DUE_DATES, FEE_PLANS, LEGACY_ROWS, PROGRAMS, feeOf, levelOf } from "./legacy.js";
import { ANOMALY_LABELS, interpretLegacyRow } from "./interpret.js";

const IMPORT_DATE = "2026-10-01";

export function buildLegacyReport() {
  return LEGACY_ROWS.map((row) => {
    const level = levelOf(row);
    const fee = feeOf(level);
    const read = interpretLegacyRow(row, fee);
    return {
      line: row.n,
      name: `${row.last} ${row.first}`.trim(),
      school: row.school,
      level,
      fee,
      raw: row.nums,
      method: row.method,
      ...read,
      anomalyLabels: read.anomalies.map((code) => ANOMALY_LABELS[code] || code),
    };
  });
}

export function seedAll(db) {
  const insertRole = db.prepare("INSERT INTO roles(code, label) VALUES(?, ?)");
  const roles = [
    ["super_admin", "Super admin"],
    ["admin", "Admin"],
    ["gestionnaire", "Gestionnaire"],
  ];
  for (const role of roles) insertRole.run(...role);

  const insertUser = db.prepare(`
    INSERT INTO users(role_id, full_name, email, password_hash, totp_secret, totp_required)
    VALUES((SELECT id FROM roles WHERE code = ?), ?, ?, ?, ?, ?)
  `);
  const accounts = [
    ["super_admin", "Super admin AfricaIIM", "superadmin@univ-africaiim.com", "Super-2026!", 1],
    ["admin", "Admin scolarité", "admin@univ-africaiim.com", "Admin-2026!", 1],
    ["gestionnaire", "Gestionnaire scolarité", "gestionnaire@univ-africaiim.com", "Gestion-2026!", 0],
    ["admin", "Mohamed Keita", "mohamed.keita@univ-africaiim.com", "Kcondetto05", 0],
  ];
  for (const [role, name, email, password, totp] of accounts) {
    insertUser.run(role, name, email, hashPassword(password), totp ? newTotpSecret() : null, totp);
  }

  db.prepare(`
    INSERT INTO academic_years(label, starts_on, ends_on, active) VALUES('2026-2027', '2026-09-01', '2027-07-31', 1)
  `).run();
  const yearId = db.prepare("SELECT id FROM academic_years WHERE label = '2026-2027'").get().id;

  const insertProgram = db.prepare("INSERT INTO programs(code, name) VALUES(?, ?)");
  for (const program of PROGRAMS) insertProgram.run(program.code, program.name);

  const insertFee = db.prepare(`
    INSERT INTO fee_schedules(
      program_id, academic_year_id, level, tuition_amount, registration_amount,
      installment_1, installment_2, installment_3, registration_included
    ) VALUES((SELECT id FROM programs WHERE code = ?), ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const program of PROGRAMS) {
    const levels = program.code === "TECH" ? ["tech"] : ["licence", "master"];
    for (const level of levels) {
      const plan = FEE_PLANS[level];
      insertFee.run(program.code, yearId, level, plan.tuition, plan.parts[0], plan.parts[1], plan.parts[2], plan.parts[3]);
    }
  }

  ensureOfferSchedules(db);

  const insertDue = db.prepare("INSERT INTO installment_due_dates(academic_year_id, code, due_on) VALUES(?, ?, ?)");
  for (const [code, due] of Object.entries(DUE_DATES)) insertDue.run(yearId, code, due);

  const settings = {
    school_name: "Université AFRICAIIM",
    school_city: "Conakry, République de Guinée",
    school_address: "Adresse à compléter par l'administrateur",
    school_phone: "Téléphone à compléter",
    card_threshold: "5000000",
    registration_included: "1",
    academic_year_label: "2026-2027",
    schedule_version: "2026-10-20-40-40",
  };
  const insertSetting = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
  for (const [key, value] of Object.entries(settings)) insertSetting.run(key, value);

  const report = buildLegacyReport();
  const insertStudent = db.prepare(`
    INSERT INTO students(
      matricule, legacy_number, last_name, first_name, program_id, academic_year_id, level, source, status
    ) VALUES(?, ?, ?, ?, (SELECT id FROM programs WHERE code = ?), ?, ?, 'pdf', 'actif')
  `);
  const insertPayment = db.prepare(`
    INSERT INTO payments(
      student_id, amount, paid_on, date_unconfirmed, method, installment_code, note, idempotency_key, received_by
    ) VALUES(?, ?, ?, 1, ?, ?, ?, ?, (SELECT id FROM users WHERE email = 'gestionnaire@univ-africaiim.com'))
  `);

  for (const row of report) {
    const source = LEGACY_ROWS.find((item) => item.n === row.line);
    const matricule = `AIM-2026-${String(row.line).padStart(4, "0")}`;
    const result = insertStudent.run(matricule, row.line, source.last, source.first || "(prénom manquant)", source.school, yearId, row.level);
    const studentId = Number(result.lastInsertRowid);
    for (const payment of row.payments) {
      insertPayment.run(
        studentId,
        payment.amount,
        IMPORT_DATE,
        source.method || "autre",
        null,
        `Import du fichier de suivi, ligne ${row.line}, ancienne colonne ${payment.code}. Date réelle inconnue, à confirmer.`,
        `pdf-${row.line}-${payment.code}`,
      );
    }
  }

  db.prepare(`
    INSERT INTO students(
      matricule, last_name, first_name, program_id, academic_year_id, level, source, phone
    ) VALUES(
      'AIM-2026-0099', 'DÉMO', 'Formation',
      (SELECT id FROM programs WHERE code = 'ABS'), ?, 'licence', 'demo', '600000000'
    )
  `).run(yearId);

  db.prepare(`
    INSERT INTO import_batches(filename, status, report_json, created_by)
    VALUES('Suivi-Paiement-des-Etudiants.pdf', 'importe', ?, (SELECT id FROM users WHERE email = 'admin@univ-africaiim.com'))
  `).run(JSON.stringify({
    source: "pdf",
    note: "Import historique. Le reste et le total du PDF ne sont pas utilisés : chaque tranche est devenue un paiement, et les soldes sont recalculés.",
    importedOn: IMPORT_DATE,
    rows: report.map((row) => ({
      line: row.line,
      name: row.name,
      school: row.school,
      level: row.level,
      raw: row.raw,
      fileTotal: row.fileTotal,
      fileReste: row.fileReste,
      paidRetained: row.paid || 0,
      anomalies: row.anomalies,
      anomalyLabels: row.anomalyLabels,
    })),
  }));

  db.prepare(`
    INSERT INTO audit_logs(user_id, action, entity, entity_id, after_json)
    VALUES((SELECT id FROM users WHERE email = 'admin@univ-africaiim.com'), 'import', 'import_batches', '1', ?)
  `).run(JSON.stringify({ students: report.length }));
}
