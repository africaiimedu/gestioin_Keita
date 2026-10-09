// Chaque champ mot de passe reçoit un œil pour l'afficher ou le masquer.
(function () {
  "use strict";
  var OEIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  var OEIL_BARRE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  function equiper(champ) {
    if (champ.dataset.oeil) return;
    champ.dataset.oeil = "1";
    var ligne = document.createElement("span");
    ligne.className = "mot-de-passe";
    champ.parentNode.insertBefore(ligne, champ);
    ligne.appendChild(champ);
    var bouton = document.createElement("button");
    bouton.type = "button";
    bouton.className = "oeil";
    ligne.appendChild(bouton);
    function peindre() {
      var visible = champ.type === "text";
      var texte = visible ? "Masquer le mot de passe" : "Afficher le mot de passe";
      bouton.innerHTML = visible ? OEIL_BARRE : OEIL;
      bouton.setAttribute("aria-label", texte);
      bouton.setAttribute("aria-pressed", String(visible));
      bouton.title = texte;
    }
    bouton.addEventListener("click", function () {
      champ.type = champ.type === "password" ? "text" : "password";
      peindre();
      champ.focus();
    });
    peindre();
  }

  function tout() {
    var champs = document.querySelectorAll('input[type="password"]');
    for (var i = 0; i < champs.length; i += 1) equiper(champs[i]);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tout);
  else tout();
})();
