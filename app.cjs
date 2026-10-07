// Fichier de démarrage pour o2switch (cPanel « Setup Node.js App », Phusion Passenger).
// Passenger charge un fichier CommonJS ; l'application, écrite en modules ES, est chargée ici.
import("./src/server.js").catch((error) => {
  console.error(error);
  process.exit(1);
});
