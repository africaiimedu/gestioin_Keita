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
      nom.textContent = panier[id].qte + " × " + panier[id].nom;
      var prix = document.createElement("strong");
      prix.textContent = francs(prixLigne(id) * panier[id].qte);
      var moins = document.createElement("button");
      moins.type = "button";
      moins.textContent = "Retirer";
      moins.addEventListener("click", function () {
        panier[id].qte -= 1;
        if (panier[id].qte <= 0) delete panier[id];
        sauver();
        dessiner();
      });
      ligne.append(nom, prix, moins);
      liste.appendChild(ligne);
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
  document.querySelectorAll(".plus").forEach(function (bouton) {
    bouton.addEventListener("click", function () {
      var id = bouton.dataset.id;
      if (!panier[id]) panier[id] = { nom: bouton.dataset.nom, prix: Number(bouton.dataset.prix), qte: 0 };
      panier[id].caisse = Number(bouton.dataset.prixCaisse || bouton.dataset.prix);
      if (panier[id].qte >= 4) return;
      panier[id].qte += 1;
      bouton.classList.add("ajoute");
      setTimeout(function () { bouton.classList.remove("ajoute"); }, 160);
      sauver();
      dessiner();
    });
  });
  function ouvrir(visible) {
    voile.hidden = !visible;
    feuille.hidden = !visible;
  }
  barre.addEventListener("click", function () { ouvrir(true); });
  document.getElementById("fermer-panier").addEventListener("click", function () { ouvrir(false); });
  voile.addEventListener("click", function () { ouvrir(false); });
  dessiner();
})();
