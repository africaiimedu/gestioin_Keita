import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
function money(amount) {
  const value = Math.trunc(Number(amount) || 0);
  const sign = value < 0 ? "-" : "";
  const body = Math.abs(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${body} GNF`;
}

const logoPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public/logo.png");
const markPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public/filigrane-u.png");
const MARK_RATIO = 740 / 806;

function drawWatermark(doc, pageWidth, centerY) {
  const height = 360;
  const width = height * MARK_RATIO;
  const x = (pageWidth - width) / 2 + 28;
  const y = centerY - height / 2;
  doc.save();
  doc.opacity(0.1);
  doc.image(markPath, x, y, { width, height });
  doc.restore();
  doc.x = doc.page.width / 2;
  doc.y = doc.page.height / 2;
}
const stampPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public/cachet.png");
const SIGNER_SERVICE = "Service de scolarité";

function frenchDate(iso) {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(iso || "");
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function filled(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function write(doc, value, x, y, size, font, color, width, align = "left") {
  doc.fillColor(color).font(font).fontSize(size);
  doc.text(String(value ?? ""), x, y, { width, height: size + 3, align, lineBreak: false });
}

function drawUniversityStamp(doc, x, y, boxWidth, boxHeight) {
  doc.save();
  doc.rotate(-14, { origin: [x + boxWidth / 2, y + boxHeight / 2] });
  doc.image(stampPath, x, y, { fit: [boxWidth, boxHeight], align: "center", valign: "center" });
  doc.restore();
}

function arcText(doc, text, radius, fromDeg, toDeg, size) {
  const chars = Array.from(text);
  doc.font("Helvetica-Bold").fontSize(size);
  const gap = size * 0.06;
  const widths = chars.map((ch) => doc.widthOfString(ch));
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, chars.length - 1);
  const from = (fromDeg * Math.PI) / 180;
  const to = (toDeg * Math.PI) / 180;
  let cursor = from + (to - from - total / radius) / 2;
  chars.forEach((ch, index) => {
    const w = widths[index];
    const mid = cursor + w / (2 * radius);
    doc.save();
    doc.translate(Math.cos(mid) * radius, Math.sin(mid) * radius);
    doc.rotate((mid * 180) / Math.PI + 90);
    doc.text(ch, -w / 2, -size * 0.78, { lineBreak: false });
    doc.restore();
    cursor += (w + gap) / radius;
  });
}

function stampStar(doc, x, y, radius) {
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? radius : radius * 0.42;
    points.push([x + Math.cos(angle) * r, y + Math.sin(angle) * r]);
  }
  doc.moveTo(points[0][0], points[0][1]);
  for (const [px, py] of points.slice(1)) doc.lineTo(px, py);
  doc.closePath().fill();
}

function drawSeal(doc, x, y, radius, title, year, color) {
  doc.save();
  doc.translate(x, y);
  doc.rotate(-12);
  doc.fillColor(color).opacity(0.08);
  doc.circle(0, 0, radius - 0.4).fill();
  doc.opacity(0.94).strokeColor(color).fillColor(color);
  doc.lineWidth(1.8).circle(0, 0, radius).stroke();
  doc.lineWidth(0.65).circle(0, 0, radius - 3.6).stroke();
  const ring = radius - 8.4;
  const ringSize = Math.max(5, radius * 0.2);
  arcText(doc, "AFRICAIIM", ring, -156, -24, ringSize);
  arcText(doc, "SCOLARITÉ", ring, 24, 156, ringSize * 0.92);
  stampStar(doc, -(radius - 5.2), 0, 2.15);
  stampStar(doc, radius - 5.2, 0, 2.15);
  const parts = title.split(" ").filter(Boolean);
  const centerSize = parts.length > 1 ? Math.max(6.4, radius * 0.26) : Math.max(8.5, radius * 0.36);
  doc.font("Helvetica-Bold").fontSize(centerSize).fillColor(color);
  const lineH = centerSize + 0.4;
  let textY = -((parts.length * lineH + 6) / 2);
  for (const line of parts) {
    const w = doc.widthOfString(line);
    doc.text(line, -w / 2, textY, { lineBreak: false });
    textY += lineH;
  }
  doc.font("Helvetica").fontSize(Math.max(4.4, radius * 0.15));
  const yearW = doc.widthOfString(year);
  doc.text(year, -yearW / 2, textY + 0.4, { lineBreak: false });
  doc.restore();
  doc.x = doc.page.width / 2;
  doc.y = doc.page.height / 2;
}

function cycleName(code) {
  const value = String(code || "");
  if (value.startsWith("master")) return "Master";
  if (value.startsWith("bachelor")) return "Bachelor";
  if (value === "tech") return "Tech Ingénieur";
  return "Licence";
}

function studyYear(code) {
  return { bachelor_1: "1re année", bachelor_2: "2e année", bachelor_3: "3e année", master_1: "1re année", master_2: "2e année" }[code] || "—";
}

function programmeName(level, school) {
  if (level === "tech") return "Cycle Tech Ingénieur";
  const domain = String(school || "")
    .replace(/^AFRICAIIM\s+/i, "")
    .replace(/^École de\s+/i, "")
    .trim();
  const named = { "Business School": "Management", "Sup de Com": "Communication", Tech: "Ingénierie" }[domain] || domain;
  return named ? `${cycleName(level)} en ${named}` : cycleName(level);
}

function writeOrdinal(doc, value, x, y, size, color) {
  const match = String(value).match(/^(\d+)(re|e)(\s.*)$/);
  if (!match) {
    write(doc, value, x, y, size, "Helvetica-Bold", color, 160);
    return;
  }
  doc.fillColor(color).font("Helvetica-Bold").fontSize(size);
  const number = doc.widthOfString(match[1]);
  doc.text(match[1], x, y, { lineBreak: false });
  doc.fontSize(size * 0.6);
  const suffix = doc.widthOfString(match[2]);
  doc.text(match[2], x + number + 0.5, y - size * 0.05, { lineBreak: false });
  doc.fontSize(size);
  doc.text(match[3], x + number + suffix + 1, y, { lineBreak: false });
}

const W = 595.28;
const LEFT = 27;
const WIDTH = W - LEFT * 2;
const RIGHT = LEFT + WIDTH;
const GREEN = "#0c3d2e";
const LEAF = "#2f6b47";
const GOLD = "#e2a31a";
const GOLD_TEXT = "#9a6a0a";
const INK = "#1b1f1d";
const MUTED = "#6b7570";

function openDoc(format) {
  const small = format === "a5";
  const doc = new PDFDocument({ size: small ? "A5" : "A4", margin: 0 });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  if (small) doc.scale(doc.page.width / W);
  return { doc, done };
}

function drawHead(doc, { school, number, dateIso, title, subtitle }) {
  const city = filled(school.city, "Conakry, Guinée");
  const town = city.split(",")[0].trim() || "Conakry";
  const site = filled(school.web, "universite-africaiim.com").replace(/^https?:\/\//, "").replace(/^www\./, "");
  doc.rect(0, 0, W, 6).fill(GREEN);
  doc.rect(0, 6, W, 2.5).fill(GOLD);
  try { doc.image(logoPath, LEFT + 4, 26, { fit: [160, 72] }); } catch { /* logo absent */ }
  write(doc, filled(school.name, "Université AFRICAIIM"), 190, 34, 17, "Times-Bold", GREEN, 220, "center");
  write(doc, city, 190, 60, 10.5, "Times-Italic", LEAF, 220, "center");
  write(doc, site, 190, 80, 9.5, "Helvetica", MUTED, 220, "center");
  const boxX = RIGHT - 141;
  doc.roundedRect(boxX, 28, 141, 64, 8).lineWidth(1.1).strokeColor(GREEN).stroke();
  write(doc, "REÇU OFFICIEL", boxX, 37, 7.5, "Helvetica", MUTED, 141, "center");
  write(doc, number, boxX, 52, 12, "Helvetica-Bold", GREEN, 141, "center");
  write(doc, `${town}, le ${frenchDate(dateIso)}`, boxX, 74, 8.5, "Helvetica", INK, 141, "center");
  doc.moveTo(LEFT, 106).lineTo(RIGHT, 106).lineWidth(0.7).strokeColor("#dfe6e2").stroke();
  write(doc, title, LEFT, 124, 20, "Times-Bold", GREEN, WIDTH, "center");
  write(doc, subtitle, LEFT, 152, 9, "Helvetica", MUTED, WIDTH, "center");
}

function drawIdentity(doc, snapshot, top) {
  doc.roundedRect(LEFT, top, WIDTH, 135, 10).fill("#f2f5f3");
  const cols = [LEFT + 14, LEFT + 251, LEFT + 390];
  const field = (label, value, col, y, color = INK) => {
    write(doc, label, cols[col], y, 7.5, "Helvetica", MUTED, col === 0 ? 230 : 150);
    write(doc, value, cols[col], y + 16, 12, "Helvetica-Bold", color, col === 0 ? 230 : 150);
  };
  field("ÉTUDIANT", filled(snapshot.studentName, "Nom non renseigné"), 0, top + 16);
  field("MATRICULE", filled(snapshot.matricule, "Non attribué"), 1, top + 16, LEAF);
  field("ANNÉE ACADÉMIQUE", filled(snapshot.year, "2026-2027"), 2, top + 16);
  field("ÉCOLE", filled(snapshot.program, "École non renseignée"), 0, top + 55);
  field("NIVEAU", cycleName(snapshot.level), 1, top + 55);
  write(doc, "ANNÉE D’ÉTUDES", cols[2], top + 55, 7.5, "Helvetica", MUTED, 150);
  writeOrdinal(doc, studyYear(snapshot.level), cols[2], top + 71, 12, INK);
  write(doc, "PROGRAMME", cols[0], top + 94, 7.5, "Helvetica", MUTED, 400);
  write(doc, programmeName(snapshot.level, snapshot.program), cols[0], top + 110, 12, "Helvetica-Bold", INK, 400);
  return top + 135 + 15;
}

function drawHero(doc, y, label, amount, details = []) {
  doc.roundedRect(LEFT, y, WIDTH, 74, 8).fill("#e6efe9");
  doc.rect(LEFT, y, 5, 74).fill(LEAF);
  write(doc, label, LEFT + 25, y + 16, 8, "Helvetica-Bold", LEAF, 300);
  write(doc, money(amount), LEFT + 25, y + 34, 27, "Helvetica-Bold", GREEN, 330);
  details.forEach(([name, value], index) => {
    const top = y + 18 + index * 22;
    write(doc, name, RIGHT - 200, top, 8, "Helvetica", MUTED, 186, "right");
    write(doc, value, RIGHT - 200, top + 10, 10.5, "Helvetica-Bold", INK, 186, "right");
  });
  return y + 74;
}

function drawFoot(doc, qr, number) {
  const foot = 690;
  doc.moveTo(LEFT, foot).lineTo(RIGHT, foot).lineWidth(0.7).strokeColor("#dfe6e2").stroke();
  doc.moveTo(LEFT, 781).lineTo(LEFT + 181, 781).lineWidth(0.7).strokeColor("#3c4540").stroke();
  write(doc, "Signature de l'étudiant", LEFT, 792, 8.5, "Helvetica", MUTED, 181);
  doc.image(qr, W / 2 - 36, 706, { width: 72 });
  write(doc, "Vérification du document", W / 2 - 80, 792, 8.5, "Helvetica", MUTED, 160, "center");
  try { drawUniversityStamp(doc, RIGHT - 158, 700, 141, 78); } catch { /* cachet absent */ }
  write(doc, SIGNER_SERVICE, RIGHT - 160, 792, 9, "Helvetica-Bold", INK, 145, "center");
  const band = `UNIVERSITÉ AFRICAIIM — ${number}`;
  write(doc, `${band} — ${band}`, LEFT - 10, 818, 6.5, "Helvetica", "#8a948f", WIDTH + 20, "center");
}

function drawCostume(doc, y, costume) {
  const settled = costume.reste <= 0;
  doc.roundedRect(LEFT, y, WIDTH, 50, 8).lineWidth(0.9).strokeColor("#cfdcd4").stroke();
  write(doc, "COSTUME", LEFT + 12, y + 8, 7.5, "Helvetica-Bold", LEAF, 120);
  write(doc, settled ? "Payé" : (costume.paidAfter > 0 ? "Partiellement payé" : "Non payé"), RIGHT - 132, y + 8, 7.5, "Helvetica-Bold", settled ? LEAF : GOLD_TEXT, 120, "right");
  const cells = [
    ["Prix du costume", money(costume.price), INK],
    ["Versé ce jour", money(costume.today), INK],
    ["Total versé", money(costume.paidAfter), INK],
    ["Reste costume", money(costume.reste), settled ? LEAF : GOLD_TEXT],
  ];
  const cell = (WIDTH - 24) / cells.length;
  cells.forEach(([label, value, color], index) => {
    const x = LEFT + 12 + index * cell;
    write(doc, label, x, y + 21, 7.5, "Helvetica", MUTED, cell - 6);
    write(doc, value, x, y + 32, 10.5, "Helvetica-Bold", color, cell - 6);
  });
  return y + 50;
}

export async function renderReceiptPdf({ snapshot, receipt, school, format = "a4", cancelled = null, verifyUrl }) {
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 240 });
  const { doc, done } = openDoc(format);
  const costume = snapshot.costume || null;
  const compact = Boolean(costume);
  const costumeToday = Number(costume?.today || 0);
  const total = Number(snapshot.totalAmount ?? snapshot.amount ?? 0);
  const paidBefore = Math.max(0, Number(snapshot.paidAfter || 0) - Number(snapshot.amount || 0));
  const settled = Number(snapshot.resteAfter || 0) <= 0 && !cancelled;
  const sealTitle = cancelled ? "ANNULÉ" : (settled ? "PAYÉ" : "ACOMPTE REÇU");
  const sealColor = cancelled ? GREEN : (settled ? LEAF : GOLD_TEXT);
  const yearLabel = filled(snapshot.year, "2026-2027");
  const reference = String(snapshot.reference ?? "").trim();

  drawHead(doc, {
    school,
    number: receipt.number,
    dateIso: snapshot.paidOn,
    title: "REÇU DE PAIEMENT",
    subtitle: costumeToday > 0 ? "Frais de scolarité et costume" : "Frais de scolarité",
  });
  let y = drawIdentity(doc, snapshot, 181);
  const split = costumeToday > 0 ? [["Scolarité", money(snapshot.amount)], ["Costume", money(costumeToday)]] : [];
  y = drawHero(doc, y, "VERSÉ CE JOUR", total, split) + (compact ? 18 : 22);

  const step = compact ? 23 : 26.5;
  const rows = [
    ["Montant total dû (scolarité)", money(snapshot.due)],
    ["Déjà versé avant ce jour", money(paidBefore)],
    ["Cumul versé à ce jour", money(snapshot.paidAfter)],
  ];
  if (snapshot.creditAfter > 0) rows.push(["Crédit", money(snapshot.creditAfter)]);
  if (!compact) rows[0][0] = "Montant total dû";
  for (const [label, value] of rows) {
    write(doc, label, LEFT + 12, y, 11, "Helvetica", MUTED, 300);
    write(doc, value, RIGHT - 230, y, 11, "Helvetica-Bold", INK, 218, "right");
    y += step;
  }
  doc.rect(LEFT, y - 8, WIDTH, 28).fill(settled ? "#e6efe9" : "#fbf2dc");
  const resteColor = settled ? LEAF : GOLD_TEXT;
  write(doc, compact ? "Reste à payer (scolarité)" : "Reste à payer", LEFT + 12, y, 12, "Helvetica-Bold", resteColor, 300);
  write(doc, money(snapshot.resteAfter), RIGHT - 230, y, 12, "Helvetica-Bold", resteColor, 218, "right");
  y += compact ? 32 : 44;

  if (costume) y = drawCostume(doc, y, costume) + 14;

  write(doc, "ARRÊTÉ LA PRÉSENTE SOMME VERSÉE À", LEFT, y, 7.5, "Helvetica-Bold", GREEN, WIDTH);
  doc.fillColor(INK).font("Times-Italic").fontSize(compact ? 12 : 13);
  doc.text(filled(snapshot.amountInWords, "Montant en lettres non disponible"), LEFT, y + 16, { width: WIDTH, height: 30 });
  y += compact ? 44 : 52;

  write(doc, "Mode de paiement", LEFT, y, 10, "Helvetica", MUTED, 250);
  write(doc, filled(snapshot.methodLabel, "Espèces"), LEFT, y + 17, 11, "Helvetica-Bold", INK, 250);
  if (reference) {
    write(doc, "Référence transaction", RIGHT - 250, y, 10, "Helvetica", MUTED, 250, "right");
    write(doc, reference, RIGHT - 250, y + 17, 11, "Helvetica-Bold", INK, 250, "right");
  }
  y += compact ? 34 : 40;
  if (snapshot.installment && snapshot.installmentLabel && y < 676) {
    write(doc, snapshot.installmentLabel, LEFT, y, 8.5, "Helvetica", MUTED, WIDTH);
    y += 14;
  }
  if (cancelled) {
    const reason = `Annulé : ${cancelled.reason}${cancelled.credit_note_number ? ` · avoir ${cancelled.credit_note_number}` : ""}`;
    write(doc, reason, LEFT, Math.min(y, 676), 9, "Helvetica-Bold", GOLD_TEXT, WIDTH);
  }

  drawFoot(doc, qr, receipt.number);
  drawWatermark(doc, W, 505);
  drawSeal(doc, RIGHT - 70, 134, 36, sealTitle, yearLabel.slice(0, 9), sealColor);
  doc.end();
  return done;
}

export async function renderEnrollmentPdf({ snapshot, receipt, school, format = "a4", verifyUrl }) {
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 240 });
  const { doc, done } = openDoc(format);
  const yearLabel = filled(snapshot.year, "2026-2027");
  const scholar = Boolean(snapshot.scholar);

  drawHead(doc, {
    school,
    number: receipt.number,
    dateIso: snapshot.issuedOn,
    title: "REÇU D'INSCRIPTION",
    subtitle: `Confirmation d'inscription — année ${yearLabel}`,
  });
  let y = drawIdentity(doc, snapshot, 181);
  const details = [];
  if (snapshot.registration) details.push(["dont frais d'inscription", scholar ? "Exonéré (boursier)" : money(snapshot.registration)]);
  if (snapshot.costumePrice) details.push(["Costume (à part)", money(snapshot.costumePrice)]);
  y = drawHero(doc, y, scholar ? "FRAIS ANNUELS — BOURSIER" : "FRAIS ANNUELS", snapshot.tuition, details) + 20;

  write(doc, "ÉCHÉANCIER", LEFT, y, 7.5, "Helvetica-Bold", GREEN, 200);
  y += 16;
  doc.rect(LEFT, y, WIDTH, 22).fill("#f2f5f3");
  write(doc, "Échéance", LEFT + 12, y + 7, 8.5, "Helvetica-Bold", MUTED, 220);
  write(doc, "Date limite", LEFT + 250, y + 7, 8.5, "Helvetica-Bold", MUTED, 120);
  write(doc, "Montant", RIGHT - 192, y + 7, 8.5, "Helvetica-Bold", MUTED, 180, "right");
  y += 30;
  const plan = (snapshot.plan || []).slice(0, 5);
  if (!plan.length) {
    write(doc, "Aucune échéance : frais pris en charge.", LEFT + 12, y, 10.5, "Helvetica", MUTED, 400);
    y += 24;
  }
  for (const item of plan) {
    write(doc, item.label, LEFT + 12, y, 11, "Helvetica", INK, 230);
    write(doc, frenchDate(item.dueOn) || "—", LEFT + 250, y, 11, "Helvetica", INK, 120);
    write(doc, money(item.amount), RIGHT - 192, y, 11, "Helvetica-Bold", INK, 180, "right");
    y += 18;
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor("#e3e9e5").stroke();
    y += 8;
  }
  doc.rect(LEFT, y, WIDTH, 28).fill("#e6efe9");
  write(doc, "Total des frais annuels", LEFT + 12, y + 8, 12, "Helvetica-Bold", LEAF, 300);
  write(doc, money(snapshot.tuition), RIGHT - 230, y + 8, 12, "Helvetica-Bold", LEAF, 218, "right");
  y += 46;

  write(doc, "ARRÊTÉ LES FRAIS ANNUELS À", LEFT, y, 7.5, "Helvetica-Bold", GREEN, WIDTH);
  doc.fillColor(INK).font("Times-Italic").fontSize(13);
  doc.text(filled(snapshot.tuitionInWords, "Montant en lettres non disponible"), LEFT, y + 16, { width: WIDTH, height: 34 });
  y += 52;
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5);
  doc.text("Ce reçu confirme l'inscription. Il ne constate pas un paiement : chaque versement reçoit son propre reçu de paiement.", LEFT, Math.min(y, 660), { width: WIDTH, height: 24 });

  drawFoot(doc, qr, receipt.number);
  drawWatermark(doc, W, 505);
  drawSeal(doc, RIGHT - 70, 134, 36, "INSCRIT", yearLabel.slice(0, 9), LEAF);
  doc.end();
  return done;
}
