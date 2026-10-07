import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Montants en BIGINT et sommes NUMERIC reviennent en nombres ; dates et horodatages restent du texte
// (« 2026-10-05 », « 2026-10-05 09:04:52 »), comme le reste du code les compare.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value) => value);

export const SCHEMA = "scolarite";
const WRITE_LOCK = 4317;
const activeClient = new AsyncLocalStorage();

export function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(root, "data", "uploads");
}

/** Remplace les « ? » par $1, $2… en ignorant ceux écrits entre apostrophes. */
export function positional(sql) {
  let index = 0;
  let quoted = false;
  let out = "";
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    out += char === "?" && !quoted ? `$${++index}` : char;
  }
  return out;
}

class Statement {
  constructor(db, text) {
    this.db = db;
    this.text = text;
  }

  async get(...params) {
    return (await this.db.query(this.text, params)).rows[0];
  }

  async all(...params) {
    return (await this.db.query(this.text, params)).rows;
  }

  /** Pour un INSERT, ajouter « RETURNING id » afin d'obtenir lastInsertRowid. */
  async run(...params) {
    const result = await this.db.query(this.text, params);
    return { changes: result.rowCount, lastInsertRowid: result.rows[0]?.id ?? null };
  }
}

export class Database {
  constructor(pool) {
    this.pool = pool;
  }

  prepare(sql) {
    return new Statement(this, positional(sql));
  }

  query(text, params = []) {
    return (activeClient.getStore() || this.pool).query(text, params);
  }

  async exec(sql) {
    await this.query(sql);
  }

  close() {
    return this.pool.end();
  }
}

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL manquant : voir .env.example");
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_SIZE || 10),
    application_name: "scolarite",
    options: `-c search_path=${SCHEMA} -c statement_timeout=30000`,
  });
  pool.on("error", (error) => console.error(`PostgreSQL : ${error.message}`));
  return new Database(pool);
}

let current = null;

export function getDb() {
  if (!current) current = connect();
  return current;
}

export async function closeDb() {
  if (current) await current.close();
  current = null;
}

/**
 * Exécute fn dans une transaction. Les écritures sont sérialisées par un verrou consultatif :
 * deux encaissements simultanés ne peuvent pas lire le même « reste » ni le même numéro de reçu.
 * Un appel imbriqué réutilise la transaction en cours.
 */
export async function transaction(db, fn) {
  if (activeClient.getStore()) return fn();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK]);
    const result = await activeClient.run(client, fn);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
