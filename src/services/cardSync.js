const NOM = /^[A-Za-zÀ-ÖØ-öø-ÿ'’\- ]{2,80}$/;
const MATRICULE = /^[A-Z0-9][A-Z0-9-]{2,30}$/;
const EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}$/;

export function ficheCarte(student) {
  const prenom = String(student.first_name || "").trim();
  const nom = String(student.last_name || "").trim();
  const matricule = String(student.matricule || "").trim().toUpperCase();
  const ecole = String(student.program_name || "").trim();
  if (!NOM.test(prenom)) return { ok: false, matricule, error: "Le prénom n'est pas reconnu par l'application de cartes." };
  if (!NOM.test(nom)) return { ok: false, matricule, error: "Le nom n'est pas reconnu par l'application de cartes." };
  if (!MATRICULE.test(matricule)) return { ok: false, matricule, error: "Le matricule n'est pas reconnu par l'application de cartes." };
  if (!ecole) return { ok: false, matricule, error: "L'école est absente." };
  let email = String(student.email || "").trim().toLowerCase();
  if (email && !EMAIL.test(email)) email = "";
  return { ok: true, payload: { prenom, nom, matricule, ecole, email } };
}

export async function pushStudentToCard(student) {
  const base = process.env.CARD_API_URL;
  const token = process.env.CARD_API_TOKEN;
  if (!base || !token) return { ok: false, skipped: true, matricule: student.matricule, error: "La liaison avec les cartes n'est pas configurée." };
  const fiche = ficheCarte(student);
  if (!fiche.ok) return fiche;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/api/inscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Jeton": token },
      body: JSON.stringify(fiche.payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, matricule: fiche.payload.matricule, error: data.message || "L'application de cartes a refusé la fiche." };
    return { ok: true, matricule: data.matricule || fiche.payload.matricule };
  } catch {
    return { ok: false, matricule: fiche.payload.matricule, error: "L'application de cartes ne répond pas." };
  } finally {
    clearTimeout(timer);
  }
}

export async function syncStudentsToCard(db) {
  const rows = await db.prepare(`
    SELECT s.matricule, s.last_name, s.first_name, s.email, p.name AS program_name
    FROM students s
    JOIN programs p ON p.id = s.program_id
    WHERE s.status != 'archive'
    ORDER BY s.matricule
  `).all();
  const results = [];
  for (const row of rows) results.push(await pushStudentToCard(row));
  const errors = results.filter((item) => !item.ok);
  return {
    sent: results.filter((item) => item.ok).length,
    ignored: errors.length,
    errors: errors.map((item) => ({ matricule: item.matricule, error: item.error })),
  };
}
