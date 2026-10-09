import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { freshTestDb } from "./helpers/testDb.js";
import { seedAll } from "../src/seed/run.js";
import { transaction } from "../src/db/index.js";
import * as domain from "../src/services/domain.js";
import * as expenses from "../src/services/expenses.js";
import { renderDischargePdf } from "../src/services/receiptPdf.js";

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

test("une nouvelle fiche ne produit aucun reçu d'inscription, et l'e-mail du personnel est contrôlé", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "ESSAI", firstName: "Inscription", programId: program.id, level: "licence",
  });
  const issued = await db.prepare("SELECT COUNT(*) AS n FROM enrollment_receipts WHERE student_id = ?").get(created.student.id);
  assert.equal(issued.n, 0);
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

test("bachelor, masters, remise de 1.200.000 en une fois et boursier", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const comptant = await domain.createStudent(db, agent, {
    lastName: "BARRY", firstName: "Comptant", programId: program.id, level: "bachelor",
    paymentAmount: 25_000_000, method: "marchand",
  });
  assert.equal(comptant.situation.due, 23_800_000);
  assert.equal(comptant.situation.paid, 23_800_000);
  assert.equal(comptant.situation.status, "solde");
  assert.equal((await db.prepare("SELECT method FROM payments WHERE student_id = ?").get(comptant.student.id)).method, "marchand");
  const remise = await db.prepare("SELECT mode, value FROM discounts WHERE student_id = ?").get(comptant.student.id);
  assert.deepEqual([remise.mode, Number(remise.value)], ["fixe", 1_200_000]);

  const masterComptant = await domain.createStudent(db, agent, {
    lastName: "BAH", firstName: "Toutpaye", programId: program.id, level: "master_2",
    paymentAmount: 31_000_000, method: "especes",
  });
  assert.equal(masterComptant.situation.due, 31_000_000);
  assert.equal(masterComptant.situation.paid, 31_000_000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM discounts WHERE student_id = ?").get(masterComptant.student.id)).n, 0);

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

test("compte étudiant créé à l'inscription, et une personne n'est jamais enregistrée deux fois", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const first = await domain.createStudent(db, agent, {
    lastName: "Kourouma", firstName: "Mamadou Alpha", programId: program.id, level: "bachelor_1",
    paymentAmount: 1_000_000, method: "especes",
  });
  assert.equal(first.student.account_email, "alpha.kourouma@univ-africaiim.com");
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM students").get()).n;
  const before = await count();
  await assert.rejects(
    () => domain.createStudent(db, agent, {
      lastName: "KOUROUMA", firstName: "alpha mamadou", programId: program.id, level: "bachelor_1",
      paymentAmount: 2_000_000, method: "especes",
    }),
    (error) => error.status === 409 && error.message.includes(first.student.matricule),
  );
  assert.equal(await count(), before);
  const other = await domain.createStudent(db, agent, {
    lastName: "KOUROUMA", firstName: "Alpha", programId: program.id, level: "bachelor_1",
    paymentAmount: 0, method: "especes",
  });
  assert.equal(other.student.account_email, "alpha.kourouma2@univ-africaiim.com");
  const payment = await db.prepare("SELECT id FROM payments WHERE student_id = ? ORDER BY id LIMIT 1").get(first.student.id);
  const added = await domain.updatePayment(db, agent, payment.id, {
    amount: 2_000_000, paidOn: "2026-10-06", method: "especes", idempotencyKey: "compte-maj-0001",
  }, "2026-10-06");
  assert.equal(added.after.paid, 3_000_000);
  assert.equal(await count(), before + 1);
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

  const receipt = await db.prepare("SELECT snapshot_json FROM receipts WHERE payment_id = ?").get(updated.paymentId);
  const snapshot = JSON.parse(receipt.snapshot_json);
  assert.equal(snapshot.history.at(-1).amount, 100_000);
  assert.equal(snapshot.history.at(-1).receiptNumber, first.receiptNumber);
  assert.equal(snapshot.history.reduce((sum, item) => sum + item.amount, 0), snapshot.paidAfter - snapshot.amount);

  const { students, totals } = await domain.listCashStudents(db, "2026-10-06");
  const rows = students.filter((row) => row.studentId === student.id);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.count, row.history.length - 1);
  assert.equal(row.cancelled, 1);
  assert.equal(row.tuitionPaid, before + 100_000 + 250_000);
  assert.equal(row.lastPaymentId, row.history.filter((item) => item.status === "valide").at(-1).id);
  assert.equal(row.receiptNumber, row.history.filter((item) => item.status === "valide" && item.receipt_number).at(-1).receipt_number);
  assert.ok(row.history.some((item) => item.receipt_number === updated.receiptNumber));
  assert.deepEqual(row.history.filter((item) => item.paid_on === "2026-10-06").map((item) => item.amount), [100_000, 250_000, 50_000]);
  const dates = row.history.map((item) => item.paid_on);
  assert.deepEqual(dates, [...dates].sort());
  const sql = await db.prepare(`
    SELECT COUNT(*)::int AS n, COUNT(DISTINCT student_id)::int AS students, COALESCE(SUM(amount), 0)::bigint AS total
    FROM payments WHERE status = 'valide'
  `).get();
  assert.equal(totals.payments, sql.n);
  assert.equal(totals.students, students.length);
  assert.equal(totals.tuition, Number(sql.total));
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

test("costumes : 1.600.000 versés = 2 costumes payés, rien à payer en plus", async () => {
  await domain.updateSettings(db, agent, { costume_price: "800.000" });
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const created = await domain.createStudent(db, agent, {
    lastName: "DOUBLE", firstName: "Tenue", programId: program.id, level: "bachelor_1",
  });
  const paid = await domain.createPayment(db, agent, {
    studentId: created.student.id, amount: 1_000_000, costumeAmount: 1_600_000, paidOn: "2026-10-06", method: "especes",
    idempotencyKey: "costume-double-0001",
  }, "2026-10-06");
  assert.equal(paid.costume.quantity, 2);
  assert.equal(paid.costume.price, 1_600_000);
  assert.equal(paid.costume.reste, 0);
  const receipt = await db.prepare("SELECT snapshot_json FROM receipts WHERE id = ?").get(paid.receiptId);
  const snapshot = JSON.parse(receipt.snapshot_json);
  assert.deepEqual([snapshot.costume.quantity, snapshot.costume.unitPrice, snapshot.costume.reste], [2, 800_000, 0]);

  await assert.rejects(() => domain.setCostumeQuantity(db, agent, created.student.id, 1), /au moins 2/);
  const three = await domain.setCostumeQuantity(db, agent, created.student.id, 3);
  assert.deepEqual([three.quantity, three.price, three.reste], [3, 2_400_000, 800_000]);
  const preview = await domain.previewPayment(db, {
    studentId: created.student.id, amount: 100_000, costumeAmount: 800_000, paidOn: "2026-10-06",
  }, "2026-10-06");
  assert.equal(preview.costume.resteAfter, 0);
});

test("matricule : saisi à l'inscription, unique, modifiable ensuite", async () => {
  const program = await db.prepare("SELECT id FROM programs WHERE code = 'ABS'").get();
  const suggested = await domain.suggestMatricule(db);
  assert.match(suggested, /^AIM-\d{4}-\d{4}$/);
  const created = await domain.createStudent(db, agent, {
    lastName: "MATRICULE", firstName: "Choisi", programId: program.id, level: "bachelor_1", matricule: " aim-2026-0500 ",
  });
  assert.equal(created.student.matricule, "AIM-2026-0500");
  await assert.rejects(() => domain.createStudent(db, agent, {
    lastName: "AUTRE", firstName: "Personne", programId: program.id, level: "bachelor_1", matricule: "AIM-2026-0500",
  }), (error) => error.status === 409);
  await assert.rejects(() => domain.changeMatricule(db, agent, created.student.id, "a"), (error) => error.status === 400);
  const changed = await domain.changeMatricule(db, agent, created.student.id, "AIM-2026-0501");
  assert.equal(changed.previousMatricule, "AIM-2026-0500");
  assert.equal(changed.student.matricule, "AIM-2026-0501");
  const taken = await db.prepare("SELECT matricule FROM students WHERE id <> ? ORDER BY id LIMIT 1").get(created.student.id);
  await assert.rejects(() => domain.changeMatricule(db, agent, created.student.id, taken.matricule), (error) => error.status === 409);
  await assert.rejects(() => domain.changeMatricule(db, direction, created.student.id, "AIM-2026-0502"), (error) => error.status === 403);
  const trace = await db.prepare("SELECT before_json, after_json FROM audit_logs WHERE action = 'etudiant.matricule' ORDER BY id DESC LIMIT 1").get();
  assert.match(trace.before_json, /AIM-2026-0500/);
  assert.match(trace.after_json, /AIM-2026-0501/);
});

test("dépenses : décharge numérotée, montant en lettres, immuable, annulable avec motif", async () => {
  await assert.rejects(() => expenses.createExpense(db, comptable, {
    amount: 500_000, receiverName: "Kaba Mariama", receiverPosition: "Logistique", reason: "Fournitures",
  }), (error) => error.status === 403);
  const { expense } = await expenses.createExpense(db, agent, {
    amount: 1_500_000, category: "fournitures", receiverName: "  Kaba   Mariama ", receiverPosition: "Responsable logistique",
    giverName: "Joseph Toupou", reason: "Achat de rames de papier", city: "Conakry",
  });
  assert.match(expense.number, /^DEC-\d{4}-000001$/);
  assert.equal(expense.receiver_name, "Kaba Mariama");
  assert.equal(expense.amountInWords, "un million cinq cent mille francs guinéens");
  assert.equal(expense.categoryLabel, "Fournitures et matériel");
  const second = await expenses.createExpense(db, agent, {
    amount: 200_000, receiverName: "Camara Ibrahima", receiverPosition: "Chauffeur", reason: "Carburant",
  });
  assert.match(second.expense.number, /000002$/);
  assert.equal(second.expense.giver_name, agent.full_name);

  await assert.rejects(() => db.prepare("UPDATE expenses SET amount = 1 WHERE id = ?").run(expense.id), /ne peut pas être modifiée/);
  await assert.rejects(() => db.prepare("DELETE FROM expenses WHERE id = ?").run(expense.id), /ne peut pas être supprimée/);
  await assert.rejects(() => expenses.cancelExpense(db, agent, second.expense.id, "non"), (error) => error.status === 400);
  const cancelled = await expenses.cancelExpense(db, agent, second.expense.id, "Montant saisi par erreur");
  assert.equal(cancelled.expense.status, "annule");
  await assert.rejects(() => expenses.cancelExpense(db, agent, second.expense.id, "Encore une fois"), (error) => error.status === 409);

  const list = await expenses.listExpenses(db, {});
  assert.equal(list.expenses.length, 2);
  assert.equal(list.summary.period, 1_500_000);
  assert.equal(list.summary.cancelledCount, 1);
  assert.deepEqual(list.byCategory.map((item) => item.code), ["fournitures"]);
  assert.equal(list.summary.pending, 1_500_000);
  assert.equal(list.summary.pendingCount, 1);

  await assert.rejects(() => expenses.markExpenseHanded(db, comptable, expense.id), (error) => error.status === 403);
  await assert.rejects(() => expenses.markExpenseHanded(db, agent, second.expense.id), (error) => error.status === 409);
  const handed = await expenses.markExpenseHanded(db, agent, expense.id);
  assert.ok(handed.expense.handed_at);
  assert.equal(handed.expense.handed_by, agent.id);
  await assert.rejects(() => expenses.markExpenseHanded(db, agent, expense.id), (error) => error.status === 409);
  await assert.rejects(() => db.prepare("UPDATE expenses SET handed_at = NULL, handed_by = NULL WHERE id = ?").run(expense.id), /ne peut pas être modifiée/);
  const after = await expenses.listExpenses(db, { status: "remis" });
  assert.deepEqual(after.expenses.map((item) => item.number), [expense.number]);
  assert.equal(after.expenses[0].handed_by_name, agent.full_name);
  assert.equal(after.summary.pendingCount, 0);

  const printed = await expenses.expenseForPrint(db, expense.id);
  assert.equal(printed.print_count, 1);
  const pdf = await renderDischargePdf({ expense: printed, school: {}, verifyUrl: `http://localhost/v/${printed.verify_token}` });
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
  assert.equal((await expenses.expenseByToken(db, printed.verify_token)).number, expense.number);
});

test("Sequelize : modèles et SQL annulés ensemble, montants en nombres, dates en texte", async () => {
  const { Payment, Reminder } = db.models;
  const student = await db.prepare("SELECT id FROM students WHERE legacy_number = 1").get();
  const before = await Reminder.count();
  await assert.rejects(() => transaction(db, async () => {
    await Reminder.create({ student_id: student.id, channel: "copie", message: "essai", created_by: agent.id });
    await db.prepare("INSERT INTO reminders(student_id, channel, message) VALUES(?, 'copie', 'essai') RETURNING id").run(student.id);
    throw new Error("annulation");
  }), /annulation/);
  assert.equal(await Reminder.count(), before);
  const payment = await Payment.findOne({ where: { student_id: student.id }, raw: true });
  assert.equal(typeof payment.amount, "number");
  assert.match(payment.paid_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(payment.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const total = await db.prepare("SELECT SUM(amount) AS s, COUNT(*) AS n FROM payments").get();
  assert.equal(typeof total.s, "number");
  assert.equal(typeof total.n, "number");
});
});
