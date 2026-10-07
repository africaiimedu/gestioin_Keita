// Outils communs aux scripts de transfert, d'export et d'import des données.

// Ordre imposé par les clés étrangères.
export const TABLES = [
  "roles", "users", "sessions", "login_logs", "academic_years", "programs", "fee_schedules",
  "fee_schedule_history", "installment_due_dates", "students", "discounts", "adjustments",
  "student_installments", "payments", "payment_controls", "costume_payments", "payment_attachments",
  "document_sequences", "receipts", "enrollment_receipts", "cancellations", "reminders",
  "audit_logs", "import_batches", "settings",
];

/** Contrôles chiffrés comparés avant et après chaque déplacement des données. */
export const CONTROLS = {
  paiementsValides: "SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE status = 'valide'",
  paiementsAnnules: "SELECT COALESCE(SUM(amount), 0) AS v FROM payments WHERE status = 'annule'",
  costumesValides: "SELECT COALESCE(SUM(amount), 0) AS v FROM costume_payments WHERE status = 'valide'",
  parEtudiant: "SELECT COALESCE(string_agg(student_id || ':' || total, ',' ORDER BY student_id), '') AS v FROM (SELECT student_id, SUM(amount) AS total FROM payments WHERE status = 'valide' GROUP BY student_id) t",
  numerosRecus: "SELECT COALESCE(string_agg(number, ',' ORDER BY number), '') AS v FROM receipts",
  numerosInscription: "SELECT COALESCE(string_agg(number, ',' ORDER BY number), '') AS v FROM enrollment_receipts",
};

export async function measure(db) {
  const counts = {};
  for (const table of TABLES) counts[table] = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
  const controls = {};
  for (const [name, sql] of Object.entries(CONTROLS)) controls[name] = (await db.prepare(sql).get()).v;
  return { counts, controls };
}

export async function isEmpty(db) {
  const used = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM students) + (SELECT COUNT(*) FROM payments) AS n",
  ).get();
  return used.n === 0;
}

export async function columnsOf(db, table) {
  return (await db.prepare(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position
  `).all(table)).map((row) => row.column_name);
}

/** Insère des lignes (tableaux de valeurs) par lots ; les paramètres restent liés, jamais concaténés. */
export async function insertRows(db, table, columns, rows, batch = 200) {
  const conflict = table === "settings" ? " ON CONFLICT (key) DO UPDATE SET value = excluded.value" : "";
  for (let start = 0; start < rows.length; start += batch) {
    const chunk = rows.slice(start, start + batch);
    const values = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    await db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES ${values}${conflict}`).run(...chunk.flat());
  }
}

/** Replace le compteur de la colonne id (SERIAL ou IDENTITY) après une copie avec identifiants conservés. */
export async function resetIdentity(db, table) {
  const hasId = await db.prepare(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'id'
  `).get(table);
  if (!hasId) return;
  const counter = await db.prepare("SELECT pg_get_serial_sequence(?, 'id') AS name").get(table);
  if (!counter.name) return;
  await db.exec(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}
