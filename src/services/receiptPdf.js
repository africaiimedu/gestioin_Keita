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

const SEAL_FONT = "Helvetica-Bold";
const SEAL_ASCENT = 0.718;
const SEAL_CAP = 0.72;
const SEAL_ACCENT = 0.2;

function arcWidth(doc, text, size) {
  doc.font(SEAL_FONT).fontSize(size);
  const chars = Array.from(text);
  return chars.reduce((sum, ch) => sum + doc.widthOfString(ch), 0) + size * 0.14 * Math.max(0, chars.length - 1);
}

/**
 * Texte droit et lisible le long du cercle, centré sur le haut (-90°) ou sur le bas (90°).
 * En haut, la ligne de base est à l'intérieur ; en bas, à l'extérieur : les lettres ne sont jamais à l'envers.
 */
function arcText(doc, text, baseline, size, side) {
  const chars = Array.from(text);
  doc.font(SEAL_FONT).fontSize(size);
  const spacing = size * 0.14;
  const widths = chars.map((ch) => doc.widthOfString(ch));
  const middle = side === "top" ? baseline + size * SEAL_CAP / 2 : baseline - size * SEAL_CAP / 2;
  const total = arcWidth(doc, text, size) / middle;
  const direction = side === "top" ? 1 : -1;
  let cursor = (side === "top" ? -Math.PI / 2 : Math.PI / 2) - direction * total / 2;
  chars.forEach((ch, index) => {
    const step = widths[index] / middle;
    const angle = cursor + direction * step / 2;
    doc.save();
    doc.translate(Math.cos(angle) * baseline, Math.sin(angle) * baseline);
    doc.rotate((angle * 180) / Math.PI + (side === "top" ? 90 : -90));
    doc.text(ch, -widths[index] / 2, -size * SEAL_ASCENT, { lineBreak: false });
    doc.restore();
    cursor += direction * (step + spacing / middle);
  });
}

/** Plus grande taille (bornée) pour que le texte tienne dans l'angle donné, à ce rayon. */
function arcFit(doc, text, radius, spanDeg, maxSize) {
  const room = radius * (spanDeg * Math.PI) / 180;
  return Math.min(maxSize, maxSize * room / arcWidth(doc, text, maxSize));
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

function drawSeal(doc, x, y, radius, title, year, color, { top = "UNIVERSITÉ AFRICAIIM", bottom = "SCOLARITÉ" } = {}) {
  const outer = radius - 3.2;
  const gap = Math.max(1.2, radius * 0.035);
  const topSize = arcFit(doc, top, outer - radius * 0.14, 150, radius * 0.19);
  const bottomSize = arcFit(doc, bottom, outer - radius * 0.14, 110, radius * 0.19);
  const ringSize = Math.max(topSize, bottomSize);
  const inner = outer - gap * 2 - ringSize * (SEAL_CAP + SEAL_ACCENT);

  doc.save();
  doc.translate(x, y);
  doc.rotate(-10);
  doc.fillColor("#ffffff").opacity(1);
  doc.circle(0, 0, radius - 0.4).fill();
  doc.fillColor(color).opacity(0.07);
  doc.circle(0, 0, radius - 0.4).fill();
  doc.opacity(0.95).strokeColor(color).fillColor(color);
  doc.lineWidth(1.7).circle(0, 0, radius).stroke();
  doc.lineWidth(0.6).circle(0, 0, outer).stroke();
  doc.lineWidth(0.6).circle(0, 0, inner).stroke();

  arcText(doc, top, inner + gap, topSize, "top");
  arcText(doc, bottom, outer - gap, bottomSize, "bottom");
  const starAt = (outer + inner) / 2;
  stampStar(doc, -starAt, 0, Math.min(2.2, (outer - inner) * 0.3));
  stampStar(doc, starAt, 0, Math.min(2.2, (outer - inner) * 0.3));

  const parts = title.split(" ").filter(Boolean);
  const yearSize = Math.max(4.4, radius * 0.14);
  doc.font(SEAL_FONT);
  const widest = Math.max(...parts.map((line) => doc.fontSize(10).widthOfString(line)));
  let centerSize = Math.min(radius * (parts.length > 1 ? 0.26 : 0.32), 10 * (inner * 1.45) / widest);
  for (let i = 0; i < 6; i += 1) {
    const blockHeight = parts.length * centerSize * 1.05 + yearSize + 2;
    const halfWidth = Math.sqrt(Math.max(0, (inner - 2.5) ** 2 - (blockHeight / 2) ** 2));
    const fit = 10 * (halfWidth * 2) / widest;
    if (centerSize <= fit) break;
    centerSize = fit;
  }
  const lineHeight = centerSize * 1.05;
  let textY = -((parts.length * lineHeight + yearSize + 2) / 2);
  doc.font(SEAL_FONT).fontSize(centerSize).fillColor(color);
  for (const line of parts) {
    doc.text(line, -doc.widthOfString(line) / 2, textY + centerSize * (1 - SEAL_ASCENT) * 0.5, { lineBreak: false });
    textY += lineHeight;
  }
  doc.font("Helvetica").fontSize(yearSize);
  doc.text(year, -doc.widthOfString(year) / 2, textY + 2, { lineBreak: false });
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

function drawHead(doc, { school, number, dateIso, title, subtitle, kind = "REÇU OFFICIEL" }) {
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
  write(doc, kind, boxX, 37, 7.5, "Helvetica", MUTED, 141, "center");
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
  const quantity = Math.max(1, Number(costume.quantity || 1));
  const unit = Number(costume.unitPrice || costume.price);
  doc.roundedRect(LEFT, y, WIDTH, 50, 8).lineWidth(0.9).strokeColor("#cfdcd4").stroke();
  write(doc, quantity > 1 ? `COSTUMES (${quantity})` : "COSTUME", LEFT + 12, y + 8, 7.5, "Helvetica-Bold", LEAF, 120);
  write(doc, settled ? "Payé" : (costume.paidAfter > 0 ? "Partiellement payé" : "Non payé"), RIGHT - 132, y + 8, 7.5, "Helvetica-Bold", settled ? LEAF : GOLD_TEXT, 120, "right");
  const cells = [
    [quantity > 1 ? `${quantity} × ${money(unit)}` : "Prix du costume", money(costume.price), INK],
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

const HISTORY_LINES = 4;

function drawHistory(doc, y, history) {
  const shown = history.length > HISTORY_LINES ? history.slice(-(HISTORY_LINES - 1)) : history;
  const older = history.slice(0, history.length - shown.length);
  write(doc, "VERSEMENTS PRÉCÉDENTS", LEFT + 12, y, 7.5, "Helvetica-Bold", LEAF, 300);
  y += 14;
  const line = (left, middle, amount) => {
    write(doc, left, LEFT + 24, y, 9.5, "Helvetica", INK, 150);
    write(doc, middle, LEFT + 175, y, 9.5, "Helvetica", MUTED, 200);
    write(doc, money(amount), RIGHT - 230, y, 9.5, "Helvetica", INK, 218, "right");
    y += 14;
  };
  if (older.length) {
    const total = older.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    line(`${older.length} versements antérieurs`, `du ${frenchDate(older[0].paidOn)} au ${frenchDate(older.at(-1).paidOn)}`, total);
  }
  for (const item of shown) {
    line(frenchDate(item.paidOn), [item.receiptNumber || "Avant l'application", item.methodLabel].filter(Boolean).join(" · "), item.amount);
  }
  return y + 6;
}

export async function renderReceiptPdf({ snapshot, receipt, school, format = "a4", cancelled = null, replacedBy = null, verifyUrl }) {
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 240 });
  const { doc, done } = openDoc(format);
  const costume = snapshot.costume || null;
  const history = !costume && Array.isArray(snapshot.history) ? snapshot.history : [];
  const compact = Boolean(costume) || history.length > 0;
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
  if (!costume) rows[0][0] = "Montant total dû";
  rows.forEach(([label, value], index) => {
    if (index === 1 && history.length) y = drawHistory(doc, y - 4, history);
    write(doc, label, LEFT + 12, y, 11, "Helvetica", MUTED, 300);
    write(doc, value, RIGHT - 230, y, 11, "Helvetica-Bold", INK, 218, "right");
    y += step;
  });
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
  } else if (replacedBy) {
    const note = `Versement repris dans le reçu ${replacedBy.number} du ${frenchDate(replacedBy.paidOn)}, qui fait foi pour le cumul.`;
    write(doc, note, LEFT, Math.min(y, 676), 9, "Helvetica-Bold", GOLD_TEXT, WIDTH);
  }

  drawFoot(doc, qr, receipt.number);
  drawWatermark(doc, W, 505);
  drawSeal(doc, RIGHT - 66, 136, 40, sealTitle, yearLabel.slice(0, 9), sealColor);
  doc.end();
  return done;
}

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

function longDate(iso) {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(iso || "");
  const day = Number(match[3]);
  return `${day === 1 ? "1er" : day} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function paragraph(doc, parts, y, size = 12.5) {
  doc.fontSize(size);
  parts.forEach(([text, strong], index) => {
    doc.font(strong ? "Times-Bold" : "Times-Roman").fillColor(strong ? GREEN : INK);
    const options = { width: WIDTH - 24, lineGap: 4, continued: index < parts.length - 1 };
    if (index === 0) doc.text(text, LEFT + 12, y, options);
    else doc.text(text, options);
  });
  return doc.y + 10;
}

function drawSignature(doc, x, y, width, title, name) {
  doc.roundedRect(x, y, width, 118, 8).lineWidth(0.9).strokeColor("#cfdcd4").stroke();
  doc.rect(x, y, width, 24).fill("#f2f5f3");
  write(doc, title, x + 12, y + 8, 8, "Helvetica-Bold", LEAF, width - 24);
  write(doc, "Nom et prénom :", x + 12, y + 34, 8.5, "Helvetica", MUTED, width - 24);
  write(doc, name, x + 12, y + 47, 11.5, "Helvetica-Bold", INK, width - 24);
  write(doc, "Signature :", x + 12, y + 70, 8.5, "Helvetica", MUTED, width - 24);
  doc.moveTo(x + 12, y + 104).lineTo(x + width - 12, y + 104).lineWidth(0.6).dash(2, { space: 2 }).strokeColor("#9aa59f").stroke().undash();
}

export async function renderDischargePdf({ expense, school, verifyUrl }) {
  const qr = await QRCode.toBuffer(verifyUrl, { margin: 0, width: 240 });
  const { doc, done } = openDoc("a4");
  const cancelled = expense.status === "annule";
  const city = filled(expense.city, "Conakry");
  const amount = money(expense.amount);

  drawHead(doc, {
    school,
    number: expense.number,
    dateIso: expense.issued_on,
    kind: "DÉCHARGE",
    title: "DÉCHARGE DE RESPONSABILITÉ FINANCIÈRE",
    subtitle: `Dépense — ${filled(expense.categoryLabel, "Autre")}`,
  });

  let y = 181;
  doc.roundedRect(LEFT, y, WIDTH, 50, 10).fill("#f2f5f3");
  [["NATURE DE LA DÉPENSE", filled(expense.categoryLabel, "Autre")], ["FAIT À", city], ["DATE", longDate(expense.issued_on)]]
    .forEach(([label, value], index) => {
      const x = LEFT + 14 + index * (WIDTH / 3);
      write(doc, label, x, y + 11, 7.5, "Helvetica", MUTED, WIDTH / 3 - 20);
      write(doc, value, x, y + 26, 12, "Helvetica-Bold", INK, WIDTH / 3 - 20);
    });
  y += 66;

  doc.roundedRect(LEFT, y, WIDTH, 74, 8).fill("#e6efe9");
  doc.rect(LEFT, y, 5, 74).fill(LEAF);
  write(doc, "SOMME REMISE", LEFT + 25, y + 16, 8, "Helvetica-Bold", LEAF, 300);
  write(doc, amount, LEFT + 25, y + 34, 27, "Helvetica-Bold", GREEN, 330);
  drawSeal(doc, RIGHT - 60, y + 37, 35, cancelled ? "ANNULÉE" : "SORTIE CAISSE", String(expense.issued_on || "").slice(0, 4), cancelled ? GOLD_TEXT : LEAF);
  y += 96;

  y = paragraph(doc, [
    ["Je soussigné(e), "], [filled(expense.receiver_name, "—"), true], [", "], [filled(expense.receiver_position, "—"), true],
    [", reconnais avoir reçu de "], [filled(expense.giver_name, "—"), true],
    [" la somme de "], [amount, true], [" ("], [filled(expense.amountInWords, "—"), true], [")."],
  ], y);
  y = paragraph(doc, [["Cette somme m'a été remise au titre de : "], [filled(expense.reason, "—"), true], ["."]], y);
  y = paragraph(doc, [[
    "Je reconnais la réception effective de cette somme et déclare en assumer désormais l'entière responsabilité, "
    + "la personne qui me l'a remise en étant déchargée.",
  ]], y);
  y = paragraph(doc, [["La présente décharge est établie pour servir et valoir ce que de droit."]], y);
  y = paragraph(doc, [["Fait à "], [city, true], [", le "], [longDate(expense.issued_on), true], ["."]], y);

  const top = Math.max(y + 8, 548);
  const half = (WIDTH - 16) / 2;
  drawSignature(doc, LEFT, top, half, "LA PERSONNE QUI REMET L'ARGENT", filled(expense.giver_name, ""));
  drawSignature(doc, LEFT + half + 16, top, half, "LA PERSONNE QUI REÇOIT L'ARGENT", filled(expense.receiver_name, ""));

  const foot = 700;
  doc.moveTo(LEFT, foot).lineTo(RIGHT, foot).lineWidth(0.7).strokeColor("#dfe6e2").stroke();
  doc.image(qr, LEFT, foot + 14, { width: 66 });
  write(doc, "Vérification du document", LEFT + 80, foot + 22, 8.5, "Helvetica-Bold", INK, 220);
  write(doc, "Scannez le code pour contrôler", LEFT + 80, foot + 36, 8, "Helvetica", MUTED, 220);
  write(doc, "l'authenticité de cette décharge.", LEFT + 80, foot + 48, 8, "Helvetica", MUTED, 220);
  if (expense.created_by_name) write(doc, `Saisie par ${expense.created_by_name}`, RIGHT - 240, foot + 22, 8.5, "Helvetica", MUTED, 240, "right");
  write(doc, `Document n° ${expense.number}`, RIGHT - 240, foot + 36, 8.5, "Helvetica-Bold", INK, 240, "right");
  if (cancelled) {
    write(doc, `ANNULÉE : ${filled(expense.cancel_reason, "")}`, RIGHT - 300, foot + 52, 8.5, "Helvetica-Bold", GOLD_TEXT, 300, "right");
  }
  const band = `UNIVERSITÉ AFRICAIIM — ${expense.number}`;
  write(doc, `${band} — ${band}`, LEFT - 10, 818, 6.5, "Helvetica", "#8a948f", WIDTH + 20, "center");
  drawWatermark(doc, W, 470);
  doc.end();
  return done;
}