# AfricaIIM Scolarité

Registre des paiements de scolarité. Chaque encaissement est une ligne. Le total payé, le reste, le taux et le statut sont **recalculés**, jamais saisis.

## Stack

Node.js 22 et Express : un seul programme, très répandu.
SQLite, déjà inclus dans Node : la base est un fichier, les montants sont des entiers.
PDFKit : reçus PDF, sans service payant.
Pages en français, sans framework lourd, pour rester rapides sur une connexion lente.
Toutes les formules sont dans `src/finance`. L'écran, l'API, le reçu et l'export appellent ce module.

## Installation

1. Installer Node.js 22 ou plus récent.
2. Dans ce dossier : `npm install`
3. Lancer : `npm start`
4. Ouvrir [http://localhost:4317](http://localhost:4317)
5. Vérifier les calculs : `npm test`

Le fichier `.env` est déjà prêt pour un essai sur cet ordinateur.

## Comptes de démonstration

À changer avant toute mise sur Internet (`DEMO_MODE=false` dans `.env`).

| Rôle | E-mail | Mot de passe | Code à 6 chiffres |
|---|---|---|---|
| Gestionnaire | gestionnaire@univ-africaiim.com | Gestion-2026! | Non |
| Admin (scolarité) | admin@univ-africaiim.com | Admin-2026! | Bouton sur l'écran de connexion |
| Super admin | superadmin@univ-africaiim.com | Super-2026! | Bouton sur l'écran de connexion |

La fiche `AIM-2026-0099` (DÉMO Formation) sert à s'entraîner. Les 62 autres viennent du PDF.

## Règles confirmées

- Le droit d'inscription est **inclus** dans les frais annuels. C'est la première échéance, pas un supplément.
- Répartition : **20 %** le 5 octobre, **40 %** le 5 décembre, **40 %** le 5 mars.
- Licence 25 000 000 = 5 000 000 + 10 000 000 + 10 000 000.
- Master 30 000 000 = 6 000 000 + 12 000 000 + 12 000 000.
- Tech Ingénieur 37 000 000 = 7 400 000 + 14 800 000 + 14 800 000.
- L'admin de la scolarité peut modifier ces trois montants. Le gestionnaire encaisse, il ne change pas le barème.
- Les dates du PDF restent « à confirmer ». L'argent importé est affecté à la plus ancienne échéance encore ouverte.

## Règles qui ne changent pas

- Montants entiers, en francs guinéens.
- Un paiement ne se modifie pas et ne se supprime pas. On l'annule avec un motif, puis on en crée un autre.
- Le reçu `REC-2026-000001` ne peut pas être réutilisé ni renuméroté.
- Un second clic sur « Valider » ne crée pas un deuxième paiement.

## Sauvegarde

`npm run backup` crée un fichier chiffré dans `data/backups`. Le mot de passe est `BACKUP_PASSPHRASE` dans `.env`. Copiez aussi le dossier `data/uploads` (justificatifs). En production, placez l'application derrière HTTPS.

## Guides

- Comptable : `docs/guide-comptable.md`
- Direction : `docs/guide-direction.md`
