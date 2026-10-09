import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { attachCardPortal } from "../src/services/cardPortal.js";

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
