import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { Sequelize } from "sequelize";
import { defineModels } from "./models.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRITE_LOCK = 4317;

// Sequelize partage la transaction en cours avec les modèles et les requêtes SQL du même appel.
const context = new AsyncLocalStorage();
const pending = new WeakMap();
Sequelize.useCLS({
  get: (key) => context.getStore()?.get(key),
  set: (key, value) => context.getStore()?.set(key, value),
  run: (fn) => {
    const store = new Map(context.getStore());
    return context.run(store, () => fn(store));
  },
  bind: (fn) => fn,
});

// Montants BIGINT et sommes NUMERIC en nombres ; dates et horodatages en texte
// (« 2026-10-05 », « 2026-10-05 09:04:52 ») : le code financier les compare ainsi.
const NATIVE_TYPES = new Map([
  [20, Number],
  [1700, Number],
  [1082, (value) => value],
  [1114, (value) => value],
]);

function keepNativeTypes(sequelize) {
  const manager = sequelize.connectionManager;
  const apply = () => {
    for (const [oid, parser] of NATIVE_TYPES) manager.oidParserMap.set(oid, parser);
  };
  const refresh = manager._refreshTypeParser.bind(manager);
  manager._refreshTypeParser = (dataType) => {
    refresh(dataType);
    apply();
  };
  apply();
}

export function schemaName() {
  const schema = process.env.DB_SCHEMA || "scolarite";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error("DB_SCHEMA invalide");
  return schema;
}

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

/** Accès à la base : modèles Sequelize (db.models) et SQL paramétré (db.prepare) dans la même transaction. */
export class Database {
  constructor(sequelize) {
    this.sequelize = sequelize;
    this.models = sequelize.models;
  }

  prepare(sql) {
    return new Statement(this, positional(sql));
  }

  async query(text, params = []) {
    const run = async () => {
      const [rows, result] = await this.sequelize.query(text, {
        bind: params.length ? params : undefined,
        raw: true,
      });
      return { rows: Array.isArray(rows) ? rows : [], rowCount: result?.rowCount ?? 0 };
    };
    // Une transaction n'a qu'une connexion : ses requêtes passent l'une après l'autre,
    // même lancées ensemble (Promise.all).
    const current = context.getStore()?.get("transaction");
    if (!current) return run();
    const previous = pending.get(current) || Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    pending.set(current, next);
    return next;
  }

  async exec(sql) {
    await this.sequelize.query(sql, { raw: true });
  }

  close() {
    return this.sequelize.close();
  }
}

export function connect(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL manquant : voir .env.example");
  const schema = schemaName();
  const sequelize = new Sequelize(url, {
    dialect: "postgres",
    logging: process.env.DB_LOG === "true" ? console.log : false,
    pool: {
      max: Number(process.env.DB_POOL_SIZE || 10),
      min: 0,
      idle: 10_000,
      acquire: 30_000,
    },
    define: { freezeTableName: true, timestamps: false, underscored: true },
    dialectOptions: {
      application_name: "scolarite",
      statement_timeout: 30_000,
      options: `-c search_path=${schema}`,
      ...(process.env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}),
    },
  });
  keepNativeTypes(sequelize);
  defineModels(sequelize);
  return new Database(sequelize);
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
 * Exécute fn dans une transaction Sequelize. Les écritures sont sérialisées par un verrou consultatif :
 * deux encaissements simultanés ne peuvent pas lire le même « reste » ni le même numéro de reçu,
 * même avec plusieurs processus Node (Passenger). Un appel imbriqué réutilise la transaction en cours.
 */
export async function transaction(db, fn) {
  if (context.getStore()?.get("transaction")) return fn();
  return db.sequelize.transaction(async () => {
    await db.sequelize.query("SELECT pg_advisory_xact_lock(?)", { replacements: [WRITE_LOCK], raw: true });
    return fn();
  });
}

/** Code d'erreur PostgreSQL, que l'erreur vienne de Sequelize ou de pg. */
export function pgCode(error) {
  return error?.original?.code ?? error?.parent?.code ?? error?.code ?? null;
}
