-- Réinscription : 500 000 GNF au lieu des frais d'inscription d'une nouvelle fiche.
ALTER TABLE students ADD COLUMN IF NOT EXISTS enrollment_kind TEXT NOT NULL DEFAULT 'inscription';
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_enrollment_kind_check;
ALTER TABLE students ADD CONSTRAINT students_enrollment_kind_check
  CHECK (enrollment_kind IN ('inscription', 'reinscription'));
