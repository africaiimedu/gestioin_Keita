(function () {
  var puces = document.querySelectorAll(".puce");
  puces.forEach(function (puce) {
    puce.addEventListener("click", function () {
      var filtre = puce.dataset.filtre;
      puces.forEach(function (autre) {
        var actif = autre === puce;
        autre.classList.toggle("actif", actif);
        autre.setAttribute("aria-pressed", actif ? "true" : "false");
      });
      document.querySelectorAll(".rayon[data-cat]").forEach(function (rayon) {
        rayon.hidden = filtre !== "tout" && rayon.dataset.cat !== filtre;
      });
      puce.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  });

  var barre = document.getElementById("ouvrir-panier");
  if (!barre) return;
  var stockage = "cantine-panier";
  var cleStock = "cantine-cle";
  var panier = lire();
  var voile = document.getElementById("voile");
  var feuille = document.getElementById("feuille");

  function lire() {
    try { return JSON.parse(sessionStorage.getItem(stockage)) || {}; }
    catch (e) { return {}; }
  }
  function sauver() { sessionStorage.setItem(stockage, JSON.stringify(panier)); }
  function francs(montant) { return new Intl.NumberFormat("fr-FR").format(montant) + " GNF"; }
  function articles() {
    return Object.keys(panier).map(function (id) { return { id: Number(id), qte: panier[id].qte }; });
  }
  var solde = Number(feuille.dataset.solde || 0);
  var maximum = Number(feuille.dataset.max || 10);
  var boutons = {};
  document.querySelectorAll(".plus").forEach(function (bouton) { boutons[bouton.dataset.id] = bouton; });
  function plafond(id) {
    var stock = boutons[id] ? boutons[id].dataset.stock : "";
    return stock === "" || stock === undefined ? maximum : Math.max(0, Math.min(maximum, Number(stock)));
  }
  function totalSolde() {
    return Object.keys(panier).reduce(function (somme, id) { return somme + panier[id].prix * panier[id].qte; }, 0);
  }
  function parSolde() { return solde >= totalSolde(); }
  function prixLigne(id) { return parSolde() ? panier[id].prix : (panier[id].caisse || panier[id].prix); }
  function total() {
    return Object.keys(panier).reduce(function (somme, id) { return somme + prixLigne(id) * panier[id].qte; }, 0);
  }
  function cle() {
    var existante = sessionStorage.getItem(cleStock);
    if (existante) return existante;
    var neuve = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/-/g, "");
    sessionStorage.setItem(cleStock, neuve);
    return neuve;
  }
  function dessiner() {
    var compte = Object.keys(panier).reduce(function (n, id) { return n + panier[id].qte; }, 0);
    barre.hidden = compte === 0;
    document.getElementById("compte-panier").textContent = String(compte);
    document.getElementById("total-panier").textContent = francs(total());
    var liste = document.getElementById("lignes");
    liste.innerHTML = "";
    Object.keys(panier).forEach(function (id) {
      var ligne = document.createElement("li");
      var nom = document.createElement("span");
      nom.className = "nom-ligne";
      nom.textContent = panier[id].nom;
      var compteur = document.createElement("div");
      compteur.className = "compteur petit";
      var moins = document.createElement("button");
      moins.type = "button";
      moins.textContent = "−";
      moins.setAttribute("aria-label", "Une portion de moins : " + panier[id].nom);
      moins.addEventListener("click", function () {
        panier[id].qte -= 1;
        if (panier[id].qte <= 0) delete panier[id];
        sauver();
        dessiner();
      });
      var valeur = document.createElement("output");
      valeur.textContent = String(panier[id].qte);
      var plus = document.createElement("button");
      plus.type = "button";
      plus.textContent = "+";
      plus.disabled = panier[id].qte >= plafond(id);
      plus.setAttribute("aria-label", "Une portion de plus : " + panier[id].nom);
      plus.addEventListener("click", function () {
        if (panier[id].qte >= plafond(id)) return;
        panier[id].qte += 1;
        sauver();
        dessiner();
      });
      compteur.append(moins, valeur, plus);
      var prix = document.createElement("strong");
      prix.textContent = francs(prixLigne(id) * panier[id].qte);
      var retirer = document.createElement("button");
      retirer.type = "button";
      retirer.className = "retirer";
      retirer.textContent = "Retirer";
      retirer.addEventListener("click", function () {
        delete panier[id];
        sauver();
        dessiner();
      });
      ligne.append(nom, compteur, prix, retirer);
      liste.appendChild(ligne);
    });
    Object.keys(boutons).forEach(function (id) {
      var choisi = Boolean(panier[id]);
      boutons[id].classList.toggle("choisi", choisi);
      boutons[id].textContent = choisi ? "✓ " + panier[id].qte : "+";
      boutons[id].setAttribute("aria-label", choisi
        ? boutons[id].dataset.nom + " : déjà choisi, " + panier[id].qte + " portion(s)"
        : "Ajouter " + boutons[id].dataset.nom);
    });
    var avis = document.getElementById("avis-caisse");
    var caisse = compte > 0 && !parSolde();
    avis.hidden = !caisse;
    avis.textContent = caisse
      ? "Votre solde (" + francs(solde) + ") ne couvre pas cette commande. Elle passe au prix sans solde : vous payez " + francs(total()) + " à la caisse (espèces ou Orange Money), puis la cuisine la prépare."
      : "";
    document.getElementById("payer-libelle").textContent = caisse ? "Commander, payer à la caisse" : "Payer avec mon solde";
    document.getElementById("payer-montant").textContent = francs(total());
    document.getElementById("panier-json").value = JSON.stringify(articles());
    document.getElementById("cle-commande").value = cle();
  }
  var choix = document.getElementById("choix-qte");
  var choixValeur = document.getElementById("choix-valeur");
  var choixValider = document.getElementById("choix-valider");
  var enCours = null;
  function peindreChoix() {
    var bouton = boutons[enCours.id];
    var prix = Number(bouton.dataset.prix);
    var caisse = Number(bouton.dataset.prixCaisse || bouton.dataset.prix);
    choixValeur.textContent = String(enCours.qte);
    document.getElementById("choix-moins").disabled = enCours.qte <= 1;
    document.getElementById("choix-plus").disabled = enCours.qte >= plafond(enCours.id);
    document.getElementById("choix-prix").textContent = enCours.qte + " × " + francs(prix) + " = " + francs(prix * enCours.qte)
      + (caisse !== prix ? " · sans solde : " + francs(caisse * enCours.qte) : "");
    var stock = bouton.dataset.stock;
    document.getElementById("choix-limite").textContent = stock !== "" && Number(stock) < maximum
      ? "Il reste " + stock + " portion" + (Number(stock) > 1 ? "s" : "") + "."
      : "Jusqu'à " + maximum + " portions par plat.";
  }
  function fermerChoix() {
    choix.hidden = true;
    voile.hidden = feuille.hidden;
    enCours = null;
  }
  function ouvrirChoix(id) {
    var bouton = boutons[id];
    var deja = document.getElementById("choix-deja");
    document.getElementById("choix-nom").textContent = bouton.dataset.nom;
    if (panier[id]) {
      deja.hidden = false;
      deja.textContent = "Ce plat est déjà choisi : " + panier[id].qte + " portion" + (panier[id].qte > 1 ? "s" : "") + " dans votre panier. Changez la quantité ci-dessous ou dans le panier.";
      choixValider.textContent = "Mettre à jour le panier";
      enCours = { id: id, qte: panier[id].qte };
    } else {
      deja.hidden = true;
      choixValider.textContent = "Ajouter au panier";
      enCours = { id: id, qte: 1 };
    }
    peindreChoix();
    voile.hidden = false;
    choix.hidden = false;
    choixValider.focus();
  }
  document.getElementById("choix-moins").addEventListener("click", function () {
    if (enCours && enCours.qte > 1) { enCours.qte -= 1; peindreChoix(); }
  });
  document.getElementById("choix-plus").addEventListener("click", function () {
    if (enCours && enCours.qte < plafond(enCours.id)) { enCours.qte += 1; peindreChoix(); }
  });
  document.getElementById("choix-annuler").addEventListener("click", fermerChoix);
  choixValider.addEventListener("click", function () {
    if (!enCours) return;
    var bouton = boutons[enCours.id];
    panier[enCours.id] = {
      nom: bouton.dataset.nom,
      prix: Number(bouton.dataset.prix),
      caisse: Number(bouton.dataset.prixCaisse || bouton.dataset.prix),
      qte: Math.min(enCours.qte, plafond(enCours.id)),
    };
    bouton.classList.add("ajoute");
    setTimeout(function () { bouton.classList.remove("ajoute"); }, 160);
    sauver();
    fermerChoix();
    dessiner();
  });
  Object.keys(boutons).forEach(function (id) {
    boutons[id].addEventListener("click", function () { ouvrirChoix(id); });
  });
  function ouvrir(visible) {
    voile.hidden = !visible;
    feuille.hidden = !visible;
  }
  barre.addEventListener("click", function () { ouvrir(true); });
  document.getElementById("fermer-panier").addEventListener("click", function () { ouvrir(false); });
  voile.addEventListener("click", function () {
    if (!choix.hidden) { fermerChoix(); return; }
    ouvrir(false);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !choix.hidden) fermerChoix();
  });
  Object.keys(panier).forEach(function (id) {
    if (!boutons[id]) delete panier[id];
    else panier[id].qte = Math.min(panier[id].qte, plafond(id));
    if (panier[id] && panier[id].qte <= 0) delete panier[id];
  });
  sauver();
  dessiner();
})();
