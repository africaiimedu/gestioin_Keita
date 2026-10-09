(() => {
  const form = document.getElementById("fiche-etudiant");
  if (!form) return;
  const champ = form.elements.email;
  const prenom = form.elements.prenom;
  const nom = form.elements.nom;

  const mots = (valeur) => (valeur || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[’']/g, "")
    .split(/[^a-z0-9-]+/).map((mot) => mot.replace(/^-+|-+$/g, "")).filter(Boolean);
  const plusCourt = (liste) => {
    const utiles = liste.filter((mot) => mot.replace(/-/g, "").length >= 3);
    return (utiles.length ? utiles : liste).reduce((a, b) => (b.length < a.length ? b : a));
  };
  const adresse = () => {
    const p = mots(prenom.value);
    const n = mots(nom.value);
    return p.length && n.length ? `${plusCourt(p)}.${plusCourt(n)}@univ-africaiim.com` : "";
  };

  let derniere = champ.dataset.auto === "oui" ? "" : adresse();
  const suivre = () => {
    const proposee = adresse();
    if (!champ.value.trim() || champ.value.trim().toLowerCase() === derniere) champ.value = proposee;
    derniere = proposee;
  };
  prenom.addEventListener("input", suivre);
  nom.addEventListener("input", suivre);
  if (!champ.value.trim()) suivre();
})();
