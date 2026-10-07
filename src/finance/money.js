/**
 * MODULE UNIQUE DES CALCULS FINANCIERS.
 * Toutes les pages, l'API, les reçus, les exports et les graphiques
 * doivent passer par ces fonctions. Aucun total n'est une donnée saisie.
 *
 * Les montants sont des entiers de francs guinéens (GNF), sans décimales.
 *
 * Formules :
 *   Frais dus = barème − remises + ajustements (plancher à 0)
 *   Total payé = somme des paiements dont le statut est « valide »
 *   Reste à payer = max(0, frais dus − total payé)
 *   Crédit = max(0, total payé − frais dus)
 *   Taux de recouvrement = total payé ÷ frais dus, affiché en % à 1 décimale
 *
 * Statut (un seul par étudiant) :
 *   trop_percu      si payé > dû
 *   solde           si payé = dû
 *   en_retard       si une échéance dont la date est dépassée n'est pas couverte
 *   aucun_paiement  si payé = 0 et aucune échéance dépassée
 *   partiel         si 0 < payé < dû et aucune échéance dépassée
 *
 * La remise (ou l'ajustement) est retirée en commençant par la dernière tranche,
 * pour que la somme des échéances reste exactement égale aux frais dus.
 */

export const STATUS_LABELS = {
  solde: "Soldé",
  partiel: "Partiel",
  aucun_paiement: "Aucun paiement",
  en_retard: "En retard",
  trop_percu: "Trop-perçu",
};

export const METHOD_LABELS = {
  especes: "Espèces",
  cheque: "Chèque",
  virement: "Virement bancaire",
  mobile: "Paiement mobile",
  orange_money: "Orange Money",
  marchand: "Paiement marchand",
  autre: "Autre",
};

export const INSTALLMENT_LABELS = {
  inscription: "Inscription — 5 octobre",
  tranche_1: "2e versement — 5 décembre",
  tranche_2: "3e versement — 5 mars",
  tranche_3: "Ancienne 3e tranche",
};

export function assertGnf(amount, label = "Montant") {
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new Error(`${label} doit être un nombre entier de francs guinéens, sans virgule`);
  }
}

export function formatGnf(amount) {
  assertGnf(amount, "Montant");
  const sign = amount < 0 ? "−" : "";
  const body = Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${body} GNF`;
}

/**
 * Frais d'inscription, en plus de la scolarité, payés avec la première échéance.
 * Ils entrent dans les frais annuels : la remise de 5 % et la bourse s'y appliquent.
 */
export const REGISTRATION_FEES = { bachelor: 1_000_000, master: 3_000_000 };

export function registrationFee(level) {
  return String(level || "").startsWith("master") ? REGISTRATION_FEES.master : REGISTRATION_FEES.bachelor;
}

/**
 * Découpe officielle : 20 % à l'inscription, 40 % en décembre, 40 % en mars.
 * Tout est en francs entiers. Le dernier versement absorbe l'arrondi
 * pour que la somme soit exactement égale aux frais annuels.
 */
export function officialInstallments(tuition) {
  assertGnf(tuition, "Frais annuels");
  const inscription = percentOf(tuition, 20);
  const december = percentOf(tuition, 40);
  const march = tuition - inscription - december;
  if (march < 0) throw new Error("La répartition 20 % / 40 % / 40 % dépasse les frais");
  return [
    { code: "inscription", amount: inscription },
    { code: "tranche_1", amount: december },
    { code: "tranche_2", amount: march },
  ];
}

/** Pourcentage entier d'un montant, arrondi au franc le plus proche (0,5 vers le haut). */
export function percentOf(amount, percent) {
  assertGnf(amount, "Montant");
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error("Le pourcentage doit être un entier entre 0 et 100");
  }
  return Math.floor((amount * percent + 50) / 100);
}

/**
 * Taux de recouvrement à 1 décimale, calculé uniquement avec des entiers.
 * @returns {{ tenths: number, label: string }} tenths = 333 signifie 33,3 %
 */
export function recoveryRate(paid, due) {
  assertGnf(paid, "Total payé");
  assertGnf(due, "Frais dus");
  if (due <= 0) return { tenths: 0, label: "0,0 %" };
  const tenths = Math.floor((paid * 1000 + Math.floor(due / 2)) / due);
  const label = `${Math.floor(tenths / 10)},${tenths % 10} %`;
  return { tenths, label };
}

export function feesDue(tuition, discounts = [], adjustments = []) {
  assertGnf(tuition, "Barème");
  let reduction = 0;
  for (const discount of discounts) {
    if (discount.mode === "fixe") {
      assertGnf(discount.value, "Remise");
      reduction += discount.value;
    } else if (discount.mode === "pourcentage") {
      reduction += percentOf(tuition, discount.value);
    } else {
      throw new Error("Type de remise inconnu");
    }
  }
  let due = tuition - reduction;
  for (const adjustment of adjustments) {
    assertGnf(adjustment.amount, "Ajustement");
    due += adjustment.amount;
  }
  if (due < 0) return { due: 0, warning: "remises_superieures_aux_frais" };
  return { due, warning: null };
}

/**
 * Ajuste les échéances pour que leur somme soit exactement les frais dus.
 * On commence par la dernière tranche.
 */
export function fitPlanToDue(installments, due) {
  assertGnf(due, "Frais dus");
  const copy = installments.map((item) => {
    assertGnf(item.amount, "Échéance");
    return { ...item };
  });
  if (copy.length === 0) return copy;
  let sum = copy.reduce((total, item) => total + item.amount, 0);
  let delta = sum - due;
  if (delta < 0) {
    copy[copy.length - 1] = { ...copy[copy.length - 1], amount: copy[copy.length - 1].amount + (-delta) };
    return copy;
  }
  for (let index = copy.length - 1; index >= 0 && delta > 0; index -= 1) {
    const cut = Math.min(copy[index].amount, delta);
    copy[index] = { ...copy[index], amount: copy[index].amount - cut };
    delta -= cut;
  }
  return copy;
}

export function paymentStatus({ paid, due, overdueUncovered }) {
  assertGnf(paid, "Total payé");
  assertGnf(due, "Frais dus");
  if (paid > due) return "trop_percu";
  if (paid === due) return "solde";
  if (overdueUncovered) return "en_retard";
  if (paid === 0) return "aucun_paiement";
  return "partiel";
}

/**
 * Répartit les paiements valides sur les échéances.
 * La tranche indiquée est servie en premier, le surplus va à la plus ancienne échéance encore ouverte.
 * Ce qui dépasse les frais dus devient un crédit.
 */
export function allocate(payments, plan) {
  const covered = Object.fromEntries(plan.map((item) => [item.code, 0]));
  const ordered = [...payments].sort((a, b) => {
    if (a.paidOn !== b.paidOn) return a.paidOn < b.paidOn ? -1 : 1;
    return a.id - b.id;
  });
  let credit = 0;
  for (const payment of ordered) {
    assertGnf(payment.amount, "Paiement");
    if (payment.amount <= 0) throw new Error("Un paiement valide doit être supérieur à zéro");
    let left = payment.amount;
    const order = [];
    if (payment.installmentCode && Object.hasOwn(covered, payment.installmentCode)) {
      order.push(payment.installmentCode);
    }
    for (const item of plan) {
      if (!order.includes(item.code)) order.push(item.code);
    }
    for (const code of order) {
      const item = plan.find((entry) => entry.code === code);
      const room = item.amount - covered[code];
      if (room <= 0) continue;
      const used = Math.min(room, left);
      covered[code] += used;
      left -= used;
      if (left === 0) break;
    }
    credit += left;
  }
  return { covered, credit };
}

export function daysBetween(earlier, later) {
  const [yearA, monthA, dayA] = earlier.split("-").map(Number);
  const [yearB, monthB, dayB] = later.split("-").map(Number);
  const utcA = Date.UTC(yearA, monthA - 1, dayA);
  const utcB = Date.UTC(yearB, monthB - 1, dayB);
  return Math.round((utcB - utcA) / 86_400_000);
}

export function agingBucket(days) {
  if (days <= 0) return null;
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/**
 * Calcule la situation d'un étudiant. Fonction pure : aucun accès base de données.
 */
export function computeSituation({ tuition, discounts = [], adjustments = [], installments, payments, asOf }) {
  const { due, warning } = feesDue(tuition, discounts, adjustments);
  const plan = fitPlanToDue(installments, due);
  const valid = payments.filter((payment) => payment.status === "valide");
  const paid = valid.reduce((total, payment) => total + payment.amount, 0);
  const allocation = allocate(valid, plan);
  const reste = Math.max(0, due - paid);
  const credit = Math.max(0, paid - due);
  const overdue = plan.filter((item) => item.dueOn < asOf && allocation.covered[item.code] < item.amount);
  const status = paymentStatus({ paid, due, overdueUncovered: overdue.length > 0 });
  const oldest = overdue.map((item) => item.dueOn).sort()[0] || null;
  const agingDays = oldest ? daysBetween(oldest, asOf) : 0;
  const overdueAmount = overdue.reduce((total, item) => total + (item.amount - allocation.covered[item.code]), 0);
  if (allocation.credit !== credit) {
    throw new Error("Incohérence interne : le crédit réparti ne correspond pas au trop-perçu");
  }
  const planSum = plan.reduce((total, item) => total + item.amount, 0);
  if (planSum !== due) {
    throw new Error("Incohérence interne : la somme des échéances n'est pas égale aux frais dus");
  }
  return {
    due,
    paid,
    reste,
    credit,
    status,
    statusLabel: STATUS_LABELS[status],
    warning,
    plan,
    covered: allocation.covered,
    overdueAmount,
    agingDays,
    agingBucket: agingBucket(agingDays),
    rate: recoveryRate(paid, due),
  };
}

/** Même calcul, en ajoutant un paiement qui n'est pas encore enregistré (aperçu). */
export function previewSituation(input, draft) {
  assertGnf(draft.amount, "Montant");
  const before = computeSituation(input);
  const after = computeSituation({
    ...input,
    payments: [
      ...input.payments,
      {
        id: Number.MAX_SAFE_INTEGER,
        amount: draft.amount,
        status: "valide",
        paidOn: draft.paidOn,
        installmentCode: draft.installmentCode || null,
      },
    ],
  });
  return { before, after };
}
