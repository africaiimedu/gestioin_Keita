-- Adresse du compte étudiant (prenom.nom@univ-africaiim.com), unique.
ALTER TABLE students ADD COLUMN IF NOT EXISTS account_email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_account_email ON students(account_email) WHERE account_email IS NOT NULL;
