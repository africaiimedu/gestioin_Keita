-- Africaiim Tech : Cycle Préparatoire Intégré (CPI 1, CPI 2) puis MIAGE 1, 2 et 3.
-- Les lignes de barème sont créées au démarrage par ensureOfferSchedules (35.000.000 GNF chacune).
-- Les anciens niveaux restent autorisés : aucune fiche ni barème existant n'est modifié.

ALTER TABLE fee_schedules DROP CONSTRAINT IF EXISTS fee_schedules_level_check;
ALTER TABLE fee_schedules ADD CONSTRAINT fee_schedules_level_check CHECK (level IN (
  'licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2',
  'cpi_1', 'cpi_2', 'miage_1', 'miage_2', 'miage_3'
));

ALTER TABLE students DROP CONSTRAINT IF EXISTS students_level_check;
ALTER TABLE students ADD CONSTRAINT students_level_check CHECK (level IN (
  'licence', 'master', 'tech', 'bachelor', 'bachelor_1', 'bachelor_2', 'bachelor_3', 'master_1', 'master_2',
  'cpi_1', 'cpi_2', 'miage_1', 'miage_2', 'miage_3'
));
