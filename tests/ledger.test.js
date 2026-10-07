import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "aim-"));
process.env.DB_PATH = path.join(dir, "test.sqlite");
process.env.UPLOAD_DIR = path.join(dir, "uploads");

let db;
let domain;
let comptable;
let agent;
let direction;
let demo;

describe("registre", { concurrency: false }, () => {
before(async () => {
  const database = await import("../src/db.js");
  const seed = await import("../src/seed/run.js");
  domain = await import("../src/services/domain.js");
  db = database.getDb();
  seed.seedAll(db);
  comptable = db.prepare("SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE email = 'gestionnaire@univ-africaiim.com'").get();
  agent = db.prepare("SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE email = 'admin@univ-africaiim.com'").get();
  direction = { id: 1, role: "invite", full_name: "Sans droit" };
  demo = db.prepare("SELECT id FROM students WHERE matricule = 'AIM-2026-0099'").get();
});

function situationOf(legacyNumber) {
  const student = db.prepare("SELECT id FROM students WHERE legacy_number = ?").get(legacyNumber);
  return domain.studentSituation(db, student.id, "2026-10-06").situation;
}

test("les 62 lignes du PDF et les cas financiers réels", () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM students WHERE source = 'pdf'").get().n, 62);
  const sow = situationOf(1);
  assert.equal(sow.paid, 25_000_000);
  assert.equal(sow.due, 26_000_000);
  assert.equal(sow.reste, 1_000_000);
  assert.equal(sow.status, "partiel");

  const partiel = situationOf(3);
  assert.equal(partiel.paid, 5_000_000);
  assert.equal(partiel.reste, 21_000_000);

  const tech = situationOf(17);
  assert.equal(tech.paid, 16_000_000);
  assert.equal(tech.reste, 22_000_000);

  const master = situationOf(47);
  assert.equal(master.paid, 26_500_000);
  assert.equal(master.reste, 6_500_000);

  const aucun = situationOf(9);
  assert.equal(aucun.paid, 0);
  assert.equal(aucun.status, "en_retard");

  const inscriptionSeule = situationOf(6);
  assert.equal(inscriptionSeule.paid, 1_000_000);
  assert.equal(inscriptionSeule.status, "en_retard");

  const sansInscription = situationOf(3);
  assert.equal(sansInscription.paid, 5_000_000);
  assert.equal(sansInscription.status, "en_retard");
  assert.equal(sansInscription.overdueAmount, 1_000_000);

  const bareme = db.prepare("SELECT registration_amount, installment_1, installment_2, installment_3 FROM fee_schedules WHERE level = 'licence' LIMIT 1").get();
  assert.deepEqual([bareme.registration_amount, bareme.installment_1, bareme.installment_2, bareme.installment_3], [5_000_000, 10_000_000, 10_000_000, 0]);
});

test("cohérence : somme des étudiants = total général", () => {
  const report = domain.reconcile(db, "2026-10-06");
  assert.equal(report.ok, true, JSON.stringify(report.gaps));
  const dashboard = domain.dashboard(db, {}, "2026-10-06");
  assert.equal(dashboard.paidAll, report.paid);
  assert.equal(dashboard.due, report.due);
  assert.equal(dashboard.reste, report.reste);
  assert.equal(dashboard.controlOk, true);
});

test("idempotence, refus des montants invalides, deux paiements, annulation, reçus sans trou", () => {
  assert.throws(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 0, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-nulle-0001",
  }, "2026-10-06"));
  assert.throws(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: -500, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-negative-1",
  }, "2026-10-06"));
  assert.throws(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1.5, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-virgule-01",
  }, "2026-10-06"));

  const first = domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-demo-0001",
  }, "2026-10-06");
  const replay = domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-demo-0001",
  }, "2026-10-06");
  assert.equal(replay.replay, true);
  assert.equal(replay.paymentId, first.paymentId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE idempotency_key = 'cle-demo-0001'").get().n, 1);

  const second = domain.createPayment(db, agent, {
    studentId: demo.id, amount: 4_000_000, paidOn: "2026-10-06", method: "mobile", idempotencyKey: "cle-demo-0002",
  }, "2026-10-06");
  assert.equal(second.after.paid, 5_000_000);
  assert.equal(second.after.reste, 21_000_000);
  assert.equal(first.receiptNumber, "REC-2026-000001");
  assert.equal(second.receiptNumber, "REC-2026-000002");

  assert.throws(() => domain.createPayment(db, direction, {
    studentId: demo.id, amount: 1000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-direction-1",
  }, "2026-10-06"));

  domain.cancelPayment(db, agent, first.paymentId, "Erreur de saisie en caisse", "2026-10-06");
  const afterCancel = domain.studentSituation(db, demo.id, "2026-10-06").situation;
  assert.equal(afterCancel.paid, 4_000_000);
  const replacement = domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "cheque", reference: "CHQ-100", idempotencyKey: "cle-demo-0003",
  }, "2026-10-06");
  assert.equal(replacement.after.paid, 5_000_000);
  assert.equal(replacement.receiptNumber, "REC-2026-000003");

  assert.throws(() => db.prepare("UPDATE payments SET amount = 1 WHERE id = ?").run(second.paymentId));
  assert.throws(() => db.prepare("DELETE FROM payments WHERE id = ?").run(second.paymentId));

  const numbers = db.prepare("SELECT seq FROM receipts ORDER BY seq").all().map((row) => row.seq);
  numbers.forEach((seq, index) => assert.equal(seq, index + 1));
});

test("une remise enregistrée change les frais dus, pas les paiements", () => {
  const student = db.prepare("SELECT id FROM students WHERE legacy_number = 7").get();
  const before = domain.studentSituation(db, student.id, "2026-10-06").situation;
  assert.equal(before.paid, 23_800_000);
  assert.equal(before.reste, 2_200_000);
  db.prepare(`
    INSERT INTO discounts(student_id, label, mode, value, reason, approved_by)
    VALUES(?, 'Bourse test', 'fixe', 2200000, 'Cas de test, pas une donnée du PDF', ?)
  `).run(student.id, comptable.id);
  const after = domain.studentSituation(db, student.id, "2026-10-06").situation;
  assert.equal(after.due, 23_800_000);
  assert.equal(after.reste, 0);
  assert.equal(after.status, "solde");
  db.prepare("DELETE FROM discounts WHERE student_id = ?").run(student.id);
});

test("une nouvelle fiche produit un reçu d'inscription, et l'e-mail du personnel est contrôlé", () => {
  const program = db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = domain.createStudent(db, agent, {
    lastName: "ESSAI", firstName: "Inscription", programId: program.id, level: "licence",
  });
  assert.match(created.enrollmentReceiptNumber, /^INS-2026-\d{6}$/);
  const again = domain.issueEnrollmentReceipt(db, agent, created.student.id);
  assert.equal(again.number, created.enrollmentReceiptNumber);
  assert.equal(again.created, false);
  assert.throws(() => domain.createUser(db, agent, {
    fullName: "Mauvais domaine", email: "essai@gmail.com", password: "Motdepasse1!", rights: ["dashboard.read"],
  }));
  const superAdmin = db.prepare("SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'super_admin' LIMIT 1").get();
  const account = domain.createUser(db, superAdmin, {
    fullName: "Agent essai", email: "agent.essai@univ-africaiim.com", password: "Motdepasse1!", rights: ["dashboard.read", "receipt.read"],
  });
  assert.equal(db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(account.id).must_change_password, 1);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(account.id);
  domain.updateUserAccess(db, superAdmin, account.id, {
    fullName: "Agent renommé", email: "agent.renomme@univ-africaiim.com", rights: ["dashboard.read"], password: "Nouveau2#",
  });
  const changed = db.prepare("SELECT full_name, email, must_change_password FROM users WHERE id = ?").get(account.id);
  assert.deepEqual([changed.full_name, changed.email, changed.must_change_password], ["Agent renommé", "agent.renomme@univ-africaiim.com", 1]);
  assert.throws(() => domain.updateUserAccess(db, superAdmin, account.id, { email: "x@gmail.com", rights: ["dashboard.read"] }));
  domain.deactivateUser(db, agent, account.id);
  assert.equal(db.prepare("SELECT active FROM users WHERE id = ?").get(account.id).active, 0);
});

test("bachelor, masters, réduction de 5 % et boursier", () => {
  const program = db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const comptant = domain.createStudent(db, agent, {
    lastName: "BARRY", firstName: "Comptant", programId: program.id, level: "bachelor",
    paymentAmount: 25_000_000, method: "marchand",
  });
  assert.equal(comptant.situation.due, 23_750_000);
  assert.equal(comptant.situation.paid, 23_750_000);
  assert.equal(comptant.situation.status, "solde");
  assert.equal(db.prepare("SELECT method FROM payments WHERE student_id = ?").get(comptant.student.id).method, "marchand");

  const partiel = domain.createStudent(db, agent, {
    lastName: "CAMARA", firstName: "Partiel", programId: program.id, level: "master_2",
    paymentAmount: 8_600_000, method: "especes",
  });
  assert.equal(partiel.situation.due, 31_000_000);
  assert.equal(partiel.situation.paid, 8_600_000);
  assert.equal(partiel.situation.status, "partiel");

  const boursier = domain.createStudent(db, agent, {
    lastName: "DIALLO", firstName: "Bourse", programId: program.id, level: "master_1",
    scholarship: true,
  });
  assert.equal(boursier.situation.due, 0);
  assert.equal(boursier.situation.paid, 0);
  assert.equal(boursier.situation.status, "solde");
  assert.throws(() => domain.createPayment(db, agent, {
    studentId: boursier.student.id, amount: 1_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "boursier-refus",
  }, "2026-10-06"));

  const bachelorYears = db.prepare("SELECT DISTINCT level FROM fee_schedules WHERE level LIKE 'bachelor_%'").all().map((row) => row.level).sort();
  assert.deepEqual(bachelorYears, ["bachelor_1", "bachelor_2", "bachelor_3"]);
  const licence = db.prepare("SELECT id, tuition_amount FROM fee_schedules WHERE level = 'licence' AND program_id = ?").get(program.id);
  assert.throws(() => domain.saveFeeSchedule(db, agent, { id: licence.id, tuition: 10_000_000 }));
  assert.equal(db.prepare("SELECT tuition_amount FROM fee_schedules WHERE id = ?").get(licence.id).tuition_amount, licence.tuition_amount);
  const bachelor2 = db.prepare("SELECT id FROM fee_schedules WHERE level = 'bachelor_2' AND program_id = ?").get(program.id);
  domain.saveFeeSchedule(db, agent, { id: bachelor2.id, tuition: 26_000_000 });
  const changed = domain.createStudent(db, agent, {
    lastName: "SYLLA", firstName: "Deuxieme", programId: program.id, level: "bachelor_2",
  });
  assert.equal(changed.situation.due, 27_000_000);
  assert.equal(db.prepare("SELECT registration_amount, installment_1, installment_2 FROM fee_schedules WHERE id = ?").get(bachelor2.id).registration_amount, 5_200_000);
});

test("une mise à jour ajoute un versement sans modifier le montant déjà enregistré", () => {
  const student = db.prepare("SELECT id FROM students WHERE last_name = 'CAMARA' AND first_name = 'Partiel'").get();
  const before = domain.studentSituation(db, student.id, "2026-10-06").situation.paid;
  const first = domain.createPayment(db, agent, {
    studentId: student.id, amount: 100_000, paidOn: "2026-10-06", method: "especes",
    reference: "REF-MAJ-1", note: "Versement initial", idempotencyKey: "maj-initial-0001",
  }, "2026-10-06");
  const updated = domain.updatePayment(db, agent, first.paymentId, {
    amount: 250_000, paidOn: "2026-10-06", method: "orange_money",
    note: "Complément", idempotencyKey: "maj-ajout-0001",
  }, "2026-10-06");
  const kept = db.prepare("SELECT amount, status FROM payments WHERE id = ?").get(first.paymentId);
  assert.equal(kept.status, "valide");
  assert.equal(kept.amount, 100_000);
  assert.equal(db.prepare("SELECT amount, status FROM payments WHERE id = ?").get(updated.paymentId).amount, 250_000);
  assert.equal(updated.after.paid, before + 100_000 + 250_000);
  assert.equal(updated.keptAmount, 100_000);
  assert.notEqual(updated.paymentId, first.paymentId);
  const added = domain.updatePayment(db, agent, first.paymentId, {
    amount: 50_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "maj-ajout-0002",
  }, "2026-10-06");
  assert.equal(added.after.paid, before + 100_000 + 250_000 + 50_000);
  assert.equal(db.prepare("SELECT amount, status FROM payments WHERE id = ?").get(first.paymentId).amount, 100_000);
  domain.cancelPayment(db, agent, added.paymentId, "Annulation unique du versement", "2026-10-06");
  assert.throws(() => domain.cancelPayment(db, agent, added.paymentId, "Seconde annulation impossible", "2026-10-06"));
  assert.equal(db.prepare("SELECT status FROM payments WHERE id = ?").get(added.paymentId).status, "annule");
  assert.equal(db.prepare("SELECT status, amount FROM payments WHERE id = ?").get(first.paymentId).amount, 100_000);
});

test("un versement supérieur au montant à payer n'est pas enregistré", () => {
  const program = db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = domain.createStudent(db, agent, {
    lastName: "PLAFOND", firstName: "Scolarite", programId: program.id, level: "master_1",
  });
  const due = created.situation.due;
  assert.throws(
    () => domain.createPayment(db, agent, {
      studentId: created.student.id, amount: due + 8_000_000, paidOn: "2026-10-06", method: "especes",
      idempotencyKey: "plafond-0001",
    }, "2026-10-06"),
    (error) => error.details?.code === "AMOUNT_TOO_HIGH",
  );
  const untouched = domain.studentSituation(db, created.student.id, "2026-10-06").situation;
  assert.equal(untouched.paid, 0);
  assert.equal(untouched.due, due);
  const refused = domain.previewPayment(db, {
    studentId: created.student.id, amount: due + 8_000_000, paidOn: "2026-10-06",
  }, "2026-10-06");
  assert.equal(refused.refused, true);
  assert.equal(refused.recordedAmount, 0);
  const settled = domain.createPayment(db, agent, {
    studentId: created.student.id, amount: due, paidOn: "2026-10-06", method: "especes",
    idempotencyKey: "plafond-0002",
  }, "2026-10-06");
  assert.equal(settled.after.reste, 0);
  assert.equal(settled.after.credit, 0);
  const extra = domain.previewPaymentUpdate(db, settled.paymentId, { amount: 5_000_000, paidOn: "2026-10-06" }, "2026-10-06");
  assert.equal(extra.todayAmount, 0);
  assert.equal(extra.refused, true);
  assert.throws(
    () => domain.updatePayment(db, agent, settled.paymentId, {
      amount: 5_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "plafond-0003",
    }, "2026-10-06"),
    (error) => error.details?.code === "AMOUNT_TOO_HIGH",
  );
  assert.equal(domain.studentSituation(db, created.student.id, "2026-10-06").situation.paid, settled.after.paid);
});
});
