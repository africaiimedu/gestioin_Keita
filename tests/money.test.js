import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSituation, feesDue, fitPlanToDue, officialInstallments, recoveryRate } from "../src/finance/money.js";
import { hotp } from "../src/auth/totp.js";
import { can } from "../src/auth/passwords.js";

const AS_OF = "2026-10-06";
const licencePlan = [
  { code: "inscription", amount: 5_000_000, dueOn: "2026-10-05" },
  { code: "tranche_1", amount: 10_000_000, dueOn: "2026-12-05" },
  { code: "tranche_2", amount: 10_000_000, dueOn: "2027-03-05" },
];
const techPlan = [
  { code: "inscription", amount: 7_400_000, dueOn: "2026-10-05" },
  { code: "tranche_1", amount: 14_800_000, dueOn: "2026-12-05" },
  { code: "tranche_2", amount: 14_800_000, dueOn: "2027-03-05" },
];
const masterPlan = [
  { code: "inscription", amount: 6_000_000, dueOn: "2026-10-05" },
  { code: "tranche_1", amount: 12_000_000, dueOn: "2026-12-05" },
  { code: "tranche_2", amount: 12_000_000, dueOn: "2027-03-05" },
];

function pay(id, amount, code) {
  return { id, amount, status: "valide", paidOn: "2026-10-01", installmentCode: code };
}

test("cas réels du fichier : soldé, partiel, tech, master, aucun paiement", () => {
  const solde = computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF,
    payments: [pay(1, 1_000_000, "inscription"), pay(2, 4_000_000, "tranche_1"), pay(3, 10_000_000, "tranche_2"), pay(4, 10_000_000, "tranche_3")],
  });
  assert.equal(solde.paid, 25_000_000);
  assert.equal(solde.reste, 0);
  assert.equal(solde.status, "solde");

  const partiel = computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF,
    payments: [pay(1, 1_000_000, null), pay(2, 4_000_000, null)],
  });
  assert.equal(partiel.paid, 5_000_000);
  assert.equal(partiel.reste, 20_000_000);
  assert.equal(partiel.status, "partiel");

  const tech = computeSituation({
    tuition: 37_000_000, installments: techPlan, asOf: AS_OF,
    payments: [pay(1, 2_000_000, null), pay(2, 14_000_000, null)],
  });
  assert.equal(tech.paid, 16_000_000);
  assert.equal(tech.reste, 21_000_000);
  assert.equal(tech.status, "partiel");

  const master = computeSituation({
    tuition: 30_000_000, installments: masterPlan, asOf: AS_OF,
    payments: [pay(1, 3_000_000, "inscription"), pay(2, 7_000_000, "tranche_1"), pay(3, 10_000_000, "tranche_2"), pay(4, 6_500_000, "tranche_3")],
  });
  assert.equal(master.paid, 26_500_000);
  assert.equal(master.reste, 3_500_000);
  assert.equal(master.status, "partiel");

  const aucun = computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: "2026-09-01", payments: [],
  });
  assert.equal(aucun.paid, 0);
  assert.equal(aucun.reste, 25_000_000);
  assert.equal(aucun.status, "aucun_paiement");

  const retard = computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF, payments: [],
  });
  assert.equal(retard.status, "en_retard");
  assert.equal(retard.overdueAmount, 5_000_000);
});

test("répartition officielle 20 % / 40 % / 40 %, en francs entiers", () => {
  for (const [tuition, expected] of [
    [25_000_000, [5_000_000, 10_000_000, 10_000_000]],
    [30_000_000, [6_000_000, 12_000_000, 12_000_000]],
    [37_000_000, [7_400_000, 14_800_000, 14_800_000]],
  ]) {
    const parts = officialInstallments(tuition).map((item) => item.amount);
    assert.deepEqual(parts, expected);
    assert.equal(parts.reduce((sum, amount) => sum + amount, 0), tuition);
  }
});

test("trop-perçu, remise et taux", () => {
  const over = computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF,
    payments: [pay(1, 26_000_000, "inscription")],
  });
  assert.equal(over.reste, 0);
  assert.equal(over.credit, 1_000_000);
  assert.equal(over.status, "trop_percu");

  const due = feesDue(25_000_000, [{ mode: "fixe", value: 1_200_000 }]);
  assert.equal(due.due, 23_800_000);
  const plan = fitPlanToDue(licencePlan, due.due);
  assert.equal(plan[2].amount, 8_800_000);
  assert.equal(plan.reduce((sum, item) => sum + item.amount, 0), 23_800_000);

  const withDiscount = computeSituation({
    tuition: 25_000_000,
    discounts: [{ mode: "fixe", value: 1_200_000 }],
    installments: licencePlan,
    asOf: AS_OF,
    payments: [pay(1, 23_800_000, null)],
  });
  assert.equal(withDiscount.due, 23_800_000);
  assert.equal(withDiscount.reste, 0);
  assert.equal(withDiscount.status, "solde");

  assert.equal(recoveryRate(26_500_000, 30_000_000).label, "88,3 %");
  assert.equal(recoveryRate(25_000_000, 25_000_000).label, "100,0 %");
});

test("paiement nul refusé par le contrôle d'entier positif à l'allocation", () => {
  assert.throws(() => computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF,
    payments: [{ id: 1, amount: 0, status: "valide", paidOn: AS_OF, installmentCode: null }],
  }));
  assert.throws(() => computeSituation({
    tuition: 25_000_000, installments: licencePlan, asOf: AS_OF,
    payments: [{ id: 1, amount: -1, status: "valide", paidOn: AS_OF, installmentCode: null }],
  }));
});

test("vecteur TOTP connu et permissions", () => {
  const secret = Buffer.from("12345678901234567890");
  assert.equal(hotp(secret, 1, 8), "94287082");
  assert.equal(can("gestionnaire", "payment.create"), true);
  assert.equal(can("gestionnaire", "payment.cancel"), false);
  assert.equal(can("gestionnaire", "fee.write"), false);
  assert.equal(can("admin", "fee.write"), true);
  assert.equal(can("admin", "payment.cancel"), true);
  assert.equal(can("admin", "user.write"), true);
  assert.equal(can("super_admin", "user.write"), true);
  assert.equal(can("super_admin", "payment.cancel"), true);
});
