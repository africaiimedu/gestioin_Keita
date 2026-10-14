// Imprime un PDF du site (reçu, décharge) comme une page web : chaque page du PDF est dessinée en image,
// puis la fenêtre d'impression du système propose toutes les imprimantes installées sur l'ordinateur.
// Safari, Chrome, Edge et Firefox, sous Windows comme sous macOS, impriment une page web ; Safari refuse
// en revanche de lancer seul l'impression d'un PDF ouvert dans un onglet.
import * as pdfjs from "/vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

const ECHELLE = 3;
const DOCUMENT = /^\/api\/[A-Za-z0-9/_.-]+\.pdf(\?[A-Za-z0-9=&_-]*)?$/;

const etat = document.getElementById("etat");
const pages = document.getElementById("pages");
const bouton = document.getElementById("imprimer");
const lien = document.getElementById("pdf");
const source = new URLSearchParams(location.search).get("src") || "";

function millimetres(points) {
  return (points * 25.4 / 72).toFixed(1);
}

async function dessiner(page) {
  const vue = page.getViewport({ scale: ECHELLE });
  const toile = document.createElement("canvas");
  toile.width = Math.round(vue.width);
  toile.height = Math.round(vue.height);
  await page.render({ canvasContext: toile.getContext("2d"), viewport: vue }).promise;
  const image = new Image();
  image.alt = `Page ${page.pageNumber}`;
  image.src = toile.toDataURL("image/png");
  await image.decode().catch(() => {});
  const feuille = document.createElement("div");
  feuille.className = "feuille";
  feuille.append(image);
  pages.append(feuille);
}

async function preparer() {
  if (!DOCUMENT.test(source)) {
    etat.textContent = "Document inconnu : relancez l'impression depuis l'application.";
    return;
  }
  lien.href = source;
  try {
    const pdf = await pdfjs.getDocument({
      url: source,
      withCredentials: true,
      isEvalSupported: false,
      standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
    }).promise;
    const premiere = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const format = document.createElement("style");
    format.textContent = `@page { size: ${millimetres(premiere.width)}mm ${millimetres(premiere.height)}mm; margin: 6mm; }`;
    document.head.append(format);
    for (let numero = 1; numero <= pdf.numPages; numero += 1) await dessiner(await pdf.getPage(numero));
  } catch {
    etat.textContent = "Le document n'a pas pu être préparé (session expirée ?). Rechargez l'application, ou ouvrez le PDF et imprimez-le avec Ctrl+P (Windows) ou Cmd+P (Mac).";
    return;
  }
  etat.textContent = "Choisissez l'imprimante dans la fenêtre d'impression : toutes celles installées sur cet ordinateur y figurent. Si elle ne s'ouvre pas, cliquez sur « Imprimer ».";
  bouton.disabled = false;
  setTimeout(() => window.print(), 300);
}

bouton.addEventListener("click", () => window.print());
preparer();
