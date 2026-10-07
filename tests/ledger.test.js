import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freshTestDb } from "./helpers/testDb.js";
import { seedAll } from "../src/seed/run.js";
import * as domain from "../src/services/domain.js";

let db;
let comptable;
let agent;
let direction;
let demo;

const USER_SQL = "SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id";

describe("registre", { concurrency: false }, () => {
before(async () => {
  db = await freshTestDb();
  await seedAll(db);
  comptable = await db.prepare(`${USER_SQL} WHERE email = 'gestionnaire@univ-africaiim.com'`).get();
  agent = await db.prepare(`${USER_SQL} WHERE email = 'admin@univ-africaiim.com'`).get();
  direction = { id: 1, role: "invite", full_name: "Sans droit" };
  demo = await db.prepare("SELECT id FROM students WHERE matricule = 'AIM-2026-0099'").get();
});

after(async () => {
  await db?.close();
});

async function situationOf(legacyNumber) {
  const student = await db.prepare("SELECT id FROM students WHERE legacy_number = ?").get(legacyNumber);
  return (await domain.studentSituation(db, student.id, "2026-10-06")).situation;
}

test("les 62 lignes du PDF et les cas financiers réels", async () => {
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM students WHERE source = 'pdf'").get()).n, 62);
  const sow = await situationOf(1);
  assert.equal(sow.paid, 25_000_000);
  assert.equal(sow.due, 26_000_000);
  assert.equal(sow.reste, 1_000_000);
  assert.equal(sow.status, "partiel");

  const partiel = await situationOf(3);
  assert.equal(partiel.paid, 5_000_000);
  assert.equal(partiel.reste, 21_000_000);

  const tech = await situationOf(17);
  assert.equal(tech.paid, 16_000_000);
  assert.equal(tech.reste, 22_000_000);

  const master = await situationOf(47);
  assert.equal(master.paid, 26_500_000);
  assert.equal(master.reste, 6_500_000);

  const aucun = await situationOf(9);
  assert.equal(aucun.paid, 0);
  assert.equal(aucun.status, "en_retard");

  const inscriptionSeule = await situationOf(6);
  assert.equal(inscriptionSeule.paid, 1_000_000);
  assert.equal(inscriptionSeule.status, "en_retard");

  const sansInscription = await situationOf(3);
  assert.equal(sansInscription.paid, 5_000_000);
  assert.equal(sansInscription.status, "en_retard");
  assert.equal(sansInscription.overdueAmount, 1_000_000);

  const bareme = await db.prepare("SELECT registration_amount, installment_1, installment_2, installment_3 FROM fee_schedules WHERE level = 'licence' LIMIT 1").get();
  assert.deepEqual([bareme.registration_amount, bareme.installment_1, bareme.installment_2, bareme.installment_3], [5_000_000, 10_000_000, 10_000_000, 0]);
});

test("cohérence : somme des étudiants = total général", async () => {
  const report = await domain.reconcile(db, "2026-10-06");
  assert.equal(report.ok, true, JSON.stringify(report.gaps));
  const dashboard = await domain.dashboard(db, {}, "2026-10-06");
  assert.equal(dashboard.paidAll, report.paid);
  assert.equal(dashboard.due, report.due);
  assert.equal(dashboard.reste, report.reste);
  assert.equal(dashboard.controlOk, true);
});

test("idempotence, refus des montants invalides, deux paiements, annulation, reçus sans trou", async () => {
  await assert.rejects(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 0, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-nulle-0001",
  }, "2026-10-06"));
  await assert.rejects(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: -500, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-negative-1",
  }, "2026-10-06"));
  await assert.rejects(() => domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1.5, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-virgule-01",
  }, "2026-10-06"));

  const first = await domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-demo-0001",
  }, "2026-10-06");
  const replay = await domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-demo-0001",
  }, "2026-10-06");
  assert.equal(replay.replay, true);
  assert.equal(replay.paymentId, first.paymentId);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM payments WHERE idempotency_key = 'cle-demo-0001'").get()).n, 1);

  const second = await domain.createPayment(db, agent, {
    studentId: demo.id, amount: 4_000_000, paidOn: "2026-10-06", method: "mobile", idempotencyKey: "cle-demo-0002",
  }, "2026-10-06");
  assert.equal(second.after.paid, 5_000_000);
  assert.equal(second.after.reste, 21_000_000);
  assert.equal(first.receiptNumber, "REC-2026-000001");
  assert.equal(second.receiptNumber, "REC-2026-000002");

  await assert.rejects(() => domain.createPayment(db, direction, {
    studentId: demo.id, amount: 1000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "cle-direction-1",
  }, "2026-10-06"));

  await domain.cancelPayment(db, agent, first.paymentId, "Erreur de saisie en caisse", "2026-10-06");
  const afterCancel = (await domain.studentSituation(db, demo.id, "2026-10-06")).situation;
  assert.equal(afterCancel.paid, 4_000_000);
  const replacement = await domain.createPayment(db, comptable, {
    studentId: demo.id, amount: 1_000_000, paidOn: "2026-10-06", method: "cheque", reference: "CHQ-100", idempotencyKey: "cle-demo-0003",
  }, "2026-10-06");
  assert.equal(replacement.after.paid, 5_000_000);
  assert.equal(replacement.receiptNumber, "REC-2026-000003");

  await assert.rejects(() => db.prepare("UPDATE payments SET amount = 1 WHERE id = ?").run(second.paymentId));
  await assert.rejects(() => db.prepare("DELETE FROM payments WHERE id = ?").run(second.paymentId));
  await assert.rejects(() => db.exec("TRUNCATE payments CASCADE"));
  await assert.rejects(() => db.prepare("UPDATE receipts SET number = 'FAUX' WHERE payment_id = ?").run(second.paymentId));
  await assert.rejects(() => db.prepare("DELETE FROM audit_logs").run());

  const numbers = (await db.prepare("SELECT seq FROM receipts ORDER BY seq").all()).map((row) => row.seq);
  numbers.forEach((seq, index) => assert.equal(seq, index + 1));
});

test("des encaissements simultanés ne dépassent jamais le reste et gardent des numéros sans trou", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "CONCURRENT", firstName: "Caisse", programId: program.id, level: "master_1",
  });
  const due = created.situation.due;
  const part = Math.ceil(due / 3);
  const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => domain.createPayment(db, agent, {
    studentId: created.student.id, amount: part, paidOn: "2026-10-06", method: "especes", idempotencyKey: `simultane-${index}-0001`,
  }, "2026-10-06")));
  const accepted = attempts.filter((item) => item.status === "fulfilled").length;
  assert.equal(accepted, Math.floor(due / part));
  const situation = (await domain.studentSituation(db, created.student.id, "2026-10-06")).situation;
  assert.ok(situation.paid <= due);
  const numbers = (await db.prepare("SELECT seq FROM receipts ORDER BY seq").all()).map((row) => row.seq);
  numbers.forEach((seq, index) => assert.equal(seq, index + 1));
});

test("une remise enregistrée change les frais dus, pas les paiements", async () => {
  const student = await db.prepare("SELECT id FROM students WHERE legacy_number = 7").get();
  const before = (await domain.studentSituation(db, student.id, "2026-10-06")).situation;
  assert.equal(before.paid, 23_800_000);
  assert.equal(before.reste, 2_200_000);
  await db.prepare(`
    INSERT INTO discounts(student_id, label, mode, value, reason, approved_by)
    VALUES(?, 'Bourse test', 'fixe', 2200000, 'Cas de test, pas une donnée du PDF', ?)
  `).run(student.id, comptable.id);
  const after = (await domain.studentSituation(db, student.id, "2026-10-06")).situation;
  assert.equal(after.due, 23_800_000);
  assert.equal(after.reste, 0);
  assert.equal(after.status, "solde");
  await db.prepare("DELETE FROM discounts WHERE student_id = ?").run(student.id);
});

test("une nouvelle fiche produit un reçu d'inscription, et l'e-mail du personnel est contrôlé", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "ESSAI", firstName: "Inscription", programId: program.id, level: "licence",
  });
  assert.match(created.enrollmentReceiptNumber, /^INS-2026-\d{6}$/);
  const again = await domain.issueEnrollmentReceipt(db, agent, created.student.id);
  assert.equal(again.number, created.enrollmentReceiptNumber);
  assert.equal(again.created, false);
  await assert.rejects(() => domain.createUser(db, agent, {
    fullName: "Mauvais domaine", email: "essai@gmail.com", password: "Motdepasse1!", rights: ["dashboard.read"],
  }));
  const superAdmin = await db.prepare(`${USER_SQL} WHERE r.code = 'super_admin' LIMIT 1`).get();
  const account = await domain.createUser(db, superAdmin, {
    fullName: "Agent essai", email: "agent.essai@univ-africaiim.com", password: "Motdepasse1!", rights: ["dashboard.read", "receipt.read"],
  });
  await assert.rejects(
    () => domain.createUser(db, superAdmin, {
      fullName: "Agent doublon", email: "agent.essai@univ-africaiim.com", password: "Motdepasse1!", rights: ["dashboard.read"],
    }),
    /déjà utilisé/,
  );
  assert.equal((await db.prepare("SELECT must_change_password FROM users WHERE id = ?").get(account.id)).must_change_password, 1);
  await db.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").run(account.id);
  await domain.updateUserAccess(db, superAdmin, account.id, {
    fullName: "Agent renommé", email: "agent.renomme@univ-africaiim.com", rights: ["dashboard.read"], password: "Nouveau2#",
  });
  const changed = await db.prepare("SELECT full_name, email, must_change_password FROM users WHERE id = ?").get(account.id);
  assert.deepEqual([changed.full_name, changed.email, changed.must_change_password], ["Agent renommé", "agent.renomme@univ-africaiim.com", 1]);
  await assert.rejects(() => domain.updateUserAccess(db, superAdmin, account.id, { email: "x@gmail.com", rights: ["dashboard.read"] }));
  await domain.deactivateUser(db, agent, account.id);
  assert.equal((await db.prepare("SELECT active FROM users WHERE id = ?").get(account.id)).active, 0);
});

test("bachelor, masters, réduction de 5 % et boursier", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const comptant = await domain.createStudent(db, agent, {
    lastName: "BARRY", firstName: "Comptant", programId: program.id, level: "bachelor",
    paymentAmount: 25_000_000, method: "marchand",
  });
  assert.equal(comptant.situation.due, 23_750_000);
  assert.equal(comptant.situation.paid, 23_750_000);
  assert.equal(comptant.situation.status, "solde");
  assert.equal((await db.prepare("SELECT method FROM payments WHERE student_id = ?").get(comptant.student.id)).method, "marchand");

  const partiel = await domain.createStudent(db, agent, {
    lastName: "CAMARA", firstName: "Partiel", programId: program.id, level: "master_2",
    paymentAmount: 8_600_000, method: "especes",
  });
  assert.equal(partiel.situation.due, 31_000_000);
  assert.equal(partiel.situation.paid, 8_600_000);
  assert.equal(partiel.situation.status, "partiel");

  const boursier = await domain.createStudent(db, agent, {
    lastName: "DIALLO", firstName: "Bourse", programId: program.id, level: "master_1",
    scholarship: true,
  });
  assert.equal(boursier.situation.due, 0);
  assert.equal(boursier.situation.paid, 0);
  assert.equal(boursier.situation.status, "solde");
  await assert.rejects(() => domain.createPayment(db, agent, {
    studentId: boursier.student.id, amount: 1_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "boursier-refus",
  }, "2026-10-06"));

  const bachelorYears = (await db.prepare("SELECT DISTINCT level FROM fee_schedules WHERE level LIKE 'bachelor_%'").all()).map((row) => row.level).sort();
  assert.deepEqual(bachelorYears, ["bachelor_1", "bachelor_2", "bachelor_3"]);
  const licence = await db.prepare("SELECT id, tuition_amount FROM fee_schedules WHERE level = 'licence' AND program_id = ?").get(program.id);
  await assert.rejects(() => domain.saveFeeSchedule(db, agent, { id: licence.id, tuition: 10_000_000 }));
  assert.equal((await db.prepare("SELECT tuition_amount FROM fee_schedules WHERE id = ?").get(licence.id)).tuition_amount, licence.tuition_amount);
  const bachelor2 = await db.prepare("SELECT id FROM fee_schedules WHERE level = 'bachelor_2' AND program_id = ?").get(program.id);
  await domain.saveFeeSchedule(db, agent, { id: bachelor2.id, tuition: 26_000_000 });
  const changed = await domain.createStudent(db, agent, {
    lastName: "SYLLA", firstName: "Deuxieme", programId: program.id, level: "bachelor_2",
  });
  assert.equal(changed.situation.due, 27_000_000);
  assert.equal((await db.prepare("SELECT registration_amount FROM fee_schedules WHERE id = ?").get(bachelor2.id)).registration_amount, 5_200_000);
});

test("une mise à jour ajoute un versement sans modifier le montant déjà enregistré", async () => {
  const student = await db.prepare("SELECT id FROM students WHERE last_name = 'CAMARA' AND first_name = 'Partiel'").get();
  const before = (await domain.studentSituation(db, student.id, "2026-10-06")).situation.paid;
  const first = await domain.createPayment(db, agent, {
    studentId: student.id, amount: 100_000, paidOn: "2026-10-06", method: "especes",
    reference: "REF-MAJ-1", note: "Versement initial", idempotencyKey: "maj-initial-0001",
  }, "2026-10-06");
  const updated = await domain.updatePayment(db, agent, first.paymentId, {
    amount: 250_000, paidOn: "2026-10-06", method: "orange_money",
    note: "Complément", idempotencyKey: "maj-ajout-0001",
  }, "2026-10-06");
  const kept = await db.prepare("SELECT amount, status FROM payments WHERE id = ?").get(first.paymentId);
  assert.equal(kept.status, "valide");
  assert.equal(kept.amount, 100_000);
  assert.equal((await db.prepare("SELECT amount FROM payments WHERE id = ?").get(updated.paymentId)).amount, 250_000);
  assert.equal(updated.after.paid, before + 100_000 + 250_000);
  assert.equal(updated.keptAmount, 100_000);
  assert.notEqual(updated.paymentId, first.paymentId);
  const added = await domain.updatePayment(db, agent, first.paymentId, {
    amount: 50_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "maj-ajout-0002",
  }, "2026-10-06");
  assert.equal(added.after.paid, before + 100_000 + 250_000 + 50_000);
  assert.equal((await db.prepare("SELECT amount FROM payments WHERE id = ?").get(first.paymentId)).amount, 100_000);
  await domain.cancelPayment(db, agent, added.paymentId, "Annulation unique du versement", "2026-10-06");
  await assert.rejects(() => domain.cancelPayment(db, agent, added.paymentId, "Seconde annulation impossible", "2026-10-06"));
  assert.equal((await db.prepare("SELECT status FROM payments WHERE id = ?").get(added.paymentId)).status, "annule");
  assert.equal((await db.prepare("SELECT amount FROM payments WHERE id = ?").get(first.paymentId)).amount, 100_000);
});

test("un versement supérieur au montant à payer n'est pas enregistré", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "PLAFOND", firstName: "Scolarite", programId: program.id, level: "master_1",
  });
  const due = created.situation.due;
  await assert.rejects(
    () => domain.createPayment(db, agent, {
      studentId: created.student.id, amount: due + 8_000_000, paidOn: "2026-10-06", method: "especes",
      idempotencyKey: "plafond-0001",
    }, "2026-10-06"),
    (error) => error.details?.code === "AMOUNT_TOO_HIGH",
  );
  const untouched = (await domain.studentSituation(db, created.student.id, "2026-10-06")).situation;
  assert.equal(untouched.paid, 0);
  assert.equal(untouched.due, due);
  const refused = await domain.previewPayment(db, {
    studentId: created.student.id, amount: due + 8_000_000, paidOn: "2026-10-06",
  }, "2026-10-06");
  assert.equal(refused.refused, true);
  assert.equal(refused.recordedAmount, 0);
  const settled = await domain.createPayment(db, agent, {
    studentId: created.student.id, amount: due, paidOn: "2026-10-06", method: "especes",
    idempotencyKey: "plafond-0002",
  }, "2026-10-06");
  assert.equal(settled.after.reste, 0);
  assert.equal(settled.after.credit, 0);
  const extra = await domain.previewPaymentUpdate(db, settled.paymentId, { amount: 5_000_000, paidOn: "2026-10-06" }, "2026-10-06");
  assert.equal(extra.todayAmount, 0);
  assert.equal(extra.refused, true);
  await assert.rejects(
    () => domain.updatePayment(db, agent, settled.paymentId, {
      amount: 5_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "plafond-0003",
    }, "2026-10-06"),
    (error) => error.details?.code === "AMOUNT_TOO_HIGH",
  );
  assert.equal((await domain.studentSituation(db, created.student.id, "2026-10-06")).situation.paid, settled.after.paid);
});

test("costume : prix, versement lié au reçu et refus du trop-perçu", async () => {
  await domain.updateSettings(db, agent, { costume_price: "800.000" });
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "TENUE", firstName: "Costume", programId: program.id, level: "bachelor_1",
  });
  const paid = await domain.createPayment(db, agent, {
    studentId: created.student.id, amount: 1_000_000, costumeAmount: 300_000, paidOn: "2026-10-06", method: "especes",
    idempotencyKey: "costume-0001",
  }, "2026-10-06");
  assert.equal(paid.costume.reste, 500_000);
  await assert.rejects(
    () => domain.recordCostume(db, agent, created.student.id, { amount: 600_000, paidOn: "2026-10-06" }, "2026-10-06"),
    (error) => error.details?.code === "AMOUNT_TOO_HIGH",
  );
  const situation = await domain.costumeSituation(db, created.student.id);
  assert.equal(situation.paid, 300_000);
  assert.equal(situation.status, "partiel");
});
});
