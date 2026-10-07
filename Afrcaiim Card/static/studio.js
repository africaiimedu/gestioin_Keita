const PX = 7.4;

function pxActuel() {
  return PX * zoom;
}
const csrf = document.querySelector('meta[name="csrf"]').content;
let etudiants = [];
let modele = null;
let index = 0;
let face = "recto";
let affichage = "recto";
let selection = null;
let outil = "selection";
let zoom = 1;
let recherche = "";
let glisser = null;
let enEdition = false;
const ecoles = JSON.parse(document.getElementById("ecoles-officielles").textContent);
let clicPrecedent = { id: "", moment: 0 };

const CHAMPS = [
  ["nom", "Nom"],
  ["prenom", "Prénom"],
  ["matricule", "Matricule"],
  ["filiere", "École"],
  ["ecole", "École"],
  ["email", "E-mail professionnel"],
  ["annee_academique", "Année"],
  ["date_validite", "Validité"],
  ["url", "Adresse de vérification"],
  ["edition", "Édition"],
  ["controle", "Code de contrôle"],
  ["qualite", "Étudiant ou étudiante"],
];

const NOMS = {
  texte: "Texte fixe",
  champ: "Champ de la base",
  photo: "Photo",
  qr: "QR code",
  codebarres: "Code-barres",
  rect: "Rectangle",
  cercle: "Cercle",
  ligne: "Ligne",
  piste: "Piste magnétique",
  image: "Logo Université AFRICAIIM",
  guilloche: "Trame de sécurité",
  rosette: "Rosace de sécurité",
  micro: "Microtexte",
};

const GABARITS = {
  texte: { type: "texte", texte: "Texte", w: 32, h: 6, taille: 8, couleur: "#1A1A1A" },
  champ: { type: "champ", champ: "nom", w: 40, h: 6, taille: 10, gras: true, couleur: "#FFFFFF", majuscules: true },
  photo: { type: "photo", w: 22, h: 26, rayon: 1.6, couleur: "#C5F0DC", couleur_texte: "#0C4630", initiales: true },
  qr: { type: "qr", w: 18, h: 18, contenu: "securise", couleur: "#111111", fond: "#FFFFFF", cadre: true },
  codebarres: { type: "codebarres", champ: "matricule", w: 46, h: 8, lisible: false, couleur: "#111111", fond: "#FFFFFF" },
  rect: { type: "rect", w: 24, h: 8, couleur: "#146042", rayon: 0.8 },
  cercle: { type: "cercle", w: 10, h: 10, couleur: "#F0A020" },
  ligne: { type: "ligne", w: 36, h: 1.2, couleur: "#1A1A1A", epaisseur: 0.35 },
  piste: { type: "piste", x: 0, w: 85.6, h: 6.2, couleur: "#1A1A1A" },
  marque: { type: "image", asset: "marque", w: 36.4, h: 15.8 },
  guilloche: { type: "guilloche", w: 40, h: 18, couleur: "#FEAB00" },
  rosette: { type: "rosette", w: 28, h: 28, couleur: "#FFFFFF" },
  micro: { type: "micro", champ: "matricule", w: 40, h: 2.2, taille: 2.4, couleur: "#FEAB00" },
};

function message(texte) {
  document.getElementById("message").textContent = texte || "";
}

function entetes() {
  return { "Content-Type": "application/json", "X-CSRF": csrf };
}

function echapper(valeur) {
  return String(valeur ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

function vue() {
  const q = recherche.trim().toLowerCase();
  if (!q) return etudiants;
  return etudiants.filter((e) =>
    `${e.nom} ${e.prenom} ${e.matricule} ${e.filiere}`.toLowerCase().includes(q)
  );
}

function courant() {
  const lignes = vue();
  if (!lignes.length) return null;
  if (index >= lignes.length) index = 0;
  return lignes[index];
}

function contexte() {
  const etu = courant();
  return {
    px: pxActuel(),
    face,
    etu,
    urls: etu
      ? {
          photo: `/admin/etudiants/${etu.id}/photo`,
          qr: `/admin/etudiants/${etu.id}/qr.png`,
          barre: `/admin/etudiants/${etu.id}/code128.png`,
        }
      : {},
    selection,
    onPointer: prendre,
  };
}

function estTexte(obj) {
  if (!obj || obj.champ === "qualite") return false;
  return obj.type === "texte" || obj.type === "champ" || obj.type === "micro";
}

function formatCarte() {
  return modele && modele.orientation === "portrait" ? { w: 54, h: 85.6 } : { w: 85.6, h: 54 };
}

function carteActive() {
  return document.getElementById(face === "verso" ? "carte-verso" : "carte-recto");
}

function libelleFace() {
  if (affichage === "double") {
    return face === "verso" ? "Double face — édition du verso" : "Double face — édition du recto";
  }
  return face === "verso" ? "Verso" : "Recto";
}

function choisirFace(nom) {
  face = nom;
  const info = document.getElementById("info-face");
  if (info) info.textContent = libelleFace();
}

function choisirAffichage(nom) {
  affichage = nom;
  if (nom === "recto" || nom === "verso") face = nom;
  document.getElementById("vue-recto").classList.toggle("actif", nom === "recto");
  document.getElementById("vue-verso").classList.toggle("actif", nom === "verso");
  document.getElementById("vue-double").classList.toggle("actif", nom === "double");
  document.getElementById("carte-recto").classList.toggle("masquee", nom === "verso");
  document.getElementById("carte-verso").classList.toggle("masquee", nom === "recto");
  choisirFace(face);
}

function dessinerCarte() {
  if (enEdition) return;
  poserRegles();
  ["recto", "verso"].forEach((cote) => {
    const carte = document.getElementById(`carte-${cote}`);
    if (!carte || !modele) return;
    rendreFace(carte, modele[cote] || [], {
      ...contexte(),
      face: cote,
      selection: cote === face ? selection : null,
      onPointer: (ev, obj) => {
        choisirFace(cote);
        prendre(ev, obj);
      },
    });
    if (cote !== face) return;
    const obj = objetChoisi();
    if (obj && !obj.verrou) {
      const poignee = document.createElement("div");
      poignee.className = "poignee";
      poignee.style.left = `${(obj.x + obj.w) * pxActuel() - 6}px`;
      poignee.style.top = `${(obj.y + obj.h) * pxActuel() - 6}px`;
      poignee.addEventListener("pointerdown", commencerTaille);
      carte.appendChild(poignee);
    }
  });
  appliquerZoom();
  calques();
}

function tailleSceneNaturelle() {
  const { w, h } = formatCarte();
  const double = affichage === "double";
  return {
    w: (double ? 2 : 1) * w * PX + (double ? 28 : 0),
    h: h * PX,
  };
}

function appliquerZoom() {
  const scene = document.getElementById("scene");
  const toile = document.getElementById("toile");
  if (!scene || !toile) return;
  scene.style.transform = "none";
  const largeur = scene.offsetWidth;
  const hauteur = scene.offsetHeight;
  const resteX = Math.max(0, toile.clientWidth - largeur);
  const resteY = Math.max(0, toile.clientHeight - hauteur);
  scene.style.marginLeft = `${resteX / 2}px`;
  scene.style.marginTop = `${resteY / 2}px`;
  scene.style.marginRight = `${resteX / 2}px`;
  scene.style.marginBottom = `${resteY / 2}px`;
  dessinerRegles();
}

function echelons(pxParMm) {
  let grand = 10;
  if (grand * pxParMm < 22) grand = 20;
  if (grand * pxParMm < 22) grand = 50;
  const moyen = grand === 10 ? 5 : grand / 2;
  const petit = pxParMm >= 4 ? 1 : Math.max(1, grand / 10);
  return { grand, moyen, petit };
}

function dessinerRegles() {
  const carte = document.querySelector(".carte:not(.masquee)");
  const axeX = document.getElementById("regle-x");
  const axeY = document.getElementById("regle-y");
  if (!carte || !axeX || !axeY) return;
  const pxParMm = PX * zoom;
  const { grand, moyen, petit } = echelons(pxParMm);
  const origineX = carte.getBoundingClientRect().left - axeX.getBoundingClientRect().left;
  const origineY = carte.getBoundingClientRect().top - axeY.getBoundingClientRect().top;
  const tracer = (axe, horizontal, origine) => {
    const longueur = horizontal ? axe.clientWidth : axe.clientHeight;
    const debut = Math.floor(-origine / pxParMm / petit) * petit;
    const fin = debut + Math.ceil(longueur / pxParMm / petit) * petit + petit;
    axe.replaceChildren();
    for (let mm = debut; mm <= fin; mm += petit) {
      const valeur = Math.round(mm);
      const marque = document.createElement("span");
      marque.className = "grad";
      const pos = Math.round(origine + valeur * pxParMm);
      marque.style[horizontal ? "left" : "top"] = `${pos}px`;
      if (valeur % grand === 0) {
        marque.classList.add("grand");
        const nombre = document.createElement("b");
        nombre.textContent = String(valeur);
        marque.appendChild(nombre);
      } else if (valeur % moyen === 0) {
        marque.classList.add("moyen");
      }
      axe.appendChild(marque);
    }
    const suivi = document.createElement("i");
    suivi.className = "suivi";
    axe.appendChild(suivi);
  };
  tracer(axeX, true, origineX);
  tracer(axeY, false, origineY);
}

function suivreRegles(ev) {
  const carte = document.querySelector(".carte:not(.masquee)");
  const axeX = document.getElementById("regle-x");
  const axeY = document.getElementById("regle-y");
  if (!carte || !axeX || !axeY) return;
  const pxParMm = PX * zoom;
  const origineX = carte.getBoundingClientRect().left - axeX.getBoundingClientRect().left;
  const origineY = carte.getBoundingClientRect().top - axeY.getBoundingClientRect().top;
  const mmx = (ev.clientX - carte.getBoundingClientRect().left) / pxParMm;
  const mmy = (ev.clientY - carte.getBoundingClientRect().top) / pxParMm;
  const suiviX = axeX.querySelector(".suivi");
  const suiviY = axeY.querySelector(".suivi");
  if (suiviX) suiviX.style.left = `${origineX + mmx * pxParMm}px`;
  if (suiviY) suiviY.style.top = `${origineY + mmy * pxParMm}px`;
}

function prendre(ev, obj) {
  if (enEdition) return;
  ev.stopPropagation();
  ev.preventDefault();
  const maintenant = Date.now();
  const double = clicPrecedent.id === obj.id && maintenant - clicPrecedent.moment < 500;
  clicPrecedent = { id: obj.id, moment: maintenant };
  if ((outil === "texte" || double) && estTexte(obj)) {
    selection = obj.id;
    editerTexte(obj);
    return;
  }
  if (outil !== "selection") {
    poser(ev);
    return;
  }
  selection = obj.id;
  if (obj.verrou) {
    proprietes();
    dessinerCarte();
    return;
  }
  glisser = { mode: "deplacer", id: obj.id, x: obj.x, y: obj.y, px: ev.clientX, py: ev.clientY };
  window.addEventListener("pointermove", bouger);
  window.addEventListener("pointerup", lacher);
  proprietes();
  dessinerCarte();
}

function commencerTaille(ev) {
  ev.stopPropagation();
  ev.preventDefault();
  const obj = objetChoisi();
  if (!obj || obj.verrou) return;
  glisser = { mode: "taille", id: obj.id, w: obj.w, h: obj.h, px: ev.clientX, py: ev.clientY };
  window.addEventListener("pointermove", bouger);
  window.addEventListener("pointerup", lacher);
}

function bouger(ev) {
  if (!glisser) return;
  const obj = (modele[face] || []).find((o) => o.id === glisser.id);
  if (!obj) return;
  if (glisser.mode === "taille") {
    obj.w = Math.max(1.2, Math.round((glisser.w + (ev.clientX - glisser.px) / PX / zoom) * 10) / 10);
    obj.h = Math.max(0.4, Math.round((glisser.h + (ev.clientY - glisser.py) / PX / zoom) * 10) / 10);
  } else {
    obj.x = Math.round((glisser.x + (ev.clientX - glisser.px) / PX / zoom) * 10) / 10;
    obj.y = Math.round((glisser.y + (ev.clientY - glisser.py) / PX / zoom) * 10) / 10;
  }
  dessinerCarte();
}

function lacher() {
  window.removeEventListener("pointermove", bouger);
  window.removeEventListener("pointerup", lacher);
  glisser = null;
  sauverModele();
  proprietes();
}

function objetChoisi() {
  return (modele[face] || []).find((o) => o.id === selection) || null;
}

async function appliquerEdition(obj, valeur) {
  const fiche = ["nom", "prenom", "filiere", "email"];
  if (obj.type === "champ" && fiche.includes(obj.champ) && !obj.personnalise) {
    const etu = courant();
    if (etu) await sauverFiche(etu, obj.champ, valeur);
    return;
  }
  if (obj.type === "texte") obj.texte = valeur;
  else obj.personnalise = valeur;
  await sauverModele();
}

function editerTexte(obj) {
  enEdition = true;
  marquerOutil("selection");
  enEdition = false;
  dessinerCarte();
  proprietes();
  enEdition = true;
  const el = [...document.querySelectorAll(`#carte-${face} .objet`)].find((n) => n.dataset.id === obj.id);
  if (!el) {
    enEdition = false;
    return;
  }
  const brut = obj.type === "texte" ? (obj.texte || "") : (obj.personnalise || texteCarte(obj, courant()));
  el.textContent = brut;
  el.contentEditable = "true";
  el.spellcheck = false;
  el.classList.add("en-edition");
  el.style.cursor = "text";
  el.style.userSelect = "text";
  el.style.whiteSpace = "pre-wrap";
  const selectionner = () => {
    el.focus();
    const dom = window.getSelection();
    const plage = document.createRange();
    plage.selectNodeContents(el);
    dom.removeAllRanges();
    dom.addRange(plage);
  };
  selectionner();
  requestAnimationFrame(selectionner);
  const terminer = async (annuler) => {
    if (!enEdition) return;
    enEdition = false;
    if (!annuler) await appliquerEdition(obj, el.innerText.replace(/\u00a0/g, " ").replace(/\n+$/g, ""));
    dessinerCarte();
    proprietes();
  };
  el.addEventListener("blur", () => terminer(false));
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      terminer(true);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    }
  });
}

function panneauCaractere(obj) {
  const actif = (cle) => (obj[cle] ? "actif" : "");
  const align = obj.align || "left";
  return `
    <p class="nom-objet">Caractère</p>
    <div class="caracteres">
      <select data-cle="police">
        <option value="sans" ${obj.police !== "serif" ? "selected" : ""}>DejaVu Sans</option>
        <option value="serif" ${obj.police === "serif" ? "selected" : ""}>DejaVu Serif</option>
      </select>
      <input data-cle="taille" type="number" min="1.6" max="32" step="0.5" value="${obj.taille || 9}" title="Taille en points">
      <button type="button" class="style-btn gras ${actif("gras")}" data-style="gras" title="Gras">B</button>
      <button type="button" class="style-btn italique ${actif("italique")}" data-style="italique" title="Italique">I</button>
      <button type="button" class="style-btn souligne ${actif("souligne")}" data-style="souligne" title="Souligné">U</button>
      <button type="button" class="align-btn ${align === "left" ? "actif" : ""}" data-align="left" title="Aligner à gauche">G</button>
      <button type="button" class="align-btn ${align === "center" ? "actif" : ""}" data-align="center" title="Centrer">C</button>
      <button type="button" class="align-btn ${align === "right" ? "actif" : ""}" data-align="right" title="Aligner à droite">D</button>
      <button type="button" class="align-btn ${align === "justify" ? "actif" : ""}" data-align="justify" title="Justifier">J</button>
      <input data-cle="couleur" type="color" value="${obj.couleur || "#1A1A1A"}" title="Couleur">
    </div>
    <label>Interligne<input data-cle="interligne" type="number" min="0.8" max="3" step="0.05" value="${obj.interligne || 1.15}"></label>
    <label>Approche<input data-cle="approche" type="number" min="-1" max="8" step="0.1" value="${obj.approche || 0}"></label>
    <label class="coche"><input data-cle="retour" type="checkbox" ${obj.retour ? "checked" : ""}> Retour à la ligne</label>
    ${obj.type === "champ" ? `<label class="coche"><input data-cle="majuscules" type="checkbox" ${obj.majuscules ? "checked" : ""}> Capitales</label>` : ""}
    ${obj.personnalise ? '<button type="button" data-act="relier">Reprendre le texte de la base</button>' : ""}
  `;
}

function champSelect(obj) {
  return `<label>Champ de la base<select data-cle="champ">${CHAMPS.map(([v, n]) => `<option value="${v}" ${obj.champ === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
}

function proprietes() {
  const zone = document.getElementById("props");
  const obj = objetChoisi();
  if (!obj) {
    zone.innerHTML = "<p class=\"vide\">Cliquez un objet sur la carte, ou posez un outil.</p>";
    return;
  }
  const forme = obj.type === "rect" || obj.type === "cercle" || obj.type === "piste" || obj.type === "photo";
  zone.innerHTML = `
    <p class="nom-objet">${NOMS[obj.type] || obj.type}</p>
    ${estTexte(obj) ? '<p class="vide">Double-cliquez le texte sur la carte pour l’écrire.</p>' : ""}
    <label>X mm<input data-cle="x" type="number" step="0.1" value="${obj.x}"></label>
    <label>Y mm<input data-cle="y" type="number" step="0.1" value="${obj.y}"></label>
    <label>Largeur mm<input data-cle="w" type="number" step="0.1" value="${obj.w}"></label>
    <label>Hauteur mm<input data-cle="h" type="number" step="0.1" value="${obj.h}"></label>
    ${obj.type === "champ" || obj.type === "codebarres" || obj.type === "micro" ? champSelect(obj) : ""}
    ${estTexte(obj) ? panneauCaractere(obj) : ""}
    ${forme ? `<label>Couleur de fond<input data-cle="couleur" type="color" value="${obj.couleur || "#0C4630"}"></label>` : ""}
    ${obj.type === "ligne" || obj.type === "guilloche" || obj.type === "rosette" ? `<label>Couleur<input data-cle="couleur" type="color" value="${obj.couleur || "#FEAB00"}"></label>` : ""}
    ${obj.type === "rect" || obj.type === "cercle" || obj.type === "ligne" || obj.type === "signature" ? "" : ""}
    ${obj.type === "rect" || obj.type === "cercle" || obj.type === "photo" ? `
      <label>Contour<input data-cle="contour" type="color" value="${obj.contour || "#C9C4B8"}"></label>
      <label>Épaisseur mm<input data-cle="epaisseur" type="number" step="0.05" min="0.05" max="2" value="${obj.epaisseur || 0.25}"></label>
    ` : ""}
    ${obj.type === "rect" || obj.type === "photo" ? `<label>Coins mm<input data-cle="rayon" type="number" step="0.1" min="0" max="20" value="${obj.rayon || 0}"></label>` : ""}
    ${obj.type === "ligne" ? `<label>Épaisseur mm<input data-cle="epaisseur" type="number" step="0.05" min="0.05" max="2" value="${obj.epaisseur || 0.3}"></label>` : ""}
    ${obj.type === "piste" ? `<p class="vide">Ce rectangle noir montre seulement l'emplacement de la bande magnétique du PVC. HiCo et LoCo se règlent sur l'encodeur de l'Evolis. Une piste se recopie avec un lecteur : elle ne remplace pas le QR sécurisé.</p>` : ""}
    ${obj.type === "photo" ? `
      <label>Couleur des initiales<input data-cle="couleur_texte" type="color" value="${obj.couleur_texte || "#0C4630"}"></label>
      <label class="coche"><input data-cle="initiales" type="checkbox" ${obj.initiales !== false ? "checked" : ""}> Initiales si pas de photo</label>
    ` : ""}
    ${obj.type === "qr" ? `
      <label>Contenu du QR<select data-cle="contenu">
        <option value="securise" ${(obj.contenu || "securise") === "securise" ? "selected" : ""}>Vérification sécurisée</option>
        ${CHAMPS.map(([v, n]) => `<option value="${v}" ${obj.contenu === v ? "selected" : ""}>${n}</option>`).join("")}
      </select></label>
      <p class="vide">${(obj.contenu || "securise") === "securise"
        ? "Ce QR contient un jeton impossible à deviner. C'est lui que la cantine et la sécurité scannent."
        : "Ce contenu peut être recopié. Pour protéger la carte, choisissez « Vérification sécurisée »."}</p>
      <label>Couleur des modules<input data-cle="couleur" type="color" value="${obj.couleur || "#111111"}"></label>
      <label>Fond<input data-cle="fond" type="color" value="${obj.fond || "#FFFFFF"}"></label>
      <label class="coche"><input data-cle="cadre" type="checkbox" ${obj.cadre !== false ? "checked" : ""}> Cadre or</label>
    ` : ""}
    ${obj.type === "codebarres" ? `
      <label>Couleur des barres<input data-cle="couleur" type="color" value="${obj.couleur || "#111111"}"></label>
      <label>Fond<input data-cle="fond" type="color" value="${obj.fond || "#FFFFFF"}"></label>
      <label class="coche"><input data-cle="lisible" type="checkbox" ${obj.lisible ? "checked" : ""}> Afficher le texte sous les barres</label>
    ` : ""}
    <label class="coche"><input data-cle="verrou" type="checkbox" ${obj.verrou ? "checked" : ""}> Verrouiller la position</label>
    <div class="ligne-boutons">
      <button type="button" data-act="gauche">Gauche</button>
      <button type="button" data-act="centre">Centre</button>
      <button type="button" data-act="droite">Droite</button>
      <button type="button" data-act="haut">Haut</button>
      <button type="button" data-act="milieu">Milieu</button>
      <button type="button" data-act="bas">Bas</button>
    </div>
    <div class="ligne-boutons">
      <button type="button" data-act="descendre">Derrière</button>
      <button type="button" data-act="monter">Devant</button>
      <button type="button" data-act="dupliquer">Dupliquer</button>
      ${obj.verrou ? "" : '<button type="button" data-act="supprimer">Retirer</button>'}
    </div>
  `;
  zone.querySelectorAll("[data-cle]").forEach((el) => {
    const appliquer = () => {
      const cle = el.dataset.cle;
      if (el.type === "checkbox") obj[cle] = el.checked;
      else if (el.type === "number") obj[cle] = Number(el.value);
      else obj[cle] = el.value;
      if (cle === "contour" && !obj.contour) delete obj.contour;
      dessinerCarte();
    };
    el.addEventListener("input", appliquer);
    el.addEventListener("change", () => {
      appliquer();
      sauverModele();
      if (el.dataset.cle === "verrou" || el.dataset.cle === "contenu") proprietes();
    });
  });
  zone.querySelectorAll("[data-style]").forEach((bouton) => {
    bouton.addEventListener("click", () => {
      obj[bouton.dataset.style] = !obj[bouton.dataset.style];
      dessinerCarte();
      proprietes();
      sauverModele();
    });
  });
  zone.querySelectorAll("[data-align]").forEach((bouton) => {
    bouton.addEventListener("click", () => {
      obj.align = bouton.dataset.align;
      if (obj.align === "justify") obj.retour = true;
      dessinerCarte();
      proprietes();
      sauverModele();
    });
  });
  zone.querySelectorAll("[data-act]").forEach((bouton) => {
    bouton.addEventListener("click", () => action(bouton.dataset.act));
  });
}

function action(nom) {
  const liste = modele[face];
  const i = liste.findIndex((o) => o.id === selection);
  const obj = liste[i];
  if (!obj) return;
  if (nom === "relier") {
    delete obj.personnalise;
  } else if (nom === "supprimer") {
    modele[face] = liste.filter((o) => o.id !== obj.id);
    selection = null;
  } else if (nom === "dupliquer") {
    const copie = JSON.parse(JSON.stringify(obj));
    copie.id = `o${Date.now()}`;
    copie.x = Math.round((obj.x + 1.5) * 10) / 10;
    copie.y = Math.round((obj.y + 1.5) * 10) / 10;
    delete copie.verrou;
    liste.push(copie);
    selection = copie.id;
  } else if (nom === "monter" && i < liste.length - 1) {
    liste.splice(i, 1);
    liste.splice(i + 1, 0, obj);
  } else if (nom === "descendre" && i > 0) {
    liste.splice(i, 1);
    liste.splice(i - 1, 0, obj);
  } else if (nom === "gauche") obj.x = 3;
  else if (nom === "droite") obj.x = Math.round((formatCarte().w - obj.w - 3) * 10) / 10;
  else if (nom === "centre") obj.x = Math.round(((formatCarte().w - obj.w) / 2) * 10) / 10;
  else if (nom === "haut") obj.y = 3;
  else if (nom === "bas") obj.y = Math.round((formatCarte().h - obj.h - 3) * 10) / 10;
  else if (nom === "milieu") obj.y = Math.round(((formatCarte().h - obj.h) / 2) * 10) / 10;
  dessinerCarte();
  proprietes();
  sauverModele();
}

function calques() {
  const liste = document.getElementById("calques");
  if (!liste) return;
  liste.innerHTML = "";
  [...(modele[face] || [])].reverse().forEach((obj) => {
    const li = document.createElement("li");
    if (obj.id === selection) li.className = "actif";
    const detail = obj.type === "texte" ? obj.texte : obj.type === "champ" || obj.type === "codebarres" ? obj.champ : "";
    li.textContent = `${NOMS[obj.type] || obj.type}${detail ? " · " + detail : ""}`;
    li.addEventListener("click", () => {
      selection = obj.id;
      outil = "selection";
      choisirOutil("selection");
      dessinerCarte();
      proprietes();
    });
    liste.appendChild(li);
  });
}

async function sauverModele() {
  const reponse = await fetch("/admin/api/modele", { method: "POST", headers: entetes(), body: JSON.stringify(modele) });
  if (!reponse.ok) {
    const corps = await reponse.json();
    message(corps.message || "Le modèle n'a pas été enregistré.");
  } else {
    message("");
  }
}

function dessinerGrille() {
  const corps = document.getElementById("lignes");
  corps.innerHTML = "";
  vue().forEach((etu, i) => {
    const tr = document.createElement("tr");
    if (i === index) tr.className = "actif";
    tr.innerHTML = `
      <td class="mini">${etu.photo ? `<img src="/admin/etudiants/${etu.id}/photo" alt="">` : "—"}</td>
      <td data-champ="nom"></td>
      <td data-champ="prenom"></td>
      <td>${etu.matricule}</td>
      <td data-champ="filiere"></td>
      <td data-champ="annee_academique"></td>
      <td data-champ="date_validite"></td>
      <td>${francs(etu.solde_cantine)}</td>
      <td>${etu.statut === "active" ? "Valide" : etu.statut || "—"}</td>
    `;
    tr.querySelectorAll("[data-champ]").forEach((td) => {
      const champ = td.dataset.champ;
      td.textContent = champ === "date_validite" ? dateCarte(etu[champ]) : etu[champ];
      if (champ === "annee_academique" || champ === "date_validite") return;
      td.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        td.textContent = "";
        if (champ === "filiere") {
          const select = document.createElement("select");
          ecoles.forEach((nom) => {
            const option = document.createElement("option");
            option.value = nom;
            option.textContent = nom;
            option.selected = nom === etu.filiere;
            select.appendChild(option);
          });
          td.appendChild(select);
          select.focus();
          select.addEventListener("change", () => sauverFiche(etu, champ, select.value));
          select.addEventListener("blur", () => sauverFiche(etu, champ, select.value));
          return;
        }
        const input = document.createElement("input");
        input.value = etu[champ];
        td.appendChild(input);
        input.focus();
        input.addEventListener("blur", () => sauverFiche(etu, champ, input.value));
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      });
    });
    tr.addEventListener("click", () => {
      index = i;
      dessinerGrille();
      dessinerCarte();
    });
    corps.appendChild(tr);
  });
  const total = vue().length;
  document.getElementById("compteur").textContent = total ? `${index + 1} / ${total}` : "0 / 0";
  const etu = courant();
  document.getElementById("info-face").textContent = libelleFace();
  document.getElementById("info-etu").textContent = etu ? `${etu.prenom} ${etu.nom}` : "—";
  document.getElementById("info-matricule").textContent = etu ? etu.matricule : "—";
  document.getElementById("info-validite").textContent = etu ? dateCarte(etu.date_validite) : "—";
}

function poserRegles() {
  const { w, h } = formatCarte();
  const px = pxActuel();
  document.querySelectorAll(".carte").forEach((carte) => {
    carte.style.width = `${w * px}px`;
    carte.style.height = `${h * px}px`;
  });
  const echelle = document.getElementById("echelle");
  if (echelle) echelle.style.gap = `${28 * zoom}px`;
  const info = document.getElementById("info-format");
  const portrait = w < h;
  document.getElementById("orient-paysage").classList.toggle("actif", !portrait);
  document.getElementById("orient-portrait").classList.toggle("actif", portrait);
  if (info) info.textContent = portrait ? "CR80 · 54 × 85,6 mm" : "CR80 · 85,6 × 54 mm";
}

function arrondiCarte(n) {
  return Math.round(n * 100) / 100;
}

function adapterFace(objets, avant, apres) {
  const fx = apres.w / avant.w;
  const fy = apres.h / avant.h;
  objets.forEach((obj) => {
    const pleineLargeur = obj.w >= avant.w - 0.4 || obj.type === "piste";
    const pleineHauteur = obj.h >= avant.h - 0.4;
    obj.x = arrondiCarte(obj.x * fx);
    obj.y = arrondiCarte(obj.y * fy);
    obj.w = pleineLargeur ? apres.w : Math.max(0.6, arrondiCarte(obj.w * fx));
    obj.h = pleineHauteur ? apres.h : Math.max(0.3, arrondiCarte(obj.h * fy));
    if (obj.type === "piste") obj.x = 0;
    if (typeof obj.taille === "number") {
      obj.taille = arrondiCarte(Math.min(32, Math.max(1.2, obj.taille * fx)));
    }
    if (obj.x < 0) obj.x = 0;
    if (obj.y < 0) obj.y = 0;
    if (obj.x + obj.w > apres.w) obj.x = Math.max(0, arrondiCarte(apres.w - obj.w));
    if (obj.y + obj.h > apres.h) obj.y = Math.max(0, arrondiCarte(apres.h - obj.h));
  });
}

async function changerOrientation(nom) {
  if (!modele || (modele.orientation || "paysage") === nom) return;
  const avant = formatCarte();
  modele.orientation = nom;
  const apres = formatCarte();
  ["recto", "verso"].forEach((cote) => adapterFace(modele[cote] || [], avant, apres));
  poserRegles();
  dessinerCarte();
  ajusterZoom();
  await sauverModele();
  if (!document.getElementById("message").textContent) {
    message(nom === "portrait"
      ? "Portrait : le dessin est adapté au format 54 × 85,6 mm."
      : "Paysage : le dessin est adapté au format 85,6 × 54 mm.");
  }
}

async function sauverFiche(etu, champ, valeur) {
  const corps = {
    prenom: etu.prenom,
    nom: etu.nom,
    filiere: etu.filiere,
    annee_academique: etu.annee_academique,
    date_validite: etu.date_validite,
    email: etu.email || "",
  };
  corps[champ] = champ === "date_validite" && valeur.includes("/")
    ? valeur.split("/").reverse().join("-")
    : valeur;
  const reponse = await fetch(`/admin/api/etudiants/${etu.id}`, {
    method: "POST",
    headers: entetes(),
    body: JSON.stringify(corps),
  });
  const data = await reponse.json();
  if (!reponse.ok) {
    message(data.message || "Modification refusée.");
    dessinerGrille();
    return;
  }
  Object.assign(etu, data);
  message("");
  dessinerGrille();
  dessinerCarte();
}

function aller(delta) {
  const total = vue().length;
  if (!total) return;
  index = (index + delta + total) % total;
  dessinerGrille();
  dessinerCarte();
}

function marquerOutil(nom) {
  outil = nom;
  document.querySelectorAll("[data-outil]").forEach((b) => {
    b.classList.toggle("actif", b.dataset.outil === nom);
  });
}

function ajouterComposant(nom, ev) {
  const gabarit = GABARITS[nom];
  if (!gabarit || !modele) return;
  const id = `o${Date.now()}`;
  let x;
  let y;
  if (ev) {
    const rect = carteActive().getBoundingClientRect();
    x = (ev.clientX - rect.left) / zoom / PX - gabarit.w / 2;
    y = (ev.clientY - rect.top) / zoom / PX - gabarit.h / 2;
  } else {
    const deja = (modele[face] || []).filter((o) => o.type === gabarit.type).length;
    x = (formatCarte().w - gabarit.w) / 2 + deja * 2.5;
    y = (formatCarte().h - gabarit.h) / 2 + deja * 2.5;
  }
  x = Math.max(0, Math.min(formatCarte().w - gabarit.w, Math.round(x * 10) / 10));
  y = Math.max(0, Math.min(formatCarte().h - gabarit.h, Math.round(y * 10) / 10));
  const base = { id, x, y, ...gabarit };
  if (nom === "piste") {
    base.x = 0;
    base.w = formatCarte().w;
  }
  modele[face].push(base);
  selection = id;
  marquerOutil("selection");
  dessinerCarte();
  proprietes();
  sauverModele();
  if (nom === "qr") {
    message("QR ajouté. Il pointe vers la vérification sécurisée. Couleurs et contenu : panneau Propriétés.");
  } else if (nom === "codebarres") {
    message("Code-barres ajouté. Champ, couleurs et texte : panneau Propriétés.");
  } else {
    message("Composant ajouté. Déplacez-le, ou réglez-le dans Propriétés.");
  }
  if (estTexte(base)) editerTexte(base);
}

function choisirOutil(nom) {
  if (nom !== "selection" && GABARITS[nom]) {
    ajouterComposant(nom);
    return;
  }
  marquerOutil(nom);
}

function poser(ev) {
  if (!GABARITS[outil]) return;
  ajouterComposant(outil, ev);
}

document.querySelectorAll("[data-outil]").forEach((b) => {
  b.addEventListener("click", () => choisirOutil(b.dataset.outil));
});

document.getElementById("echelle").addEventListener("pointerdown", (ev) => {
  const carte = ev.target.closest(".carte");
  if (!carte || ev.target !== carte) return;
  choisirFace(carte.dataset.face);
  if (outil === "selection") {
    selection = null;
    dessinerCarte();
    proprietes();
    return;
  }
  poser(ev);
});

function basculerAffichage(nom) {
  selection = null;
  choisirAffichage(nom);
  dessinerCarte();
  ajusterZoom();
  dessinerGrille();
  proprietes();
}
document.getElementById("vue-recto").onclick = () => basculerAffichage("recto");
document.getElementById("vue-verso").onclick = () => basculerAffichage("verso");
document.getElementById("vue-double").onclick = () => basculerAffichage("double");
document.getElementById("zoom").oninput = (ev) => {
  zoom = Number(ev.target.value);
  dessinerCarte();
};
function reglerZoom(delta) {
  const champ = document.getElementById("zoom");
  const valeur = Math.round(Math.min(Number(champ.max), Math.max(Number(champ.min), Number(champ.value) + delta)) * 20) / 20;
  champ.value = String(valeur);
  zoom = valeur;
  dessinerCarte();
}

function ajusterZoom() {
  const toile = document.getElementById("toile");
  if (!toile) return;
  const dispoW = Math.max(220, toile.clientWidth - 32);
  const dispoH = Math.max(180, toile.clientHeight - 72);
  const besoin = tailleSceneNaturelle();
  const champ = document.getElementById("zoom");
  zoom = Math.min(Number(champ.max), Math.max(Number(champ.min), Math.round(Math.min(dispoW / besoin.w, dispoH / besoin.h, 1) * 20) / 20));
  champ.value = String(zoom);
  dessinerCarte();
}
document.getElementById("orient-paysage").onclick = () => changerOrientation("paysage");
document.getElementById("orient-portrait").onclick = () => changerOrientation("portrait");
document.getElementById("zoom-moins").onclick = () => reglerZoom(-0.1);
document.getElementById("zoom-plus").onclick = () => reglerZoom(0.1);
document.getElementById("enregistrer").onclick = async () => {
  await sauverModele();
  if (!document.getElementById("message").textContent) message("Modèle enregistré.");
};
document.getElementById("basculer-base").onclick = () => {
  document.querySelector(".atelier").classList.toggle("base-ferme");
  document.getElementById("basculer-base").classList.toggle("actif");
};
document.getElementById("premier").onclick = () => { index = 0; dessinerGrille(); dessinerCarte(); };
document.getElementById("dernier").onclick = () => { index = Math.max(0, vue().length - 1); dessinerGrille(); dessinerCarte(); };
document.getElementById("precedent").onclick = () => aller(-1);
document.getElementById("suivant").onclick = () => aller(1);
document.getElementById("recherche").oninput = (ev) => {
  recherche = ev.target.value;
  index = 0;
  dessinerGrille();
  dessinerCarte();
};
document.getElementById("imprimer").onclick = () => {
  const etu = courant();
  if (!etu) {
    message("Choisissez un étudiant dans la base.");
    return;
  }
  window.location.href = `/admin/impression?etudiant=${etu.id}`;
};
document.getElementById("origine").onclick = async () => {
  const reponse = await fetch("/admin/api/modele/origine", { method: "POST", headers: entetes(), body: "{}" });
  if (!reponse.ok) return;
  modele = await reponse.json();
  if (modele.orientation !== "portrait") modele.orientation = "paysage";
  selection = null;
  poserRegles();
  dessinerCarte();
  ajusterZoom();
  proprietes();
  message("Modèle d'origine rétabli.");
};
function francs(montant) {
  const nombre = String(Math.max(0, Number(montant) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  return `${nombre} GNF`;
}
document.getElementById("recharger").onclick = () => {
  const etu = courant();
  if (!etu) {
    message("Choisissez un étudiant dans la base.");
    return;
  }
  document.getElementById("recharge-qui").textContent = `${etu.prenom} ${etu.nom} · ${etu.matricule}`;
  document.getElementById("recharge-solde").textContent = `Compte actuel : ${francs(etu.solde_cantine)}`;
  document.getElementById("recharge").showModal();
};
document.getElementById("fermer-recharge").onclick = () => document.getElementById("recharge").close();
document.getElementById("form-recharge").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const etu = courant();
  if (!etu) return;
  const montant = new FormData(ev.target).get("montant");
  const reponse = await fetch(`/admin/api/etudiants/${etu.id}/cantine`, {
    method: "POST",
    headers: entetes(),
    body: JSON.stringify({ montant }),
  });
  const corps = await reponse.json();
  if (!reponse.ok) {
    message(corps.message || "Rechargement impossible.");
    return;
  }
  Object.assign(etu, corps);
  document.getElementById("recharge").close();
  ev.target.reset();
  message(`Compte de ${etu.matricule} : ${francs(etu.solde_cantine)}. Le QR débite ce compte.`);
  dessinerGrille();
  dessinerCarte();
});
document.getElementById("ajouter").onclick = () => document.getElementById("dialogue").showModal();
document.getElementById("fermer-dialogue").onclick = () => document.getElementById("dialogue").close();
document.getElementById("photo-fiche").addEventListener("change", (ev) => {
  const apercu = document.getElementById("apercu-photo");
  const fichier = ev.target.files && ev.target.files[0];
  if (!fichier) {
    apercu.hidden = true;
    apercu.removeAttribute("src");
    return;
  }
  apercu.src = URL.createObjectURL(fichier);
  apercu.hidden = false;
});
document.getElementById("form-ajout").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const formulaire = new FormData(ev.target);
  const photo = formulaire.get("photo");
  const donnees = Object.fromEntries(formulaire.entries());
  delete donnees.photo;
  const reponse = await fetch("/admin/api/etudiants", { method: "POST", headers: entetes(), body: JSON.stringify(donnees) });
  const corps = await reponse.json();
  if (!reponse.ok) {
    message(corps.message || "Création impossible.");
    return;
  }
  if (photo instanceof File && photo.size > 0) {
    const envoi = new FormData();
    envoi.append("csrf", csrf);
    envoi.append("fichier", photo);
    const photoReponse = await fetch(`/admin/etudiants/${corps.id}/photo`, {
      method: "POST",
      headers: { Accept: "application/json", "X-CSRF": csrf },
      body: envoi,
    });
    if (photoReponse.ok) corps.photo = true;
    else message("La fiche est créée, mais la photo n'a pas été acceptée.");
  }
  document.getElementById("dialogue").close();
  ev.target.reset();
  document.getElementById("apercu-photo").hidden = true;
  message(`Mot de passe temporaire de ${corps.matricule} : ${corps.mot_de_passe}`);
  etudiants.push(corps);
  etudiants.sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  index = vue().findIndex((e) => e.id === corps.id);
  dessinerGrille();
  dessinerCarte();
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.matches("input, textarea, select") || ev.target.isContentEditable) return;
  if ((ev.key === "Delete" || ev.key === "Backspace") && selection) {
    const obj = objetChoisi();
    if (!obj || obj.verrou) return;
    ev.preventDefault();
    action("supprimer");
  }
});

function garderMenus() {
  document.querySelectorAll(".service").forEach((service) => {
    const titre = service.querySelector(".service-titre");
    if (!titre) return;
    titre.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const etait = service.classList.contains("ouvert");
      document.querySelectorAll(".service.ouvert").forEach((autre) => autre.classList.remove("ouvert"));
      if (!etait) service.classList.add("ouvert");
    });
    service.addEventListener("mouseenter", () => {
      clearTimeout(service._fermeture);
      service.classList.add("survole");
    });
    service.addEventListener("mouseleave", () => {
      clearTimeout(service._fermeture);
      service._fermeture = setTimeout(() => service.classList.remove("survole"), 400);
    });
  });
  document.addEventListener("click", (ev) => {
    if (ev.target.closest(".service")) return;
    document.querySelectorAll(".service.ouvert").forEach((service) => service.classList.remove("ouvert"));
  });
}
garderMenus();

poserRegles();
document.getElementById("toile").addEventListener("scroll", dessinerRegles);
document.getElementById("toile").addEventListener("pointermove", suivreRegles);
window.addEventListener("resize", dessinerRegles);
fetch("/admin/api/atelier")
  .then((r) => r.json())
  .then((data) => {
    etudiants = data.etudiants;
    modele = data.modele;
    if (modele.orientation !== "portrait") modele.orientation = "paysage";
    choisirAffichage(affichage);
    poserRegles();
    dessinerGrille();
    dessinerCarte();
    ajusterZoom();
  })
  .catch(() => message("La base ne répond pas."));
