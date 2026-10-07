/**
 * Lignes lues dans le PDF « Suivi Paiement des Étudiants ».
 * Les montants à 0 sont conservés : ils signalent une ligne vide, ils ne deviennent pas des paiements.
 * school : code interne. method null = case vide dans le fichier.
 * À partir de la ligne 45, le PDF indique le niveau Master.
 */
export const LEGACY_ROWS = [
  { n: 1, school: "DROIT", last: "SOW", first: "Souleymane", nums: [1_000_000, 4_000_000, 10_000_000, 10_000_000, 25_000_000, 0], method: "cheque" },
  { n: 2, school: "ABS", last: "LENO", first: "La Grace", nums: [1_000_000, 4_000_000, 10_000_000, 15_000_000, 10_000_000], method: "virement" },
  { n: 3, school: "ABS", last: "DIALLO", first: "Salimatou Fatima", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 4, school: "CARRIERE", last: "BALDE", first: "Hadja Aissatou", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 5, school: "ABS", last: "DIALLO", first: "Diariou", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 6, school: "ABS", last: "SACKO", first: "Aicha", nums: [1_000_000, 1_000_000, 24_000_000], method: "mobile" },
  { n: 7, school: "DROIT", last: "DIALLO", first: "Fatoumata", nums: [1_000_000, 4_000_000, 10_000_000, 8_800_000, 23_800_000, 0], method: "virement" },
  { n: 8, school: "SUP", last: "MARA", first: "Fasaly", nums: [1_000_000, 1_000_000, 24_000_000], method: "especes" },
  { n: 9, school: "SUP", last: "TOURE", first: "Mariame", nums: [0, 0, 0, 0, 0, 0], method: null },
  { n: 10, school: "DROIT", last: "TOURE", first: "Mamadi", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "orange_money" },
  { n: 11, school: "ABS", last: "HOLIE", first: "Bernadette", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "especes" },
  { n: 12, school: "TECH", last: "DOUKOURE", first: "Aicha", nums: [2_000_000, 9_400_000, 11_400_000, 25_600_000], method: "mobile" },
  { n: 13, school: "TECH", last: "DIABATE", first: "Kekoura", nums: [2_000_000, 2_000_000, 35_000_000], method: "especes" },
  { n: 14, school: "DROIT", last: "CONDE", first: "Tata", nums: [1_000_000, 4_000_000, 5_000_000, 32_000_000], method: "mobile" },
  { n: 15, school: "TECH", last: "YATTARA", first: "Kerfala", nums: [2_000_000, 18_000_000, 20_000_000, 17_000_000], method: "cheque" },
  { n: 16, school: "ABS", last: "CAMARA", first: "Aicha Deen", nums: [1_000_000, 4_000_000, 10_000_000, 9_800_000, 24_800_000, 0], method: "virement" },
  { n: 17, school: "TECH", last: "BOCOUM", first: "Madina", nums: [2_000_000, 14_000_000, 16_000_000, 21_000_000], method: "mobile" },
  { n: 18, school: "TECH", last: "KOUYATE", first: "Aminata", nums: [2_000_000, 2_000_000, 35_000_000], method: "mobile" },
  { n: 19, school: "TECH", last: "DIALLO", first: "Ibrahima Sory", nums: [2_000_000, 1_000_000, 3_000_000, 34_000_000], method: "mobile" },
  { n: 20, school: "TECH", last: "DIALLO", first: "Alpha Oumar", nums: [2_000_000, 14_000_000, 16_000_000, 21_000_000], method: "cheque" },
  { n: 21, school: "ABS", last: "KABA", first: "Djénè", nums: [1_000_000, 5_000_000, 6_000_000, 19_000_000], method: "mobile" },
  { n: 22, school: "ABS", last: "GUIRASSY", first: "Mohamed L", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "especes" },
  { n: 23, school: "DROIT", last: "CAMARA", first: "Elhadj B", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 24, school: "DROIT", last: "SIDIBE", first: "Mariame", nums: [1_000_000, 1_000_000, 24_000_000], method: "mobile" },
  { n: 25, school: "DROIT", last: "BARRY", first: "Zeinab", nums: [1_000_000, 1_000_000, 21_500_000], method: "especes" },
  { n: 26, school: "DROIT", last: "SYLLA", first: "Fatoumata Ben", nums: [1_000_000, 4_000_000, 1_000_000, 8_800_000, 23_800_000, 0], method: "cheque" },
  { n: 27, school: "DROIT", last: "FERNANDEZ", first: "Rose Diaye", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "especes" },
  { n: 28, school: "ABS", last: "SACKO", first: "M'mah Kaba", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "especes" },
  { n: 29, school: "ABS", last: "BAH", first: "Houleymatou", nums: [1_000_000, 4_000_000, 10_000_000, 8_800_000, 23_000_000, 800_000], method: "virement" },
  { n: 30, school: "TECH", last: "HABA", first: "Marcel", nums: [2_000_000, 1_000_000, 3_000_000, 22_000_000], method: "mobile" },
  { n: 31, school: "TECH", last: "SAGNO", first: "Nyanga Abel", nums: [2_000_000, 1_000_000, 3_000_000, 22_000_000], method: "mobile" },
  { n: 32, school: "TECH", last: "BALDE", first: "Ibrahima Dio", nums: [2_000_000, 2_000_000, 35_000_000], method: "especes" },
  { n: 33, school: "TECH", last: "CAMARA", first: "Mariame C", nums: [2_000_000, 14_000_000, 16_000_000, 21_000_000], method: "virement" },
  { n: 34, school: "TECH", last: "TOUPOU", first: "Apollinaire", nums: [2_000_000, 14_000_000, 10_000_000, 1_000_000, 27_000_000, 0], method: "especes" },
  { n: 35, school: "ABS", last: "DANSO", first: "Fatoumata B", nums: [1_000_000, 3_000_000, 4_000_000, 21_000_000], method: "mobile" },
  { n: 36, school: "ABS", last: "DIALLO", first: "Hassatou", nums: [1_000_000, 1_000_000, 24_000_000], method: "especes" },
  { n: 37, school: "ABS", last: "DIALLO", first: "Alhassane", nums: [1_000_000, 2_000_000, 3_000_000, 22_000_000], method: "especes" },
  { n: 38, school: "ABS", last: "BAH", first: "Mohamed M", nums: [1_000_000, 1_000_000, 21_500_000], method: "especes" },
  { n: 39, school: "ABS", last: "MARA", first: "Mohamed Ke", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 40, school: "ABS", last: "DIALLO", first: "Mariame Kor", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 41, school: "ABS", last: "BAH", first: "Kadiatou", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: null },
  { n: 42, school: "ABS", last: "CAMARA", first: "Almamy k", nums: [1_000_000, 4_000_000, 10_000_000, 8_800_000, 0], method: "mobile" },
  { n: 43, school: "ABS", last: "FERNAND", first: "", nums: [0, 0, 0, 0, 0, 0], method: null },
  { n: 44, school: "ABS", last: "DIALLO", first: "Ibrahima", nums: [1_000_000, 4_000_000, 5_000_000, 20_000_000], method: "mobile" },
  { n: 45, school: "ABS", last: "CAMARA", first: "Simita", nums: [3_000_000, 3_000_000, 27_000_000], method: "virement" },
  { n: 46, school: "ABS", last: "CAMARA", first: "Mamadou", nums: [3_000_000, 7_000_000, 10_000_000, 20_000_000], method: "mobile" },
  { n: 47, school: "EXPERTISE", last: "BANGOURA", first: "Mabinty", nums: [3_000_000, 7_000_000, 10_000_000, 6_500_000, 26_500_000, 3_500_000], method: "cheque" },
  { n: 48, school: "ABS", last: "DIALLO", first: "Mamadou Aliou", nums: [3_000_000, 7_000_000, 10_000_000, 20_000_000], method: "mobile" },
  { n: 49, school: "EXPERTISE", last: "KOUROUMA", first: "Ibrahima Kalil", nums: [3_000_000, 3_000_000, 27_000_000], method: "mobile" },
  { n: 50, school: "ABS", last: "SOUMAH", first: "Mohamed", nums: [3_000_000, 3_000_000, 27_000_000], method: "especes" },
  { n: 51, school: "ABS", last: "SOUMAH", first: "Aboubacar", nums: [3_000_000, 3_000_000, 3_000_000], method: "especes" },
  { n: 52, school: "ABS", last: "KAMANO", first: "Sia Therese", nums: [3_000_000, 7_000_000, 10_000_000, 20_000_000], method: "mobile" },
  { n: 53, school: "ABS", last: "BALDE", first: "Aminata", nums: [3_000_000, 3_000_000, 27_000_000], method: "mobile" },
  { n: 54, school: "ABS", last: "SYLLA", first: "Abdrahmane", nums: [3_000_000, 3_000_000, 37_000_000], method: "mobile" },
  { n: 55, school: "ABS", last: "CONDE", first: "Sekou", nums: [3_000_000, 10_000_000, 5_000_000, 18_000_000, 12_000_000], method: null },
  { n: 56, school: "CARRIERE", last: "DIARRA", first: "Salima", nums: [3_000_000, 7_000_000, 8_000_000, 18_000_000, 12_000_000], method: "especes" },
  { n: 57, school: "DROIT", last: "CAMARA", first: "Cheick AH", nums: [3_000_000, 7_000_000, 10_000_000, 20_000_000], method: "mobile" },
  { n: 58, school: "ABS", last: "CONDE", first: "Mouctar", nums: [], method: null },
  { n: 59, school: "DROIT", last: "SANDE", first: "Djiba", nums: [3_000_000, 7_000_000, 10_000_000, 20_000_000], method: "mobile" },
  { n: 60, school: "ABS", last: "BAH", first: "Fatoumata Diaraye", nums: [3_000_000, 3_000_000, 27_000_000], method: "especes" },
  { n: 61, school: "ABS", last: "DIALLO", first: "Kadiatou", nums: [3_000_000, 4_000_000, 7_000_000, 23_000_000], method: "mobile" },
  { n: 62, school: "ABS", last: "KEITA", first: "Rokiatou", nums: [3_000_000, 3_000_000, 27_000_000], method: "orange_money" },
];

export const PROGRAMS = [
  { code: "ABS", name: "AFRICAIIM Business School" },
  { code: "TECH", name: "AFRICAIIM Tech" },
  { code: "DROIT", name: "AFRICAIIM École de Droit et Sciences Politiques" },
  { code: "SUP", name: "AFRICAIIM Sup de Com" },
  { code: "EXPERTISE", name: "AFRICAIIM Expertise Comptable" },
  { code: "CARRIERE", name: "AFRICAIIM Carrières Bancaires" },
];

import { officialInstallments } from "../finance/index.js";

/** Le droit d'inscription est la première échéance, déjà comprise dans les frais annuels. */
function partsOf(tuition) {
  const rows = officialInstallments(tuition);
  return [rows[0].amount, rows[1].amount, rows[2].amount, 0];
}

export const FEE_PLANS = {
  licence: { tuition: 25_000_000, parts: partsOf(25_000_000) },
  master: { tuition: 30_000_000, parts: partsOf(30_000_000) },
  tech: { tuition: 37_000_000, parts: partsOf(37_000_000) },
};

/** Barème des nouvelles fiches. Les étudiants déjà importés gardent leur ancien barème. */
export const OFFER_PLANS = {
  bachelor: { tuition: 24_000_000, parts: partsOf(24_000_000) },
  bachelor_1: { tuition: 24_000_000, parts: partsOf(24_000_000) },
  bachelor_2: { tuition: 24_000_000, parts: partsOf(24_000_000) },
  bachelor_3: { tuition: 24_000_000, parts: partsOf(24_000_000) },
  master_1: { tuition: 27_000_000, parts: partsOf(27_000_000) },
  master_2: { tuition: 28_000_000, parts: partsOf(28_000_000) },
};

export const DUE_DATES = {
  inscription: "2026-10-05",
  tranche_1: "2026-12-05",
  tranche_2: "2027-03-05",
};

export function levelOf(row) {
  if (row.school === "TECH") return "tech";
  if (row.n >= 45) return "master";
  return "licence";
}

export function feeOf(level) {
  return FEE_PLANS[level].tuition;
}
