const bloc = document.getElementById("carte-data");
if (bloc) {
  const data = JSON.parse(bloc.textContent);
  const recto = document.getElementById("apercu-recto");
  const verso = document.getElementById("apercu-verso");

  function dessiner() {
    const portrait = data.modele && data.modele.orientation === "portrait";
    const largeur = portrait ? 54 : 85.6;
    const support = recto.closest(".carte-3d");
    if (support) support.style.aspectRatio = portrait ? "54 / 85.6" : "85.6 / 54";
    const px = recto.clientWidth / largeur;
    if (!px) return;
    const ctx = { px, etu: data.etu, urls: data.urls };
    rendreFace(recto, data.modele.recto, { ...ctx, face: "recto" });
    rendreFace(verso, data.modele.verso, { ...ctx, face: "verso" });
  }

  dessiner();
  requestAnimationFrame(dessiner);
  window.addEventListener("resize", dessiner);
}
