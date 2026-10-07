(() => {
  const path = location.pathname.replace(/^\/portail\/cartes/, "") || "/";
  const section = path.startsWith("/cantine") ? "Cuisine" : path.startsWith("/securite") ? "Contrôle" : "Cartes étudiantes";

  function buildHero() {
    const title = document.querySelector("main h1");
    if (!title || title.closest(".pc-hero")) return null;
    const parent = title.parentElement;
    if (parent.matches(".impression-entete")) {
      parent.classList.add("pc-hero");
      const text = document.createElement("div");
      text.className = "pc-hero-text";
      while (parent.firstChild) text.append(parent.firstChild);
      parent.append(text);
      return parent;
    }
    const hero = document.createElement("header");
    hero.className = "pc-hero";
    const text = document.createElement("div");
    text.className = "pc-hero-text";
    hero.append(text);
    parent.insertBefore(hero, title);
    const before = hero.previousElementSibling;
    if (before?.matches(".surtitre")) text.append(before);
    else {
      const mark = document.createElement("p");
      mark.className = "pc-mark";
      mark.textContent = section;
      text.append(mark);
    }
    text.append(title);
    let actions = null;
    let next = hero.nextElementSibling;
    while (next && (next.matches("p.intro") || (next.matches("p.actions") && !actions))) {
      const current = next;
      next = next.nextElementSibling;
      if (current.matches("p.actions")) actions = current;
      else text.append(current);
    }
    if (!actions) actions = [...parent.children].slice(0, 8).find((item) => item.matches("p.actions"));
    if (actions) hero.append(actions);
    return hero;
  }

  function stats(after, items) {
    if (!after || !items.length) return;
    const row = document.createElement("div");
    row.className = "pc-stats";
    row.innerHTML = items.map(([label, value, tone]) => `<div class="pc-stat ${tone || ""}"><span>${label}</span><strong>${value}</strong></div>`).join("");
    after.after(row);
  }

  function studentsPage(hero) {
    const rows = [...document.querySelectorAll("table tbody tr")].filter((row) => row.cells.length > 2);
    if (!rows.length) return;
    const valid = rows.filter((row) => row.querySelector(".pastille-active")).length;
    const photo = rows.filter((row) => row.cells[row.cells.length - 1].textContent.trim() === "Oui").length;
    stats(hero, [
      ["Étudiants affichés", rows.length, "strong"],
      ["Cartes valides", valid],
      ["Avec photo", photo],
      ["Photo manquante", rows.length - photo, "gold"],
    ]);
  }

  function journalPage(hero) {
    const rows = [...document.querySelectorAll("table tbody tr")].filter((row) => row.cells.length > 2);
    if (!rows.length) return;
    const today = rows[0].cells[0].textContent.trim().slice(0, 10);
    const sameDay = rows.filter((row) => row.cells[0].textContent.trim().startsWith(today)).length;
    const students = new Set(rows.map((row) => row.cells[1].textContent.trim()).filter((value) => value && value !== "—")).size;
    rows.forEach((row) => {
      const cell = row.cells[2];
      const pill = document.createElement("span");
      pill.className = "pc-pill oui";
      pill.textContent = cell.textContent.trim();
      cell.replaceChildren(pill);
    });
    stats(hero, [
      ["Entrées affichées", rows.length, "strong"],
      [`Le ${today}`, sameDay],
      ["Étudiants concernés", students, "gold"],
    ]);
  }

  function kitchenPage(hero) {
    const moves = [...document.querySelectorAll(".journal-court li")];
    moves.forEach((item) => { if (/débité/.test(item.textContent)) item.classList.add("pc-debit"); });
    const debits = moves.filter((item) => item.classList.contains("pc-debit")).length;
    if (moves.length && moves[0].querySelector("time")) {
      stats(hero, [
        ["Derniers mouvements", moves.length, "strong"],
        ["Repas débités", debits],
        ["Recharges", moves.length - debits, "gold"],
      ]);
    }
  }

  function ordersPage(hero) {
    const dishes = [...document.querySelectorAll(".epuisement li")];
    let out = 0;
    dishes.forEach((item) => {
      const textNode = [...item.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim());
      if (!textNode) return;
      const [name, state] = textNode.textContent.trim().split(/\s+—\s+/);
      const empty = /épuisé/.test(state || "");
      if (empty) { item.classList.add("pc-out"); out += 1; }
      const label = document.createElement("span");
      label.className = "pc-plat";
      label.innerHTML = `<strong></strong><span class="pc-pill ${empty ? "" : "oui"}">${empty ? "Épuisé" : "Servi aujourd'hui"}</span>`;
      label.querySelector("strong").textContent = name;
      textNode.replaceWith(label);
    });
    const tickets = document.querySelectorAll(".ticket").length;
    stats(hero, [
      ["Commandes en cours", tickets, "strong"],
      ["Plats servis", dishes.length - out],
      ["Plats épuisés", out, "gold"],
    ]);
  }

  function menuPage(hero) {
    const dishes = document.querySelectorAll(".ligne-jour").length;
    const groups = document.querySelectorAll(".liste-jour").length;
    if (dishes) stats(hero, [["Plats et boissons", dishes, "strong"], ["Catégories", groups]]);
  }

  function emptyState(message) {
    const filters = document.querySelector("main .filtres");
    if (!filters || filters.nextElementSibling) return;
    const box = document.createElement("div");
    box.className = "pc-empty";
    box.innerHTML = `<span class="pc-empty-icon" aria-hidden="true">✓</span><p></p>`;
    box.querySelector("p").textContent = message;
    filters.after(box);
  }

  function yesNo() {
    document.querySelectorAll("td").forEach((cell) => {
      const value = cell.textContent.trim();
      if (cell.children.length || (value !== "Oui" && value !== "Non")) return;
      cell.innerHTML = `<span class="pc-pill ${value === "Oui" ? "oui" : ""}">${value}</span>`;
    });
  }

  function labelTables() {
    document.querySelectorAll("table").forEach((table) => {
      const head = table.tHead?.rows[0] || (table.rows[0]?.querySelector("th") ? table.rows[0] : null);
      if (!head) return;
      const labels = [];
      [...head.cells].forEach((cell) => {
        for (let span = 0; span < (cell.colSpan || 1); span += 1) labels.push(cell.textContent.trim());
      });
      table.classList.add("rows-as-cards");
      [...table.rows].forEach((row) => {
        if (row === head) {
          row.classList.add("stack-head");
          return;
        }
        let index = 0;
        [...row.cells].forEach((cell) => {
          if (!cell.hasAttribute("data-label")) cell.setAttribute("data-label", labels[index] || "");
          index += cell.colSpan || 1;
        });
      });
    });
  }

  function start() {
    if (!document.querySelector("header.barre")) return;
    document.body.classList.add("pc");
    const hero = buildHero();
    if (path === "/admin/etudiants") studentsPage(hero);
    else if (path.startsWith("/admin/journal")) journalPage(hero);
    else if (path === "/cantine") kitchenPage(hero);
    else if (path.startsWith("/cantine/commandes")) ordersPage(hero);
    else if (path.startsWith("/cantine/menu")) menuPage(hero);
    else if (path.startsWith("/securite")) emptyState("Flashez le QR code d'une carte ou cherchez un étudiant par son nom ou son matricule.");
    else if (path === "/admin/lot") emptyState("Choisissez une école et une année, puis cliquez sur « Préparer » pour voir les cartes prêtes.");
    yesNo();
    labelTables();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
