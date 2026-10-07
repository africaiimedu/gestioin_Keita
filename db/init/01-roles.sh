#!/bin/sh
# Exécuté une seule fois, à la création du volume PostgreSQL.
# L'app se connecte avec le rôle « scolarite », propriétaire de son seul schéma (pas de superutilisateur).
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
REVOKE ALL ON DATABASE africaiim FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE ROLE scolarite LOGIN PASSWORD '${SCOLARITE_DB_PASSWORD}';
GRANT CONNECT ON DATABASE africaiim TO scolarite;
CREATE SCHEMA scolarite AUTHORIZATION scolarite;
ALTER ROLE scolarite SET search_path = scolarite;

-- Emplacement réservé à l'app Cartes quand elle rejoindra ce serveur.
CREATE SCHEMA cartes;

-- Base séparée pour les tests automatiques : jamais les données réelles.
CREATE DATABASE africaiim_test OWNER scolarite;
SQL
