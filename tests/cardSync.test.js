import assert from "node:assert/strict";
import test from "node:test";
import { ficheCarte } from "../src/services/cardSync.js";

test("une fiche de scolarité garde le même matricule pour la carte", () => {
  const fiche = ficheCarte({
    first_name: "Fatoumata",
    last_name: "BAH",
    matricule: "AIM-2026-0003",
    program_name: "AFRICAIIM École de Droit et Sciences Politiques",
    email: "pas-un-email",
  });
  assert.equal(fiche.ok, true);
  assert.deepEqual(fiche.payload, {
    prenom: "Fatoumata",
    nom: "BAH",
    matricule: "AIM-2026-0003",
    ecole: "AFRICAIIM École de Droit et Sciences Politiques",
    email: "",
  });
});

test("un prénom manquant n'est pas envoyé à la carte", () => {
  const fiche = ficheCarte({
    first_name: "(prénom manquant)",
    last_name: "FERNAND",
    matricule: "AIM-2026-0043",
    program_name: "AFRICAIIM Business School",
  });
  assert.equal(fiche.ok, false);
  assert.equal(fiche.matricule, "AIM-2026-0043");
});
