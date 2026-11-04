import { HttpError } from "../httpError.js";
import { cardCall, cardConfigured, cardReady, cardToken } from "./cardRuntime.js";

async function callCantine(matricule, options = {}, suffix = "") {
  if (!cardConfigured() || !cardToken()) return { status: 0, body: {} };
  await cardReady();
  return cardCall(`/api/cantine/${encodeURIComponent(matricule)}${suffix}`, options);
}

function emptyCantine(unavailable) {
  return {
    found: false,
    unavailable,
    solde: 0,
    prixRepas: 0,
    abonne: false,
    abonnementMois: 0,
    abonnementFin: "",
    recuNumero: "",
  };
}

function cantineBody(response) {
  return {
    found: true,
    unavailable: false,
    solde: Number(response.body.solde || 0),
    prixRepas: Number(response.body.prixRepas || 0),
    abonne: Boolean(response.body.abonne),
    abonnementMois: Number(response.body.abonnementMois || 0),
    abonnementFin: String(response.body.abonnementFin || ""),
    recuNumero: response.body.recuNumero || "",
  };
}

export async function readCantine(matricule) {
  const response = await callCantine(matricule);
  if (!response.status) return emptyCantine(true);
  if (response.status === 404) return emptyCantine(false);
  if (response.status >= 400) return emptyCantine(true);
  return cantineBody(response);
}

export async function creditCantine(matricule, amount) {
  const response = await callCantine(matricule, { method: "POST", body: JSON.stringify({ montant: amount }) });
  if (!response.status) throw new HttpError(503, "L'application des cartes ne répond pas.");
  if (response.status === 404) throw new HttpError(404, "Pas de fiche carte pour ce matricule. Ouvrez Cartes → Atelier étudiants.");
  if (response.status >= 400) throw new HttpError(response.status, response.body.message || "Le compte cantine n'a pas pu être crédité.");
  return cantineBody(response);
}

export async function subscribeCantine(matricule, mois) {
  const response = await callCantine(matricule, { method: "POST", body: JSON.stringify({ mois }) }, "/abonnement");
  if (!response.status) throw new HttpError(503, "L'application des cartes ne répond pas.");
  if (response.status === 404) throw new HttpError(404, "Pas de fiche carte pour ce matricule. Ouvrez Cartes → Atelier étudiants.");
  if (response.status >= 400) throw new HttpError(response.status, response.body.message || "L'abonnement cantine n'a pas pu être enregistré.");
  return cantineBody(response);
}
