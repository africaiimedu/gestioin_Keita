(function () {
  const services = document.querySelectorAll(".service");
  const menuBtn = document.getElementById("touche-menu");

  function placerMenu(service) {
    const menu = service.querySelector(".sous-menu");
    const barre = document.querySelector("header.barre");
    if (!menu) return;
    const tiroir = document.body.classList.contains("menu-ouvert");
    if (!tiroir && window.matchMedia("(max-width: 800px)").matches && barre) {
      menu.style.top = Math.round(barre.getBoundingClientRect().bottom) + "px";
    } else {
      menu.style.top = "";
    }
  }

  function fermerServices(sauf) {
    services.forEach((service) => {
      if (service === sauf) return;
      service.classList.remove("ouvert");
      const titre = service.querySelector(".service-titre");
      if (titre) titre.setAttribute("aria-expanded", "false");
      const menu = service.querySelector(".sous-menu");
      if (menu && service !== sauf) menu.style.top = "";
    });
  }

  function fermerTiroir() {
    document.body.classList.remove("menu-ouvert");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
    fermerServices();
  }

  services.forEach((service) => {
    const titre = service.querySelector(".service-titre");
    if (!titre) return;
    titre.setAttribute("aria-expanded", "false");
    titre.setAttribute("aria-haspopup", "true");
    titre.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const etait = service.classList.contains("ouvert");
      fermerServices();
      if (!etait) {
        service.classList.add("ouvert");
        titre.setAttribute("aria-expanded", "true");
        placerMenu(service);
      }
    });
  });

  if (menuBtn) {
    menuBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (document.body.classList.contains("menu-ouvert")) fermerTiroir();
      else {
        document.body.classList.add("menu-ouvert");
        menuBtn.setAttribute("aria-expanded", "true");
        fermerServices();
      }
    });
  }

  document.addEventListener("click", (ev) => {
    if (ev.target.closest(".service")) return;
    if (ev.target.closest("#touche-menu") || ev.target.closest("#nav-app")) return;
    fermerServices();
    if (!ev.target.closest("header.barre")) fermerTiroir();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") fermerTiroir();
  });
  window.addEventListener("resize", () => {
    if (!window.matchMedia("(max-width: 800px)").matches) fermerTiroir();
  });
})();
