import { HttpError } from "../httpError.js";
import { cardCall, cardConfigured, cardReady, cardToken } from "./cardRuntime.js";

async function callCantine(matricule, options = {}) {
  if (!cardConfigured() || !cardToken()) return { status: 0, body: {} };
  await cardReady();
  return cardCall(`/api/cantine/${encodeURIComponent(matricule)}`, options);
}

export async function readCantine(matricule) {
  const response = await callCantine(matricule);
  if (!response.status) return { found: false, unavailable: true, solde: 0, prixRepas: 0 };
  if (response.status === 404) return { found: false, unavailable: false, solde: 0, prixRepas: 0 };
  if (response.status >= 400) return { found: false, unavailable: true, solde: 0, prixRepas: 0 };
  return {
    found: true,
    unavailable: false,
    solde: Number(response.body.solde || 0),
    prixRepas: Number(response.body.prixRepas || 0),
  };
}

export async function creditCantine(matricule, amount) {
  const response = await callCantine(matricule, { method: "POST", body: JSON.stringify({ montant: amount }) });
  if (!response.status) throw new HttpError(503, "L'application des cartes ne répond pas.");
  if (response.status === 404) throw new HttpError(404, "Pas de fiche carte pour ce matricule. Ouvrez Cartes → Atelier étudiants.");
  if (response.status >= 400) throw new HttpError(response.status, response.body.message || "Le compte cantine n'a pas pu être crédité.");
  return {
    found: true,
    unavailable: false,
    solde: Number(response.body.solde || 0),
    prixRepas: Number(response.body.prixRepas || 0),
  };
}
