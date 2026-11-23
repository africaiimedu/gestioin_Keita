(function () {
  const racine = document.getElementById("erp");
  if (!racine) return;
  const pageEl = document.getElementById("erp-page");
  const titre = document.getElementById("erp-titre");
  const sous = document.getElementById("erp-sous");
  const msg = document.getElementById("erp-msg");
  const voile = document.getElementById("erp-voile");
  const modale = document.getElementById("erp-modale");
  const titres = {
    tableau: ["Tableau de bord", "Chiffre d'affaires, stock, bénéfices et caisse"],
    stock: ["Stocks", "Quantités, valeur et mouvements"],
    achats: ["Achats", "Entrée automatique en stock selon le paiement"],
    depenses: ["Dépenses", "Charges hors achats déjà comptés"],
    ventes: ["Ventes", "Plats vendus, prix unitaire et total calculé"],
    plats: ["Plats", "Prix, fiches, catégories et suppressions"],
    caisse: ["Caisse", "Ouverture, opérations, clôture et écart"],
    pertes: ["Pertes", "Périmé, gaspillage et écarts"],
    rapports: ["Rapports", "Export PDF et Excel"],
  };
  const MODES = { especes: "Espèces", orange_money: "Orange Money", mobile_money: "Mobile Money", banque: "Banque", credit: "Crédit" };
  const NATURES = {
    vente: "Vente", vente_plat: "Vente de plat", recette_diverse: "Recette diverse",
    apport_capital: "Apport de capital", remboursement: "Remboursement", paiement_client: "Paiement client",
  };
  let constantes = { unites: [], categories_articles: [], categories_depenses: [], natures: [], modes: [], motifs_perte: [] };
  let stock = [];
  let plats = [];
  let categories = [];

  function entier(n) { return Math.max(0, Math.round(Number(n) || 0)); }
  function gnf(n) {
    return entier(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " GNF";
  }
  function datefr(iso) {
    if (!iso) return "—";
    const p = String(iso).slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
  }
  function dire(texte, ok) {
    msg.hidden = !texte;
    msg.textContent = texte || "";
    msg.classList.toggle("erreur", ok === false);
  }
  async function api(chemin, options) {
    const r = await fetch(chemin, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {}));
    const type = r.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const data = await r.json();
      if (!r.ok && data && data.message) throw new Error(data.message);
      return data;
    }
    if (!r.ok) throw new Error("Erreur " + r.status);
    return r;
  }
  async function post(chemin, corps) {
    const data = await api(chemin, { method: "POST", body: JSON.stringify(corps) });
    if (!data.ok) throw new Error(data.message || "Opération refusée");
    return data;
  }
  function sel(id, options, valeur) {
    return `<select name="${id}">${options.map((o) => {
      const v = typeof o === "string" ? o : o.id;
      const l = typeof o === "string" ? o : (o.libelle || o.nom);
      return `<option value="${v}" ${String(v) === String(valeur || "") ? "selected" : ""}>${l}</option>`;
    }).join("")}</select>`;
  }
  function modesSel(name, valeur) {
    return sel(name, (constantes.modes || []).map((m) => ({ id: m, nom: MODES[m] || m })), valeur);
  }
  function carte(lib, val, alerte) {
    return `<article class="erp-carte${alerte ? " alerte" : ""}"><span>${lib}</span><strong>${val}</strong></article>`;
  }
  function formCarte(titreForm, champs) {
    const ouvert = window.matchMedia("(min-width: 900px)").matches ? " open" : "";
    return `<details class="erp-ajout erp-panneau"${ouvert}><summary>${titreForm}</summary><form class="erp-form">${champs}<label><span>&nbsp;</span><button type="submit">Enregistrer</button></label></form></details>`;
  }
  function formulaireProduit(apres) {
    ouvrirModale(`
      <h2>Nouveau produit</h2>
      <form>
        <div class="champs">
          <label>Nom<input name="nom" required></label>
          <label>Catégorie${sel("categorie", constantes.categories_articles)}</label>
          <label>Unité${sel("unite", constantes.unites)}</label>
          <label>Quantité<input name="quantite" type="number" min="0" step="1" value="0"></label>
          <label>Coût unitaire (GNF)<input name="cout_moyen" type="number" min="0" step="1" value="0"></label>
          <label>Seuil d'alerte<input name="seuil" type="number" min="0" step="1" value="0"></label>
        </div>
        <div class="pied">
          <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
          <button type="submit" class="erp-btn">Ajouter</button>
        </div>
      </form>`);
    modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
    modale.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      f.quantite = entier(f.quantite);
      f.seuil = entier(f.seuil);
      try {
        const r = await post("/cantine/gestion/api/stock", f);
        fermerModale();
        dire("Produit ajouté.", true);
        if (apres) apres(r.article);
        else afficher("stock");
      } catch (e) { dire(e.message, false); fermerModale(); }
    });
  }
  function formulairePlat(apres) {
    ouvrirModale(`
      <h2>Nouveau plat</h2>
      <form>
        <div class="champs">
          <label>Nom du plat<input name="nom" required></label>
          <label>Catégorie${sel("categorie_id", categories.length ? categories : [{ id: "", nom: "—" }])}</label>
          <label>Prix de vente (GNF)<input name="prix" type="number" min="1" step="1" required></label>
        </div>
        <div class="pied">
          <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
          <button type="submit" class="erp-btn">Ajouter</button>
        </div>
      </form>`);
    modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
    modale.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      try {
        const r = await post("/cantine/gestion/api/plats", { nom: f.nom, prix: entier(f.prix), categorie_id: f.categorie_id });
        fermerModale();
        dire("Plat ajouté.", true);
        if (apres) apres(r);
        else afficher("plats");
      } catch (e) { dire(e.message, false); fermerModale(); }
    });
  }
  function tableauHtml(entetes, lignes, vide) {
    if (!lignes.length) return `<div class="erp-panneau"><p class="erp-vide">${vide || "Aucun enregistrement."}</p></div>`;
    return `<div class="erp-only-desk"><div class="erp-panneau"><div class="erp-table-wrap"><table class="erp-table"><thead><tr>${entetes}</tr></thead><tbody>${lignes.join("")}</tbody></table></div></div></div>`;
  }
  function barreAjout(id, libelle) {
    return `<div class="erp-toolbar"><button type="button" class="erp-ajouter erp-only-phone" id="${id}">${libelle}</button></div>`;
  }
  function etiqueterTableaux() {
    pageEl.querySelectorAll("table.erp-table").forEach((table) => {
      const labels = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
      table.querySelectorAll("tbody tr").forEach((tr) => {
        [...tr.children].forEach((td, i) => {
          if (labels[i]) td.setAttribute("data-label", labels[i]);
        });
      });
    });
  }

  function fermerModale() {
    voile.hidden = true;
    modale.innerHTML = "";
    modale.classList.remove("large");
  }
  function ouvrirModale(html, large) {
    modale.classList.toggle("large", !!large);
    modale.innerHTML = html;
    voile.hidden = false;
    const champ = modale.querySelector("input, select, textarea");
    if (champ) champ.focus();
  }

  async function chargerRefs() {
    constantes = await api("/cantine/gestion/api/constantes");
    stock = (await api("/cantine/gestion/api/stock")).articles || [];
    plats = (await api("/cantine/gestion/api/plats")).plats || [];
    categories = (await api("/cantine/gestion/api/categories")).categories || [];
  }
  function idsCoches(selecteur) {
    return [...new Set([...pageEl.querySelectorAll(selecteur)].map((c) => Number(c.value)))];
  }
  function confirmer(titre, texte, onOk) {
    ouvrirModale(`
      <h2>${titre}</h2>
      <p class="aide">${texte}</p>
      <div class="pied">
        <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
        <button type="button" class="erp-btn danger" id="erp-ok">Supprimer</button>
      </div>`);
    modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
    modale.querySelector("#erp-ok").addEventListener("click", onOk);
  }

  function barres(id, items) {
    const el = document.getElementById(id);
    if (!el) return;
    if (!items.length) {
      el.innerHTML = "<p class=\"erp-vide\">Pas encore de données.</p>";
      return;
    }
    const max = Math.max(1, ...items.map((x) => Number(x.valeur) || 0));
    el.innerHTML = items.map((x) => {
      const val = Number(x.valeur) || 0;
      const h = val ? Math.max(12, Math.round((val / max) * 100)) : 0;
      return `<div class="erp-col" title="${x.label} : ${gnf(val)}"><i style="height:${h}%"></i><span>${x.label}</span></div>`;
    }).join("");
  }

  async function pageTableau() {
    const t = await api("/cantine/gestion/api/tableau");
    const s = t.series || {};
    pageEl.innerHTML = `
      <div class="erp-grille">
        ${carte("CA du jour", gnf(t.ca_jour))}
        ${carte("CA de la semaine", gnf(t.ca_semaine))}
        ${carte("CA du mois", gnf(t.ca_mois))}
        ${carte("Achats", gnf(t.achats))}
        ${carte("Dépenses du mois", gnf(t.depenses))}
        ${carte("Recettes encaissées", gnf(t.recettes))}
        ${carte("Sorties d'argent", gnf(t.sorties))}
        ${carte("Solde caisse", gnf(t.solde_caisse), !t.caisse_ouverte)}
        ${carte("Valeur du stock", gnf(t.valeur_stock))}
        ${carte("Marchandises consommées", gnf(t.consomme))}
        ${carte("Bénéfice brut", gnf(t.benefice_brut))}
        ${carte("Bénéfice net", gnf(t.benefice_net))}
        ${carte("Marge", (t.marge || 0) + " %")}
        ${carte("Pertes", gnf(t.pertes))}
        ${carte("Reste à payer", gnf(t.dettes))}
        ${carte("Créances clients", gnf(t.creances))}
        ${carte("Seuil de rentabilité", gnf(t.seuil))}
      </div>
      <div class="erp-2">
        <div class="erp-panneau"><h2>Évolution du chiffre d'affaires</h2><div class="barres" id="g-ca"></div></div>
        <div class="erp-panneau"><h2>Dépenses par catégorie</h2><div class="barres" id="g-dep"></div></div>
      </div>
      <div class="erp-panneau">
        <h2>Alertes de stock</h2>
        ${(t.alertes || []).length ? `<div class="erp-table-wrap"><table class="erp-table"><thead><tr><th>Produit</th><th class="num">Disponible</th><th class="num">Seuil</th></tr></thead><tbody>${t.alertes.map((a) => `<tr><td>${a.nom}</td><td class="num">${entier(a.quantite)} ${a.unite}</td><td class="num">${entier(a.seuil)}</td></tr>`).join("")}</tbody></table></div>` : "<p class=\"erp-vide\">Aucun stock faible.</p>"}
      </div>`;
    barres("g-ca", (s.ca || []).map((x) => ({ label: x.date.slice(5), valeur: x.valeur })));
    barres("g-dep", (s.depenses_cat || []).map((c) => ({ label: c.categorie, valeur: c.valeur })));
  }

  async function pageStock() {
    await chargerRefs();
    pageEl.innerHTML = `
      ${formCarte("Nouveau produit", `
        <label>Nom<input name="nom" required></label>
        <label>Catégorie${sel("categorie", constantes.categories_articles)}</label>
        <label>Unité${sel("unite", constantes.unites)}</label>
        <label>Quantité initiale<input name="quantite" type="number" min="0" step="1" value="0" required></label>
        <label>Coût unitaire (GNF)<input name="cout_moyen" type="number" min="0" step="1" value="0"></label>
        <label>Seuil d'alerte<input name="seuil" type="number" min="0" step="1" value="0"></label>
      `)}
      ${barreAjout("ajout-prod-tel", "Nouveau produit")}
      <div class="erp-actions">
        <label class="erp-tout"><input type="checkbox" id="tout-prod"> Tout sélectionner</label>
        <button type="button" class="erp-btn danger" id="suppr-produits">Supprimer</button>
      </div>
      ${tableauHtml(
        `<th></th><th>Produit</th><th>Catégorie</th><th class="num">Quantité</th><th class="num">Coût moyen</th><th class="num">Valeur</th><th>Action</th>`,
        stock.map((a) => `<tr class="clicable" data-fiche="${a.id}">
          <td><input type="checkbox" class="coche-prod" value="${a.id}"></td>
          <td>${a.nom}${a.rupture ? '<span class="tag tag-alerte">rupture</span>' : a.alerte ? '<span class="tag tag-alerte">alerte</span>' : ""}</td>
          <td>${a.categorie || "—"}</td>
          <td class="num">${entier(a.quantite)} ${a.unite}</td>
          <td class="num">${gnf(a.cout_moyen)}</td>
          <td class="num">${gnf(a.valeur)}</td>
          <td class="centre"><button type="button" class="erp-btn fin" data-mvt="${a.id}">Mouvement</button></td>
        </tr>`),
        "Aucun produit en stock."
      )}
      ${stock.length ? `<div class="erp-liste">${stock.map((a) => `<article class="erp-fiche clicable" data-fiche="${a.id}">
        <div class="erp-fiche-haut">
          <label class="erp-check"><input type="checkbox" class="coche-prod" value="${a.id}"></label>
          <div class="erp-fiche-titre">
            <strong>${a.nom}</strong>
            <span class="erp-pill">${a.categorie || "Produit"}${a.rupture ? " · rupture" : a.alerte ? " · alerte" : ""}</span>
          </div>
          <button type="button" class="erp-lien" data-mvt="${a.id}">Mouvement</button>
        </div>
        <div class="erp-stats">
          <div><span>Quantité</span><b>${entier(a.quantite)} ${a.unite}</b></div>
          <div><span>Coût</span><b>${gnf(a.cout_moyen)}</b></div>
          <div><span>Valeur</span><b>${gnf(a.valeur)}</b></div>
        </div>
      </article>`).join("")}</div>` : ""}`;
    const ajoutTel = pageEl.querySelector("#ajout-prod-tel");
    if (ajoutTel) ajoutTel.addEventListener("click", () => formulaireProduit(() => afficher("stock")));
    pageEl.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      f.quantite = entier(f.quantite);
      f.seuil = entier(f.seuil);
      try {
        await post("/cantine/gestion/api/stock", f);
        dire("Produit enregistré.", true);
        afficher("stock");
      } catch (e) { dire(e.message, false); }
    });
    const toutProd = pageEl.querySelector("#tout-prod");
    if (toutProd) toutProd.addEventListener("change", () => {
      pageEl.querySelectorAll(".coche-prod").forEach((c) => { c.checked = toutProd.checked; });
    });
    pageEl.querySelector("#suppr-produits").addEventListener("click", () => {
      const ids = idsCoches(".coche-prod:checked");
      if (!ids.length) { dire("Cochez un ou plusieurs produits.", false); return; }
      confirmer("Supprimer les produits", ids.length + " produit(s) seront retirés du stock.", async () => {
        try {
          await post("/cantine/gestion/api/stock/supprimer", { ids });
          fermerModale();
          dire("Produits supprimés.", true);
          afficher("stock");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
    pageEl.querySelectorAll("[data-fiche]").forEach((tr) => tr.addEventListener("click", (ev) => {
      if (ev.target.closest("button, input, label")) return;
      const art = stock.find((a) => String(a.id) === tr.dataset.fiche);
      if (!art) return;
      ouvrirModale(`
        <h2>${art.nom}</h2>
        <p class="aide">${art.categorie || ""} · ${art.unite}</p>
        <form>
          <div class="champs">
            <label>Nom<input name="nom" value="${art.nom}" required></label>
            <label>Catégorie${sel("categorie", constantes.categories_articles, art.categorie)}</label>
            <label>Unité${sel("unite", constantes.unites, art.unite)}</label>
            <label>Seuil d'alerte<input name="seuil" type="number" min="0" step="1" value="${entier(art.seuil)}"></label>
          </div>
          <p class="aide">Quantité : ${entier(art.quantite)} ${art.unite} — Valeur : ${gnf(art.valeur)} — Coût moyen : ${gnf(art.cout_moyen)}</p>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Fermer</button>
            <button type="submit" class="erp-btn">Enregistrer</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev2) => {
        ev2.preventDefault();
        const f = Object.fromEntries(new FormData(ev2.target).entries());
        try {
          await post(`/cantine/gestion/api/stock/${art.id}`, { nom: f.nom, categorie: f.categorie, unite: f.unite, seuil: entier(f.seuil) });
          fermerModale();
          dire("Produit mis à jour.", true);
          afficher("stock");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    }));
    pageEl.querySelectorAll("[data-mvt]").forEach((b) => b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const art = stock.find((a) => String(a.id) === b.dataset.mvt);
      ouvrirModale(`
        <h2>Mouvement de stock</h2>
        <p class="aide">${art ? art.nom : ""} — disponible : ${entier(art && art.quantite)} ${art ? art.unite : ""}</p>
        <form>
          <div class="champs">
            <div class="erp-sens">
              <label><input type="radio" name="sens" value="entree" checked> Entrée</label>
              <label><input type="radio" name="sens" value="sortie"> Sortie</label>
            </div>
            <label>Quantité<input name="quantite" type="number" min="1" step="1" required></label>
            <label>Motif<input name="motif" value="Ajustement"></label>
          </div>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
            <button type="submit" class="erp-btn">Valider</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const f = Object.fromEntries(new FormData(ev.target).entries());
        try {
          await post(`/cantine/gestion/api/stock/${b.dataset.mvt}/mouvement`, {
            quantite: entier(f.quantite), sens: f.sens, motif: f.motif,
          });
          fermerModale();
          dire("Stock mis à jour.", true);
          afficher("stock");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    }));
  }

  async function pageAchats() {
    await chargerRefs();
    const data = await api("/cantine/gestion/api/achats");
    pageEl.innerHTML = `
      ${formCarte("Nouvel achat", `
        <label>Date<input name="date_achat" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label>Produit
          <span class="avec-action">${sel("article_id", stock)}<button type="button" class="erp-btn fin" id="nouveau-produit">+</button></span>
        </label>
        <label>Quantité<input name="quantite" type="number" min="1" step="1" required></label>
        <label>Prix unitaire<input name="prix_unitaire" type="number" min="0" step="1" required></label>
        <label>Mode de paiement${modesSel("mode")}</label>
        <label>Montant payé<input name="paye" type="number" min="0" step="1" value="0"></label>
      `)}
      ${barreAjout("ajout-achat-tel", "Nouvel achat")}
      ${tableauHtml(
        `<th>N°</th><th>Date</th><th>Produit</th><th class="num">Total</th><th class="num">Payé</th><th class="num">Reste</th><th></th>`,
        (data.achats || []).map((a) => {
          const produit = (a.lignes || []).map((l) => {
            const art = stock.find((s) => s.id === l.article_id);
            return (art ? art.nom : "Produit") + " × " + entier(l.quantite);
          }).join(", ");
          return `<tr>
            <td>${a.numero}</td><td>${datefr(a.date)}</td><td>${produit || "—"}</td>
            <td class="num">${gnf(a.total)}</td><td class="num">${gnf(a.paye)}</td><td class="num">${gnf(a.reste)}</td>
            <td class="centre">${a.reste > 0 ? `<button type="button" class="erp-btn fin" data-payer="${a.id}" data-reste="${a.reste}">Payer</button>` : '<span class="tag tag-ok">soldé</span>'}</td>
          </tr>`;
        }),
        "Aucun achat enregistré."
      )}
      ${(data.achats || []).length ? `<div class="erp-liste">${(data.achats || []).map((a) => {
        const produit = (a.lignes || []).map((l) => {
          const art = stock.find((s) => s.id === l.article_id);
          return (art ? art.nom : "Produit") + " × " + entier(l.quantite);
        }).join(", ");
        return `<article class="erp-fiche">
          <div class="erp-fiche-ligne"><span class="erp-fiche-meta">${datefr(a.date)}</span><b>${gnf(a.total)}</b></div>
          <strong>${produit || "Achat"}</strong>
          <p class="erp-fiche-meta">${a.reste > 0 ? "Reste " + gnf(a.reste) : "Soldé"}</p>
          ${a.reste > 0 ? `<button type="button" class="erp-lien" data-payer="${a.id}" data-reste="${a.reste}" style="margin-top:.6rem">Payer</button>` : ""}
        </article>`;
      }).join("")}</div>` : ""}`;
    const ajoutAchat = pageEl.querySelector("#ajout-achat-tel");
    if (ajoutAchat) ajoutAchat.addEventListener("click", () => pageEl.querySelector(".erp-ajout summary").click());
    pageEl.querySelector("#nouveau-produit").addEventListener("click", () => {
      formulaireProduit((article) => {
        stock.push(article);
        afficher("achats");
      });
    });
    pageEl.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      try {
        await post("/cantine/gestion/api/achats", {
          date_achat: f.date_achat, mode: f.mode, paye: entier(f.paye || 0),
          lignes: [{ article_id: Number(f.article_id), quantite: entier(f.quantite), prix_unitaire: entier(f.prix_unitaire) }],
        });
        dire("Achat enregistré, stock mis à jour.", true);
        afficher("achats");
      } catch (e) { dire(e.message, false); }
    });
    pageEl.querySelectorAll("[data-payer]").forEach((b) => b.addEventListener("click", () => {
      const reste = entier(b.dataset.reste);
      ouvrirModale(`
        <h2>Règlement</h2>
        <p class="aide">Reste à payer : ${gnf(reste)}</p>
        <form>
          <div class="champs"><label>Montant (GNF)<input name="montant" type="number" min="1" step="1" value="${reste}" required></label></div>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
            <button type="submit" class="erp-btn">Encaisser</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          await post(`/cantine/gestion/api/achats/${b.dataset.payer}/payer`, { montant: entier(new FormData(ev.target).get("montant")) });
          fermerModale();
          afficher("achats");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    }));
  }

  async function pageDepenses() {
    const data = await api("/cantine/gestion/api/depenses");
    pageEl.innerHTML = `
      ${formCarte("Nouvelle dépense", `
        <label>Date<input name="date_depense" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label>Catégorie${sel("categorie", constantes.categories_depenses)}</label>
        <label>Description<input name="description" required></label>
        <label>Montant<input name="montant" type="number" min="1" step="1" required></label>
        <label>Mode${modesSel("mode")}</label>
        <label>Responsable<input name="responsable"></label>
      `)}
      ${barreAjout("ajout-dep-tel", "Nouvelle dépense")}
      ${tableauHtml(
        `<th>Date</th><th>Catégorie</th><th>Libellé</th><th class="num">Montant</th>`,
        (data.depenses || []).map((d) => `<tr><td>${datefr(d.date)}</td><td>${d.categorie}</td><td>${d.description}</td><td class="num">${gnf(d.montant)}</td></tr>`),
        "Aucune dépense."
      )}
      ${(data.depenses || []).length ? `<div class="erp-liste">${(data.depenses || []).map((d) => `<article class="erp-fiche">
        <div class="erp-fiche-ligne"><span class="erp-fiche-meta">${datefr(d.date)} · ${d.categorie}</span><b>${gnf(d.montant)}</b></div>
        <strong>${d.description}</strong>
      </article>`).join("")}</div>` : ""}`;
    const ajoutDep = pageEl.querySelector("#ajout-dep-tel");
    if (ajoutDep) ajoutDep.addEventListener("click", () => pageEl.querySelector(".erp-ajout summary").click());
    pageEl.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await post("/cantine/gestion/api/depenses", Object.fromEntries(new FormData(ev.target).entries()));
        dire("Dépense enregistrée.", true);
        afficher("depenses");
      } catch (e) { dire(e.message, false); }
    });
  }

  async function pageVentes() {
    await chargerRefs();
    const data = await api("/cantine/gestion/api/entrees");
    const optionsPlats = plats.map((p) => `<option value="${p.id}" data-prix="${p.prix}">${p.nom}</option>`).join("");
    pageEl.innerHTML = `
      ${formCarte("Nouvelle vente", `
        <label>Date<input name="date_entree" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label>Plat
          <span class="avec-action">
            <select name="plat_id" id="sel-plat" required>
              <option value="">Choisir un plat</option>
              ${optionsPlats}
            </select>
            <button type="button" class="erp-btn fin" id="nouveau-plat">+</button>
          </span>
        </label>
        <label>Prix unitaire<input name="prix_unitaire" id="prix-unitaire" type="number" min="0" step="1" readonly></label>
        <label>Quantité<input name="quantite_plats" id="qte-vente" type="number" min="1" step="1" value="1" required></label>
        <label>Montant total<input name="montant" id="montant-vente" type="number" min="0" step="1" value="0" readonly class="total"></label>
        <label>Mode${modesSel("mode")}</label>
        <label>Description<input name="description"></label>
      `)}
      ${barreAjout("ajout-vente-tel", "Nouvelle vente")}
      ${tableauHtml(
        `<th>Date</th><th>Commande</th><th>Détail</th><th class="num">Montant</th>`,
        (data.entrees || []).map((e) => `<tr><td>${datefr(e.date)}</td><td>${e.nature_affichee || e.plat_nom || e.description || "Vente"}</td><td>${e.description && e.description !== e.plat_nom ? e.description : (e.quantite_plats > 1 ? e.quantite_plats + " portions" : "—")}</td><td class="num">${gnf(e.montant)}</td></tr>`),
        "Aucune vente."
      )}
      ${(data.entrees || []).length ? `<div class="erp-liste">${(data.entrees || []).map((e) => `<article class="erp-fiche">
        <div class="erp-fiche-ligne">
          <div>
            <strong>${e.nature_affichee || e.plat_nom || e.description || "Vente"}</strong>
            <p class="erp-fiche-meta">${datefr(e.date)}${e.quantite_plats > 1 ? " · " + e.quantite_plats + " portions" : ""}</p>
          </div>
          <b>${gnf(e.montant)}</b>
        </div>
      </article>`).join("")}</div>` : ""}`;
    const ajoutVente = pageEl.querySelector("#ajout-vente-tel");
    if (ajoutVente) ajoutVente.addEventListener("click", () => pageEl.querySelector(".erp-ajout summary").click());
    const selPlat = pageEl.querySelector("#sel-plat");
    const prixEl = pageEl.querySelector("#prix-unitaire");
    const qteEl = pageEl.querySelector("#qte-vente");
    const totEl = pageEl.querySelector("#montant-vente");
    function recalculer() {
      const opt = selPlat.selectedOptions[0];
      const prix = entier(opt && opt.dataset.prix);
      prixEl.value = prix || "";
      totEl.value = prix * entier(qteEl.value);
    }
    selPlat.addEventListener("change", recalculer);
    qteEl.addEventListener("input", recalculer);
    pageEl.querySelector("#nouveau-plat").addEventListener("click", () => {
      formulairePlat((plat) => {
        plats.push({ id: plat.id, nom: plat.nom, prix: plat.prix, lignes: [] });
        afficher("ventes");
      });
    });
    pageEl.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      if (!f.plat_id) { dire("Choisissez un plat.", false); return; }
      try {
        const nomPlat = (selPlat.selectedOptions[0] && selPlat.selectedOptions[0].textContent) || "";
        const qte = entier(f.quantite_plats);
        await post("/cantine/gestion/api/entrees", {
          date_entree: f.date_entree,
          nature: "vente_plat",
          plat_id: f.plat_id,
          quantite_plats: qte,
          mode: f.mode,
          description: (f.description || "").trim() || (qte > 1 ? nomPlat + " × " + qte : nomPlat),
        });
        dire("Vente enregistrée.", true);
        afficher("ventes");
      } catch (e) { dire(e.message, false); }
    });
  }

  async function pagePlats() {
    await chargerRefs();
    pageEl.innerHTML = `
      <div class="erp-panneau">
        <h2>Catégories</h2>
        <form class="erp-form" id="form-cat">
          <label>Nouvelle catégorie<input name="nom" required placeholder="Ex. Grillades"></label>
          <label><span>&nbsp;</span><button type="submit">Ajouter</button></label>
        </form>
        <div class="erp-actions">
          <label class="erp-tout"><input type="checkbox" id="tout-cat"> Tout sélectionner</label>
          <button type="button" class="erp-btn danger" id="suppr-cat">Supprimer</button>
        </div>
        <div class="erp-table-wrap"><table class="erp-table">
          <thead><tr><th></th><th>Catégorie</th><th class="num">Plats</th></tr></thead>
          <tbody>${categories.map((c) => `<tr><td><input type="checkbox" class="coche-cat" value="${c.id}"></td><td>${c.nom}</td><td class="num">${c.plats}</td></tr>`).join("") || `<tr><td colspan="3">Aucune catégorie.</td></tr>`}</tbody>
        </table></div>
      </div>
      <div class="erp-actions">
        <label class="erp-tout"><input type="checkbox" id="tout-plat"> Tout sélectionner</label>
        <button type="button" class="erp-btn" id="nouveau-plat-page">Nouveau plat</button>
        <button type="button" class="erp-btn danger" id="suppr-plats">Supprimer</button>
      </div>
      ${tableauHtml(
        `<th></th><th>Plat</th><th>Catégorie</th><th class="num">Prix de vente</th><th class="num">Coût</th><th class="num">Marge</th>`,
        plats.map((p) => `<tr class="clicable" data-plat="${p.id}">
          <td><input type="checkbox" class="coche-plat" value="${p.id}"></td>
          <td>${p.nom}${p.disponible === false ? '<span class="tag tag-off">indisponible</span>' : ""}</td>
          <td>${p.categorie || "—"}</td>
          <td class="num">${gnf(p.prix)}</td>
          <td class="num">${gnf(p.cout)}</td>
          <td class="num ${p.marge < 0 ? "tag-alerte" : ""}">${gnf(p.marge)} <small>(${p.pct} %)</small></td>
        </tr>`),
        "Aucun plat."
      )}
      ${plats.length ? `<div class="erp-liste">${plats.map((p) => `<article class="erp-fiche clicable" data-plat="${p.id}">
        <div class="erp-fiche-haut">
          <label class="erp-check"><input type="checkbox" class="coche-plat" value="${p.id}"></label>
          <div class="erp-fiche-titre"><strong>${p.nom}</strong><span class="erp-pill">${p.categorie || "Plat"}</span></div>
        </div>
        <div class="erp-stats">
          <div><span>Prix</span><b>${gnf(p.prix)}</b></div>
          <div><span>Coût</span><b>${gnf(p.cout)}</b></div>
          <div><span>Marge</span><b>${gnf(p.marge)}</b></div>
        </div>
      </article>`).join("")}</div>` : ""}`;
    pageEl.querySelector("#nouveau-plat-page").addEventListener("click", () => formulairePlat(() => afficher("plats")));
    pageEl.querySelector("#form-cat").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await post("/cantine/gestion/api/categories", { nom: new FormData(ev.target).get("nom") });
        dire("Catégorie ajoutée.", true);
        afficher("plats");
      } catch (e) { dire(e.message, false); }
    });
    const toutCat = pageEl.querySelector("#tout-cat");
    if (toutCat) toutCat.addEventListener("change", () => pageEl.querySelectorAll(".coche-cat").forEach((c) => { c.checked = toutCat.checked; }));
    const toutPlat = pageEl.querySelector("#tout-plat");
    if (toutPlat) toutPlat.addEventListener("change", () => pageEl.querySelectorAll(".coche-plat").forEach((c) => { c.checked = toutPlat.checked; }));
    pageEl.querySelector("#suppr-cat").addEventListener("click", () => {
      const ids = idsCoches(".coche-cat:checked");
      if (!ids.length) { dire("Cochez une ou plusieurs catégories.", false); return; }
      confirmer("Supprimer des catégories", "Les plats de ces catégories seront aussi retirés du menu.", async () => {
        try {
          await post("/cantine/gestion/api/categories/supprimer", { ids });
          fermerModale();
          dire("Catégories supprimées.", true);
          afficher("plats");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
    pageEl.querySelector("#suppr-plats").addEventListener("click", () => {
      const ids = idsCoches(".coche-plat:checked");
      if (!ids.length) { dire("Cochez un ou plusieurs plats.", false); return; }
      confirmer("Supprimer des plats", ids.length + " plat(s) seront retirés du menu.", async () => {
        try {
          await post("/cantine/gestion/api/plats/supprimer", { ids });
          fermerModale();
          dire("Plats supprimés.", true);
          afficher("plats");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
    pageEl.querySelectorAll("[data-plat]").forEach((tr) => tr.addEventListener("click", (ev) => {
      if (ev.target.closest("input, label")) return;
      const p = plats.find((x) => String(x.id) === tr.dataset.plat);
      if (!p) return;
      ouvrirModale(`
        <h2>${p.nom}</h2>
        <p class="aide">${p.categorie || "Sans catégorie"}</p>
        <form>
          <div class="champs">
            <label>Nom<input name="nom" value="${p.nom.replace(/"/g, "&quot;")}" required></label>
            <label>Catégorie${sel("categorie_id", categories, p.categorie_id)}</label>
            <label>Prix de vente (GNF)<input name="prix" type="number" min="1" step="1" value="${p.prix}" required></label>
            <label>Description<input name="description" value="${(p.description || "").replace(/"/g, "&quot;")}"></label>
          </div>
          <p class="aide">Coût estimé : ${gnf(p.cout)} — Marge : ${gnf(p.marge)} (${p.pct} %)</p>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Fermer</button>
            <button type="submit" class="erp-btn">Enregistrer le prix</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev2) => {
        ev2.preventDefault();
        const f = Object.fromEntries(new FormData(ev2.target).entries());
        try {
          await post(`/cantine/gestion/api/plats/${p.id}`, { nom: f.nom, categorie_id: f.categorie_id, prix: entier(f.prix), description: f.description });
          fermerModale();
          dire("Plat mis à jour.", true);
          afficher("plats");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    }));
  }

  async function pageCaisse() {
    const c = await api("/cantine/gestion/api/caisse");
    pageEl.innerHTML = `
      <div class="erp-grille">
        ${carte("État", c.ouverte ? "Ouverte" : "Fermée", !c.ouverte)}
        ${carte("Solde d'ouverture", gnf(c.solde_ouverture))}
        ${carte("Solde théorique", gnf(c.solde_theorique))}
      </div>
      <div class="erp-actions">
        ${c.ouverte
          ? `<button type="button" class="erp-btn" id="cloturer">Clôturer la caisse</button>`
          : `<button type="button" class="erp-btn" id="ouvrir">Ouvrir la caisse</button>`}
      </div>
      ${tableauHtml(
        `<th>Sens</th><th>Libellé</th><th class="num">Montant</th>`,
        (c.operations || []).map((o) => `<tr><td>${o.sens === "entree" ? "Entrée" : "Sortie"}</td><td>${o.libelle}</td><td class="num">${gnf(o.montant)}</td></tr>`),
        "Aucune opération sur cette session."
      )}`;
    const ouvrir = document.getElementById("ouvrir");
    if (ouvrir) ouvrir.addEventListener("click", () => {
      ouvrirModale(`
        <h2>Ouvrir la caisse</h2>
        <form>
          <div class="champs"><label>Solde d'ouverture (GNF)<input name="solde" type="number" min="0" step="1" value="0" required></label></div>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
            <button type="submit" class="erp-btn">Ouvrir</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          await post("/cantine/gestion/api/caisse/ouvrir", { solde: entier(new FormData(ev.target).get("solde")) });
          fermerModale();
          afficher("caisse");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
    const cloturer = document.getElementById("cloturer");
    if (cloturer) cloturer.addEventListener("click", () => {
      ouvrirModale(`
        <h2>Clôturer la caisse</h2>
        <p class="aide">Solde théorique : ${gnf(c.solde_theorique)}</p>
        <form>
          <div class="champs"><label>Solde physique compté (GNF)<input name="solde_physique" type="number" min="0" step="1" value="${entier(c.solde_theorique)}" required></label></div>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
            <button type="submit" class="erp-btn">Clôturer</button>
          </div>
        </form>`);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        try {
          const r = await post("/cantine/gestion/api/caisse/cloturer", { solde_physique: entier(new FormData(ev.target).get("solde_physique")) });
          fermerModale();
          dire("Caisse clôturée. Écart : " + gnf(r.ecart), true);
          afficher("caisse");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
  }

  async function pagePertes() {
    await chargerRefs();
    const data = await api("/cantine/gestion/api/pertes");
    pageEl.innerHTML = `
      ${formCarte("Enregistrer une perte", `
        <label>Date<input name="date_perte" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label>Produit${sel("article_id", stock)}</label>
        <label>Motif${sel("motif", constantes.motifs_perte)}</label>
        <label>Quantité<input name="quantite" type="number" min="1" step="1" required></label>
        <label>Observation<input name="observation"></label>
      `)}
      <div class="erp-actions"><button type="button" class="erp-btn or" id="inventaire">Inventaire</button></div>
      ${barreAjout("ajout-perte-tel", "Enregistrer une perte")}
      ${tableauHtml(
        `<th>Date</th><th>Motif</th><th class="num">Quantité</th><th class="num">Valeur</th>`,
        (data.pertes || []).map((p) => `<tr><td>${datefr(p.date)}</td><td>${p.motif}</td><td class="num">${entier(p.quantite)}</td><td class="num">${gnf(p.valeur)}</td></tr>`),
        "Aucune perte enregistrée."
      )}
      ${(data.pertes || []).length ? `<div class="erp-liste">${(data.pertes || []).map((p) => `<article class="erp-fiche">
        <div class="erp-fiche-ligne"><span class="erp-fiche-meta">${datefr(p.date)} · ${p.motif}</span><b>${gnf(p.valeur)}</b></div>
        <p class="erp-fiche-meta">Quantité ${entier(p.quantite)}</p>
      </article>`).join("")}</div>` : ""}`;
    const ajoutPerte = pageEl.querySelector("#ajout-perte-tel");
    if (ajoutPerte) ajoutPerte.addEventListener("click", () => pageEl.querySelector(".erp-ajout summary").click());
    pageEl.querySelector("form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(ev.target).entries());
      f.quantite = entier(f.quantite);
      try {
        await post("/cantine/gestion/api/pertes", f);
        dire("Perte enregistrée.", true);
        afficher("pertes");
      } catch (e) { dire(e.message, false); }
    });
    document.getElementById("inventaire").addEventListener("click", () => {
      ouvrirModale(`
        <h2>Inventaire</h2>
        <p class="aide">Saisissez la quantité physique constatée, en nombre entier.</p>
        <form>
          <div class="erp-table-wrap"><table class="erp-table">
            <thead><tr><th>Produit</th><th class="num">Théorique</th><th class="num">Physique</th></tr></thead>
            <tbody>${stock.map((a) => `<tr>
              <td>${a.nom}</td>
              <td class="num">${entier(a.quantite)} ${a.unite}</td>
              <td class="num"><input name="phys_${a.id}" type="number" min="0" step="1" value="${entier(a.quantite)}" style="width:5.5rem"></td>
            </tr>`).join("")}</tbody>
          </table></div>
          <div class="pied">
            <button type="button" class="erp-btn clair" data-fermer>Annuler</button>
            <button type="submit" class="erp-btn">Valider l'inventaire</button>
          </div>
        </form>`, true);
      modale.querySelector("[data-fermer]").addEventListener("click", fermerModale);
      modale.querySelector("form").addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const form = new FormData(ev.target);
        const lignes = stock.map((a) => ({ article_id: a.id, physique: entier(form.get("phys_" + a.id)) }));
        try {
          await post("/cantine/gestion/api/inventaire", { lignes, observation: "Inventaire" });
          fermerModale();
          dire("Inventaire enregistré.", true);
          afficher("stock");
        } catch (e) { dire(e.message, false); fermerModale(); }
      });
    });
  }

  function pageRapports() {
    pageEl.innerHTML = `
      <div class="erp-panneau">
        <h2>Exports</h2>
        <p class="erp-vide">Les rapports reprennent le tableau de bord, le stock valorisé et le bénéfice net. Les calculs sont faits côté serveur, en GNF.</p>
        <div class="erp-actions" style="margin-top:1rem">
          <a class="lien-export" href="/cantine/gestion/api/export.pdf">Télécharger le PDF</a>
          <a class="lien-export or" href="/cantine/gestion/api/export.xlsx">Télécharger Excel</a>
        </div>
      </div>`;
  }

  const pages = {
    tableau: pageTableau, stock: pageStock, achats: pageAchats, depenses: pageDepenses,
    ventes: pageVentes, plats: pagePlats, caisse: pageCaisse, pertes: pagePertes, rapports: pageRapports,
  };

  const menuErp = document.getElementById("erp-menu");
  const boutonPlus = document.getElementById("erp-plus");
  const tabs = ["tableau", "stock", "achats", "ventes"];
  function fermerMenuErp() {
    if (menuErp) menuErp.classList.remove("ouvert");
  }
  function marquerOnglets(nom) {
    document.querySelectorAll(".erp-nav button, .erp-bas [data-page]").forEach((b) => {
      b.classList.toggle("actif", b.dataset.page === nom);
    });
    if (boutonPlus) boutonPlus.classList.toggle("actif", tabs.indexOf(nom) === -1);
  }
  async function afficher(nom) {
    fermerModale();
    fermerMenuErp();
    dire("");
    titre.textContent = titres[nom][0];
    sous.textContent = titres[nom][1];
    marquerOnglets(nom);
    try {
      await (pages[nom] || pageTableau)();
      etiqueterTableaux();
    } catch (e) {
      pageEl.innerHTML = `<div class="erp-panneau"><p>Impossible de charger ce module : ${e.message}</p></div>`;
    }
  }

  voile.addEventListener("click", (ev) => { if (ev.target === voile) fermerModale(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !voile.hidden) fermerModale(); });
  document.querySelectorAll(".erp-nav button, .erp-bas [data-page]").forEach((b) => {
    b.addEventListener("click", () => afficher(b.dataset.page));
  });
  if (boutonPlus) {
    boutonPlus.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menuErp.classList.toggle("ouvert");
    });
  }
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#erp-menu") && !ev.target.closest("#erp-plus")) fermerMenuErp();
  });
  chargerRefs().then(() => afficher("tableau"));
})();
