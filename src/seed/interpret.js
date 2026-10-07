/**
 * Transforme une ligne du PDF (cases vides souvent perdues) en paiements.
 * Le total et le reste écrits dans le fichier ne sont jamais repris comme vérité :
 * ils servent seulement à signaler une anomalie.
 */
const CODES = ["inscription", "tranche_1", "tranche_2", "tranche_3"];

export function interpretLegacyRow(row, fee) {
  const nums = row.nums;
  const anomalies = [];
  if (!row.first) anomalies.push("prenom_manquant");

  if (nums.length === 0 || nums.every((value) => value === 0)) {
    anomalies.push("ligne_a_zero");
    return { payments: [], fileTotal: nums.length ? 0 : null, fileReste: nums.length ? 0 : null, anomalies };
  }

  let payments = [];
  let fileTotal = null;
  let fileReste = null;

  if (nums.length === 6) {
    const [a, b, c, d, total, reste] = nums;
    payments = [a, b, c, d].map((amount, index) => ({ code: CODES[index], amount })).filter((item) => item.amount > 0);
    fileTotal = total;
    fileReste = reste;
  } else {
    const matches = [];
    for (let index = 0; index < nums.length - 1; index += 1) {
      const sum = nums.slice(0, index + 1).reduce((total, value) => total + value, 0);
      if (sum > 0 && sum === nums[index + 1]) matches.push(index + 1);
    }
    const totalIndex = matches.length ? matches[matches.length - 1] : null;
    if (matches.length > 1) anomalies.push("colonnes_ambigues");
    if (totalIndex !== null) {
      payments = nums.slice(0, totalIndex).map((amount, index) => ({ code: CODES[index], amount })).filter((item) => item.amount > 0);
      fileTotal = nums[totalIndex];
      fileReste = nums[totalIndex + 1] === undefined ? null : nums[totalIndex + 1];
    } else if (nums[nums.length - 1] === 0) {
      payments = nums.slice(0, -1).map((amount, index) => ({ code: CODES[index], amount })).filter((item) => item.amount > 0);
      fileReste = 0;
      anomalies.push("total_fichier_absent");
    } else {
      payments = nums.map((amount, index) => ({ code: CODES[index] || "tranche_3", amount })).filter((item) => item.amount > 0);
      anomalies.push("colonnes_ambigues");
    }
  }

  const paid = payments.reduce((total, item) => total + item.amount, 0);
  if (!row.method && paid > 0) anomalies.push("moyen_manquant");
  if (fileTotal !== null && fileTotal !== paid) anomalies.push("total_fichier_different");
  const computedReste = Math.max(0, fee - paid);
  if (fileReste !== null && fileReste !== computedReste) anomalies.push("reste_fichier_different");
  if (fileReste !== null && fileReste > fee) anomalies.push("reste_superieur_aux_frais");
  if (fileTotal !== null && fileReste !== null && fileTotal + fileReste !== fee) anomalies.push("paye_plus_reste_different_des_frais");
  if (paid > fee) anomalies.push("trop_percu_potentiel");

  return { payments, fileTotal, fileReste, paid, anomalies };
}

export const ANOMALY_LABELS = {
  prenom_manquant: "Prénom manquant",
  moyen_manquant: "Moyen de paiement absent",
  ligne_a_zero: "Ligne vide ou entièrement à zéro",
  total_fichier_absent: "Total payé absent dans le fichier",
  total_fichier_different: "Le total du fichier n'est pas égal à la somme des tranches",
  reste_fichier_different: "Le reste du fichier ne correspond pas aux frais moins les paiements",
  reste_superieur_aux_frais: "Le reste du fichier est supérieur aux frais",
  paye_plus_reste_different_des_frais: "Payé + reste du fichier n'est pas égal aux frais",
  trop_percu_potentiel: "La somme des tranches dépasse les frais officiels",
  colonnes_ambigues: "Lecture incertaine : des cases vides ont disparu dans le PDF",
};
