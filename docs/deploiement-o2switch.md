# Mise en ligne sur o2switch

o2switch est un hébergement cPanel sans Docker. L'application tourne avec **Setup Node.js App** (Phusion Passenger, chaque application a son propre environnement virtuel Node) et la base est une **base PostgreSQL créée dans cPanel**. Le code est le même que sur le poste : seules les variables de `.env` changent.

Dans ce guide, `USER` est votre identifiant cPanel et `scolarite.univ-africaiim.com` l'adresse choisie.

## 1. Base PostgreSQL

1. cPanel → **Bases de données PostgreSQL**.
2. Créer la base `USER_africaiim`.
3. Créer l'utilisateur `USER_scolarite` avec un mot de passe long (générateur de cPanel).
4. Ajouter l'utilisateur à la base avec **tous les privilèges**.

L'application crée elle-même son schéma `scolarite`, ses tables, ses contraintes et ses déclencheurs au premier démarrage. Il fonctionne avec PostgreSQL 9.6 (version d'o2switch) et toutes les versions suivantes. Si la création du schéma est refusée, mettez `DB_SCHEMA=public` dans `.env`.

## 2. Accès SSH

cPanel → **Autorisation SSH** : ajouter votre adresse IP. Ensuite :

```sh
ssh USER@VOTRE_SERVEUR.o2switch.net
```

## 3. Code

Le dépôt GitHub est `africaiimedu/gestioin_Keita`, branche `master`. Le placer **hors de `public_html`** :

```sh
cd ~
git clone -b master https://github.com/africaiimedu/gestioin_Keita.git scolarite
```

Si le dépôt est privé, utilisez cPanel → **Git Version Control** avec une clé de déploiement GitHub.

## 4. Application Node.js

cPanel → **Setup Node.js App** → **Create Application** :

| Champ | Valeur |
|---|---|
| Node.js version | la plus récente proposée (22, sinon 20) |
| Application mode | Production |
| Application root | `scolarite` |
| Application URL | `scolarite.univ-africaiim.com` |
| Application startup file | `app.cjs` |

Créer ensuite `~/scolarite/.env` (Gestionnaire de fichiers ou `nano`), puis `chmod 600 ~/scolarite/.env` :

```ini
NODE_ENV=production
DEMO_MODE=false
TRUST_PROXY=true
PUBLIC_BASE_URL=https://scolarite.univ-africaiim.com
DATABASE_URL=postgres://USER_scolarite:MOT_DE_PASSE@localhost:5432/USER_africaiim
DB_SCHEMA=scolarite
DB_POOL_SIZE=5
SUPER_ADMIN_INITIAL_PASSWORD=
INTEGRATION_TOKEN=
CARD_API_URL=
CARD_API_TOKEN=
BACKUP_KEEP_DAYS=30
```

Un mot de passe contenant `@`, `:` ou `/` doit être encodé dans `DATABASE_URL` (`@` devient `%40`).

Installer les dépendances : bouton **Run NPM Install**, ou en SSH avec la commande `source …/activate` affichée en haut de la page de l'application :

Sur o2switch, `node_modules` doit rester un raccourci vers l'environnement Node : ne jamais créer ce dossier à la main ni lancer `npm ci`, qui le remplacerait.

```sh
source ~/nodevenv/scolarite/22/bin/activate && cd ~/scolarite
npm install --omit=dev
npm run migrate
```

## 5. Données

Sur le poste, avec la base Docker démarrée :

```sh
npm run export
```

Envoyer le fichier `data/exports/scolarite_….json.gz` dans `~/scolarite/data/exports/` (SFTP ou Gestionnaire de fichiers, **jamais dans `public_html`**), puis sur le serveur :

```sh
npm run import -- data/exports/scolarite_AAAA-MM-JJ_HH-MM.json.gz
rm data/exports/scolarite_*.json.gz
```

L'import refuse une base qui contient déjà des données. Il travaille dans une seule transaction et compare les lignes, les totaux encaissés, le total de chaque étudiant et les numéros de reçus. Au moindre écart, il annule tout. Les justificatifs (`data/uploads`) sont inclus dans le fichier.

Pendant la bascule, n'enregistrez plus de paiement sur le poste : l'export doit être le dernier état.

## 6. Démarrage et HTTPS

1. **Setup Node.js App** → **Restart**. Après une mise à jour en SSH : `touch ~/scolarite/tmp/restart.txt`.
2. cPanel → **Domaines** : activer **Forcer la redirection HTTPS**. Le certificat (AutoSSL) est gratuit et renouvelé automatiquement.
3. Vérifier `https://scolarite.univ-africaiim.com/api/sante`, qui doit répondre `{"ok":true,...}`.

Avec `TRUST_PROXY=true`, les cookies de session sont marqués `Secure`, l'en-tête HSTS est envoyé et le journal des connexions note la vraie adresse IP. Le blocage après 8 essais de mot de passe est calculé en base : il vaut pour tous les processus lancés par Passenger.

## 7. Sauvegardes automatiques

cPanel → **Tâches Cron**, une fois par jour à 2 h :

```
0 2 * * * cd ~/scolarite && ~/nodevenv/scolarite/22/bin/node scripts/backup.js >> data/backups/cron.log 2>&1
```

Le script utilise `pg_dump` du serveur et garde 30 jours de copies dans `~/scolarite/data/backups`. Téléchargez-en une régulièrement sur un autre support. Restauration (application arrêtée) :

```sh
pg_restore --clean --if-exists --no-owner \
  -d "postgres://USER_scolarite:MOT_DE_PASSE@localhost:5432/USER_africaiim" \
  data/backups/africaiim_AAAA-MM-JJ_HH-MM.dump
```

## 8. Mises à jour

```sh
source ~/nodevenv/scolarite/22/bin/activate && cd ~/scolarite
npm run backup
git pull
npm install --omit=dev
npm run migrate
touch tmp/restart.txt
```

## Application Cartes

L'application Cartes (Python FastAPI) se déploie à part avec **Setup Python App**. Tant qu'elle n'est pas en ligne, laissez `CARD_API_URL` vide : le portail cartes est désactivé et la scolarité fonctionne normalement.
