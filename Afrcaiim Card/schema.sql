-- Plan de la base AFRICAIIM Cartes.
-- Le programme crée ces tables tout seul au démarrage.
-- Ce fichier sert à comprendre la structure.

CREATE TABLE etudiants (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prenom          VARCHAR(80)  NOT NULL,
    nom             VARCHAR(80)  NOT NULL,
    matricule       VARCHAR(40)  NOT NULL UNIQUE,
    filiere         VARCHAR(150) NOT NULL,
    annee_academique VARCHAR(9)  NOT NULL,
    date_validite   DATE         NOT NULL,
    photo_chemin    VARCHAR(255),
    cree_le         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE utilisateurs (
    id                          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identifiant                 VARCHAR(80) NOT NULL UNIQUE,
    mot_de_passe_hash           VARCHAR(255) NOT NULL,
    role                        VARCHAR(20) NOT NULL,
    actif                       BOOLEAN NOT NULL DEFAULT TRUE,
    doit_changer_mot_de_passe   BOOLEAN NOT NULL DEFAULT TRUE,
    etudiant_id                 INTEGER UNIQUE REFERENCES etudiants (id),
    cree_le                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cartes (
    id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    etudiant_id      INTEGER NOT NULL REFERENCES etudiants (id),
    jeton            VARCHAR(80) NOT NULL UNIQUE,
    statut           VARCHAR(20) NOT NULL,
    date_emission    DATE NOT NULL,
    date_validite    DATE NOT NULL,
    numero_edition   INTEGER NOT NULL,
    uid_nfc          VARCHAR(40),
    cree_le          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cartes_etudiant ON cartes (etudiant_id);

CREATE TABLE journal_cartes (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    carte_id        INTEGER REFERENCES cartes (id),
    etudiant_id     INTEGER REFERENCES etudiants (id),
    utilisateur_id  INTEGER REFERENCES utilisateurs (id),
    action          VARCHAR(40) NOT NULL,
    details         VARCHAR(500) NOT NULL DEFAULT '',
    cree_le         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_journal_etudiant ON journal_cartes (etudiant_id);
