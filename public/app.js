const app = document.querySelector("#app");
function newKey() {
  if (globalThis.crypto?.randomUUID) return newKey();
  const bytes = new Uint8Array(16);
  (globalThis.crypto?.getRandomValues || ((b) => { for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256); }))(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const state = { user: null, screen: "tableau", suite: "finances", carte: "etudiants", demo: null, catalog: null, idempotencyKey: newKey(), studentPage: 1 };

const labels = {
  licence: "Licence", master: "Master", tech: "Tech Ingénieur",
  bachelor: "Bachelor", bachelor_1: "Bachelor 1", bachelor_2: "Bachelor 2", bachelor_3: "Bachelor 3",
  master_1: "Master 1", master_2: "Master 2",
  actif: "Actif", suspendu: "Suspendu", archive: "Archivé",
  active: "Carte active", limited: "Carte limitée", suspended: "Carte suspendue",
  super_admin: "Super admin", admin: "Admin", gestionnaire: "Gestionnaire",
};

const schools = [
  "AFRICAIIM Business School",
  "AFRICAIIM Tech",
  "AFRICAIIM École de Droit et Sciences Politiques",
  "AFRICAIIM Sup de Com",
  "AFRICAIIM Expertise Comptable",
  "AFRICAIIM Carrières Bancaires",
];

const months = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function levelLabel(code) {
  const year = { bachelor_1: "1re année", bachelor_2: "2e année", bachelor_3: "3e année", master_1: "1re année", master_2: "2e année" }[code];
  if (code === "bachelor" || String(code).startsWith("bachelor_")) return year ? `Bachelor · ${year}` : "Bachelor";
  if (code === "master" || code === "master_1" || code === "master_2") return year ? `Master · ${year}` : "Master";
  return labels[code] || code;
}

function notifyOverpay(message) {
  let dialog = document.querySelector("#overpay-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "overpay-dialog";
    dialog.className = "sheet notice";
    dialog.setAttribute("closedby", "none");
    document.body.appendChild(dialog);
    dialog.addEventListener("cancel", (event) => event.preventDefault());
  }
  dialog.innerHTML = `<form>
      <div class="dialog-head"><h2>Montant trop élevé</h2><button class="dialog-close" type="button" id="close-overpay">Fermer</button></div>
      <p>${esc(message)}</p>
      <button class="btn" id="ok-overpay" type="button">Fermer</button>
    </form>`;
  dialog.querySelector("#close-overpay").addEventListener("click", () => dialog.close());
  dialog.querySelector("#ok-overpay").addEventListener("click", () => dialog.close());
  if (!dialog.open) dialog.showModal();
}

function saved(message) {
  let box = document.querySelector("#saved-toast");
  if (!box) {
    box = document.createElement("p");
    box.id = "saved-toast";
    box.setAttribute("role", "status");
    document.body.appendChild(box);
  }
  box.replaceChildren();
  const mark = document.createElement("span");
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "✓";
  box.append(mark, document.createTextNode(message));
  box.hidden = false;
  box.classList.remove("is-leaving");
  requestAnimationFrame(() => box.classList.add("is-visible"));
  clearTimeout(saved.timer);
  clearTimeout(saved.hide);
  saved.timer = setTimeout(() => {
    box.classList.remove("is-visible");
    box.classList.add("is-leaving");
    saved.hide = setTimeout(() => { box.hidden = true; }, 320);
  }, 2200);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function grouped(value) {
  const amount = Math.trunc(Number(value) || 0);
  const sign = amount < 0 ? "-" : "";
  const body = Math.abs(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${body}`;
}
function gnf(value) {
  return `${grouped(value)} GNF`;
}
function monthLabel(value) {
  const [year, month] = String(value).split("-");
  const name = months[Number(month) - 1];
  return name ? `${name} ${year}` : value;
}
function sortSchools(items) {
  return [...items].sort((a, b) => {
    const left = schools.indexOf(a.program);
    const right = schools.indexOf(b.program);
    return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
  });
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Africaiim": "1", ...(options.headers || {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (response.status === 401 && !url.endsWith("/connexion")) {
    state.user = null;
    render();
    throw new Error(data.error || "Connexion requise");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Erreur");
    error.data = data;
    throw error;
  }
  return data;
}

function allowed(code) {
  const rights = state.user?.rights || [];
  return rights.includes("*") || rights.includes(code);
}

function carteGroups() {
  return [
    ["Cartes", [
      ["etudiants", "Étudiants", "/portail/cartes/admin/etudiants"],
      ["atelier", "Atelier", "/portail/cartes/admin"],
      ["impression", "Impression", "/portail/cartes/admin/impression"],
      ["lot", "Lot d'impression", "/portail/cartes/admin/lot"],
      ["import", "Import", "/portail/cartes/admin/import"],
      ["journal", "Journal", "/portail/cartes/admin/journal"],
    ]],
    ["Cuisine", [
      ["cantine", "Cantine", "/portail/cartes/cantine"],
      ["menu", "Menu", "/portail/cartes/cantine/menu"],
      ["commandes", "Commandes", "/portail/cartes/cantine/commandes"],
    ]],
    ["Liens", [
      ["controle", "Contrôle", "/portail/cartes/securite"],
    ]],
  ];
}

function findCarte(id) {
  for (const [, items] of carteGroups()) {
    const found = items.find((item) => item[0] === id);
    if (found) return { id: found[0], label: found[1], path: found[2] };
  }
  return findCarte("etudiants");
}

function financeGroups() {
  const groups = [
    ["Pilotage", [
      allowed("dashboard.read") && ["tableau", "Tableau de bord"],
    ]],
    ["Scolarité", [
      (allowed("student.read") || allowed("student.write")) && ["etudiants", "Étudiants"],
      allowed("payment.create") && ["paiement", "Encaisser"],
      allowed("student.read") && ["retards", "Relances"],
    ]],
    ["Caisse", [
      allowed("report.read") && ["journal", "Journal de caisse"],
      allowed("audit.read") && ["audit", "Journal d'audit"],
    ]],
    ["Réglages", [
      (allowed("fee.write") || allowed("settings.write")) && ["parametres", "Tarifs"],
    ]],
  ];
  return groups.map(([label, items]) => [label, items.filter(Boolean)]).filter(([, items]) => items.length);
}

function nav() {
  return financeGroups().flatMap(([, items]) => items);
}

function openHome() {
  if (nav().length) {
    state.suite = "finances";
    state.screen = allowed("dashboard.read") ? "tableau" : nav()[0][0];
    return;
  }
  state.suite = "cartes";
  state.carte = allowed("cards.manage") ? "etudiants" : "cantine";
  state.cartePath = findCarte(state.carte).path;
}

function passwordIssue(password) {
  const value = String(password || "");
  const ok = value.length >= 6 && /[A-ZÀ-ÖØ-Þ]/.test(value) && /[a-zà-öø-ÿ]/.test(value) && /\d/.test(value) && /[^A-Za-zÀ-ÖØ-öø-ÿ0-9]/.test(value);
  return ok ? "" : "Le mot de passe doit contenir au moins 6 caractères, dont une majuscule, une minuscule, un chiffre et un caractère spécial.";
}

function pageTitle() {
  if (state.suite === "finances" && state.screen === "comptes") return "Comptes";
  if (state.suite === "finances" && state.screen === "fiche") return "Fiche étudiant";
  if (state.suite === "cartes") {
    const page = findCarte(state.carte);
    return page.id === "atelier" ? "Atelier cartes" : page.label;
  }
  const item = nav().find(([id]) => id === state.screen);
  return item ? item[1] : "Scolarité";
}

const MENU_ICONS = {
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  people: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  cash: "M2 7h20v10H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 12h.01M18 12h.01",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM8 7h8M8 11h6",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10M9 12l2 2 4-4",
  tag: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8M7 7h.01",
  card: "M2 5h20v14H2zM2 10h20M6 15h4",
  brush: "M9.1 11.9 4 17v3h3l5.1-5.1M14 4l6 6-6.9 6.9-6-6zM16.5 1.5l6 6",
  print: "M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z",
  stack: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  plate: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  menu: "M3 3h18v18H3zM7 8h10M7 12h10M7 16h6",
  bag: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0",
};
const MENU_INFO = {
  "screen:tableau": ["chart", "Encaissements et recouvrement"],
  "screen:etudiants": ["people", "Fiches et situation de paiement"],
  "screen:paiement": ["cash", "Enregistrer un paiement"],
  "screen:retards": ["bell", "Étudiants à relancer"],
  "screen:journal": ["book", "Encaissements du jour"],
  "screen:audit": ["shield", "Qui a fait quoi, et quand"],
  "screen:parametres": ["tag", "Frais par école et par niveau"],
  "carte:etudiants": ["card", "Fiches et statut des cartes"],
  "carte:atelier": ["brush", "Composer le modèle de carte"],
  "carte:impression": ["print", "Imprimer une carte"],
  "carte:lot": ["stack", "Imprimer une école entière"],
  "carte:import": ["upload", "Ajouter des étudiants par fichier"],
  "carte:journal": ["list", "Historique des cartes"],
  "carte:cantine": ["plate", "Valider les repas par QR"],
  "carte:menu": ["menu", "Plats, boissons et prix"],
  "carte:commandes": ["bag", "Commandes en cours"],
};

function menuIcon(name) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MENU_ICONS[name] || MENU_ICONS.list}"/></svg>`;
}

function dropHtml(label, items, attr, current) {
  if (!items.length) return "";
  const here = items.some(([id]) => id === current);
  return `<div class="nav-group${here ? " has-current" : ""}">
      <button type="button" class="nav-drop${here ? " actif" : ""}" aria-expanded="false" aria-haspopup="true">${label}</button>
      <div class="nav-menu" role="menu"><p class="nav-menu-title">${label}</p>${items.map(([id, name]) => {
        const [icon, hint] = MENU_INFO[`${attr}:${id}`] || ["list", ""];
        return `<button type="button" role="menuitem" data-${attr}="${id}" class="${current === id ? "active" : ""}">
          <span class="nav-ico">${menuIcon(icon)}</span>
          <span class="nav-txt"><strong>${name}</strong>${hint ? `<small>${hint}</small>` : ""}</span>
        </button>`;
      }).join("")}</div>
    </div>`;
}

function closeMenus() {
  document.querySelectorAll(".nav-group").forEach((group) => {
    if (group.classList.contains("is-open") || group.matches(":hover")) group.classList.add("is-dismissed");
    group.classList.remove("is-open");
    group.querySelector(".nav-drop")?.setAttribute("aria-expanded", "false");
  });
}

function matchCarte(path) {
  const clean = String(path || "").split("?")[0];
  const items = carteGroups().flatMap(([, list]) => list);
  const found = items
    .filter((item) => clean === item[2] || clean.startsWith(`${item[2]}/`))
    .sort((a, b) => b[2].length - a[2].length)[0];
  return found ? found[0] : "";
}

function restorePlace() {
  const raw = location.hash.replace(/^#/, "");
  if (raw.startsWith("cartes/")) {
    const tail = raw.slice("cartes/".length).replace(/^\//, "");
    state.suite = "cartes";
    state.cartePath = `/portail/cartes/${tail}`;
    state.carte = matchCarte(state.cartePath) || "etudiants";
    return;
  }
  if (!raw.startsWith("finances/")) return;
  const [screen, id] = raw.slice("finances/".length).split("/");
  const known = ["tableau", "etudiants", "paiement", "journal", "retards", "audit", "parametres", "comptes", "fiche"];
  if (!known.includes(screen)) return;
  state.suite = "finances";
  state.screen = screen;
  if (screen === "fiche" && id) state.studentId = Number(id);
}

function rememberPlace() {
  if (!state.user || state.user.mustChangePassword) return;
  const hash = state.suite === "cartes"
    ? `cartes/${(state.cartePath || findCarte(state.carte).path).replace(/^\/portail\/cartes\/?/, "")}`
    : `finances/${state.screen}${state.screen === "fiche" && state.studentId ? `/${state.studentId}` : ""}`;
  const next = `#${hash}`;
  if (location.hash !== next) history.replaceState(null, "", next);
}

function watchCarteFrame(frame) {
  frame.addEventListener("load", () => {
    try {
      const loc = frame.contentWindow.location;
      const path = `${loc.pathname}${loc.search}`;
      if (!path.startsWith("/portail/cartes/") || path.includes("/login")) return;
      state.cartePath = path;
      const matched = matchCarte(path);
      if (matched) state.carte = matched;
      rememberPlace();
      syncChrome();
    } catch { /* la page embarquée n'est pas encore lisible */ }
  });
}

async function boot() {
  try { state.user = (await api("/api/moi")).user; } catch { state.user = null; }
  state.demo = await fetch("/api/demo").then((response) => response.json());
  if (state.user) restorePlace();
  render();
  window.addEventListener("hashchange", () => {
    if (!state.user || state.user.mustChangePassword) return;
    restorePlace();
    render();
  });
}

function stopDashboard() {
  clearInterval(state.dashRefresh);
  clearTimeout(state.dashClock);
}

function render() {
  stopDashboard();
  app.innerHTML = !state.user ? loginHtml() : state.user.mustChangePassword ? passwordGate() : shell();
  bind();
  rememberPlace();
}

function passwordGate() {
  return `<div class="login-photo"><div class="login-stack">
      <section class="login-card">
        <img class="brand-logo" src="/logo.png?v=clair" alt="Université AFRICAIIM">
        <p class="lead">Première connexion. Remplacez le mot de passe provisoire avant d'entrer.</p>
        <form id="first-password">
          <label>Nouveau mot de passe</label>
          <input name="next" type="password" autocomplete="new-password" required>
          <label>Confirmez le mot de passe</label>
          <input name="confirm" type="password" autocomplete="new-password" required>
          <p class="muted">Au moins 6 caractères, avec une majuscule, une minuscule, un chiffre et un caractère spécial.</p>
          <p id="first-error" class="error" hidden></p>
          <button class="btn" type="submit">Enregistrer mon mot de passe</button>
        </form>
        <button class="btn secondary" data-logout type="button">Sortir</button>
      </section>
    </div></div>`;
}

function loginHtml() {
  return `<div class="login-photo"><div class="login-stack">
      <section class="login-card">
        <img class="brand-logo" src="/logo.png?v=clair" alt="Université AFRICAIIM">
        <p class="lead">Connectez-vous à votre compte pour accéder à votre espace d'apprentissage.</p>
        <div class="login-glass is-open">
          <button class="welcome-toggle" id="welcome-toggle" type="button" aria-expanded="true">
            <span>Bienvenue à la gestion<br>de l'Université AFRICAIIM</span>
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14.5 12 8.5l6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="login-fold"><div class="login-fold-inner">
            <form id="login-form">
              <label>Nom d'utilisateur ou e-mail</label>
              <input name="email" type="text" autocomplete="username" required>
              <label>Mot de passe</label>
              <div class="password-row">
                <input name="password" type="password" autocomplete="current-password" placeholder="Saisissez votre mot de passe" required>
                <button class="eye" id="toggle-password" type="button" aria-label="Afficher le mot de passe">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
                </button>
              </div>
              <p class="forgot"><button type="button" id="forgot">Mot de passe oublié ?</button></p>
              <p id="forgot-note" class="muted" hidden>Contactez la scolarité pour recevoir un nouveau mot de passe.</p>
              <p id="login-error" class="error" hidden></p>
              <button class="btn" type="submit">Se connecter</button>
            </form>
          </div></div>
        </div>
      </section>
      <button class="login-extra cookies" id="cookies-toggle" type="button">Avis sur les cookies</button>
      <p id="cookies-note" class="login-menu" hidden>Un cookie de session garde la connexion ouverte. Aucun cookie publicitaire.</p>
    </div></div>`;
}

function financeOnly() {
  return nav().length > 0 && !allowed("cards.manage") && !allowed("kitchen.manage");
}

function accountsButton(current) {
  return `<button type="button" data-screen="comptes" class="${current === "comptes" ? "actif" : ""}">Comptes</button>`;
}

function financeBar(current) {
  const groups = financeGroups().map(([label, items]) => {
    if (items.length === 1) {
      const [id, name] = items[0];
      return `<button type="button" data-screen="${id}" class="${current === id ? "actif" : ""}">${name}</button>`;
    }
    return dropHtml(label, items, "screen", current);
  }).join("");
  return `${groups}${accountsButton(current)}`;
}

function shell() {
  const financeCurrent = state.suite === "finances" ? state.screen : "";
  const carteCurrent = state.suite === "cartes" ? state.carte : "";
  const onlyFinance = financeOnly();
  const cartes = allowed("cards.manage") ? carteGroups()[0][1].map(([id, name]) => [id, name]) : [];
  const cuisine = allowed("kitchen.manage") ? carteGroups()[1][1].map(([id, name]) => [id, name]) : [];
  const liens = carteGroups()[2][1].filter(() => allowed("cards.manage"));
  const menu = onlyFinance
    ? financeBar(financeCurrent)
    : `${dropHtml("Finances", nav(), "screen", financeCurrent)}
        ${accountsButton(financeCurrent)}
        ${dropHtml("Cartes", cartes, "carte", carteCurrent)}
        ${dropHtml("Cuisine", cuisine, "carte", carteCurrent)}
        ${liens.map(([id, name]) => `<button type="button" data-carte="${id}" class="${carteCurrent === id ? "actif" : ""}">${name}</button>`).join("")}`;
  return `<div class="shell">
    <header class="app-top${onlyFinance ? " finance-bar" : ""}">
      <span class="puce-logo"><img src="/logo.png?v=clair" alt="Université AFRICAIIM"></span>
      <strong class="titre-barre" id="titre-barre">${esc(pageTitle())}</strong>
      <nav aria-label="Menu" id="main-nav">
        <div class="drawer-head"><span><small>Connecté</small><strong>${esc(state.user?.name || "")}</strong></span><button type="button" class="drawer-close" data-close-menu aria-label="Fermer le menu">Fermer</button></div>
        ${menu}<button type="button" class="lien${onlyFinance ? " drawer-only" : ""}" data-logout>Quitter</button></nav>
      ${onlyFinance ? `<button type="button" class="lien" data-logout>Quitter</button>` : ""}
      <button type="button" class="nav-toggle" id="nav-toggle" aria-label="Ouvrir le menu" aria-expanded="false" aria-controls="main-nav"><span></span><span></span><span></span></button>
    </header>
    <main id="screen"><p>Chargement…</p></main>
    <div class="nav-scrim" data-close-menu></div>
    ${mobileTabs(financeCurrent, carteCurrent)}</div>`;
}

function mobileTabs(financeCurrent, carteCurrent) {
  const finance = nav().filter(([id]) => ["tableau", "etudiants", "paiement", "retards", "journal"].includes(id)).slice(0, 4)
    .map(([id, name]) => ({ attr: "screen", id, name: { tableau: "Accueil", paiement: "Encaisser" }[id] || name, on: financeCurrent === id }));
  const cartes = carteGroups().slice(0, 2).flatMap(([group, items]) => items
    .filter(() => allowed(group === "Cartes" ? "cards.manage" : "kitchen.manage"))
    .map(([id, name]) => ({ attr: "carte", id, name, on: carteCurrent === id })));
  const tabs = [...finance, ...cartes].slice(0, 4);
  if (!tabs.length) return "";
  return `<nav class="tabbar" aria-label="Accès rapide" style="--tabs:${tabs.length + 1}">
    ${tabs.map((tab) => {
      const [icon] = MENU_INFO[`${tab.attr}:${tab.id}`] || ["list"];
      return `<button type="button" data-${tab.attr}="${tab.id}" class="${tab.on ? "actif" : ""}">${menuIcon(icon)}<span>${esc(tab.name)}</span></button>`;
    }).join("")}
    <button type="button" data-open-menu aria-controls="main-nav"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>Menu</span></button>
  </nav>`;
}

function setDrawer(open) {
  document.body.classList.toggle("menu-open", open);
  document.querySelector("#nav-toggle")?.setAttribute("aria-expanded", open ? "true" : "false");
}

function bindMenu(root) {
  root.querySelectorAll("[data-suite]").forEach((button) => button.addEventListener("click", () => {
    if (state.suite === button.dataset.suite) return;
    navigate({ suite: button.dataset.suite });
  }));
  root.querySelectorAll("[data-carte]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    button.blur();
    if (state.suite === "cartes" && state.carte === button.dataset.carte) return;
    navigate({ suite: "cartes", carte: button.dataset.carte });
  }));
  root.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    closeMenus();
    button.blur();
    if (state.suite === "finances" && state.screen === button.dataset.screen) return;
    navigate({ suite: "finances", screen: button.dataset.screen });
  }));
  root.querySelectorAll(".nav-group").forEach((group) => group.addEventListener("mouseleave", () => {
    group.classList.remove("is-dismissed");
  }));
  root.querySelectorAll(".nav-drop").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const group = button.closest(".nav-group");
    const open = group.classList.contains("is-open");
    closeMenus();
    if (!open) {
      group.classList.remove("is-dismissed");
      group.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
    }
  }));
}

function syncChrome() {
  const titre = document.querySelector("#titre-barre");
  if (titre) titre.textContent = pageTitle();
  const navEl = document.querySelector(".app-top nav");
  if (!navEl) return;
  navEl.querySelectorAll(".nav-group").forEach((group) => {
    let here = false;
    group.querySelectorAll("[data-screen], [data-carte]").forEach((button) => {
      const on = button.dataset.screen
        ? state.suite === "finances" && button.dataset.screen === state.screen
        : state.suite === "cartes" && button.dataset.carte === state.carte;
      button.classList.toggle("active", on);
      if (on) here = true;
    });
    group.classList.toggle("has-current", here);
    group.querySelector(".nav-drop")?.classList.toggle("actif", here);
  });
  navEl.querySelectorAll(":scope > [data-carte]").forEach((button) => {
    button.classList.toggle("actif", state.suite === "cartes" && button.dataset.carte === state.carte);
  });
  navEl.querySelectorAll(":scope > [data-screen]").forEach((button) => {
    button.classList.toggle("actif", state.suite === "finances" && button.dataset.screen === state.screen);
  });
  document.querySelectorAll(".tabbar [data-screen], .tabbar [data-carte]").forEach((button) => {
    const on = button.dataset.screen
      ? state.suite === "finances" && button.dataset.screen === state.screen
      : state.suite === "cartes" && button.dataset.carte === state.carte;
    button.classList.toggle("actif", on);
  });
  closeMenus();
  setDrawer(false);
}

/** Sur téléphone, chaque ligne de tableau devient une carte : chaque cellule reçoit le titre de sa colonne. */
function labelTables(root) {
  root.querySelectorAll("table").forEach((table) => {
    const rows = [...(table.tHead?.rows || [])];
    if (!rows.length) return;
    const columns = [];
    rows.forEach((row) => {
      let index = 0;
      [...row.cells].forEach((cell) => {
        const text = cell.textContent.trim();
        for (let span = 0; span < (cell.colSpan || 1); span += 1) {
          columns[index] = columns[index] || [];
          if (text && !columns[index].includes(text)) columns[index].push(text);
          index += 1;
        }
      });
    });
    const labels = columns.map((parts) => (parts || []).join(" · "));
    table.classList.add("rows-as-cards");
    [...table.tBodies].forEach((body) => [...body.rows].forEach((row) => {
      let index = 0;
      [...row.cells].forEach((cell) => {
        if (!cell.hasAttribute("data-label")) cell.setAttribute("data-label", labels[index] || "");
        index += cell.colSpan || 1;
      });
    }));
  });
}

function watchTables() {
  let pending = 0;
  const run = () => {
    pending = 0;
    labelTables(document);
  };
  new MutationObserver(() => {
    if (!pending) pending = requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true });
}

function navigate(patch) {
  const suiteChanged = Boolean(patch.suite && patch.suite !== state.suite);
  if (patch.suite) state.suite = patch.suite;
  if (patch.screen) state.screen = patch.screen;
  if (patch.carte) {
    state.carte = patch.carte;
    state.cartePath = findCarte(patch.carte).path;
  }
  if (state.suite !== "finances" || state.screen !== "tableau") stopDashboard();
  rememberPlace();
  syncChrome(suiteChanged);
  if (state.suite === "cartes" && !suiteChanged) {
    const frame = document.querySelector(".carte-frame");
    const page = findCarte(state.carte);
    if (frame) {
      frame.title = page.label;
      const next = new URL(page.path, location.origin).pathname;
      if (new URL(frame.src).pathname !== next) frame.src = page.path;
      return;
    }
  }
  openScreen();
}

function bind() {
  bindMenu(document);
  if (!document.documentElement.dataset.menus) {
    document.documentElement.dataset.menus = "1";
    document.addEventListener("click", () => closeMenus());
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      closeMenus();
      setDrawer(false);
    });
    watchTables();
  }
  document.querySelectorAll("[data-logout]").forEach((button) => button.addEventListener("click", async () => {
    setDrawer(false);
    await api("/api/deconnexion", { method: "POST", body: "{}" });
    state.user = null;
    history.replaceState(null, "", location.pathname);
    render();
  }));
  document.querySelectorAll("#nav-toggle, [data-open-menu]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    setDrawer(!document.body.classList.contains("menu-open"));
  }));
  document.querySelectorAll("[data-close-menu]").forEach((element) => element.addEventListener("click", () => setDrawer(false)));
  if (!state.user) setDrawer(false);
  document.querySelector("#login-form")?.addEventListener("submit", onLogin);
  document.querySelector("#first-password")?.addEventListener("submit", onFirstPassword);
  document.querySelector("#welcome-toggle")?.addEventListener("click", () => {
    const glass = document.querySelector(".login-glass");
    const open = glass.classList.toggle("is-open");
    document.querySelector("#welcome-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.querySelector("#toggle-password")?.addEventListener("click", () => {
    const input = document.querySelector("[name=password]");
    input.type = input.type === "password" ? "text" : "password";
  });
  document.querySelector("#forgot")?.addEventListener("click", () => {
    const note = document.querySelector("#forgot-note");
    note.hidden = !note.hidden;
  });
  document.querySelector("#cookies-toggle")?.addEventListener("click", () => {
    const note = document.querySelector("#cookies-note");
    note.hidden = !note.hidden;
  });
  if (state.user) openScreen();
}

async function onFirstPassword(event) {
  event.preventDefault();
  const form = event.target;
  const error = document.querySelector("#first-error");
  error.hidden = true;
  if (form.next.value !== form.confirm.value) {
    error.hidden = false;
    error.textContent = "Les deux mots de passe ne sont pas identiques.";
    return;
  }
  const weak = passwordIssue(form.next.value);
  if (weak) {
    error.hidden = false;
    error.textContent = weak;
    return;
  }
  try {
    const data = await api("/api/compte/mot-de-passe", { method: "POST", body: JSON.stringify({ next: form.next.value }) });
    state.user = data.user;
    if (!location.hash) openHome();
    render();
  } catch (caught) {
    error.hidden = false;
    error.textContent = caught.message;
  }
}

async function onLogin(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const error = document.querySelector("#login-error");
  try {
    const data = await api("/api/connexion", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    state.user = data.user;
    if (location.hash) restorePlace();
    else openHome();
    render();
  } catch (caught) {
    error.hidden = false;
    error.textContent = caught.message;
  }
}

async function openScreen() {
  const screen = document.querySelector("#screen");
  if (!screen) return;
  if (state.suite !== "finances" || state.screen !== "tableau") stopDashboard();
  if (state.suite === "cartes") {
    const kitchen = ["cantine", "menu", "commandes"].includes(state.carte);
    if (kitchen ? !allowed("kitchen.manage") : !allowed("cards.manage")) {
      screen.classList.remove("carte-host");
      screen.innerHTML = `<p class="error">Cette partie n'est pas autorisée pour votre compte.</p>`;
      return;
    }
    const page = findCarte(state.carte);
    const src = state.cartePath || page.path;
    screen.classList.add("carte-host");
    screen.innerHTML = `<iframe class="carte-frame" title="${esc(page.label)}" src="${src}"></iframe>`;
    watchCarteFrame(screen.querySelector(".carte-frame"));
    return;
  }
  screen.classList.remove("carte-host");
  try {
    if (!state.catalog) {
      state.catalog = await api("/api/referentiel");
      state.catalog.programs.sort((a, b) => {
        const left = schools.indexOf(a.name);
        const right = schools.indexOf(b.name);
        return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
      });
    }
    if (state.screen === "tableau") await showDashboard(screen);
    else if (state.screen === "etudiants") await showStudents(screen);
    else if (state.screen === "paiement") await showPayment(screen);
    else if (state.screen === "journal") await showJournal(screen);
    else if (state.screen === "retards") await showLate(screen);
    else if (state.screen === "audit") await showAudit(screen);
    else if (state.screen === "parametres") showSettings(screen);
    else     if (state.screen === "comptes") await showAccounts(screen);
    else if (state.screen === "fiche") await showStudent(screen, state.studentId);
  } catch (error) {
    screen.innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
  screen.classList.remove("enter");
  void screen.offsetWidth;
  screen.classList.add("enter");
}

function frenchDay(iso) {
  const [year, month, day] = String(iso || "").split("-").map(Number);
  if (!year || !month || !day) return iso || "";
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("fr-FR", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

function bindDashboard(screen) {
  screen.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => {
    state.status = "";
    state.studentPage = 1;
    state.screen = "etudiants";
    render();
  }));
  screen.querySelectorAll("[data-status]").forEach((button) => button.addEventListener("click", () => {
    state.status = button.dataset.status;
    state.studentPage = 1;
    state.screen = "etudiants";
    render();
  }));
  screen.querySelectorAll("[data-student]").forEach((button) => button.addEventListener("click", () => openStudent(button.dataset.student)));
}

function dashSignature(data) {
  return JSON.stringify({
    programs: sortSchools(data.byProgram).map((item) => item.program),
    statuses: Object.keys(data.counts),
    methods: data.byMethod.map((item) => item.label),
    months: data.forecast.map((item) => item.month),
    debtors: data.debtors.map((item) => item.id),
  });
}

function tickClock() {
  clearTimeout(state.dashClock);
  if (state.screen !== "tableau") return;
  const clock = document.querySelector("#dash-clock");
  if (!clock) return;
  const parts = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Africa/Conakry",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const [slot, type] of [["h", "hour"], ["m", "minute"], ["s", "second"]]) {
    const face = clock.querySelector(`[data-slot="${slot}"] span`);
    if (!face || face.textContent === value[type]) continue;
    if (reduced) {
      face.textContent = value[type];
      continue;
    }
    const card = face.parentElement;
    card.classList.remove("is-flip");
    void card.offsetWidth;
    card.classList.add("is-flip");
    window.setTimeout(() => { face.textContent = value[type]; }, 220);
  }
  state.dashClock = setTimeout(tickClock, 1000);
}

function patchDashboard(root, data, control) {
  const dueBase = Math.max(data.due, 1);
  const rate = Math.min(100, (data.rate.tenths || 0) / 10);
  const countMax = Math.max(...Object.values(data.counts), 1);
  const methodMax = Math.max(...data.byMethod.map((item) => item.amount), 1);
  const forecastMax = Math.max(...data.forecast.map((item) => item.amount), 1);
  const write = (tone, text, width) => {
    const card = root.querySelector(`.dash-kpi.${tone}`);
    if (!card) return;
    card.querySelector(".value").textContent = text;
    card.querySelector(".dash-track i").style.width = `${width}%`;
  };
  write("tone-due", gnf(data.due), 100);
  write("tone-paid", gnf(data.paid), Math.min(100, Math.round(data.paid / dueBase * 100)));
  write("tone-left", gnf(data.reste), Math.min(100, Math.round(data.reste / dueBase * 100)));
  write("tone-rate", data.rate.label, rate);
  const ring = root.querySelector(".donut-value");
  if (ring) ring.style.setProperty("--pct", String(rate));
  const rateLabel = root.querySelector(".donut-label strong");
  if (rateLabel) rateLabel.textContent = data.rate.label;
  const badge = root.querySelector(".coherence");
  if (badge) {
    badge.className = `coherence ${control.ok ? "ok" : "bad"}`;
    badge.textContent = control.ok ? "Cohérence OK" : "Écart de cohérence";
  }
  const count = root.querySelector(".dash-count");
  if (count) count.textContent = String(data.students);
  const plural = root.querySelector(".dash-plural");
  if (plural) plural.textContent = data.students > 1 ? "s" : "";
  for (const item of sortSchools(data.byProgram)) {
    const block = root.querySelector(`[data-program="${CSS.escape(item.program)}"]`);
    if (!block) continue;
    const share = Math.min(100, Math.round(item.paid / Math.max(item.due, 1) * 100));
    block.querySelector(".dash-school-top strong").textContent = `${share} %`;
    block.querySelector(".meter .paid").style.width = `${share}%`;
    const figures = block.querySelectorAll(".figures strong");
    figures[0].textContent = String(item.students || 0);
    figures[1].textContent = gnf(item.paid);
    figures[2].textContent = gnf(item.reste);
    figures[3].textContent = gnf(item.due);
  }
  for (const [status, countValue] of Object.entries(data.counts)) {
    const row = root.querySelector(`.dash-status-row[data-status="${CSS.escape(status)}"]`);
    if (!row) continue;
    row.querySelector("strong").textContent = String(countValue);
    row.querySelector("i").style.width = `${Math.max(countValue ? 8 : 0, Math.round(countValue / countMax * 100))}%`;
  }
  data.byMethod.forEach((item) => {
    const row = root.querySelector(`[data-method="${CSS.escape(item.label)}"]`);
    if (!row) return;
    row.querySelector("strong").textContent = gnf(item.amount);
    row.querySelector(".meter span").style.width = `${Math.max(4, Math.round(item.amount / methodMax * 100))}%`;
  });
  data.forecast.forEach((item) => {
    const row = root.querySelector(`[data-month="${CSS.escape(item.month)}"]`);
    if (!row) return;
    row.querySelector("strong").textContent = gnf(item.amount);
    row.querySelector(".meter span").style.width = `${Math.max(4, Math.round(item.amount / forecastMax * 100))}%`;
  });
  data.debtors.forEach((item) => {
    const row = root.querySelector(`.dash-debtor[data-student="${CSS.escape(String(item.id))}"]`);
    if (!row) return;
    row.querySelector(".who strong").textContent = item.name;
    row.querySelector(".who .muted").textContent = item.program;
    row.querySelector(".due").textContent = gnf(item.reste);
  });
}

function dashboardHtml(data, control) {
  const programs = sortSchools(data.byProgram);
  const rate = Math.min(100, (data.rate.tenths || 0) / 10);
  const circ = (2 * Math.PI * 46).toFixed(2);
  const countMax = Math.max(...Object.values(data.counts), 1);
  const methodMax = Math.max(...data.byMethod.map((item) => item.amount), 1);
  const forecastMax = Math.max(...data.forecast.map((item) => item.amount), 1);
  const dueBase = Math.max(data.due, 1);
  const paidShare = Math.min(100, Math.round(data.paid / dueBase * 100));
  const resteShare = Math.min(100, Math.round(data.reste / dueBase * 100));
  const kpiCard = (label, text, share, tone) => `<article class="dash-kpi ${tone}">
      <button data-go="etudiants" type="button">
        <span class="muted">${label}</span>
        <strong class="value">${text}</strong>
      </button>
      <span class="dash-track" aria-hidden="true"><i style="width:${share}%"></i></span>
    </article>`;
  return `<div class="dash">
    <header class="dash-hero">
      <div>
        <p class="mark">Scolarité · ${esc(frenchDay(data.asOf))}</p>
        <h1>Tableau de bord</h1>
        <p class="dash-lead">
          <time id="dash-clock" class="flip-clock">
            <span class="flip-slot" data-slot="h"><span>--</span></span><span class="flip-sep">:</span>
            <span class="flip-slot" data-slot="m"><span>--</span></span><span class="flip-sep">:</span>
            <span class="flip-slot" data-slot="s"><span>--</span></span>
          </time>
          <span>Conakry · <span class="dash-count">${data.students}</span> étudiant<span class="dash-plural">${data.students > 1 ? "s" : ""}</span></span>
        </p>
      </div>
      <div class="dash-hero-side">
        <div class="donut-wrap">
          <svg class="donut" viewBox="0 0 120 120" role="img" aria-label="Taux de recouvrement ${esc(data.rate.label)}">
            <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1b7a45"/><stop offset="100%" stop-color="#d4a017"/></linearGradient></defs>
            <circle class="donut-track" cx="60" cy="60" r="46"></circle>
            <circle class="donut-value" cx="60" cy="60" r="46" style="--circ:${circ}; --pct:${rate}"></circle>
            <g class="orbit"><circle class="orbit-bead" cx="60" cy="14" r="3.4"></circle></g>
          </svg>
          <div class="donut-label"><strong>${esc(data.rate.label)}</strong><span class="muted">encaissé</span></div>
        </div>
        <span class="coherence ${control.ok ? "ok" : "bad"}">${control.ok ? "Cohérence OK" : "Écart de cohérence"}</span>
      </div>
    </header>
    <div class="info-strip">
      <span>Inscription 20 % · 5 octobre</span>
      <span>2e versement 40 % · 5 décembre</span>
      <span>3e versement 40 % · 5 mars</span>
      ${offerChip("bachelor_1", "Bachelor 1")}
      ${offerChip("bachelor_2", "Bachelor 2")}
      ${offerChip("bachelor_3", "Bachelor 3")}
      ${offerChip("master_1", "Master 1")}
      ${offerChip("master_2", "Master 2")}
      <span>Comptant −5 %</span>
      <span>Boursier : aucun frais</span>
    </div>
    <section class="dash-kpis">
      ${kpiCard("Frais attendus", gnf(data.due), 100, "tone-due")}
      ${kpiCard("Encaissé", gnf(data.paid), paidShare, "tone-paid")}
      ${kpiCard("Reste à payer", gnf(data.reste), resteShare, "tone-left")}
      ${kpiCard("Taux de recouvrement", esc(data.rate.label), rate, "tone-rate")}
    </section>
    <section class="dash-split">
      <article class="card">
        <h2>Encaissements par école</h2>
        ${programs.map((item) => {
          const base = Math.max(item.due, 1);
          const share = Math.min(100, Math.round(item.paid / base * 100));
          return `<section class="dash-school" data-program="${esc(item.program)}">
            <div class="dash-school-top"><h3>${esc(item.program)}</h3><strong>${share} %</strong></div>
            <div class="meter" aria-hidden="true"><span class="paid" style="width:${share}%"></span></div>
            <div class="figures"><p class="muted">Étudiants<strong>${item.students || 0}</strong></p><p class="muted">Encaissé<strong>${gnf(item.paid)}</strong></p><p class="muted">Reste<strong>${gnf(item.reste)}</strong></p><p class="muted">Frais annuels<strong>${gnf(item.due)}</strong></p></div>
          </section>`;
        }).join("")}
      </article>
      <div class="dash-stack">
        <article class="card">
          <h2>Situation des étudiants</h2>
          <div class="dash-status">
            ${Object.entries(data.counts).map(([status, count]) => {
              const width = Math.max(count ? 8 : 0, Math.round(count / countMax * 100));
              const label = state.catalog.statuses.find((item) => item.code === status)?.label || status;
              return `<button class="dash-status-row" data-status="${esc(status)}" type="button">
                <span>${esc(label)}</span>
                <span class="dash-status-bar"><i class="${esc(status)}" style="width:${width}%"></i></span>
                <strong>${count}</strong>
              </button>`;
            }).join("")}
          </div>
        </article>
        <article class="card">
          <h2>Moyens de paiement</h2>
          ${data.byMethod.map((item) => `<div class="method-row" data-method="${esc(item.label)}"><p>${esc(item.label)}<strong>${gnf(item.amount)}</strong></p><div class="meter"><span class="paid" style="width:${Math.max(4, Math.round(item.amount / methodMax * 100))}%"></span></div></div>`).join("") || "<p>Aucun encaissement sur le filtre.</p>"}
        </article>
      </div>
    </section>
    <section class="dash-split">
      <article class="card">
        <h2>Échéances encore ouvertes</h2>
        ${data.forecast.map((item) => `<div class="method-row" data-month="${esc(item.month)}"><p>${esc(monthLabel(item.month))}<strong>${gnf(item.amount)}</strong></p><div class="meter"><span class="left" style="width:${Math.max(4, Math.round(item.amount / forecastMax * 100))}%"></span></div></div>`).join("") || "<p>Aucune échéance future ouverte.</p>"}
      </article>
      <article class="card">
        <h2>Plus gros restes</h2>
        <div class="dash-debtors">${data.debtors.map((item, index) => `<button class="dash-debtor" data-student="${item.id}" type="button">
          <span class="rank">${String(index + 1).padStart(2, "0")}</span>
          <span class="who"><strong>${esc(item.name)}</strong><span class="muted">${esc(item.program)}</span></span>
          <strong class="due">${gnf(item.reste)}</strong>
        </button>`).join("")}</div>
      </article>
    </section>
  </div>`;
}

async function showDashboard(screen) {
  clearInterval(state.dashRefresh);
  clearTimeout(state.dashClock);
  state.dashSignature = "";
  const paint = async () => {
    const [data, control] = await Promise.all([api("/api/tableau"), api("/api/coherence")]);
    if (state.screen !== "tableau") return;
    const signature = dashSignature(data);
    const root = screen.querySelector(".dash");
    if (root && signature === state.dashSignature) {
      patchDashboard(root, data, control);
      return;
    }
    const y = document.scrollingElement ? document.scrollingElement.scrollTop : 0;
    screen.innerHTML = dashboardHtml(data, control);
    bindDashboard(screen);
    state.dashSignature = signature;
    tickClock();
    if (y && document.scrollingElement) document.scrollingElement.scrollTop = y;
  };
  await paint();
  if (state.screen !== "tableau") return;
  state.dashRefresh = setInterval(() => {
    if (state.screen !== "tableau") {
      clearInterval(state.dashRefresh);
      return;
    }
    paint().catch(() => {});
  }, 20000);
}

function kpi(label, value, raw = false) {
  return `<article class="kpi"><button data-go="etudiants" type="button"><span class="muted">${label}</span><p class="value">${raw ? esc(value) : gnf(value)}</p></button></article>`;
}

async function showStudents(screen) {
  const program = state.catalog.programs.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join("");
  screen.innerHTML = `    <div class="top"><div><p class="mark">Registre</p><h1>Étudiants</h1></div>
      <div class="row-actions">${allowed("student.write") ? `<button class="btn secondary" id="link-cards" type="button">Lier les cartes</button>` : ""}<button class="btn" id="new-student" type="button">Nouvelle fiche</button></div></div>
    <div class="filters"><input id="q" placeholder="Nom ou matricule" value="${esc(state.q || "")}">
      <select id="filiere"><option value="">Toutes les écoles</option>${program}</select>
      <select id="niveau"><option value="">Tous les niveaux</option>${(state.catalog.levels || []).map((item) => `<option value="${item.code}">${esc(item.label)}</option>`).join("")}</select>
      <select id="statut"><option value="">Tous les statuts</option>${state.catalog.statuses.map((item) => `<option value="${item.code}" ${state.status === item.code ? "selected" : ""}>${esc(item.label)}</option>`).join("")}</select></div>
    <div id="student-table"></div>
    <dialog id="fiche-dialog" class="sheet" closedby="none"></dialog>`;
  const load = async () => {
    const params = new URLSearchParams({
      q: document.querySelector("#q").value,
      filiere: document.querySelector("#filiere").value,
      niveau: document.querySelector("#niveau").value,
      statut: document.querySelector("#statut").value,
    });
    const data = await api(`/api/etudiants?${params}`);
    const pageSize = 10;
    const pages = Math.max(1, Math.ceil(data.students.length / pageSize));
    if (state.studentPage > pages) state.studentPage = pages;
    const visible = data.students.slice((state.studentPage - 1) * pageSize, state.studentPage * pageSize);
    document.querySelector("#student-table").innerHTML = `<article class="card"><div class="table-scroll"><table><thead><tr><th>Matricule</th><th>Nom</th><th>École</th><th class="num">Frais</th><th class="num">Payé</th><th class="num">Reste</th><th>Statut</th><th>Inscription</th></tr></thead><tbody>
      ${visible.map((student) => `<tr class="clickable" data-student="${student.id}"><td>${esc(student.matricule)}</td><td class="name">${esc(student.name)}</td><td class="school">${esc(student.program)}<br><span class="muted">${esc(levelLabel(student.level))}</span></td><td class="num">${gnf(student.situation.due)}</td><td class="num">${gnf(student.situation.paid)}</td><td class="num">${gnf(student.situation.reste)}${student.situation.credit ? `<br><span class="muted">Crédit ${gnf(student.situation.credit)}</span>` : ""}</td><td><span class="tag ${student.situation.status}">${esc(student.situation.statusLabel)}</span></td><td><button class="btn secondary enroll-btn" type="button" data-enroll="${student.id}">Reçu d'inscription</button></td></tr>`).join("")}
    </tbody></table></div>
      <div class="pager"><button type="button" id="page-prev" ${state.studentPage <= 1 ? "disabled" : ""}>Précédent</button><span>${data.students.length} étudiants · page ${state.studentPage} / ${pages}</span><button type="button" id="page-next" ${state.studentPage >= pages ? "disabled" : ""}>Suivant</button></div>
    </article>`;
    document.querySelectorAll("[data-student]").forEach((row) => row.addEventListener("click", () => openStudent(row.dataset.student)));
    document.querySelectorAll("[data-enroll]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      openEnrollmentReceipt(button.dataset.enroll, button);
    }));
    document.querySelector("#page-prev").addEventListener("click", () => { state.studentPage -= 1; load(); });
    document.querySelector("#page-next").addEventListener("click", () => { state.studentPage += 1; load(); });
  };
  ["q", "filiere", "niveau", "statut"].forEach((id) => document.querySelector(`#${id}`).addEventListener("input", () => { state.studentPage = 1; load(); }));
  document.querySelector("#link-cards")?.addEventListener("click", async () => {
    const button = document.querySelector("#link-cards");
    button.disabled = true;
    try {
      const report = await api("/api/cartes/synchroniser", { method: "POST", body: "{}" });
      const ignored = report.ignored ? ` ${report.ignored} fiche n'a pas pu partir.` : "";
      saved(`${report.sent} matricules liés aux cartes.${ignored}`);
    } catch (error) {
      saved(error.message);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#new-student").addEventListener("click", () => {
    const methods = state.catalog.methods.map((item) => `<option value="${item.code}">${esc(item.label)}</option>`).join("");
    const dialog = document.querySelector("#fiche-dialog");
    dialog.innerHTML = `<form id="create-student" novalidate>
        <div class="dialog-head"><h2>Nouvelle fiche</h2><button class="dialog-close" type="button" id="close-fiche">Fermer</button></div>
        <div class="duo"><p><label>Nom</label><input name="lastName" required autocomplete="off"></p><p><label>Prénom</label><input name="firstName" required autocomplete="off"></p></div>
        <div class="duo"><p><label>École</label><select name="programId" required>${state.catalog.programs.map((item) => `<option value="${item.id}">${esc(item.name)}</option>`).join("")}</select></p>
          <p><label>Niveau</label><select name="level" required><option value="bachelor">Bachelor</option><option value="master">Master</option></select></p></div>
        <p id="year-row"><label id="year-label">Année de bachelor</label><select name="studyYear" required></select></p>
        <p class="muted" id="fee-hint"></p>
        <label class="check"><input type="checkbox" name="scholarship"> Boursier — aucun frais de scolarité</label>
        <label class="check"><input type="checkbox" name="payInFull"> Paiement de toute la scolarité en une fois (−5 %)</label>
        <div class="duo" id="payment-fields"><p><label>Versement du jour (GNF)</label><input name="paymentAmount" inputmode="numeric" required placeholder="0 si aucun versement"></p>
          <p><label>Moyen de paiement</label><select name="method" required>${methods}</select></p></div>
        ${costumeField("Costume versé à l'inscription (GNF)")}
        <p id="create-error" class="error" hidden></p>
        <button class="btn" type="submit">Enregistrer la fiche</button>
      </form>`;
    dialog.showModal();
    document.querySelector("#close-fiche").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    const form = document.querySelector("#create-student");
    const yearOptions = {
      bachelor: [["bachelor_1", "1re année"], ["bachelor_2", "2e année"], ["bachelor_3", "3e année"]],
      master: [["master_1", "1re année"], ["master_2", "2e année"]],
    };
    const schoolingOf = () => {
      const fee = state.catalog.fees.find((item) => item.program_id === Number(form.programId.value) && item.level === form.studyYear.value);
      return fee ? fee.tuition_amount : 0;
    };
    const registrationOf = () => {
      const fees = state.catalog.registrationFees || { bachelor: 0, master: 0 };
      return form.studyYear.value.startsWith("master") ? fees.master : fees.bachelor;
    };
    const tuitionOf = () => (schoolingOf() ? schoolingOf() + registrationOf() : 0);
    const cashOf = (tuition) => tuition - Math.floor((tuition * 5 + 50) / 100);
    const syncFee = () => {
      const track = form.level.value === "master" ? "master" : "bachelor";
      const options = yearOptions[track];
      const previous = form.studyYear.value;
      form.studyYear.innerHTML = options.map(([code, label]) => `<option value="${code}">${label}</option>`).join("");
      if (options.some(([code]) => code === previous)) form.studyYear.value = previous;
      document.querySelector("#year-label").textContent = track === "master" ? "Année de master" : "Année de bachelor";
      const tuition = tuitionOf();
      const cash = cashOf(tuition);
      const scholar = form.scholarship.checked;
      document.querySelector("#fee-hint").textContent = scholar
        ? "Boursier : les frais de scolarité sont à 0 GNF."
        : `Frais annuels : ${gnf(tuition)} (scolarité ${gnf(schoolingOf())} + inscription ${gnf(registrationOf())}). En une fois : ${gnf(cash)} (−5 %).`;
      document.querySelector("#payment-fields").hidden = scholar;
      form.payInFull.disabled = scholar;
      const amount = form.paymentAmount;
      amount.required = !scholar;
      form.method.required = !scholar;
      if (scholar) amount.value = "0";
      else if (form.payInFull.checked) amount.value = grouped(cash);
    };
    form.level.addEventListener("change", syncFee);
    form.studyYear.addEventListener("change", syncFee);
    form.programId.addEventListener("change", syncFee);
    form.scholarship.addEventListener("change", syncFee);
    form.payInFull.addEventListener("change", syncFee);
    form.paymentAmount.addEventListener("input", (event) => {
      if (form.payInFull.checked) return;
      const digits = event.target.value.replace(/[^\d]/g, "");
      event.target.value = digits ? grouped(Number(digits)) : "";
    });
    form.costumeAmount?.addEventListener("input", (event) => {
      const digits = event.target.value.replace(/[^\d]/g, "");
      event.target.value = digits ? grouped(Number(digits)) : "";
    });
    syncFee();
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = document.querySelector("#create-error");
      error.hidden = true;
      const missing = [];
      if (form.lastName.value.trim().length < 2) missing.push("le nom");
      if (form.firstName.value.trim().length < 2) missing.push("le prénom");
      if (!form.programId.value) missing.push("l'école");
      if (!form.level.value) missing.push("le niveau");
      if (!form.studyYear.value) missing.push("l'année");
      if (!form.scholarship.checked && form.paymentAmount.value.trim() === "") missing.push("le versement du jour");
      if (!form.scholarship.checked && !form.method.value) missing.push("le moyen de paiement");
      if (missing.length) {
        error.hidden = false;
        error.textContent = `Renseignez ${missing.join(", ")} avant d'enregistrer.`;
        return;
      }
      if (!form.scholarship.checked) {
        const typed = Number(form.paymentAmount.value.replace(/\D/g, "") || 0);
        const tuition = tuitionOf();
        const limit = form.payInFull.checked ? cashOf(tuition) : tuition;
        if (typed > limit) {
          notifyOverpay(`Le versement du jour (${gnf(typed)}) est supérieur au montant à payer (${gnf(limit)}). La fiche n'a pas été enregistrée.`);
          return;
        }
      }
      const level = form.studyYear.value;
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      try {
        const created = await api("/api/etudiants", { method: "POST", body: JSON.stringify({
          lastName: form.lastName.value,
          firstName: form.firstName.value,
          programId: Number(form.programId.value),
          level,
          scholarship: form.scholarship.checked,
          paymentAmount: form.scholarship.checked ? 0 : form.paymentAmount.value.replace(/\D/g, ""),
          costumeAmount: moneyOf(form.costumeAmount),
          method: form.method.value,
        }) });
        state.freshReceipt = created.enrollmentReceiptId ? { id: created.enrollmentReceiptId, number: created.enrollmentReceiptNumber } : null;
        saved("Fiche enregistrée");
        openStudent(created.student.id);
      } catch (caught) {
        if (caught.data?.code === "AMOUNT_TOO_HIGH") notifyOverpay(caught.message);
        error.hidden = false;
        error.textContent = caught.message;
        button.disabled = false;
      }
    });
  });
  await load();
}

async function openEnrollmentReceipt(studentId, button) {
  const tab = window.open("", "_blank");
  if (button) button.disabled = true;
  try {
    const receipt = await api(`/api/etudiants/${studentId}/inscription`, { method: "POST", body: "{}" });
    const url = `/api/inscriptions/${receipt.id}.pdf`;
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    if (receipt.created) saved(`Reçu d'inscription ${receipt.number} émis`);
    return receipt;
  } catch (caught) {
    tab?.close();
    saved(caught.message);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function openStudent(id) {
  state.studentId = id;
  state.screen = "fiche";
  render();
}

async function showStudent(screen, id) {
  const data = await api(`/api/etudiants/${id}`);
  const student = data.student;
  const situation = data.situation;
  screen.innerHTML = `<div class="top"><div><p class="mark">${esc(student.matricule)}</p><h1>${esc(student.name)}</h1>
      <p>${esc(student.program)} · ${esc(levelLabel(student.level))} · ${esc(student.year)}</p></div>
      <div class="row-actions">
        ${data.enrollment ? `<a class="btn" href="/api/inscriptions/${data.enrollment.id}.pdf" target="_blank">Imprimer le reçu d'inscription ${esc(data.enrollment.number)}</a>` : `<button class="btn" id="issue-enrollment" type="button">Émettre le reçu d'inscription</button>`}
        <button class="btn secondary" id="pay-this" type="button">Encaisser</button>
      </div></div>
    ${state.freshReceipt ? `<div class="banner">Le reçu d'inscription <strong>${esc(state.freshReceipt.number)}</strong> est prêt. Le bouton ci-dessus l'ouvre pour l'impression, autant de fois que vous voulez.</div>` : ""}
    ${state.paymentReceipt ? `<div class="banner">Paiement mis à jour. Nouveau reçu <a href="/api/recus/${state.paymentReceipt.id}.pdf" target="_blank">${esc(state.paymentReceipt.number)}</a>. L'ancien reçu est annulé.</div>` : ""}
    <section class="kpis">${kpi("Frais dus", situation.due)}${kpi("Total payé", situation.paid)}${kpi("Reste", situation.reste)}${kpi("Statut", situation.statusLabel, true)}</section>
    ${data.discounts?.length ? `<p class="banner">${data.discounts.map((item) => esc(item.reason || item.label)).join(" · ")}</p>` : ""}
    <article class="card" style="margin-top:14px"><h2>Paiements</h2>
      <div class="table-scroll"><table><thead><tr><th>Date</th><th class="num">Montant</th><th>Moyen</th><th>Reçu</th><th></th></tr></thead><tbody>
      ${data.payments.map((payment) => `<tr><td>${esc(frenchDay(payment.paid_on))}${payment.date_unconfirmed ? "<br><span class='muted'>Date à confirmer</span>" : ""}</td><td class="num"><strong>${gnf(payment.amount)}</strong></td><td>${esc(state.catalog.methods.find((item) => item.code === payment.method)?.label || payment.method)}${payment.status === "annule" ? `<br><span class="tag trop_percu">Annulé</span>` : ""}</td><td>${payment.receipt_number ? `<a href="/api/recus/${payment.receipt_id}.pdf" target="_blank">${esc(payment.receipt_number)}</a>` : ""}</td><td>${payment.status === "annule" ? esc(payment.cancel_reason || "Annulé") : ""}</td></tr>`).join("")}
      </tbody></table></div></article>
    ${costumeCard(data.costume)}
    <article class="card" style="margin-top:14px"><h2>Échéances couvertes</h2>
      <div class="steps">${situation.plan.map((item, index) => {
        const covered = situation.covered[item.code] || 0;
        const share = item.amount ? Math.min(100, Math.round(covered / item.amount * 100)) : 100;
        const done = covered >= item.amount;
        const late = !done && item.dueOn < new Date().toISOString().slice(0, 10);
        const [tone, label] = done ? ["solde", "Réglée"] : late ? ["en_retard", "En retard"] : covered ? ["partiel", "Partielle"] : ["aucun_paiement", "À venir"];
        return `<div class="step ${done ? "is-done" : late ? "is-late" : ""}" style="animation-delay:${index * 70}ms">
          <span class="step-dot" aria-hidden="true">${done ? "✓" : index + 1}</span>
          <div class="step-body">
            <div class="step-head"><strong>${esc(item.label)}</strong><span class="tag ${tone}">${label}</span></div>
            <p class="muted">Avant le ${esc(frenchDay(item.dueOn))}</p>
            <span class="step-bar" aria-hidden="true"><i style="width:${share}%"></i></span>
            <p class="step-figs"><span>Couvert <strong>${gnf(covered)}</strong></span><span>sur ${gnf(item.amount)}</span></p>
          </div>
        </div>`;
      }).join("")}</div>
      <p class="muted">Carte étudiant : ${esc(labels[student.cardStatus] || student.cardStatus)}. Le même matricule sert à la carte et à la cantine. Une correction ou une annulation se fait dans Encaissement.</p></article>`;
  state.freshReceipt = null;
  state.paymentReceipt = null;
  document.querySelector("#issue-enrollment")?.addEventListener("click", async (event) => {
    if (await openEnrollmentReceipt(id, event.currentTarget)) showStudent(screen, id);
  });
  const costumeForm = document.querySelector("#costume-form");
  if (costumeForm) {
    costumeForm.paidOn.value = new Date().toISOString().slice(0, 10);
    costumeForm.amount.addEventListener("input", (event) => {
      const digits = event.target.value.replace(/[^\d]/g, "");
      event.target.value = digits ? grouped(Number(digits)) : "";
    });
    costumeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = costumeForm.querySelector("[data-costume-error]");
      error.hidden = true;
      const amount = moneyOf(costumeForm.amount);
      if (!amount) {
        error.hidden = false;
        error.textContent = "Indiquez le montant versé pour le costume.";
        return;
      }
      const button = costumeForm.querySelector("[type=submit]");
      button.disabled = true;
      try {
        await api(`/api/etudiants/${id}/costume`, { method: "POST", body: JSON.stringify({
          amount,
          paidOn: costumeForm.paidOn.value,
          method: costumeForm.method.value,
          note: costumeForm.note.value.trim(),
        }) });
        saved("Versement du costume enregistré");
        showStudent(screen, id);
      } catch (caught) {
        if (caught.data?.code === "AMOUNT_TOO_HIGH") notifyOverpay(caught.message);
        error.hidden = false;
        error.textContent = caught.message;
        button.disabled = false;
      }
    });
  }
  document.querySelectorAll("[data-costume-cancel]").forEach((button) => button.addEventListener("click", async () => {
    const reason = window.prompt("Motif de l'annulation de ce versement de costume (au moins 5 caractères) :");
    if (!reason) return;
    try {
      await api(`/api/costumes/${button.dataset.costumeCancel}/annuler`, { method: "POST", body: JSON.stringify({ reason }) });
      saved("Versement du costume annulé");
      showStudent(screen, id);
    } catch (caught) {
      saved(caught.message);
    }
  }));
  document.querySelector("#pay-this").addEventListener("click", () => {
    state.prefillStudent = { ...student, situation };
    state.screen = "paiement";
    state.idempotencyKey = newKey();
    render();
  });
}

function costumeCard(costume) {
  if (!costume) return "";
  const tone = { paye: "solde", partiel: "partiel", non_paye: "en_retard", non_fixe: "aucun_paiement" }[costume.status] || "aucun_paiement";
  const share = costume.price ? Math.min(100, Math.round(costume.paid / costume.price * 100)) : 0;
  const methodLabel = (code) => state.catalog.methods.find((item) => item.code === code)?.label || "—";
  const canPay = allowed("payment.create") && costume.price > 0 && costume.reste > 0;
  return `<article class="card costume-box" style="margin-top:14px">
    <div class="costume-head"><h2>Costume</h2><span class="tag ${tone}">${esc(costume.statusLabel)}</span></div>
    ${costume.price ? `<div class="stat-row">
        <div class="stat-tile"><span>Prix du costume</span><strong>${gnf(costume.price)}</strong></div>
        <div class="stat-tile"><span>Montant versé</span><strong>${gnf(costume.paid)}</strong></div>
        <div class="stat-tile ${costume.reste ? "alert" : ""}"><span>Reste à payer</span><strong>${gnf(costume.reste)}</strong></div>
      </div>
      <span class="step-bar costume-bar" aria-hidden="true"><i style="width:${share}%"></i></span>`
    : `<p class="muted">Le prix du costume n'est pas encore fixé. L'administrateur le règle dans Tarifs.</p>`}
    ${costume.entries.length ? `<div class="table-scroll"><table><thead><tr><th>Date</th><th class="num">Montant</th><th>Moyen</th><th>Reçu</th><th></th></tr></thead><tbody>
      ${costume.entries.map((entry) => `<tr><td class="when-cell">${esc(frenchDay(entry.paid_on))}</td><td class="num"><strong>${gnf(entry.amount)}</strong></td><td>${esc(methodLabel(entry.method))}</td>
        <td>${entry.receipt_number ? `<a href="/api/recus/${entry.receipt_id}.pdf" target="_blank">${esc(entry.receipt_number)}</a>` : `<span class="muted">Saisi sur la fiche</span>`}</td>
        <td>${!entry.counted ? `<span class="tag trop_percu">Annulé</span>${entry.cancel_reason ? ` <span class="muted">${esc(entry.cancel_reason)}</span>` : ""}` : (!entry.payment_id && allowed("payment.cancel") ? `<button class="btn secondary" type="button" data-costume-cancel="${entry.id}">Annuler</button>` : "")}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
    ${canPay ? `<form id="costume-form" class="costume-form" novalidate>
        <p><label>Montant versé pour le costume (GNF)</label><input name="amount" inputmode="numeric" required placeholder="Reste ${esc(grouped(costume.reste))}"></p>
        <p><label>Date</label><input name="paidOn" type="date" required></p>
        <p><label>Moyen de paiement</label><select name="method">${state.catalog.methods.map((item) => `<option value="${item.code}">${esc(item.label)}</option>`).join("")}</select></p>
        <p><label>Observation <span class="muted">(facultatif)</span></label><input name="note" placeholder="Ex. payé avant l'application"></p>
        <button class="btn" type="submit">Enregistrer le versement</button>
        <p class="error" data-costume-error hidden></p>
      </form>
      <p class="muted">Pour qu'il figure sur un reçu de paiement, saisissez plutôt le costume dans Encaissement, avec le versement de scolarité.</p>` : ""}
  </article>`;
}

function openPaymentUpdate(payment, onDone) {
  const dialog = document.querySelector("#update-dialog");
  const methods = state.catalog.methods.map((item) => `<option value="${item.code}" ${item.code === payment.method ? "selected" : ""}>${esc(item.label)}</option>`).join("");
  dialog.innerHTML = `<form id="update-form" novalidate>
      <div class="dialog-head"><h2>Mettre à jour le paiement</h2><button class="dialog-close" id="close-update" type="button">Fermer</button></div>
      <p class="muted">Le montant déjà enregistré${payment.receipt_number ? ` sur ${esc(payment.receipt_number)}` : ""} ne change pas. Le versement du jour s'ajoute, et un nouveau reçu est émis pour ce complément.</p>
      <div id="update-preview" class="receipt-preview"><p class="muted">Calcul du reçu…</p></div>
      <div class="duo"><p><label>Versement du jour à ajouter (GNF)</label><input name="amount" inputmode="numeric" required placeholder="Montant à ajouter"></p>
      <p><label>Date</label><input name="paidOn" type="date" required value="${esc(payment.paid_on)}"></p></div>
      ${costumeField()}
      <label>Moyen de paiement</label><select name="method" required>${methods}</select>
      <label>Référence de transaction <span class="muted">(facultatif)</span></label><input name="reference" placeholder="Numéro de transaction, chèque ou bordereau">
      <label>Observation <span class="muted">(facultatif)</span></label><textarea name="note" placeholder="Motif du versement"></textarea>
      <p id="update-error" class="error" hidden></p>
      <button class="btn" type="submit">Enregistrer la mise à jour</button>
    </form>`;
  dialog.showModal();
  document.querySelector("#close-update").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  const form = document.querySelector("#update-form");
  const key = newKey();
  const paintPreview = (data) => {
    const box = document.querySelector("#update-preview");
    if (!box) return;
    box.innerHTML = `<p><span>Montant dû</span><strong>${gnf(data.due)}</strong></p>
      <p><span>Dernier versement</span><strong>${gnf(data.lastAmount)}</strong></p>
      <p class="today"><span>Versement du jour</span><strong>${gnf(data.todayAmount)}</strong></p>
      <p><span>Déjà versé avant ce jour</span><strong>${gnf(data.paidBefore)}</strong></p>
      <p><span>Cumul versé</span><strong>${gnf(data.paidAfter)}</strong></p>
      <p class="reste"><span>Reste à payer</span><strong>${gnf(data.reste)}</strong></p>
      <p class="seal"><span>Mention du reçu</span><strong>${esc(data.seal)}</strong></p>
      ${data.costume?.price ? `<p><span>Costume (prix ${gnf(data.costume.price)})</span><strong>versé ${gnf(data.costume.paid)} · reste ${gnf(data.costume.reste)}</strong></p>` : ""}
      ${data.limitedMessage ? `<p class="limited">${esc(data.limitedMessage)}</p>` : ""}
      ${data.cashDiscount ? `<p class="muted">Réduction de 5 % : le versement du jour sur le reçu est le prix comptant.</p>` : ""}`;
  };
  const refreshUpdatePreview = async () => {
    const amountValue = Number(form.amount.value.replace(/\D/g, ""));
    if (!amountValue) return;
    try {
      const data = await api(`/api/paiements/${payment.id}/apercu`, { method: "POST", body: JSON.stringify({
        amount: amountValue,
        paidOn: form.paidOn.value,
      }) });
      paintPreview(data);
    } catch (caught) {
      const box = document.querySelector("#update-preview");
      if (box) box.innerHTML = `<p class="error">${esc(caught.message)}</p>`;
    }
  };
  form.amount.addEventListener("input", (event) => {
    const digits = event.target.value.replace(/[^\d]/g, "");
    event.target.value = digits ? grouped(Number(digits)) : "";
    refreshUpdatePreview();
  });
  form.paidOn.addEventListener("change", refreshUpdatePreview);
  form.costumeAmount?.addEventListener("input", (event) => {
    const digits = event.target.value.replace(/[^\d]/g, "");
    event.target.value = digits ? grouped(Number(digits)) : "";
  });
  refreshUpdatePreview();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = document.querySelector("#update-error");
    error.hidden = true;
    const button = form.querySelector("[type=submit]");
    const amountValue = Number(form.amount.value.replace(/\D/g, ""));
    const missing = [];
    if (!amountValue) missing.push("le montant");
    if (!form.paidOn.value) missing.push("la date");
    if (!form.method.value) missing.push("le moyen de paiement");
    if (missing.length) {
      error.hidden = false;
      error.textContent = `Renseignez ${missing.join(", ")} avant d'enregistrer.`;
      return;
    }
    button.disabled = true;
    const payload = {
      amount: amountValue,
      costumeAmount: moneyOf(form.costumeAmount),
      paidOn: form.paidOn.value,
      method: form.method.value,
      reference: form.reference.value.trim(),
      note: form.note.value.trim(),
      idempotencyKey: key,
    };
    try {
      let result;
      try {
        result = await api(`/api/paiements/${payment.id}/mettre-a-jour`, { method: "POST", body: JSON.stringify(payload) });
      } catch (caught) {
        if (caught.data?.code === "DUPLICATE_REFERENCE" && window.confirm("Cette référence existe déjà. Continuer quand même ?")) {
          result = await api(`/api/paiements/${payment.id}/mettre-a-jour`, { method: "POST", body: JSON.stringify({ ...payload, acceptDuplicateReference: true }) });
        } else throw caught;
      }
      dialog.close();
      saved("Versement ajouté");
      if (onDone) onDone(result);
      } catch (caught) {
        if (caught.data?.code === "AMOUNT_TOO_HIGH") notifyOverpay(caught.message);
        error.hidden = false;
        error.textContent = caught.message;
        button.disabled = false;
      }
    });
}

async function loadCashPayments() {
  const box = document.querySelector("#cash-payments");
  if (!box) return;
  const data = await api("/api/caisse/paiements");
  const methodLabel = (code) => state.catalog.methods.find((item) => item.code === code)?.label || code;
  if (!data.payments.length) {
    box.innerHTML = `<div class="empty"><span class="empty-icon" aria-hidden="true">GNF</span><p><strong>Aucun paiement enregistré.</strong></p><p class="muted">Cliquez sur « Ouvrir la caisse » : chaque paiement validé apparaîtra ici avec son reçu, et y restera.</p></div>`;
    return;
  }
  const valid = data.payments.filter((payment) => payment.status === "valide");
  const total = valid.reduce((sum, payment) => sum + payment.amount + Number(payment.costume_amount || 0), 0);
  box.innerHTML = `<div class="cash-tools">
      <input id="cash-search" type="search" placeholder="Nom, matricule ou numéro de reçu" aria-label="Rechercher un encaissement">
      <p class="muted" id="cash-count">${data.payments.length} encaissement${data.payments.length > 1 ? "s" : ""} · ${gnf(total)}</p>
    </div>
    <div class="table-scroll"><table class="cash-table"><thead><tr><th>Date</th><th>Étudiant</th><th class="num">Montant</th><th>Moyen</th><th>Reçu</th><th class="actions">Action</th></tr></thead><tbody>
    ${data.payments.map((payment) => `<tr data-find="${esc(`${payment.name} ${payment.matricule} ${payment.receipt_number || ""}`.toLowerCase())}">
      <td class="when-cell">${esc(frenchDay(payment.paid_on))}</td>
      <td><div class="who-cell"><strong>${esc(payment.name)}</strong><span class="muted">${esc(payment.matricule)}</span></div></td>
      <td class="num">${gnf(payment.amount)}${payment.costume_amount ? `<br><span class="muted">+ costume ${gnf(payment.costume_amount)}</span>` : ""}</td>
      <td>${esc(methodLabel(payment.method))}${payment.status === "annule" ? `<span class="tag trop_percu">Annulé</span>` : ""}</td>
      <td class="receipt">${payment.receipt_number ? `<a href="/api/recus/${payment.receipt_id}.pdf" target="_blank">${esc(payment.receipt_number)}</a>` : ""}</td>
      <td class="actions"><div class="row-actions">${payment.status === "valide" && allowed("payment.create") ? `<button data-update="${payment.id}" class="btn secondary" type="button">Mettre à jour</button>` : ""}</div></td>
    </tr>`).join("")}
  </tbody></table></div>`;
  const search = box.querySelector("#cash-search");
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    box.querySelectorAll("tbody tr").forEach((row) => {
      row.hidden = Boolean(query) && !row.dataset.find.includes(query);
      if (!row.hidden) shown += 1;
    });
    box.querySelector("#cash-count").textContent = query
      ? `${shown} sur ${data.payments.length} encaissements`
      : `${data.payments.length} encaissement${data.payments.length > 1 ? "s" : ""} · ${gnf(total)}`;
  });
  document.querySelectorAll("#cash-payments [data-update]").forEach((button) => button.addEventListener("click", () => {
    const payment = data.payments.find((item) => String(item.id) === button.dataset.update);
    openPaymentUpdate({ ...payment, paid_on: payment.paid_on }, async (result) => {
      const success = document.querySelector("#pay-success");
      if (success && result?.receiptNumber) {
        success.innerHTML = `<div class="banner">Versement ajouté. Nouveau reçu <a href="/api/recus/${result.receiptId}.pdf" target="_blank">${esc(result.receiptNumber)}</a>. Le montant déjà enregistré n'a pas été modifié.</div>`;
      }
      await loadCashPayments();
    });
  }));
}

async function showPayment(screen) {
  screen.innerHTML = `<div class="top"><div><p class="mark">Caisse</p><h1>Enregistrer un paiement</h1>
      <p class="lead">Tous les encaissements restent dans la liste ci-dessous, du plus récent au plus ancien. Une mise à jour ajoute un nouveau versement : le montant déjà enregistré ne change pas.</p></div>
      <button class="btn" id="open-pay" type="button">Ouvrir la caisse</button></div>
    <p id="pay-success"></p>
    <article class="card"><h2>Tous les encaissements</h2><div id="cash-payments"><p class="muted">Chargement…</p></div></article>
    <dialog id="update-dialog" class="sheet" closedby="none"></dialog>
    <dialog id="pay-dialog" class="sheet" closedby="none"><form id="pay-form">
        <div class="dialog-head"><h2>Encaissement</h2><button class="dialog-close" id="close-pay" type="button">Fermer</button></div>
        <label>Étudiant</label><input id="search" placeholder="Nom ou matricule" autocomplete="off" value="${esc(state.prefillStudent?.name || "")}" required>
        <div id="results"></div><input type="hidden" name="studentId" value="${esc(state.prefillStudent?.id || "")}">
        <div id="current"></div>
        <div class="duo"><p><label>Montant (GNF, sans virgule)</label><input name="amount" inputmode="numeric" required></p>
        <p><label>Date</label><input name="paidOn" type="date" required></p></div>
        ${costumeField()}
        <label>Moyen de paiement</label><select name="method" required>${state.catalog.methods.map((item) => `<option value="${item.code}">${esc(item.label)}</option>`).join("")}</select>
        <label>Référence de transaction <span class="muted">(facultatif)</span></label><input name="reference" placeholder="Numéro de transaction, chèque ou bordereau">
        <label>Observation <span class="muted">(facultatif)</span></label><textarea name="note" placeholder="Motif du versement"></textarea>
        <label>Justificatif (image ou PDF, 2 Mo)</label><input name="file" type="file" accept="image/*,application/pdf">
        <div id="preview" class="preview"><p class="muted">Choisissez un étudiant et un montant.</p></div>
        <p id="pay-error" class="error" hidden></p>
        <button class="btn" type="submit">Valider le paiement</button>
      </form></dialog>`;
  const dialog = document.querySelector("#pay-dialog");
  const openPay = () => dialog.showModal();
  document.querySelector("#open-pay").addEventListener("click", openPay);
  document.querySelector("#close-pay").addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  if (state.prefillStudent) openPay();
  await loadCashPayments();
  const date = document.querySelector("[name=paidOn]");
  date.value = new Date().toISOString().slice(0, 10);
  const search = document.querySelector("#search");
  if (state.prefillStudent) showCurrent(state.prefillStudent);
  search.addEventListener("input", async () => {
    const data = await api(`/api/etudiants?q=${encodeURIComponent(search.value)}`);
    document.querySelector("#results").innerHTML = data.students.slice(0, 6).map((student) => `<button type="button" data-pick="${student.id}">${esc(student.name)} · ${esc(student.matricule)} · reste ${gnf(student.situation.reste)}</button>`).join("");
    document.querySelectorAll("[data-pick]").forEach((button) => button.addEventListener("click", async () => {
      const picked = data.students.find((student) => String(student.id) === button.dataset.pick);
      document.querySelector("[name=studentId]").value = picked.id;
      search.value = picked.name;
      document.querySelector("#results").innerHTML = "";
      showCurrent(picked);
      refreshPreview();
    }));
  });
  ["amount", "costumeAmount"].forEach((name) => document.querySelector(`#pay-form [name=${name}]`)?.addEventListener("input", (event) => {
    const digits = event.target.value.replace(/[^\d]/g, "");
    event.target.value = digits ? grouped(Number(digits)) : "";
    refreshPreview();
  }));
  ["paidOn", "method", "reference"].forEach((name) => document.querySelector(`[name=${name}]`).addEventListener("change", refreshPreview));
  document.querySelector("#pay-form").addEventListener("submit", submitPayment);
}

function showCurrent(student) {
  const situation = student.situation;
  if (!situation) {
    document.querySelector("#current").innerHTML = `<div class="preview"><p><strong>${esc(student.name)}</strong> · ${esc(student.matricule)}</p></div>`;
    return;
  }
  document.querySelector("#current").innerHTML = `<div class="preview"><p><strong>${esc(student.name)}</strong> · ${esc(student.matricule)}</p>
    <p>Frais ${gnf(situation.due)} · déjà payé ${gnf(situation.paid)} · reste ${gnf(situation.reste)}</p>
    <p><span class="tag ${situation.status}">${esc(situation.statusLabel)}</span></p></div>`;
}

async function refreshPreview() {
  const studentId = document.querySelector("[name=studentId]").value;
  const amount = Number(document.querySelector("[name=amount]").value.replace(/\D/g, ""));
  const costumeAmount = moneyOf(document.querySelector("#pay-form [name=costumeAmount]"));
  if (!studentId || !amount) return;
  try {
    const data = await api("/api/paiements/apercu", { method: "POST", body: JSON.stringify({
      studentId: Number(studentId), amount, costumeAmount, paidOn: document.querySelector("[name=paidOn]").value,
      reference: document.querySelector("[name=reference]").value,
    }) });
    const costume = data.costume;
    document.querySelector("#preview").innerHTML = `<p>Montant dû : <strong>${gnf(data.after.due)}</strong></p>
      <p>Cumul versé : <strong>${gnf(data.after.paid)}</strong></p>
      <p>Reste après ce paiement : <strong>${gnf(data.after.reste)}</strong></p>
      <p>Statut après : ${esc(data.after.statusLabel)}</p>
      ${costume?.price ? `<p>Costume : prix ${gnf(costume.price)} · déjà versé ${gnf(costume.paid)} · reste après ${gnf(costume.resteAfter)}</p>` : ""}
      ${costume?.today ? `<p>Total encaissé ce jour : <strong>${gnf(amount + costume.today)}</strong></p>` : ""}
      ${data.warnings.map((warning) => `<p class="limited">${esc(warning)}</p>`).join("")}`;
  } catch (error) {
    document.querySelector("#preview").innerHTML = `<p class="error">${esc(error.message)}</p>`;
  }
}

async function submitPayment(event) {
  event.preventDefault();
  const error = document.querySelector("#pay-error");
  error.hidden = true;
  const button = event.target.querySelector("[type=submit]");
  button.disabled = true;
  if (!document.querySelector("[name=studentId]").value) {
    error.hidden = false;
    error.textContent = "Choisissez un étudiant dans la liste.";
    button.disabled = false;
    return;
  }
  const amount = Number(document.querySelector("[name=amount]").value.replace(/\D/g, ""));
  if (!amount) {
    error.hidden = false;
    error.textContent = "Indiquez le montant versé, en francs entiers.";
    button.disabled = false;
    return;
  }
  const file = document.querySelector("[name=file]").files[0];
  let attachment = null;
  if (file) attachment = { dataBase64: await fileToData(file), mime: file.type };
  const payload = {
    studentId: Number(document.querySelector("[name=studentId]").value),
    amount,
    costumeAmount: moneyOf(document.querySelector("#pay-form [name=costumeAmount]")),
    paidOn: document.querySelector("[name=paidOn]").value,
    method: document.querySelector("[name=method]").value,
    reference: document.querySelector("[name=reference]").value.trim(),
    note: document.querySelector("[name=note]").value.trim(),
    idempotencyKey: state.idempotencyKey,
    attachment,
  };
  try {
    let result;
    try {
      result = await api("/api/paiements", { method: "POST", body: JSON.stringify(payload) });
    } catch (caught) {
      if (caught.data?.code === "DUPLICATE_REFERENCE" && window.confirm("Cette référence existe déjà. Continuer quand même ?")) {
        result = await api("/api/paiements", { method: "POST", body: JSON.stringify({ ...payload, acceptDuplicateReference: true }) });
      } else throw caught;
    }
    document.querySelector("#pay-dialog")?.close();
    saved("Paiement enregistré");
    const success = document.querySelector("#pay-success");
    if (success) {
      const costumeNote = result.costume?.today ? ` Costume versé : ${gnf(result.costume.today)}, reste costume ${gnf(result.costume.reste)}.` : "";
      success.innerHTML = `<div class="banner">Paiement enregistré. Reçu <a href="/api/recus/${result.receiptId}.pdf" target="_blank">${esc(result.receiptNumber)}</a>. Reste après paiement : ${gnf(result.after.reste)}. ${result.after.reste <= 0 ? "Mention du reçu : PAYÉ." : "Mention du reçu : ACOMPTE REÇU."}${costumeNote}</div>`;
    }
    const costumeInput = document.querySelector("#pay-form [name=costumeAmount]");
    if (costumeInput) costumeInput.value = "";
    state.idempotencyKey = newKey();
    await loadCashPayments();
  } catch (caught) {
    if (caught.data?.code === "AMOUNT_TOO_HIGH") notifyOverpay(caught.message);
    error.hidden = false;
    error.textContent = caught.message;
  } finally {
    button.disabled = false;
  }
}

function costumePriceSetting() {
  return Number(state.catalog?.settings?.costume_price || 0);
}

function costumeField(label = "Costume versé ce jour (GNF)") {
  const price = costumePriceSetting();
  if (!price) return `<p class="muted costume-hint">Costume : prix non fixé. L'administrateur le règle dans Tarifs.</p>`;
  return `<p class="costume-field"><label>${esc(label)} <span class="muted">(facultatif · prix ${gnf(price)})</span></label><input name="costumeAmount" inputmode="numeric" placeholder="0 si le costume n'est pas payé aujourd'hui"></p>`;
}

function moneyOf(input) {
  return Number(String(input?.value || "").replace(/\D/g, "") || 0);
}

function fileToData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function showJournal(screen) {
  screen.innerHTML = `<div class="top"><div><p class="mark">Caisse</p><h1>Journal du jour</h1>
      <p class="lead">Les encaissements d'une journée, avec leur total de contrôle.</p></div>
      <label class="top-field">Date du journal<input id="journal-date" type="date"></label></div>
    <div id="journal"></div>`;
  const input = document.querySelector("#journal-date");
  input.value = new Date().toISOString().slice(0, 10);
  const load = async () => {
    const data = await api(`/api/journal?date=${input.value}`);
    document.querySelector("#journal").innerHTML = `<div class="stat-row">
        <div class="stat-tile strong"><span>Total encaissé</span><strong>${gnf(data.total)}</strong></div>
        <div class="stat-tile"><span>Paiements</span><strong>${data.count}</strong></div>
        <div class="stat-tile ${data.controlOk ? "ok" : "alert"}"><span>Contrôle</span><strong>${data.controlOk ? "Cohérent" : "Écart"}</strong></div>
        ${data.byMethod.map((item) => `<div class="stat-tile"><span>${esc(item.label)}</span><strong>${gnf(item.amount)}</strong></div>`).join("")}
      </div>
      ${data.unconfirmed ? `<div class="banner">${data.unconfirmed} paiement(s) ont une date à confirmer (import).</div>` : ""}
      <article class="card"><h2>Encaissements</h2>${data.rows.length ? `<div class="table-scroll"><table><thead><tr><th>Reçu</th><th>Étudiant</th><th class="num">Montant</th><th>Agent</th></tr></thead><tbody>
      ${data.rows.map((row) => `<tr><td><span class="tag action">${esc(row.receipt || "—")}</span></td><td class="name"><strong>${esc(row.last_name)}</strong> ${esc(row.first_name)}</td><td class="num"><strong>${gnf(row.amount)}</strong></td><td>${esc(row.agent)}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">GNF</span><p><strong>Aucun encaissement ce jour-là.</strong></p><p class="muted">Choisissez une autre date en haut à droite.</p></div>`}</article>`;
  };
  input.addEventListener("change", load);
  await load();
}

async function showLate(screen) {
  const data = await api("/api/retards");
  const rows = [...data.students].sort((a, b) => b.situation.overdueAmount - a.situation.overdueAmount);
  const overdue = rows.reduce((sum, row) => sum + row.situation.overdueAmount, 0);
  const monogram = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  const card = (row, index) => {
    const due = row.situation.due || 1;
    const ratio = Math.max(8, Math.min(100, Math.round(row.situation.overdueAmount / due * 100)));
    const delay = Math.min(index, 14) * 40;
    const days = row.situation.agingDays || 0;
    const delayLabel = days > 1 ? `${days} jours de retard` : `${days} jour de retard`;
    return `<article class="late-card" style="animation-delay:${delay}ms" data-late="${esc(`${row.student.name} ${row.student.matricule} ${row.student.program}`.toLowerCase())}">
      <header>
        <span class="late-avatar" aria-hidden="true">${esc(monogram(row.student.name))}</span>
        <div>
          <h2>${esc(row.student.name)}</h2>
          <p>${esc(row.student.program || "")}</p>
          <p class="muted">${esc(row.student.matricule)} · ${esc(levelLabel(row.student.level))}</p>
        </div>
        <span class="tag en_retard">${esc(delayLabel)}</span>
      </header>
      <div class="late-figures">
        <p>Reste à payer<strong>${gnf(row.situation.reste)}</strong></p>
        <p class="due">Déjà échu<strong>${gnf(row.situation.overdueAmount)}</strong></p>
      </div>
      <div class="meter" aria-hidden="true"><span class="left" style="width:${ratio}%; animation-delay:${delay + 160}ms"></span></div>
      <p class="late-ratio">${ratio} % de la scolarité est déjà échu</p>
      <label>Message à envoyer</label>
      <textarea readonly>${esc(row.message)}</textarea>
      <div class="row-actions">
        <button class="btn secondary" data-copy="${row.student.id}" type="button">Copier</button>
        <button class="btn" data-log="${row.student.id}" type="button">Noter la relance</button>
      </div>
    </article>`;
  };
  screen.innerHTML = `<div class="top"><div><p class="mark">Communication</p><h1>Étudiants en retard</h1></div></div>
    <section class="late-hero">
      <article class="late-stat">
        <p><span class="pulse" aria-hidden="true"></span> À relancer</p>
        <strong>${rows.length}</strong>
        <span>${rows.length > 1 ? "étudiants ont une échéance dépassée" : "étudiant a une échéance dépassée"}</span>
      </article>
      <article class="late-stat late-stat-gold" style="animation-delay:90ms">
        <p>Impayé déjà échu</p>
        <strong>${gnf(overdue)}</strong>
        <span>Copiez le message, puis notez la relance. Elle reste dans l'historique.</span>
      </article>
    </section>
    ${rows.length ? `<div class="late-tools">
      <input class="late-search" id="late-search" type="search" placeholder="Nom, matricule ou école" aria-label="Filtrer les étudiants en retard">
      <p class="muted" id="late-count">${rows.length} fiche${rows.length > 1 ? "s" : ""}</p>
    </div>
    <p class="late-none" id="late-none" hidden>Aucun étudiant ne correspond à cette recherche.</p>
    <div class="late-grid" id="late-grid">${rows.map(card).join("")}</div>` : `<article class="late-card late-empty"><h2>Personne en retard</h2><p>Toutes les échéances ouvertes sont à jour.</p></article>`}`;
  const search = document.querySelector("#late-search");
  const count = document.querySelector("#late-count");
  const none = document.querySelector("#late-none");
  search?.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll(".late-card").forEach((item) => {
      const show = !query || item.dataset.late.includes(query);
      item.hidden = !show;
      if (show) visible += 1;
    });
    if (count) count.textContent = query ? `${visible} fiche${visible > 1 ? "s" : ""} sur ${rows.length}` : `${rows.length} fiche${rows.length > 1 ? "s" : ""}`;
    if (none) none.hidden = visible !== 0;
  });
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    const text = button.closest(".late-card").querySelector("textarea").value;
    button.textContent = "Copié";
    button.classList.add("is-done");
    try { await navigator.clipboard.writeText(text); } catch { /* la copie peut être refusée par le navigateur */ }
  }));
  document.querySelectorAll("[data-log]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await api("/api/relances", { method: "POST", body: JSON.stringify({ studentId: Number(button.dataset.log), channel: "copie" }) });
      button.textContent = "Notée";
      button.classList.add("is-done");
      button.closest(".late-card").classList.add("is-noted");
      saved("Relance notée");
    } catch (caught) {
      button.disabled = false;
      button.textContent = caught.message;
    }
  }));
}

async function showAudit(screen) {
  const data = await api("/api/audit");
  const when = (value) => {
    const [day, time] = String(value || "").split(" ");
    return `<span class="when"><strong>${esc(frenchDay(day))}</strong><span class="muted">${esc((time || "").slice(0, 5))}</span></span>`;
  };
  const refused = data.logins.filter((entry) => !entry.success).length;
  screen.innerHTML = `<div class="top"><div><p class="mark">Contrôle</p><h1>Journal d'audit</h1>
      <p class="lead">Chaque action enregistrée dans l'application, avec son auteur et son heure.</p></div></div>
    <div class="stat-row">
      <div class="stat-tile"><span>Actions récentes</span><strong>${data.entries.length}</strong></div>
      <div class="stat-tile"><span>Connexions</span><strong>${data.logins.length}</strong></div>
      <div class="stat-tile ${refused ? "alert" : ""}"><span>Connexions refusées</span><strong>${refused}</strong></div>
    </div>
    <article class="card"><h2>Actions</h2>${data.entries.length ? `<div class="table-scroll"><table><thead><tr><th>Quand</th><th>Qui</th><th>Action</th><th>Élément</th></tr></thead><tbody>
    ${data.entries.map((entry) => `<tr><td>${when(entry.created_at)}</td><td><span class="who-chip">${esc(entry.user_name || "—")}</span></td><td><span class="tag action">${esc(entry.action)}</span></td><td class="muted">${esc(entry.entity)} ${esc(entry.entity_id || "")}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><p>Aucune action pour le moment.</p></div>`}</article>
    <article class="card"><h2>Connexions</h2>${data.logins.length ? `<div class="table-scroll"><table><thead><tr><th>Quand</th><th>Compte</th><th>Résultat</th></tr></thead><tbody>
    ${data.logins.map((entry) => `<tr><td>${when(entry.created_at)}</td><td>${esc(entry.email)}</td><td><span class="tag ${entry.success ? "solde" : "en_retard"}">${entry.success ? "Réussie" : "Refusée"}</span></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="empty"><span class="empty-icon" aria-hidden="true">✓</span><p>Aucune connexion enregistrée.</p></div>`}</article>`;
}

const FINANCE_RIGHTS = ["dashboard.read", "student.read", "student.write", "student.status", "payment.create", "payment.cancel", "receipt.read", "reminder.create", "report.read", "audit.read", "fee.write", "settings.write"];
const PASSWORD_RULE = "Au moins 6 caractères, avec une majuscule, une minuscule, un chiffre et un caractère spécial.";

function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

function accountAreas(account) {
  const rights = account.rights || [];
  if (account.role === "super_admin" || rights.includes("*")) return ["all"];
  const areas = [];
  if (rights.some((code) => FINANCE_RIGHTS.includes(code))) areas.push("finance");
  if (rights.includes("cards.manage")) areas.push("cards");
  if (rights.includes("kitchen.manage")) areas.push("kitchen");
  return areas;
}

function areaPills(account) {
  const names = { all: "Tous les droits", finance: "Finances", cards: "Cartes", kitchen: "Cuisine" };
  const areas = accountAreas(account);
  if (!areas.length) return `<span class="acc-pill none">Aucun accès</span>`;
  return areas.map((area) => `<span class="acc-pill ${area}">${names[area]}</span>`).join("");
}

function roleBadge(account) {
  const code = account.role === "super_admin" ? "super" : account.role === "admin" ? "admin" : "staff";
  return `<span class="acc-role ${code}">${esc(account.roleLabel || "Compte")}</span>`;
}

function askConfirm(title, message, action) {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "sheet notice acc-confirm";
    dialog.setAttribute("closedby", "none");
    dialog.innerHTML = `<form method="dialog">
        <div class="dialog-head"><h2>${esc(title)}</h2><button class="dialog-close" type="button" data-no>Fermer</button></div>
        <p>${esc(message)}</p>
        <div class="acc-foot"><span></span><div class="acc-foot-right"><button class="btn secondary" type="button" data-no>Garder le compte</button><button class="btn" type="button" data-yes>${esc(action)}</button></div></div>
      </form>`;
    document.body.appendChild(dialog);
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.querySelectorAll("[data-no]").forEach((button) => button.addEventListener("click", () => finish(false)));
    dialog.querySelector("[data-yes]").addEventListener("click", () => finish(true));
    dialog.showModal();
  });
}

async function showAccounts(screen) {
  const manager = allowed("user.write");
  const creator = state.user.role === "super_admin";
  const data = manager ? await api("/api/utilisateurs") : { users: [], rights: [] };
  const me = data.users.find((account) => account.id === state.user.id)
    || { id: state.user.id, name: state.user.name, email: state.user.email, role: state.user.role, roleLabel: state.user.role === "super_admin" ? "Super admin" : "Compte", rights: state.user.rights || [] };
  const count = (area) => data.users.filter((account) => {
    const areas = accountAreas(account);
    return areas.includes("all") || areas.includes(area);
  }).length;

  const meCard = `<aside class="acc-me">
      <div class="acc-me-head">
        <span class="acc-avatar big">${esc(initials(me.name))}</span>
        <div><p class="mark">Mon compte</p><h2>${esc(me.name || "")}</h2><p class="acc-mail">${esc(me.email || "")}</p></div>
      </div>
      <div class="acc-me-tags">${roleBadge(me)}${areaPills(me)}</div>
      <form id="my-password" class="acc-me-form">
        <h3>Changer mon mot de passe</h3>
        <label>Mot de passe actuel<input name="current" type="password" autocomplete="current-password" required></label>
        <label>Nouveau mot de passe<input name="next" type="password" autocomplete="new-password" required></label>
        <label>Confirmer le nouveau<input name="confirm" type="password" autocomplete="new-password" required></label>
        <p class="acc-hint">${PASSWORD_RULE}</p>
        <p class="error" data-me-error hidden></p>
        <button class="btn" type="submit">Mettre à jour</button>
      </form>
    </aside>`;

  const rows = data.users.map((account) => {
    const mine = account.id === state.user.id;
    const locked = account.role === "super_admin" && !creator;
    const search = `${account.name} ${account.email}`.toLowerCase();
    return `<li class="acc-row${mine ? " is-me" : ""}" data-search="${esc(search)}" data-areas="${accountAreas(account).join(" ")}">
        <span class="acc-avatar">${esc(initials(account.name))}</span>
        <div class="acc-id"><strong>${esc(account.name)}${mine ? ` <span class="acc-you">Vous</span>` : ""}</strong><span class="acc-mail">${esc(account.email)}</span></div>
        <div class="acc-tags">${roleBadge(account)}</div>
        <div class="acc-tags">${areaPills(account)}</div>
        <div class="acc-action">${mine ? `<span class="acc-note">Votre compte</span>` : locked ? `<span class="acc-note">Protégé</span>` : `<button class="acc-manage" type="button" data-manage="${account.id}">Gérer</button>`}</div>
      </li>`;
  }).join("");

  screen.innerHTML = `<section class="acc">
    <header class="acc-hero">
      <div>
        <p class="mark">Administration</p>
        <h1>Comptes</h1>
        <p class="acc-lead">${manager ? "Tous les comptes de l'application, au même endroit : création, autorisations, mise à jour et suppression." : "Votre compte et votre mot de passe."}</p>
      </div>
      ${creator ? `<button class="btn acc-add" type="button" id="add-account"><span aria-hidden="true">+</span> Nouveau compte</button>` : ""}
    </header>
    ${manager ? `<div class="acc-stats">
      <div class="acc-stat"><span>Comptes actifs</span><strong>${data.users.length}</strong></div>
      <div class="acc-stat finance"><span>Accès finances</span><strong>${count("finance")}</strong></div>
      <div class="acc-stat cards"><span>Accès cartes</span><strong>${count("cards")}</strong></div>
      <div class="acc-stat kitchen"><span>Accès cuisine</span><strong>${count("kitchen")}</strong></div>
    </div>` : ""}
    <p id="account-error" class="error" hidden></p>
    <div class="acc-layout${manager ? "" : " solo"}">
      ${manager ? `<div class="acc-main">
        <div class="acc-toolbar">
          <input type="search" id="acc-search" placeholder="Rechercher un nom ou un e-mail" aria-label="Rechercher un compte">
          <div class="acc-seg" role="group" aria-label="Filtrer">
            <button type="button" class="on" data-area="">Tous</button>
            <button type="button" data-area="finance">Finances</button>
            <button type="button" data-area="cards">Cartes</button>
            <button type="button" data-area="kitchen">Cuisine</button>
          </div>
        </div>
        <ul class="acc-list">${rows}</ul>
        <p class="acc-empty" hidden>Aucun compte ne correspond.</p>
        <p class="acc-foot-note">Chaque e-mail se termine par @univ-africaiim.com. ${creator ? "Vous seul créez les comptes ; le mot de passe provisoire est changé à la première connexion." : "Seul le super admin crée un compte."}</p>
      </div>` : ""}
      ${meCard}
    </div>
  </section>`;

  const myForm = document.querySelector("#my-password");
  myForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const box = myForm.querySelector("[data-me-error]");
    box.hidden = true;
    const show = (message) => { box.hidden = false; box.textContent = message; };
    if (myForm.next.value !== myForm.confirm.value) return show("Les deux nouveaux mots de passe ne sont pas identiques.");
    const weak = passwordIssue(myForm.next.value);
    if (weak) return show(weak);
    try {
      await api("/api/compte/mot-de-passe", { method: "POST", body: JSON.stringify({ current: myForm.current.value, next: myForm.next.value }) });
      myForm.reset();
      saved("Mot de passe changé");
    } catch (caught) { show(caught.message); }
  });

  if (!manager) return;

  let area = "";
  const search = document.querySelector("#acc-search");
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    document.querySelectorAll(".acc-row").forEach((row) => {
      const areas = row.dataset.areas.split(" ");
      const ok = (!query || row.dataset.search.includes(query)) && (!area || areas.includes(area) || areas.includes("all"));
      row.hidden = !ok;
      if (ok) shown += 1;
    });
    document.querySelector(".acc-empty").hidden = shown > 0;
  };
  search.addEventListener("input", filter);
  document.querySelectorAll(".acc-seg button").forEach((button) => button.addEventListener("click", () => {
    area = button.dataset.area;
    document.querySelectorAll(".acc-seg button").forEach((item) => item.classList.toggle("on", item === button));
    filter();
  }));

  document.querySelector("#add-account")?.addEventListener("click", () => openAccountDialog(screen, data, null, creator));
  document.querySelectorAll("[data-manage]").forEach((button) => button.addEventListener("click", () => {
    const account = data.users.find((item) => String(item.id) === button.dataset.manage);
    if (account) openAccountDialog(screen, data, account, creator);
  }));
}

function openAccountDialog(screen, data, account, creator) {
  const creating = !account;
  const selected = account ? account.rights : [];
  const isSuper = account?.role === "super_admin";
  const has = (code) => selected.includes("*") || selected.includes(code);
  const labels = new Map(data.rights.map((right) => [right.code, right.label]));
  const financeList = FINANCE_RIGHTS.filter((code) => labels.has(code));
  const otherList = data.rights.map((right) => right.code)
    .filter((code) => !FINANCE_RIGHTS.includes(code) && !["cards.manage", "kitchen.manage", "import.run"].includes(code));
  const check = (code) => `<label class="acc-check"><input type="checkbox" name="right" value="${esc(code)}" ${has(code) ? "checked" : ""}><span>${esc(labels.get(code) || code)}</span></label>`;
  const switchTile = (code, title, text, tone) => `<label class="acc-tile ${tone}">
      <span class="acc-tile-text"><strong>${title}</strong><small>${text}</small></span>
      <input class="acc-switch" type="checkbox" name="right" value="${code}" ${has(code) ? "checked" : ""}>
    </label>`;

  const dialog = document.createElement("dialog");
  dialog.className = "sheet acc-dialog";
  dialog.setAttribute("closedby", "none");
  dialog.innerHTML = `<form novalidate>
      <div class="acc-dialog-head">
        <span class="acc-avatar big">${creating ? "+" : esc(initials(account.name))}</span>
        <div><p class="mark">${creating ? "Nouveau compte" : "Gérer le compte"}</p><h2>${creating ? "Créer un accès" : esc(account.name)}</h2>${creating ? "" : `<p class="acc-mail">${esc(account.email)}</p>`}</div>
        <button class="dialog-close" type="button" data-close>Fermer</button>
      </div>

      <section class="acc-section">
        <h3><span>1</span> Identité</h3>
        <div class="acc-grid">
          <label>Nom complet<input name="fullName" value="${esc(account?.name || "")}" placeholder="Prénom Nom" required></label>
          <label>E-mail professionnel<input name="email" type="email" value="${esc(account?.email || "")}" placeholder="prenom.nom@univ-africaiim.com" required></label>
        </div>
      </section>

      <section class="acc-section">
        <h3><span>2</span> Autorisations</h3>
        ${creator ? `<label class="acc-tile gold acc-super">
            <span class="acc-tile-text"><strong>Super admin</strong><small>Tous les droits, y compris la création des comptes.</small></span>
            <input class="acc-switch" type="checkbox" name="superAdmin" ${isSuper ? "checked" : ""}>
          </label>` : ""}
        <div class="acc-areas">
          <div class="acc-tile finance acc-finance">
            <label class="acc-tile-row">
              <span class="acc-tile-text"><strong>Finances</strong><small>Toute la finance d'un seul geste, ou page par page.</small></span>
              <span class="acc-count" data-finance-count></span>
              <input class="acc-switch" type="checkbox" data-all-finance>
            </label>
            <div class="acc-checks">${financeList.map(check).join("")}</div>
          </div>
          ${switchTile("cards.manage", "Gestion des cartes", "Étudiants, atelier, impression, import et contrôle.", "cards")}
          ${switchTile("kitchen.manage", "Cuisine", "Cantine, menus et commandes.", "kitchen")}
          ${otherList.length ? `<div class="acc-tile other"><span class="acc-tile-text"><strong>Autres autorisations</strong></span><div class="acc-checks">${otherList.map(check).join("")}</div></div>` : ""}
        </div>
      </section>

      <section class="acc-section">
        <h3><span>3</span> Mot de passe</h3>
        <label>${creating ? "Mot de passe provisoire" : "Nouveau mot de passe provisoire"} ${creating ? "" : `<em>facultatif</em>`}
          <span class="acc-pass"><input name="password" type="password" autocomplete="new-password" placeholder="${creating ? "" : "Laisser vide pour ne pas le changer"}" ${creating ? "required" : ""}><button type="button" data-eye>Afficher</button></span>
        </label>
        <p class="acc-hint">${PASSWORD_RULE} ${creating ? "La personne le changera à sa première connexion." : "La personne devra le changer à sa prochaine connexion."}</p>
      </section>

      <p class="error" data-dialog-error hidden></p>
      <div class="acc-foot">
        ${creating ? "<span></span>" : `<button class="acc-delete" type="button" data-delete>Supprimer le compte</button>`}
        <div class="acc-foot-right">
          <button class="btn secondary" type="button" data-close>Fermer</button>
          <button class="btn" type="submit">${creating ? "Créer le compte" : "Enregistrer"}</button>
        </div>
      </div>
    </form>`;
  document.body.appendChild(dialog);
  const form = dialog.querySelector("form");
  const box = dialog.querySelector("[data-dialog-error]");
  const fail = (message) => { box.hidden = false; box.textContent = message; box.scrollIntoView({ block: "nearest" }); };
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.addEventListener("cancel", (event) => event.preventDefault());
  dialog.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", close));

  const master = dialog.querySelector("[data-all-finance]");
  const financeItems = [...dialog.querySelectorAll(".acc-finance .acc-checks input")];
  const counter = dialog.querySelector("[data-finance-count]");
  const syncFinance = () => {
    const on = financeItems.filter((input) => input.checked).length;
    master.checked = on === financeItems.length;
    master.indeterminate = on > 0 && on < financeItems.length;
    counter.textContent = `${on}/${financeItems.length}`;
    dialog.querySelector(".acc-finance").classList.toggle("is-on", on > 0);
  };
  master.addEventListener("change", () => {
    financeItems.forEach((input) => { input.checked = master.checked; });
    syncFinance();
  });
  financeItems.forEach((input) => input.addEventListener("change", syncFinance));
  syncFinance();

  const superBox = dialog.querySelector("[name=superAdmin]");
  const syncSuper = () => dialog.querySelector(".acc-areas").classList.toggle("is-all", Boolean(superBox?.checked));
  superBox?.addEventListener("change", syncSuper);
  syncSuper();

  const eye = dialog.querySelector("[data-eye]");
  eye.addEventListener("click", () => {
    const input = form.password;
    input.type = input.type === "password" ? "text" : "password";
    eye.textContent = input.type === "password" ? "Afficher" : "Masquer";
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    box.hidden = true;
    const password = form.password.value;
    if (form.fullName.value.trim().length < 3) return fail("Indiquez le nom complet.");
    if (!/@univ-africaiim\.com$/i.test(form.email.value.trim())) return fail("L'e-mail doit se terminer par @univ-africaiim.com.");
    if (creating || password) {
      const weak = passwordIssue(password);
      if (weak) return fail(weak);
    }
    const rights = [...form.querySelectorAll("input[name=right]:checked")].map((input) => input.value);
    const superAdmin = Boolean(superBox?.checked);
    if (!superAdmin && !rights.length) return fail("Activez au moins une partie : Finances, Gestion des cartes ou Cuisine.");
    const body = { fullName: form.fullName.value.trim(), email: form.email.value.trim(), superAdmin, rights, password };
    const submit = form.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      if (creating) await api("/api/utilisateurs", { method: "POST", body: JSON.stringify(body) });
      else await api(`/api/utilisateurs/${account.id}`, { method: "PUT", body: JSON.stringify(body) });
      close();
      saved(creating ? "Compte créé" : password ? "Compte mis à jour, mot de passe provisoire remis" : "Compte mis à jour");
      showAccounts(screen);
    } catch (caught) {
      submit.disabled = false;
      fail(caught.message);
    }
  });

  dialog.querySelector("[data-delete]")?.addEventListener("click", async () => {
    const ok = await askConfirm("Supprimer le compte", `${account.name} ne pourra plus se connecter. Les reçus et le journal gardent son nom.`, "Supprimer");
    if (!ok) return;
    try {
      await api(`/api/utilisateurs/${account.id}`, { method: "DELETE" });
      close();
      saved("Compte supprimé");
      showAccounts(screen);
    } catch (caught) { fail(caught.message); }
  });

  dialog.showModal();
}

function offerChip(level, title) {
  const amounts = [...new Set((state.catalog.fees || []).filter((fee) => fee.level === level).map((fee) => fee.tuition_amount))];
  if (amounts.length === 1) return `<span>${title} ${gnf(amounts[0])}</span>`;
  if (!amounts.length) return "";
  return `<span>${title} selon l'école</span>`;
}

function showSettings(screen) {
  const settings = state.catalog.settings;
  const offerLevels = ["bachelor_1", "bachelor_2", "bachelor_3", "master_1", "master_2"];
  const yearHeads = ["1re année", "2e année", "3e année", "1re année", "2e année"];
  const francs = (amount) => grouped(amount);
  screen.innerHTML = `<div class="top"><div><p class="mark">Scolarité</p><h1>Tarifs des programmes</h1>
      <p class="lead">Scolarité annuelle en francs guinéens, répartie en 20 % le 5 octobre, 40 % le 5 décembre et 40 % le 5 mars. Les fiches Bachelor et Master déjà créées suivent le nouveau tarif.</p></div></div>
    <div class="stat-row">
      <div class="stat-tile"><span>Inscription Licence et Bachelor</span><strong>${gnf(state.catalog.registrationFees?.bachelor || 0)}</strong></div>
      <div class="stat-tile"><span>Inscription Master</span><strong>${gnf(state.catalog.registrationFees?.master || 0)}</strong></div>
      <div class="stat-tile alert"><span>Inscription due en entier le</span><strong>5 octobre</strong></div>
      <div class="stat-tile"><span>Costume (prix unique)</span><strong>${Number(settings.costume_price) ? gnf(Number(settings.costume_price)) : "Non fixé"}</strong></div>
    </div>
    <article class="card costume-card">
      <form id="costume-price">
        <div><h2>Prix du costume</h2>
          <p class="muted">Même prix pour tous les étudiants, suivi à part de la scolarité. Le versement se saisit à l'encaissement ou sur la fiche de l'étudiant, et figure sur le reçu de paiement.</p></div>
        <div class="costume-row">
          <p><label>Prix du costume (GNF)</label><input name="costume_price" inputmode="numeric" required value="${Number(settings.costume_price) ? grouped(Number(settings.costume_price)) : ""}" placeholder="Ex. 500.000"></p>
          <button class="btn" type="submit">Enregistrer le prix</button>
        </div>
        <p class="error" data-costume-error hidden></p>
      </form>
    </article>
    <article class="card fee-board">
      <form id="fees">
        <div class="table-scroll">
          <table class="fee-table">
            <thead>
              <tr class="fee-group">
                <th></th>
                <th colspan="3">Bachelor</th>
                <th colspan="2">Master</th>
              </tr>
              <tr>
                <th>École</th>
                ${yearHeads.map((year) => `<th class="num">${year}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${state.catalog.programs.map((program) => `<tr>
                <th scope="row">${esc(program.name)}</th>
                ${offerLevels.map((level) => {
                  const fee = state.catalog.fees.find((item) => item.program_id === program.id && item.level === level);
                  const caption = `${program.name}, ${labels[level]}`;
                  return `<td><input name="tuition" data-fee="${fee?.id || ""}" data-label="${esc(caption)}" inputmode="numeric" required aria-label="${esc(caption)}" value="${fee ? francs(fee.tuition_amount) : ""}"></td>`;
                }).join("")}
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="fee-foot">
          <p class="muted" data-split>Cliquez un montant pour voir sa répartition 20 % / 40 % / 40 %.</p>
          <button class="btn" type="submit">Enregistrer</button>
        </div>
        <p class="error" data-fee-error hidden></p>
      </form>
    </article>
    <details class="card settings-card">
      <summary>Établissement</summary>
      <div>
        <form id="settings">
          <h2>Établissement</h2>
          <div class="settings-grid">
            <p><label>Nom</label><input name="school_name" value="${esc(settings.school_name)}"></p>
            <p><label>Ville</label><input name="school_city" value="${esc(settings.school_city)}"></p>
            <p><label>Adresse</label><input name="school_address" value="${esc(settings.school_address)}"></p>
            <p><label>Téléphone</label><input name="school_phone" value="${esc(settings.school_phone)}"></p>
            <p><label>E-mail</label><input name="school_email" value="${esc(settings.school_email || "")}"></p>
            <p><label>Site</label><input name="school_web" value="${esc(settings.school_web || "")}"></p>
            <p><label>Seuil de limitation de la carte (GNF)</label><input name="card_threshold" value="${esc(settings.card_threshold)}"></p>
          </div>
          <button class="btn" type="submit">Enregistrer</button>
        </form>
      </div>
    </details>`;
  const splitText = (amount) => {
    const inscription = Math.floor((amount * 20 + 50) / 100);
    const december = Math.floor((amount * 40 + 50) / 100);
    const march = amount - inscription - december;
    return `20 % : ${gnf(inscription)} · 40 % : ${gnf(december)} · 40 % : ${gnf(march)}`;
  };
  const fees = document.querySelector("#fees");
  const hint = fees.querySelector("[data-split]");
  const showSplit = (input) => {
    const digits = input.value.replace(/[^\d]/g, "");
    const amount = Number(digits);
    hint.textContent = amount
      ? `${input.dataset.label} — ${splitText(amount)}`
      : "Cliquez un montant pour voir sa répartition 20 % / 40 % / 40 %.";
  };
  fees.addEventListener("input", (event) => {
    if (!event.target.matches("[data-fee]")) return;
    const digits = event.target.value.replace(/[^\d]/g, "");
    event.target.value = digits ? grouped(Number(digits)) : "";
    showSplit(event.target);
  });
  fees.addEventListener("focusin", (event) => {
    if (event.target.matches("[data-fee]")) showSplit(event.target);
  });
  fees.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = fees.querySelector("[data-fee-error]");
    error.hidden = true;
    const button = fees.querySelector("[type=submit]");
    button.disabled = true;
    try {
      for (const input of fees.querySelectorAll("[data-fee]")) {
        const tuition = Number(input.value.replace(/\D/g, ""));
        if (!input.dataset.fee || !tuition) throw new Error("Chaque tarif doit être un montant entier supérieur à zéro.");
        const current = state.catalog.fees.find((fee) => String(fee.id) === input.dataset.fee);
        if (current && current.tuition_amount === tuition) continue;
        await api(`/api/baremes/${input.dataset.fee}`, { method: "PUT", body: JSON.stringify({ tuition }) });
      }
      state.catalog = null;
      saved("Tarifs enregistrés");
      render();
    } catch (caught) {
      error.hidden = false;
      error.textContent = caught.message;
      button.disabled = false;
    }
  });
  const costumeForm = document.querySelector("#costume-price");
  costumeForm.costume_price.addEventListener("input", (event) => {
    const digits = event.target.value.replace(/[^\d]/g, "");
    event.target.value = digits ? grouped(Number(digits)) : "";
  });
  costumeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const error = costumeForm.querySelector("[data-costume-error]");
    error.hidden = true;
    const price = Number(costumeForm.costume_price.value.replace(/\D/g, ""));
    if (!price) {
      error.hidden = false;
      error.textContent = "Indiquez le prix du costume, en francs entiers.";
      return;
    }
    try {
      await api("/api/parametres", { method: "PUT", body: JSON.stringify({ costume_price: price }) });
      state.catalog = null;
      saved("Prix du costume enregistré");
      render();
    } catch (caught) {
      error.hidden = false;
      error.textContent = caught.message;
    }
  });
  document.querySelector("#settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/parametres", { method: "PUT", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
    state.catalog = null;
    saved("Établissement enregistré");
    render();
  });
}

boot();
