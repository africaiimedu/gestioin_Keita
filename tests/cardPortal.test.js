import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { attachCardPortal, rewriteText } from "../src/services/cardPortal.js";

const admin = { id: 1, role: "super_admin", permissions: [] };

async function withPortal(renameMatricule, run) {
  const app = express();
  attachCardPortal(app, () => admin, { renameMatricule });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}/portail/cartes/admin/etudiants/7/matricule`);
  } finally {
    server.close();
  }
}

const post = (url, fields, headers = {}) => fetch(url, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields),
});

test("matricule changé depuis la fiche carte : la scolarité renomme, puis retour sur la fiche", async () => {
  const calls = [];
  await withPortal(async (user, previous, next) => {
    calls.push([user.id, previous, next]);
    if (next === "PRIS") throw Object.assign(new Error("pris"), { status: 409 });
    return previous === "INCONNU" ? null : "synchro";
  }, async (url) => {
    const ok = await post(url, { csrf: "x", ancien: "UA26AT0001", matricule: "UA26AT0042" });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/portail/cartes/admin/etudiants/7?matricule=synchro");
    assert.deepEqual(calls[0], [1, "UA26AT0001", "UA26AT0042"]);

    const taken = await post(url, { ancien: "UA26AT0001", matricule: "PRIS" });
    assert.equal(taken.headers.get("location"), "/portail/cartes/admin/etudiants/7?matricule=pris");

    const foreign = await post(url, { ancien: "UA26AT0001", matricule: "X1" }, { origin: "https://pirate.example" });
    assert.equal(foreign.status, 403);
    assert.equal(calls.length, 2);

    const cardOnly = await post(url, { ancien: "INCONNU", matricule: "UA26AT0050" });
    assert.notEqual(cardOnly.status, 303);
  });
});

test("le portail transmet l'enregistrement de la carte sans le modifier", async () => {
  const recu = [];
  const amont = http.createServer((req, res) => {
    const morceaux = [];
    req.on("data", (morceau) => morceaux.push(morceau));
    req.on("end", () => {
      recu.push({
        url: req.url,
        csrf: req.headers["x-csrf"],
        corps: Buffer.concat(morceaux).toString("utf8"),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => amont.listen(0, "127.0.0.1", resolve));
  const ancienUrl = process.env.CARD_API_URL;
  const ancienEmbarque = process.env.CARD_EMBEDDED;
  process.env.CARD_API_URL = `http://127.0.0.1:${amont.address().port}`;
  delete process.env.CARD_EMBEDDED;
  const app = express();
  attachCardPortal(app, () => admin);
  const serveur = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => serveur.once("listening", resolve));
  const modele = JSON.stringify({
    orientation: "paysage",
    recto: [{ id: "ecole", type: "champ", x: 26.1, y: 38.2, w: 56, h: 4, couleur: "#000000", gras: true }],
    verso: [{ id: "mention", type: "texte", x: 3, y: 49, w: 70, h: 3, texte: "Carte personnelle", gras: true, couleur: "#000000" }],
  });
  try {
    const reponse = await fetch(`http://127.0.0.1:${serveur.address().port}/portail/cartes/admin/api/modele`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf": "jeton-atelier" },
      body: modele,
    });
    assert.equal(reponse.status, 200);
    assert.deepEqual(await reponse.json(), { ok: true });
    assert.equal(recu.length, 1);
    assert.equal(recu[0].url, "/admin/api/modele");
    assert.equal(recu[0].csrf, "jeton-atelier");
    assert.equal(recu[0].corps, modele);
  } finally {
    serveur.close();
    amont.close();
    if (ancienUrl === undefined) delete process.env.CARD_API_URL;
    else process.env.CARD_API_URL = ancienUrl;
    if (ancienEmbarque === undefined) delete process.env.CARD_EMBEDDED;
    else process.env.CARD_EMBEDDED = ancienEmbarque;
  }
});

test("la réécriture du portail ne casse pas le JavaScript de la cuisine", () => {
  const source = `
    const d = p[2] + "/" + p[1] + "/" + p[0];
    nom.replace(/"/g, "&quot;");
    fetch("/cantine/gestion/api/tableau");
    fetch("/admin/api/atelier");
  `;
  const out = rewriteText(source);
  new Function(out);
  assert.match(out, /\/portail\/cartes\/cantine\/gestion\/api\/tableau/);
  assert.match(out, /\/portail\/cartes\/admin\/api\/atelier/);
  assert.equal(out.includes('p[2] + "/" + p[1] + "/" + p[0]'), true);
  assert.equal(out.includes('replace(/"/g, "&quot;")'), true);
});
