(function () {
  function francs(n) {
    var nombre = String(Math.max(0, Math.floor(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return nombre + " GNF";
  }
  function lire(valeur) {
    var texte = String(valeur || "").replace(/GNF|FG/gi, "").replace(/[\s.\u00a0]/g, "").replace(",", "");
    var n = parseInt(texte, 10);
    return isNaN(n) ? 0 : n;
  }
  function maj(form) {
    var mensuel = lire(form.querySelector("[data-abo-mensuel]") && form.querySelector("[data-abo-mensuel]").value);
    var mois = lire(form.querySelector("[data-abo-mois]") && form.querySelector("[data-abo-mois]").value) || 1;
    var cible = form.querySelector("[data-abo-total]");
    if (cible) cible.textContent = "Total : " + francs(mensuel * mois);
  }
  document.querySelectorAll("[data-abo]").forEach(function (form) {
    form.addEventListener("input", function () { maj(form); });
    form.addEventListener("change", function () { maj(form); });
    maj(form);
  });
})();
