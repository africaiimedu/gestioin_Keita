import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function databasePath() {
  return process.env.DB_PATH || path.join(root, "data", "scolarite.sqlite");
}

export function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(root, "data", "uploads");
}

let current = null;

export function getDb() {
  if (current) return current;
  const file = databasePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(uploadDir(), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  const schema = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
  db.exec(schema);
  current = db;
  return db;
}

export function closeDb() {
  if (current) current.close();
  current = null;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* déjà annulée */ }
    throw error;
  }
}
