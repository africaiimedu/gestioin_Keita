# AfricaIIM Scolarité

Registre des paiements de scolarité de l'Université AFRICAIIM. Chaque encaissement est une ligne. Le total payé, le reste, le taux et le statut sont **recalculés**, jamais saisis.

## Architecture

```
docker compose
├── postgres     PostgreSQL 16 — base « africaiim », stockage permanent (volume africaiim_pg_data)
│                 schéma « scolarite » : cette application (rôle dédié, sans droits d'administration)
│                 schéma « cartes »    : réservé à l'application de cartes
├── scolarite    Node.js 22 + Express + Sequelize — http://localhost:4317
└── sauvegarde   pg_dump automatique toutes les 24 h dans data/backups (30 jours gardés)
```

| Dossier | Contenu |
|---|---|
| `src/db/` | Sequelize : connexion, modèles de toutes les tables (`models.js`), transactions, migrations versionnées (`migrations/NNN_nom.sql`) |
| `src/finance/` | Toutes les formules (allocation, reste, retard, montants en lettres) |
| `src/services/` | Règles métier : paiements, reçus, costume, comptes, import CSV, liaison cartes |
| `src/seed/` | Données de départ d'une base neuve |
| `public/` | Interface (sans framework, rapide sur connexion lente) |
| `db/` | Initialisation de PostgreSQL et script de sauvegarde |
| `scripts/` | Migrations, sauvegarde, export et import des données, transfert depuis l'ancienne base SQLite |
| `app.cjs` | Point de démarrage pour l'hébergement o2switch (Passenger) |
| `tests/` | Tests automatiques sur une base PostgreSQL séparée (`africaiim_test`) |

### Solidité des données

- Montants en entiers `BIGINT` (francs guinéens), dates en `DATE`, contraintes `CHECK` sur chaque valeur.
- Un paiement validé, un reçu, une annulation et le journal d'audit ne peuvent être ni modifiés ni supprimés : des déclencheurs PostgreSQL le refusent, même en SQL direct.
- Les encaissements passent dans une transaction verrouillée : deux caisses simultanées ne dépassent jamais le reste et les numéros de reçu restent sans trou.
- Le schéma évolue par migrations numérotées, appliquées une seule fois au démarrage. Il reste compatible PostgreSQL 9.6 et suivants (version d'o2switch).
- Sequelize sert pour la connexion, les transactions et les tables simples (comptes, sessions, paramètres, audit, relances). Les calculs financiers restent en SQL paramétré, exécuté par Sequelize dans la même transaction.

## Démarrage

Prérequis : Docker Desktop.

1. Copier `.env.example` vers `.env` et remplir les mots de passe (`openssl rand -hex 24`).
2. `docker compose up -d --build`
3. Ouvrir [http://localhost:4317](http://localhost:4317)

| Commande | Effet |
|---|---|
| `docker compose ps` | État des services |
| `docker compose logs -f scolarite` | Journal de l'application |
| `docker compose restart scolarite` | Redémarrer l'application |
| `docker compose down` | Arrêter (les données restent sur le volume) |
| `npm run backup` | Sauvegarde immédiate dans `data/backups` |
| `npm run migrate` | Appliquer les migrations sans démarrer le serveur |
| `npm run export` | Exporter toutes les données dans `data/exports` (pour une mise en ligne) |
| `npm run import -- fichier` | Installer un export dans une base vide, avec contrôle des totaux |
| `npm test` | Tests (PostgreSQL démarré, Node 20 ou 22 local) |

Ne jamais lancer `docker compose down -v` : l'option `-v` efface le volume de la base.

## Sauvegarde et restauration

Les sauvegardes (`data/backups/*.dump`) contiennent toutes les données : copiez-les régulièrement sur un autre support. Copiez aussi `data/uploads` (justificatifs).

Restaurer une sauvegarde (remplace le contenu actuel du schéma) :

```sh
docker compose stop scolarite
docker compose exec -T sauvegarde pg_restore --clean --if-exists -d africaiim /backups/NOM_DU_FICHIER.dump
docker compose start scolarite
```

## Ancienne base SQLite

Les données ont été transférées le 7 octobre 2026. Une copie de l'ancienne base est gardée dans `data/archives`. Le transfert se rejoue sur une base PostgreSQL vide avec `npm run transfert -- chemin/vers/scolarite.sqlite` : il compare ensuite les lignes, les totaux encaissés et les numéros de reçus.

## Règles confirmées

- Répartition : **20 %** le 5 octobre, **40 %** le 5 décembre, **40 %** le 5 mars.
- Frais d'inscription : 1 000 000 en Licence et Bachelor, 3 000 000 en Master, dus au premier versement, offerts aux boursiers.
- Réduction de 5 % quand tous les frais annuels sont payés en une fois.
- Les fiches importées gardent leur ancien barème.
- Le costume se suit à part, au même prix pour tous (Paramètres).

## Règles qui ne changent pas

- Montants entiers, en francs guinéens.
- Un paiement ne se modifie pas et ne se supprime pas. On l'annule avec un motif ; une mise à jour ajoute un nouveau versement.
- Un versement supérieur au reste à payer est refusé.
- Le reçu `REC-2026-000001` ne peut pas être réutilisé ni renuméroté.
- Un second clic sur « Valider » ne crée pas un deuxième paiement.

## Mise en ligne sur o2switch

Voir `docs/deploiement-o2switch.md` : base PostgreSQL de cPanel, application Node.js (Passenger), HTTPS, transfert des données et sauvegardes automatiques. En production (`NODE_ENV=production`), le mode démonstration est toujours fermé.

## Guides

- Comptable : `docs/guide-comptable.md`
- Direction : `docs/guide-direction.md`
