import crypto from "node:crypto";

const PERMISSIONS = {
  super_admin: ["*"],
  admin: [
    "dashboard.read", "student.read", "student.write", "student.status",
    "payment.create", "payment.cancel", "receipt.read", "report.read",
    "reminder.create", "import.run", "audit.read",     "fee.write", "settings.write",
    "user.write", "cards.manage", "kitchen.manage", "expense.write",
  ],
  gestionnaire: [
    "dashboard.read", "student.read", "student.write", "payment.create",
    "receipt.read", "report.read", "reminder.create",
  ],
};

export const RIGHTS = [
  ["dashboard.read", "Tableau de bord"],
  ["student.read", "Consulter les étudiants"],
  ["student.write", "Créer et modifier une fiche"],
  ["student.status", "Changer le statut d'un étudiant"],
  ["payment.create", "Encaisser un paiement"],
  ["payment.cancel", "Annuler un paiement"],
  ["receipt.read", "Imprimer les reçus"],
  ["reminder.create", "Noter une relance"],
  ["report.read", "Journal de caisse"],
  ["expense.write", "Dépenses et décharges"],
  ["import.run", "Importer un fichier"],
  ["audit.read", "Journal d'audit"],
  ["fee.write", "Modifier le barème"],
  ["settings.write", "Modifier les réglages"],
  ["user.write", "Gérer les comptes"],
  ["cards.manage", "Gestion des cartes"],
  ["kitchen.manage", "Cuisine"],
];

const RIGHT_CODES = new Set(RIGHTS.map(([code]) => code));

export function normalizeRights(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((code) => RIGHT_CODES.has(code)))];
}

export function rightsOf(userOrRole) {
  if (typeof userOrRole === "string") {
    const list = PERMISSIONS[userOrRole] || [];
    return list.includes("*") ? ["*"] : [...list];
  }
  if (!userOrRole) return [];
  if (userOrRole.role === "super_admin") return ["*"];
  if (userOrRole.permissions_json) {
    try {
      const parsed = JSON.parse(userOrRole.permissions_json);
      if (Array.isArray(parsed)) return normalizeRights(parsed);
    } catch {
      /* le rôle sert de repli */
    }
  }
  const list = PERMISSIONS[userOrRole.role] || [];
  return list.includes("*") ? ["*"] : [...list];
}

export function can(userOrRole, action) {
  const list = rightsOf(userOrRole);
  return list.includes("*") || list.includes(action);
}

export function passwordIssue(password) {
  const value = String(password || "");
  const upper = /[A-ZÀ-ÖØ-Þ]/;
  const lower = /[a-zà-öø-ÿ]/;
  const digit = /\d/;
  const special = /[^A-Za-zÀ-ÖØ-öø-ÿ0-9]/;
  if (value.length >= 6 && upper.test(value) && lower.test(value) && digit.test(value) && special.test(value)) return "";
  return "Le mot de passe doit contenir au moins 6 caractères, dont une majuscule, une minuscule, un chiffre et un caractère spécial.";
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function sessionToken() {
  return crypto.randomBytes(32).toString("hex");
}
