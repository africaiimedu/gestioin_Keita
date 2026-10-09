const PX = 96 / 25.4;
const data = JSON.parse(document.getElementById("donnees").textContent);
let zoom = 1;

function formatCarte() {
  return data.modele && data.modele.orientation === "portrait"
    ? { w: 54, h: 85.6 }
    : { w: 85.6, h: 54 };
}

function pasMm() {
  return PX * zoom;
}

function construire() {
  const doc = document.getElementById("document");
  const { w, h } = formatCarte();
  const marge = 10;
  const ecart = 8;
  const legende = 6;
  const pas = pasMm();
  doc.replaceChildren();
  const largeur = marge + w + ecart + w + marge;
  let y = marge;
  data.cartes.forEach((etu) => {
    const etiquette = document.createElement("div");
    etiquette.className = "etiquette";
    etiquette.textContent = `${etu.nom} ${etu.prenom} · ${etu.matricule}`;
    etiquette.style.left = `${marge * pas}px`;
    etiquette.style.top = `${y * pas}px`;
    doc.appendChild(etiquette);
    y += legende;
    ["recto", "verso"].forEach((face, index) => {
      const carte = document.createElement("div");
      carte.className = "carte";
      carte.style.left = `${(marge + index * (w + ecart)) * pas}px`;
      carte.style.top = `${y * pas}px`;
      carte.style.width = `${w * pas}px`;
      carte.style.height = `${h * pas}px`;
      rendreFace(carte, data.modele[face] || [], {
        px: pas,
        face,
        etu,
        urls: etu.urls,
      });
      doc.appendChild(carte);
    });
    y += h + ecart;
  });
  if (!data.cartes.length) y = marge + 20;
  doc.style.width = `${largeur * pas}px`;
  doc.style.height = `${(y + marge) * pas}px`;
}

function echelons(pxParMm) {
  let grand = 10;
  if (grand * pxParMm < 22) grand = 20;
  if (grand * pxParMm < 22) grand = 50;
  if (grand * pxParMm < 22) grand = 100;
  const moyen = grand === 10 ? 5 : grand / 2;
  const petit = pxParMm >= 4 ? 1 : Math.max(1, grand / 10);
  return { grand, moyen, petit };
}

function dessinerRegles() {
  const vue = document.getElementById("vue");
  const doc = document.getElementById("document");
  const axeX = document.getElementById("regle-x");
  const axeY = document.getElementById("regle-y");
  const pxParMm = pasMm();
  const origineX = doc.getBoundingClientRect().left - axeX.getBoundingClientRect().left;
  const origineY = doc.getBoundingClientRect().top - axeY.getBoundingClientRect().top;
  const { grand, moyen, petit } = echelons(pxParMm);
  axeX.replaceChildren();
  axeY.replaceChildren();
  const debutX = Math.floor((-origineX) / pxParMm / petit) * petit - petit;
  const finX = debutX + Math.ceil(axeX.clientWidth / pxParMm) + petit * 2;
  const debutY = Math.floor((-origineY) / pxParMm / petit) * petit - petit;
  const finY = debutY + Math.ceil(axeY.clientHeight / pxParMm) + petit * 2;
  for (let mm = debutX; mm <= finX; mm += petit) {
    const valeur = Math.round(mm);
    const marque = document.createElement("span");
    marque.style.left = `${origineX + valeur * pxParMm}px`;
    if (valeur % grand === 0) {
      marque.className = "grand";
      marque.textContent = String(valeur);
    } else if (valeur % moyen === 0) {
      marque.className = "moyen";
    }
    axeX.appendChild(marque);
  }
  for (let mm = debutY; mm <= finY; mm += petit) {
    const valeur = Math.round(mm);
    const marque = document.createElement("span");
    marque.style.top = `${origineY + valeur * pxParMm}px`;
    if (valeur % grand === 0) {
      marque.className = "grand";
      marque.textContent = String(valeur);
    } else if (valeur % moyen === 0) {
      marque.className = "moyen";
    }
    axeY.appendChild(marque);
  }
  const suiviX = document.createElement("i");
  suiviX.className = "suivi";
  const suiviY = document.createElement("i");
  suiviY.className = "suivi";
  axeX.appendChild(suiviX);
  axeY.appendChild(suiviY);
}

function suivre(ev) {
  const doc = document.getElementById("document");
  const axeX = document.getElementById("regle-x");
  const axeY = document.getElementById("regle-y");
  const origineX = doc.getBoundingClientRect().left - axeX.getBoundingClientRect().left;
  const origineY = doc.getBoundingClientRect().top - axeY.getBoundingClientRect().top;
  const mmx = (ev.clientX - doc.getBoundingClientRect().left) / pasMm();
  const mmy = (ev.clientY - doc.getBoundingClientRect().top) / pasMm();
  const suiviX = axeX.querySelector(".suivi");
  const suiviY = axeY.querySelector(".suivi");
  if (suiviX) suiviX.style.left = `${origineX + mmx * pasMm()}px`;
  if (suiviY) suiviY.style.top = `${origineY + mmy * pasMm()}px`;
}

function afficherZoom() {
  document.getElementById("zoom-valeur").textContent = `${Math.round(zoom * 100)} %`;
}

function reglerZoom(valeur) {
  const vue = document.getElementById("vue");
  const avant = pasMm();
  const centreX = (vue.scrollLeft + vue.clientWidth / 2) / avant;
  const centreY = (vue.scrollTop + vue.clientHeight / 2) / avant;
  zoom = Math.round(Math.min(2, Math.max(0.25, valeur)) * 20) / 20;
  construire();
  afficherZoom();
  vue.scrollLeft = centreX * pasMm() - vue.clientWidth / 2;
  vue.scrollTop = centreY * pasMm() - vue.clientHeight / 2;
  dessinerRegles();
}

document.getElementById("vue").addEventListener("scroll", dessinerRegles);
document.getElementById("vue").addEventListener("pointermove", suivre);
document.getElementById("zoom-moins").onclick = () => reglerZoom(zoom - 0.1);
document.getElementById("zoom-plus").onclick = () => reglerZoom(zoom + 0.1);
window.addEventListener("resize", dessinerRegles);

document.getElementById("titre").textContent = data.filiere;
document.getElementById("compte").textContent = `${data.annee} · ${data.cartes.length} carte(s) · règle en millimètres, non imprimée`;
const pdf = document.getElementById("pdf");
const imprimer = document.getElementById("imprimer");
if (data.cartes.length) {
  pdf.href = `/admin/lot.pdf?filiere=${encodeURIComponent(data.filiere)}&annee=${encodeURIComponent(data.annee)}`;
  imprimer.dataset.imprimerPdf = `${pdf.href}&inline=1`;
} else {
  pdf.hidden = true;
  imprimer.hidden = true;
  const message = document.getElementById("message");
  message.hidden = false;
  message.textContent = data.exclus.length
    ? "Aucune carte imprimable pour cette école. Vérifiez la photo et le statut."
    : "Aucun étudiant pour cette école et cette année.";
}

construire();
afficherZoom();
dessinerRegles();
