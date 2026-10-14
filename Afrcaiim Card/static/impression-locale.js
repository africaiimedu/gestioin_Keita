/*
 * Impression depuis cet ordinateur, sous Windows comme sous macOS : le PDF s'ouvre dans un onglet
 * (au clic, donc jamais bloqué), puis le dialogue d'impression du système propose les imprimantes
 * installées sur ce poste. Un cadre caché ne suffit pas : Edge, Chrome et Firefox sous Windows
 * refusent d'y imprimer un PDF.
 * Safari ignore print() sur un onglet PDF : l'onglet s'ouvre et l'utilisateur lance ⌘ P lui-même.
 */
(function () {
  const SAFARI = /^((?!chrome|chromium|crios|fxios|edg|opr|android).)*safari/i.test(navigator.userAgent);

  function imprimerPdf(url) {
    const onglet = window.open(url, "_blank");
    if (!onglet) return false;
    if (SAFARI) return true;
    let essais = 0;
    const minuteur = setInterval(function () {
      essais += 1;
      if (onglet.closed || essais > 80) {
        clearInterval(minuteur);
        return;
      }
      let pret = false;
      try {
        pret = onglet.location.href !== "about:blank" && onglet.document.readyState === "complete";
      } catch (e) {
        clearInterval(minuteur);
        return;
      }
      if (!pret) return;
      clearInterval(minuteur);
      setTimeout(function () {
        try {
          onglet.focus();
          onglet.print();
        } catch (e) { /* le bouton Imprimer du lecteur PDF reste disponible */ }
      }, 1200);
    }, 250);
    return true;
  }

  document.addEventListener("click", function (ev) {
    const bouton = ev.target.closest("[data-imprimer-pdf]");
    if (!bouton) return;
    ev.preventDefault();
    const ouvert = imprimerPdf(bouton.dataset.imprimerPdf);
    const note = bouton.dataset.note ? document.getElementById(bouton.dataset.note) : null;
    if (!note) return;
    note.hidden = false;
    if (!ouvert) {
      note.textContent = "Le navigateur a bloqué le nouvel onglet. Autorisez les fenêtres pour ce site, puis recommencez.";
    } else if (SAFARI) {
      note.textContent = "Safari ne lance pas l'impression d'un PDF tout seul : dans l'onglet qui vient de s'ouvrir, appuyez sur ⌘ + P (Cmd + P), choisissez l'imprimante et gardez l'échelle à 100 %. Avec Google Chrome, la fenêtre d'impression s'ouvre automatiquement.";
    } else {
      note.textContent = "Le document est ouvert dans un nouvel onglet et le dialogue d'impression s'ouvre. S'il ne s'affiche pas, cliquez sur l'icône d'imprimante du lecteur PDF (ou Ctrl+P sous Windows, Cmd+P sur Mac).";
    }
  });

  window.imprimerPdf = imprimerPdf;
})();
