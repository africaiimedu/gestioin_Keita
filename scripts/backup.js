import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { databasePath, uploadDir } from "../src/db.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const passphrase = process.env.BACKUP_PASSPHRASE || "changer-ce-mot-de-passe";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(root, "data", "backups");
fs.mkdirSync(outDir, { recursive: true });

const payload = {
  createdAt: new Date().toISOString(),
  database: fs.existsSync(databasePath()) ? fs.readFileSync(databasePath()).toString("base64") : null,
};
const json = Buffer.from(JSON.stringify(payload));
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(passphrase, salt, 32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
const tag = cipher.getAuthTag();
const file = path.join(outDir, `sauvegarde-${stamp}.aimbak`);
fs.writeFileSync(file, Buffer.concat([Buffer.from("AIM1"), salt, iv, tag, encrypted]));
console.log(`Sauvegarde chiffrée : ${file}`);
console.log(`Dossier des pièces : ${uploadDir()}`);
