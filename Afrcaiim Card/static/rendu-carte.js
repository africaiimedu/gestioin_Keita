function teinte(valeur, defaut) {
  return /^#[0-9A-Fa-f]{6}$/.test(String(valeur || "")) ? String(valeur).slice(1) : defaut.slice(1);
}

function dateCarte(valeur) {
  if (!valeur) return "";
  if (String(valeur).includes("/")) return String(valeur);
  const parties = String(valeur).split("-");
  if (parties.length !== 3) return String(valeur);
  return `${parties[2]}/${parties[1]}/${parties[0]}`;
}

function initialesCarte(etu) {
  const prenom = (etu.prenom || "").trim();
  const nom = (etu.nom || "").trim();
  return `${prenom.slice(0, 1)}${nom.slice(0, 1)}`.toUpperCase();
}

function texteCarte(obj, etu) {
  if (obj.personnalise) return obj.personnalise;
  if (obj.type === "texte") return obj.texte || "";
  if (!etu) return "";
  const brut = {
    nom: etu.nom || "",
    prenom: etu.prenom || "",
    matricule: etu.matricule || "",
    filiere: etu.filiere || "",
    ecole: (etu.filiere || "").trim(),
    email: etu.email || "",
    annee_academique: etu.annee_academique || "",
    date_validite: dateCarte(etu.date_validite),
    url: etu.url || "",
    edition: `Éd. ${etu.edition || 1}`,
    controle: etu.controle || "",
    qualite: String(etu.sexe || "M").toUpperCase() === "F" ? "Étudiante" : "Étudiant",
  }[obj.champ] || "";
  return obj.majuscules ? brut.toUpperCase() : brut;
}

function styleTexte(el, obj, px) {
  const famille = obj.police === "serif" ? '"DejaVu Serif", serif' : '"DejaVu Sans", sans-serif';
  el.style.fontFamily = famille;
  el.style.color = obj.couleur || "#1A1A1A";
  el.style.fontSize = `${(obj.taille || 9) * px * (25.4 / 72)}px`;
  el.style.fontWeight = obj.gras ? "700" : "400";
  el.style.fontStyle = obj.italique ? "italic" : "normal";
  el.style.textDecoration = obj.souligne ? "underline" : "none";
  el.style.letterSpacing = `${(obj.approche || 0) * px * (25.4 / 72)}px`;
  el.style.lineHeight = String(obj.interligne || 1.15);
  el.style.display = "flex";
  el.style.alignItems = obj.retour || obj.align === "justify" ? "flex-start" : "center";
  el.style.justifyContent = obj.align === "center" ? "center" : obj.align === "right" ? "flex-end" : "flex-start";
  el.style.textAlign = obj.align === "center" ? "center" : obj.align === "right" ? "right" : obj.align === "justify" ? "justify" : "left";
  el.style.whiteSpace = obj.retour || obj.align === "justify" ? "pre-wrap" : "nowrap";
  el.style.overflowWrap = obj.retour ? "anywhere" : "normal";
  el.style.overflow = "hidden";
}

function tenirDansLaBoite(el) {
  if (el.style.whiteSpace !== "nowrap") return;
  let taille = parseFloat(el.style.fontSize);
  if (!taille) return;
  let tours = 0;
  while (tours < 28 && el.scrollWidth > el.clientWidth + 1 && taille > 8) {
    taille *= 0.94;
    el.style.fontSize = `${taille}px`;
    tours += 1;
  }
}

function rendreFace(carte, objets, ctx) {
  const px = ctx.px;
  carte.innerHTML = "";
  carte.style.borderRadius = `${2.2 * px}px`;
  (objets || []).forEach((obj) => {
    const el = document.createElement("div");
    el.className = "objet";
    el.dataset.id = obj.id;
    el.style.left = `${obj.x * px}px`;
    el.style.top = `${obj.y * px}px`;
    el.style.width = `${obj.w * px}px`;
    el.style.height = `${obj.h * px}px`;
    if (ctx.selection === obj.id) el.style.outline = "1px dashed #1d4f8a";
    if (obj.type === "rect" || obj.type === "piste") {
      el.style.background = obj.couleur || "#0C4630";
      if (obj.rayon) el.style.borderRadius = `${obj.rayon * px}px`;
      if (obj.contour) el.style.border = `${Math.max(1, (obj.epaisseur || 0.25) * px * 0.35)}px solid ${obj.contour}`;
    } else if (obj.type === "cercle") {
      el.style.background = obj.couleur || "#F0A020";
      el.style.borderRadius = "50%";
      if (obj.contour) el.style.border = `${Math.max(1, (obj.epaisseur || 0.25) * px * 0.35)}px solid ${obj.contour}`;
    } else if (obj.type === "guilloche") {
      el.appendChild(toileGuilloche(obj, px, graineCarte(ctx.etu)));
    } else if (obj.type === "rosette") {
      el.appendChild(toileRosette(obj, px, graineCarte(ctx.etu)));
    } else if (obj.type === "micro") {
      const motif = `${texteCarte(obj, ctx.etu)} · `;
      el.textContent = motif.repeat(12);
      styleTexte(el, obj, px);
      el.style.whiteSpace = "nowrap";
      el.style.alignItems = "center";
    } else if (obj.type === "ligne") {
      el.style.display = "flex";
      el.style.alignItems = "center";
      const trait = document.createElement("div");
      trait.style.width = "100%";
      trait.style.height = `${Math.max(1, (obj.epaisseur || 0.3) * px)}px`;
      trait.style.background = obj.couleur || "#1A1A1A";
      el.appendChild(trait);
    } else if (obj.type === "image") {
      const src = obj.id === "logo" ? "/static/marque-blanc.png?v=2" : "/static/marque.png";
      el.innerHTML = `<img alt="Université AFRICAIIM" src="${src}" style="width:100%;height:100%;object-fit:contain;pointer-events:none">`;
    } else if (obj.type === "photo") {
      el.style.background = obj.couleur || "#C5F0DC";
      el.style.borderRadius = `${(obj.rayon || 0) * px}px`;
      el.style.display = "grid";
      el.style.placeItems = "center";
      if (ctx.etu && ctx.etu.photo && ctx.urls && ctx.urls.photo) {
        el.innerHTML = `<img alt="" src="${ctx.urls.photo}" style="width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:inherit">`;
      } else if (obj.initiales !== false && ctx.etu) {
        const span = document.createElement("span");
        span.textContent = initialesCarte(ctx.etu);
        span.style.fontWeight = "700";
        span.style.fontSize = `${obj.h * px * 0.38}px`;
        span.style.color = obj.couleur_texte || "#0C4630";
        span.style.pointerEvents = "none";
        el.appendChild(span);
      }
    } else if (obj.type === "qr") {
      el.style.background = obj.fond || "#fff";
      el.style.boxShadow = obj.cadre === false ? "none" : "0 0 0 1.5px #FEAB00";
      if (ctx.urls && ctx.urls.qr) {
        const contenu = encodeURIComponent(obj.contenu || "securise");
        const src = `${ctx.urls.qr}?contenu=${contenu}&encre=${teinte(obj.couleur, "#111111")}&fond=${teinte(obj.fond, "#FFFFFF")}`;
        el.innerHTML = `<img alt="QR code" src="${src}" style="width:100%;height:100%;object-fit:contain;image-rendering:crisp-edges;pointer-events:none">`;
      }
    } else if (obj.type === "codebarres") {
      el.style.background = obj.fond || "#fff";
      el.style.overflow = "hidden";
      el.style.display = "grid";
      el.style.placeItems = "center";
      const champ = encodeURIComponent(obj.champ || "matricule");
      if (ctx.urls && ctx.urls.barre) {
        const jointure = ctx.urls.barre.includes("?") ? "&" : "?";
        const src = `${ctx.urls.barre}${jointure}champ=${champ}&encre=${teinte(obj.couleur, "#111111")}&fond=${teinte(obj.fond, "#FFFFFF")}`;
        const net = "object-fit:contain;image-rendering:crisp-edges;pointer-events:none";
        if (obj.sens === "vertical") {
          el.innerHTML = `<img alt="Code-barres" src="${src}" style="width:${obj.h * px}px;height:${obj.w * px}px;max-width:100%;max-height:100%;transform:rotate(-90deg);${net}">`;
        } else {
          el.innerHTML = `<img alt="Code-barres" src="${src}" style="width:100%;height:100%;${net}">`;
        }
      }
    } else {
      el.textContent = texteCarte(obj, ctx.etu);
      styleTexte(el, obj, px);
    }
    if (ctx.onPointer) el.addEventListener("pointerdown", (ev) => ctx.onPointer(ev, obj));
    const fond = obj.type === "rect" || obj.type === "piste" || obj.type === "guilloche" || obj.type === "ligne";
    el.style.zIndex = obj.type === "rosette" ? "2" : fond ? "1" : "3";
    carte.appendChild(el);
    if (el.style.whiteSpace === "nowrap") tenirDansLaBoite(el);
  });
  const largeurMm = parseFloat(carte.style.width) / px || 85.6;
  const hauteurMm = parseFloat(carte.style.height) / px || 54;
  carte.appendChild(filigraneLogo(px, ctx.face || "recto", largeurMm, hauteurMm));
}

function graineCarte(etu) {
  const texte = (etu && (etu.controle || etu.matricule)) || "carte";
  let somme = 0;
  for (let i = 0; i < texte.length; i += 1) somme = (somme * 33 + texte.charCodeAt(i)) >>> 0;
  return somme;
}

function filigraneLogo(px, face, largeurMm, hauteurMm) {
  const img = document.createElement("img");
  img.alt = "";
  const recto = face !== "verso";
  const portrait = (hauteurMm || 54) > (largeurMm || 85.6) + 1;
  const ratio = 740 / 806;
  let hauteur;
  let haut;
  if (recto && portrait) {
    hauteur = 36;
    haut = 28;
  } else if (recto) {
    hauteur = 36;
    haut = 17.2;
  } else if (portrait) {
    hauteur = 24;
    haut = 22;
  } else {
    hauteur = 28;
    haut = 14;
  }
  const largeur = hauteur * ratio;
  const droite = 1;
  const gauche = (largeurMm || (portrait ? 54 : 85.6)) - largeur - droite;
  img.src = recto ? "/static/filigrane.png?v=10" : "/static/filigrane-verso.png?v=10";
  img.style.cssText = `position:absolute;left:${gauche * px}px;top:${haut * px}px;width:${largeur * px}px;height:${hauteur * px}px;object-fit:contain;pointer-events:none;z-index:1`;
  return img;
}

function toileGuilloche(obj, px, graine) {
  const canvas = document.createElement("canvas");
  const largeur = Math.max(1, obj.w * px);
  const hauteur = Math.max(1, obj.h * px);
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(largeur * ratio));
  canvas.height = Math.max(1, Math.round(hauteur * ratio));
  canvas.style.cssText = `width:${largeur}px;height:${hauteur}px;display:block;pointer-events:none`;
  const crayon = canvas.getContext("2d");
  crayon.scale(ratio, ratio);
  const phase = (graine % 628) / 100;
  crayon.strokeStyle = obj.couleur || "#FEAB00";
  crayon.globalAlpha = 0.42;
  crayon.lineWidth = Math.max(1 / ratio, (0.6 / 7.4) * px);
  const pas = (6 / 7.4) * px;
  const periode = (16 / 7.4) * px;
  const amplitude = (1.2 / 7.4) * px;
  const pasX = (2 / 7.4) * px;
  let indice = 0;
  for (let ordonnee = 0; ordonnee < hauteur; ordonnee += pas) {
    crayon.beginPath();
    for (let abscisse = 0; abscisse <= largeur; abscisse += pasX) {
      const crete = Math.sin(abscisse / periode + phase + indice * 0.45) * amplitude;
      if (abscisse === 0) crayon.moveTo(abscisse, ordonnee + crete);
      else crayon.lineTo(abscisse, ordonnee + crete);
    }
    crayon.stroke();
    indice += 1;
  }
  return canvas;
}

function toileRosette(obj, px, graine) {
  const canvas = document.createElement("canvas");
  const largeur = Math.max(1, obj.w * px);
  const hauteur = Math.max(1, obj.h * px);
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.max(1, Math.round(largeur * ratio));
  canvas.height = Math.max(1, Math.round(hauteur * ratio));
  canvas.style.cssText = `width:${largeur}px;height:${hauteur}px;display:block;pointer-events:none`;
  const crayon = canvas.getContext("2d");
  crayon.scale(ratio, ratio);
  const phase = (graine % 628) / 100;
  const centreX = largeur / 2;
  const centreY = hauteur / 2;
  const rayon = Math.min(largeur, hauteur) * 0.46;
  crayon.lineWidth = Math.max(1 / ratio, (0.5 / 7.4) * px);
  crayon.lineJoin = "round";
  crayon.lineCap = "round";
  const tracer = () => {
    [[5, 0.58], [7, 0.76], [11, 0.94]].forEach(([lobes, echelle], indice) => {
      const grand = rayon * echelle;
      const petit = grand / lobes;
      const ecart = petit * (0.7 + (graine % 5) * 0.04);
      const pas = Math.max(petit, 0.4);
      const tours = lobes * 2;
      const points = 90 * tours;
      crayon.beginPath();
      for (let i = 0; i <= points; i += 1) {
        const angle = (i / points) * Math.PI * 2 * tours + phase * (indice + 1) * 0.2;
        const rapport = (grand - petit) / pas;
        const abscisse = (grand - petit) * Math.cos(angle) + ecart * Math.cos(rapport * angle);
        const ordonnee = (grand - petit) * Math.sin(angle) - ecart * Math.sin(rapport * angle);
        if (i === 0) crayon.moveTo(centreX + abscisse, centreY + ordonnee);
        else crayon.lineTo(centreX + abscisse, centreY + ordonnee);
      }
      crayon.stroke();
    });
    [0.18, 0.34, 0.48].forEach((facteur) => {
      crayon.beginPath();
      crayon.arc(centreX, centreY, rayon * facteur, 0, Math.PI * 2);
      crayon.stroke();
    });
  };
  crayon.save();
  crayon.translate(0.8, 1);
  crayon.strokeStyle = "rgba(0, 76, 34, 0.35)";
  crayon.globalAlpha = 1;
  tracer();
  crayon.restore();
  crayon.strokeStyle = obj.couleur || "#FFFFFF";
  crayon.globalAlpha = 0.95;
  tracer();
  return canvas;
}
