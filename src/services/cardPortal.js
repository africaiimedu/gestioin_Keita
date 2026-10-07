import http from "node:http";
import https from "node:https";
import { can } from "../auth/passwords.js";

const PREFIX = "/portail/cartes";

function origin() {
  return new URL(process.env.CARD_API_URL || "http://127.0.0.1:8000");
}

export function isCardPortal(req) {
  return req.path === "/theme.css"
    || req.path.startsWith("/static/")
    || req.path.startsWith("/fonts/")
    || req.path.startsWith("/photo/")
    || req.path.startsWith(`${PREFIX}/`)
    || req.path === PREFIX;
}

function rewriteLocation(value) {
  if (!value) return value;
  if (value.startsWith(PREFIX) || value.startsWith("/static/") || value.startsWith("/fonts/") || value.startsWith("/theme.css")) return value;
  try {
    const target = origin();
    const url = new URL(value, target);
    if (url.host === target.host) return PREFIX + url.pathname + url.search + url.hash;
  } catch { /* adresse laissée telle quelle */ }
  if (value.startsWith("/")) return PREFIX + value;
  return value;
}

function rewriteText(text) {
  return text.replace(/(["'`])\/(?!portail\/cartes\/|static\/|fonts\/|theme\.css)/g, "$1/portail/cartes/");
}

const EMBED_STYLE = `<style>
header.barre{display:none!important}
.login-visuel{display:none!important}
.login{min-height:70vh;background:transparent!important;display:grid!important;place-items:center}
</style>
<link rel="stylesheet" href="/portail-cartes.css?v=3">
<script src="/portail-cartes.js?v=3" defer></script>`;

function cookiePair(header, name) {
  const source = Array.isArray(header) ? header.join("; ") : String(header || "");
  const match = source.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : "";
}

function cardRequest(path, { method = "GET", cookie = "", body = "" } = {}) {
  const token = process.env.CARD_API_TOKEN;
  const target = origin();
  const transport = target.protocol === "https:" ? https : http;
  const headers = { host: target.host };
  if (cookie) headers.cookie = cookie;
  if (body) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
    if (token) headers["x-jeton"] = token;
  }
  return new Promise((resolve) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 80,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
        const line = response.headers["set-cookie"];
        const chosen = (Array.isArray(line) ? line : [line]).find((item) => item && String(item).startsWith("africard="));
        resolve({ status: response.statusCode || 0, cookie: chosen || "", body });
      });
    });
    request.on("error", () => resolve({ status: 0, cookie: "" }));
    request.end(body || undefined);
  });
}

function replaceCookie(header, pair) {
  const name = pair.split("=")[0];
  const kept = String(header || "").split(";").map((part) => part.trim()).filter((part) => part && !part.startsWith(`${name}=`));
  kept.push(pair.split(";")[0]);
  return kept.join("; ");
}

function portalRole(user) {
  const cards = can(user, "cards.manage");
  const kitchen = can(user, "kitchen.manage");
  if (cards && kitchen) return "admin";
  if (kitchen) return "cuisiniere";
  if (cards) return "scolarite";
  return "";
}

function portalAllowed(user, tail) {
  if (!user) return false;
  if (tail.startsWith("/cantine")) return can(user, "kitchen.manage");
  if (tail.startsWith("/login")) return can(user, "cards.manage") || can(user, "kitchen.manage");
  return can(user, "cards.manage");
}

async function ensureCardSession(req, user) {
  const wanted = portalRole(user);
  if (!user || !wanted || !process.env.CARD_API_TOKEN) return;
  const current = cookiePair(req.headers.cookie, "africard");
  if (current) {
    const state = await cardRequest("/api/portail/session", { cookie: current });
    if (state.status === 200 && state.body?.role === wanted) return;
  }
  const opened = await cardRequest("/api/portail", {
    method: "POST",
    body: JSON.stringify({ role: wanted }),
  });
  if (!opened.cookie) return;
  req.headers.cookie = replaceCookie(req.headers.cookie, opened.cookie);
  req.portalCookie = opened.cookie;
}

function unavailable(_req, res) {
  res.status(503).type("html").send(`<!doctype html><meta charset="utf-8"><title>Cartes</title>
    <p style="font-family:Georgia,serif;color:#0c3d2e;padding:28px 24px;line-height:1.5">L'application des cartes ne répond pas. Ouvrez-la, puis rechargez cette page.</p>`);
}

function forward(req, res, targetPath, rewrite) {
  const target = origin();
  const transport = target.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers["accept-encoding"];
  const proxyReq = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: targetPath,
    headers,
  }, (upstream) => {
    const type = String(upstream.headers["content-type"] || "");
    const textual = rewrite && (/text\/html|javascript|ecmascript/.test(type) || targetPath.split("?")[0].endsWith(".js"));
    const headersOut = { ...upstream.headers };
    delete headersOut["x-frame-options"];
    delete headersOut["content-security-policy"];
    if (headersOut.location) headersOut.location = rewriteLocation(String(headersOut.location));
    if (!textual) {
      if (req.portalCookie) {
        const current = headersOut["set-cookie"];
        headersOut["set-cookie"] = current ? [].concat(current, req.portalCookie) : req.portalCookie;
      }
      res.writeHead(upstream.statusCode || 502, headersOut);
      upstream.pipe(res);
      return;
    }
    const chunks = [];
    upstream.on("data", (chunk) => chunks.push(chunk));
    upstream.on("end", () => {
      let text = rewriteText(Buffer.concat(chunks).toString("utf8"));
      if (/text\/html/.test(type) && text.includes("barre")) {
        const style = text.includes('class="atelier')
          ? `<style>header.barre{display:none!important}html,body{height:100%!important;background:#eceff1!important}</style>`
          : EMBED_STYLE;
        text = text.replace("</head>", `${style}</head>`);
      }
      const body = Buffer.from(text);
      delete headersOut["content-length"];
      delete headersOut["transfer-encoding"];
      delete headersOut["content-encoding"];
      headersOut["content-length"] = String(body.length);
      if (req.portalCookie) {
        const current = headersOut["set-cookie"];
        headersOut["set-cookie"] = current ? [].concat(current, req.portalCookie) : req.portalCookie;
      }
      res.writeHead(upstream.statusCode || 502, headersOut);
      res.end(body);
    });
  });
  proxyReq.on("error", () => {
    if (!res.headersSent) unavailable(req, res);
  });
  req.pipe(proxyReq);
}

export function attachCardPortal(app, resolveUser = () => null) {
  app.use("/static", (req, res) => forward(req, res, req.originalUrl, true));
  app.use("/fonts", (req, res) => forward(req, res, req.originalUrl, false));
  app.use("/photo", (req, res) => forward(req, res, req.originalUrl, false));
  app.get("/theme.css", (req, res) => forward(req, res, req.originalUrl, false));
  app.use(PREFIX, (req, res) => {
    let tail = req.url && req.url !== "/" ? req.url : "/";
    if (!tail.startsWith("/")) tail = `/${tail}`;
    const user = resolveUser(req);
    const pathOnly = tail.split("?")[0];
    if (pathOnly.startsWith("/admin/comptes") || pathOnly.startsWith("/compte")) {
      res.status(200).type("html").send(`<!doctype html><meta charset="utf-8"><title>Comptes</title>
        <script>(window.top || window).location.href = "/#finances/comptes";</script>
        <p style="font-family:Georgia,serif;color:#0c3d2e;padding:28px 24px">Les comptes se gèrent uniquement dans <a href="/#finances/comptes" target="_top">Comptes</a>.</p>`);
      return;
    }
    if (user && !portalAllowed(user, pathOnly)) {
      res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><p style="font-family:Georgia,serif;color:#0c3d2e;padding:28px 24px">Cette partie n'est pas autorisée pour votre compte.</p>`);
      return;
    }
    ensureCardSession(req, user).then(() => {
      if (user && (tail === "/login" || tail.startsWith("/login?"))) {
        tail = can(user, "kitchen.manage") && !can(user, "cards.manage") ? "/cantine" : "/admin/etudiants";
      }
      forward(req, res, tail, true);
    });
  });
}
