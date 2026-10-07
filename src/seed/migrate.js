import { randomBytes } from "node:crypto";
import { hashPassword } from "../auth/passwords.js";
import { OFFER_PLANS, PROGRAMS } from "./legacy.js";
import { transaction } from "../db/index.js";

const SUPER_ADMIN_EMAIL = "jtoupou@univ-africaiim.com";

function initialPassword() {
  if (process.env.SUPER_ADMIN_INITIAL_PASSWORD) return process.env.SUPER_ADMIN_INITIAL_PASSWORD;
  const generated = `Aim-${randomBytes(6).toString("base64url")}9!`;
  console.log(`Mot de passe initial de ${SUPER_ADMIN_EMAIL} : ${generated}`);
  return generated;
}

/** Noms officiels des écoles, coordonnées, compte du super admin et barèmes de l'offre. Idempotent. */
export async function applyIdentity(db) {
  await transaction(db, async () => {
    for (const program of PROGRAMS) {
      await db.prepare("UPDATE programs SET name = ? WHERE code = ? AND name <> ?").run(program.name, program.code, program.name);
    }

    const email = SUPER_ADMIN_EMAIL;
    const joseph = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    const ready = (await db.prepare("SELECT value FROM settings WHERE key = 'identity_joseph'").get())?.value === "1";
    if (!joseph) {
      await db.prepare(`
        INSERT INTO users(role_id, full_name, email, password_hash, totp_secret, totp_required, permissions_json, must_change_password, active)
        VALUES((SELECT id FROM roles WHERE code = 'super_admin'), 'Joseph Toupou', ?, ?, NULL, 0, NULL, 0, 1)
      `).run(email, hashPassword(initialPassword()));
    } else if (!ready) {
      await db.prepare(`
        UPDATE users
        SET full_name = 'Joseph Toupou',
            role_id = (SELECT id FROM roles WHERE code = 'super_admin'),
            password_hash = ?,
            totp_secret = NULL,
            totp_required = 0,
            permissions_json = NULL,
            must_change_password = 0,
            active = 1
        WHERE email = ?
      `).run(hashPassword(initialPassword()), email);
    } else {
      await db.prepare(`
        UPDATE users
        SET full_name = 'Joseph Toupou',
            role_id = (SELECT id FROM roles WHERE code = 'super_admin'),
            active = 1
        WHERE email = ? AND (full_name <> 'Joseph Toupou' OR active <> 1
          OR role_id <> (SELECT id FROM roles WHERE code = 'super_admin'))
      `).run(email);
    }
    if (!ready) {
      await db.prepare("UPDATE users SET active = 0 WHERE email <> ?").run(email);
      await db.prepare("DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users WHERE email = ?)").run(email);
      await db.prepare(`
        INSERT INTO settings(key, value) VALUES('identity_joseph', '1')
        ON CONFLICT(key) DO UPDATE SET value = '1'
      `).run();
    }

    await db.prepare(`
      INSERT INTO settings(key, value) VALUES('school_name', 'Université AFRICAIIM')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value <> excluded.value
    `).run();

    const replacePlaceholder = async (key, value) => {
      const current = (await db.prepare("SELECT value FROM settings WHERE key = ?").get(key))?.value;
      if (current == null || current.includes("compléter") || current === "Conakry, République de Guinée") {
        await db.prepare(`
          INSERT INTO settings(key, value) VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
      }
    };
    await replacePlaceholder("school_city", "Conakry, Guinée");
    await replacePlaceholder("school_address", "Le Choix de l'Excellence");
    await replacePlaceholder("school_phone", "(00224) 620 11 13 13");
    await replacePlaceholder("school_email", "contact@univ-africaiim.com");
    await replacePlaceholder("school_web", "www.universite-africaiim.com");

    await ensureOfferSchedules(db);
  });
}

export async function ensureOfferSchedules(db) {
  const year = await db.prepare("SELECT id FROM academic_years WHERE active = 1").get();
  if (!year) return;
  const programs = await db.prepare("SELECT id FROM programs").all();
  for (const program of programs) {
    for (const [level, plan] of Object.entries(OFFER_PLANS)) {
      await db.prepare(`
        INSERT INTO fee_schedules(
          program_id, academic_year_id, level, tuition_amount, registration_amount,
          installment_1, installment_2, installment_3, registration_included
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(program_id, academic_year_id, level) DO NOTHING
      `).run(program.id, year.id, level, plan.tuition, plan.parts[0], plan.parts[1], plan.parts[2], plan.parts[3]);
    }
  }
}
