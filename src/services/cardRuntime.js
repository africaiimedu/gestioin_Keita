import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RETRY_MAX_MS = 60_000;

let socketPath = null;
let child = null;
let stopping = false;
let retryMs = 2_000;
let cachedToken = null;

export function cardEmbedded() {
  return process.env.CARD_EMBEDDED === "true";
}

export function cardDir() {
  return path.resolve(process.env.CARD_APP_DIR || path.join(ROOT, "Afrcaiim Card"));
}

export function cardConfigured() {
  return cardEmbedded() ? Boolean(socketPath) : Boolean(process.env.CARD_API_URL);
}

export function cardOrigin() {
  return cardEmbedded() ? new URL("http://localhost") : new URL(process.env.CARD_API_URL || "http://127.0.0.1:8000");
}

function envFileValue(file, key) {
  try {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  } catch {
    return "";
  }
}

export function cardToken() {
  if (process.env.CARD_API_TOKEN) return process.env.CARD_API_TOKEN;
  if (!cardEmbedded()) return "";
  if (cachedToken === null) cachedToken = envFileValue(path.join(cardDir(), ".env"), "INSCRIPTION_JETON");
  return cachedToken;
}

export function cardTarget() {
  if (cardEmbedded()) return { transport: http, options: { socketPath }, host: "localhost" };
  const target = cardOrigin();
  return {
    transport: target.protocol === "https:" ? https : http,
    options: { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80) },
    host: target.host,
  };
}

export async function cardReady(timeoutMs = 20_000) {
  if (!cardEmbedded()) return true;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (socketPath && fs.existsSync(socketPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function cardCall(urlPath, { method = "GET", cookie = "", body = "", timeoutMs = 8_000 } = {}) {
  const token = cardToken();
  const { transport, options, host } = cardTarget();
  const headers = { host };
  if (cookie) headers.cookie = cookie;
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
    if (token) headers["x-jeton"] = token;
  }
  return new Promise((resolve) => {
    const request = transport.request({ ...options, method, path: urlPath, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { data = {}; }
        resolve({ status: response.statusCode || 0, headers: response.headers, body: data });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.on("error", () => resolve({ status: 0, headers: {}, body: {} }));
    request.end(body || undefined);
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function launch(python, dir) {
  if (stopping) return;
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  const started = Date.now();
  child = spawn(python, ["serveur_embarque.py", socketPath], {
    cwd: dir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || dir, LANG: "C.UTF-8", TZ: process.env.TZ || "Africa/Conakry" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", (error) => console.error(`Cartes : lancement impossible (${error.message}).`));
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    retryMs = Date.now() - started > RETRY_MAX_MS ? 2_000 : Math.min(retryMs * 2, RETRY_MAX_MS);
    console.error(`Cartes arrêtée (${signal || code}) : relance dans ${Math.round(retryMs / 1000)} s.`);
    setTimeout(() => launch(python, dir), retryMs).unref();
  });
}

export function startEmbeddedCards() {
  if (!cardEmbedded() || child) return;
  const dir = cardDir();
  const python = path.join(dir, ".venv", "bin", "python");
  if (!fs.existsSync(python) || !fs.existsSync(path.join(dir, ".env"))) {
    console.error(`Cartes : environnement Python ou fichier .env absent dans « ${dir} ».`);
    return;
  }
  const sockets = path.join(ROOT, "tmp", "cartes");
  fs.mkdirSync(sockets, { recursive: true, mode: 0o700 });
  fs.chmodSync(sockets, 0o700);
  for (const name of fs.readdirSync(sockets)) {
    const pid = Number(name.replace(/\.sock$/, ""));
    if (pid && pid !== process.pid && !alive(pid)) fs.rmSync(path.join(sockets, name), { force: true });
  }
  socketPath = path.join(sockets, `${process.pid}.sock`);
  launch(python, dir);
  process.once("exit", () => {
    stopping = true;
    child?.kill("SIGTERM");
    fs.rmSync(socketPath, { force: true });
  });
}
