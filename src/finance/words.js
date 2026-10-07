/**
 * Montant en lettres, en français.
 * Une seule fonction pour les reçus, les tests et les avoirs.
 * Exemple : 4 000 000 → « quatre millions de francs guinéens ».
 */

const UNITS = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  "dix-sept", "dix-huit", "dix-neuf",
];

function convertTens(n, terminalPlural) {
  if (n < 20) return UNITS[n];
  if (n < 70) {
    const tens = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante"];
    const ten = Math.floor(n / 10);
    const unit = n % 10;
    if (unit === 0) return tens[ten];
    if (unit === 1) return `${tens[ten]} et un`;
    return `${tens[ten]}-${UNITS[unit]}`;
  }
  if (n < 80) {
    if (n === 71) return "soixante et onze";
    return `soixante-${UNITS[n - 60]}`;
  }
  const unit = n - 80;
  if (unit === 0) return terminalPlural ? "quatre-vingts" : "quatre-vingt";
  return `quatre-vingt-${UNITS[unit]}`;
}

function convertHundreds(n, terminalPlural) {
  if (n < 100) return convertTens(n, terminalPlural);
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  let word = hundreds === 1 ? "cent" : `${UNITS[hundreds]} cent`;
  if (rest === 0) {
    if (hundreds > 1 && terminalPlural) word += "s";
    return word;
  }
  return `${word} ${convertTens(rest, terminalPlural)}`;
}

/**
 * Écrit un entier positif ou nul en toutes lettres, sans la devise.
 * @param {number} n
 */
export function integerToWords(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("Le montant en lettres exige un entier positif ou nul");
  }
  if (n === 0) return "zéro";

  const scales = [
    { value: 1_000_000_000, one: "milliard", many: "milliards", terminal: true },
    { value: 1_000_000, one: "million", many: "millions", terminal: true },
    { value: 1_000, one: "mille", many: "mille", terminal: false },
  ];

  const parts = [];
  let rest = n;
  for (const scale of scales) {
    if (rest < scale.value) continue;
    const count = Math.floor(rest / scale.value);
    rest -= count * scale.value;
    if (scale.value === 1_000 && count === 1) {
      parts.push("mille");
      continue;
    }
    const countWords = convertHundreds(count, scale.terminal);
    const label = count > 1 ? scale.many : scale.one;
    parts.push(`${countWords} ${label}`);
  }
  if (rest > 0) parts.push(convertHundreds(rest, true));
  return parts.join(" ");
}

/**
 * @param {number} amount entier GNF
 * @returns {string} ex. « quatre millions de francs guinéens »
 */
export function amountInWords(amount) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Le montant en lettres exige un entier GNF positif ou nul");
  }
  if (amount === 0) return "zéro franc guinéen";
  if (amount === 1) return "un franc guinéen";
  const words = integerToWords(amount);
  const roundLarge = amount >= 1_000_000 && (amount % 1_000_000 === 0 || amount % 1_000_000_000 === 0);
  const link = roundLarge ? "de " : "";
  return `${words} ${link}francs guinéens`;
}
