import PDFDocument from "pdfkit";

/** Liste imprimable, sans les données d'un reçu. */
export function renderListPdf({ title, subtitle, columns, rows }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    const width = doc.page.width - 72;
    const drawHead = () => {
      doc.font("Helvetica-Bold").fontSize(16).fillColor("#0c3d2e").text(title, 36, 32, { width, lineBreak: false });
      doc.font("Helvetica").fontSize(9).fillColor("#3d463f").text(subtitle, 36, 54, { width });
      let x = 36;
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#0c3d2e");
      for (const column of columns) {
        doc.text(column.label, x, 78, { width: column.width - 6, lineBreak: false });
        x += column.width;
      }
      doc.moveTo(36, 94).lineTo(36 + width, 94).strokeColor("#c5d5cb").stroke();
      return 102;
    };
    let y = drawHead();
    doc.font("Helvetica").fontSize(8).fillColor("#1c2420");
    for (const row of rows) {
      if (y > doc.page.height - 42) {
        doc.addPage();
        y = drawHead();
        doc.font("Helvetica").fontSize(8).fillColor("#1c2420");
      }
      let x = 36;
      row.forEach((cell, index) => {
        const column = columns[index];
        doc.text(String(cell ?? ""), x, y, { width: column.width - 6, height: 12, ellipsis: true, lineBreak: false, align: column.align || "left" });
        x += column.width;
      });
      y += 16;
    }
    if (!rows.length) doc.text("Aucune fiche.", 36, y);
    doc.end();
  });
}
