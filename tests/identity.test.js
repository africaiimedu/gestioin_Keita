import assert from "node:assert/strict";
import test from "node:test";
import { accountAddress, accountBase, personKey } from "../src/services/identity.js";

test("compte étudiant : prenom.nom, prénom le plus court, sans accents ni particules", () => {
  assert.equal(accountBase("Fatoumata", "BAH"), "fatoumata.bah");
  assert.equal(accountBase("Mamadou Alpha", "DIALLO"), "alpha.diallo");
  assert.equal(accountBase("La Grace", "LENO"), "grace.leno");
  assert.equal(accountBase("Aïssatou Binta", "CAMARA"), "binta.camara");
  assert.equal(accountBase("Jean-Pierre Ali", "SOW"), "ali.sow");
  assert.equal(accountBase("Ibrahima", "DIALLO BAH"), "ibrahima.bah");
  assert.equal(accountBase("Moussa Sékou", "TOURE"), "sekou.toure");
  assert.equal(accountBase("(prénom manquant)", "FERNAND"), "");
  assert.equal(accountAddress("grace.leno"), "grace.leno@univ-africaiim.com");
  assert.equal(accountAddress("grace.leno", 2), "grace.leno2@univ-africaiim.com");
});

test("même personne : casse, accents et ordre des mots ne comptent pas", () => {
  assert.equal(personKey("LENO", "La Grace"), personKey("Leno", "grâce la"));
  assert.equal(personKey("DIALLO", "Mamadou Alpha"), personKey("diallo", "Alpha Mamadou"));
  assert.notEqual(personKey("DIALLO", "Mamadou Alpha"), personKey("DIALLO", "Mamadou"));
});
