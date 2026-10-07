# Guide de l'admin (1 page)

L'admin suit la scolarité. Il peut modifier les trois échéances (20 % le 5 octobre, 40 % le 5 décembre, 40 % le 5 mars) et annuler un paiement avec un motif. Le super admin est le seul à créer les comptes.

## Lire le tableau de bord

- **Frais attendus** : somme des barèmes, après remise s'il y en a une.
- **Encaissé** : somme des paiements valides. Un paiement annulé n'y entre pas.
- **Reste à payer** : frais attendus moins l'encaissé. Un trop-perçu apparaît à part, comme un crédit, et n'est pas un reste négatif.
- **Taux** : encaissé divisé par les frais, arrondi à 1 décimale. Exemple : 26 500 000 sur 30 000 000 = 88,3 %.

Cliquez un statut (Soldé, Partiel, Aucun paiement, En retard, Trop-perçu) pour voir les étudiants qui le composent. Le même calcul sert à l'écran, au reçu et à l'export.

## Retard

Un étudiant est en retard quand une échéance dont la date est passée n'est pas encore couverte, même s'il a payé une tranche plus tardive. L'inscription de cette année était due le 30 septembre 2026.

## Relances et cartes

La page Relances prépare le texte. L'envoi par téléphone reste manuel. Si le reste en retard atteint le seuil (5 000 000 GNF par défaut), la fiche indique « carte limitée ». C'est un signal pour le système de cartes, qui partage le matricule `AIM-2026-….`.

## Contrôle

Le bandeau « Contrôle de cohérence : OK » signifie que la somme des étudiants est égale au total général. S'il passe au rouge, ne prenez aucune décision d'argent avant vérification avec le comptable.
