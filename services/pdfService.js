// backend/services/pdfService.js
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// ═══════════════════════════════════════════════
// CONFIGURATION A4 PAYSAGE
// ═══════════════════════════════════════════════
// A4 = 595.28 x 841.89 pt en portrait
// A4 paysage = 841.89 x 595.28 pt
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 40;

const COLORS = {
  primary: '#1e3a5f',      // Bleu foncé (brand)
  primaryLight: '#3b6db8',
  accent: '#f59e0b',       // Orange (accent)
  success: '#10b981',      // Vert
  danger: '#ef4444',       // Rouge
  warning: '#f59e0b',      // Jaune
  slate900: '#0f172a',
  slate700: '#334155',
  slate500: '#64748b',
  slate300: '#cbd5e1',
  slate100: '#f1f5f9',
  slate50: '#f8fafc',
  white: '#ffffff',
};

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function safe(str) {
  return String(str ?? '');
}

function formatMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR').format(n) + ' FCFA';
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('fr-FR').format(n);
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return String(d);
  }
}

// ═══════════════════════════════════════════════
// EN-TÊTE : bandeau + logo + titre + période
// ═══════════════════════════════════════════════
function drawHeader(doc, { title, subtitle, period, meta }) {
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  // Bandeau principal
  doc.rect(0, 0, PAGE_WIDTH, 90).fill(COLORS.primary);

  // Bande de couleur accent (fine ligne en bas du bandeau)
  doc.rect(0, 90, PAGE_WIDTH, 4).fill(COLORS.accent);

  // Cercle décoratif droit
  doc.circle(PAGE_WIDTH - 60, 45, 40).fillOpacity(0.1).fill(COLORS.white).fillOpacity(1);

  // Logo "KGG" en carré
  doc
    .roundedRect(MARGIN, 25, 42, 42, 8)
    .fill(COLORS.accent);
  doc
    .fillColor(COLORS.primary)
    .fontSize(16)
    .font('Helvetica-Bold')
    .text('KGG', MARGIN, 36, { width: 42, align: 'center' });

  // Titre
  doc
    .fillColor(COLORS.white)
    .fontSize(20)
    .font('Helvetica-Bold')
    .text('KHAMIS GLOBALE GROUPES', MARGIN + 55, 28, { width: contentWidth - 55 });

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor('#cbd5e1')
    .text(title || 'Rapport', MARGIN + 55, 50);

  // Période / date à droite
  if (period) {
    doc
      .fontSize(9)
      .fillColor('#cbd5e1')
      .font('Helvetica')
      .text(period, PAGE_WIDTH - MARGIN - 200, 32, { width: 200, align: 'right' });
  }
  doc
    .fontSize(9)
    .fillColor('#cbd5e1')
    .font('Helvetica')
    .text(
      `Généré le ${new Date().toLocaleDateString('fr-FR')}`,
      PAGE_WIDTH - MARGIN - 200,
      48,
      { width: 200, align: 'right' }
    );

  // Sous-titre sous le bandeau
  let y = 110;
  if (subtitle) {
    doc
      .fillColor(COLORS.slate700)
      .fontSize(11)
      .font('Helvetica')
      .text(subtitle, MARGIN, y, { width: contentWidth });
    y += 20;
  }

  // Meta (KPIs clés) en cartes
  if (meta && Object.keys(meta).length > 0) {
    const cards = Object.entries(meta).slice(0, 4);
    const cardWidth = (contentWidth - 12 * (cards.length - 1)) / cards.length;
    const cardHeight = 60;

    cards.forEach(([key, value], i) => {
      const x = MARGIN + i * (cardWidth + 12);

      // Carte
      doc
        .roundedRect(x, y, cardWidth, cardHeight, 8)
        .fill(COLORS.slate50)
        .stroke(COLORS.slate300);

      // Label
      doc
        .fillColor(COLORS.slate500)
        .fontSize(8)
        .font('Helvetica')
        .text(key.toUpperCase(), x + 12, y + 12, { width: cardWidth - 24, characterSpacing: 0.5 });

      // Valeur
      doc
        .fillColor(COLORS.primary)
        .fontSize(16)
        .font('Helvetica-Bold')
        .text(value, x + 12, y + 28, { width: cardWidth - 24 });
    });

    y += cardHeight + 16;
  }

  return y;
}

// ═══════════════════════════════════════════════
// PIED DE PAGE : numérotation + signature
// ═══════════════════════════════════════════════
function drawFooter(doc, pageNumber, totalPages) {
  const footerY = PAGE_HEIGHT - 30;
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  // Ligne de séparation
  doc
    .moveTo(MARGIN, footerY - 8)
    .lineTo(PAGE_WIDTH - MARGIN, footerY - 8)
    .strokeColor(COLORS.slate300)
    .lineWidth(0.5)
    .stroke();

  // Texte gauche
  doc
    .fillColor(COLORS.slate500)
    .fontSize(8)
    .font('Helvetica')
    .text('KHAMIS GLOBALE GROUPES — Document confidentiel', MARGIN, footerY, {
      width: contentWidth / 2,
    });

  // Page numéro à droite
  doc
    .fillColor(COLORS.slate500)
    .fontSize(8)
    .font('Helvetica')
    .text(`Page ${pageNumber} / ${totalPages}`, PAGE_WIDTH - MARGIN - 100, footerY, {
      width: 100,
      align: 'right',
    });
}

// ═══════════════════════════════════════════════
// EN-TÊTE DU TABLEAU
// ═══════════════════════════════════════════════
function drawTableHeader(doc, { columns, y }) {
  const rowHeight = 32;

  // Fond
  doc
    .rect(MARGIN, y, PAGE_WIDTH - 2 * MARGIN, rowHeight)
    .fill(COLORS.primary);

  // Colonnes
  let x = MARGIN;
  columns.forEach((col) => {
    doc
      .fillColor(COLORS.white)
      .fontSize(9)
      .font('Helvetica-Bold')
      .text(
        col.header.toUpperCase(),
        x + 8,
        y + 11,
        {
          width: col.width - 16,
          align: col.align || 'left',
          characterSpacing: 0.5,
        }
      );
    x += col.width;
  });

  return y + rowHeight;
}

// ═══════════════════════════════════════════════
// LIGNE DU TABLEAU
// ═══════════════════════════════════════════════
function drawTableRow(doc, { row, columns, y, rowIndex, rowHeight = 26 }) {
  const isEven = rowIndex % 2 === 0;

  // Alternance fond
  if (isEven) {
    doc
      .rect(MARGIN, y, PAGE_WIDTH - 2 * MARGIN, rowHeight)
      .fill(COLORS.slate50);
  }

  // Séparateur
  doc
    .moveTo(MARGIN, y + rowHeight)
    .lineTo(PAGE_WIDTH - MARGIN, y + rowHeight)
    .strokeColor('#e2e8f0')
    .lineWidth(0.3)
    .stroke();

  // Contenu
  let x = MARGIN;
  columns.forEach((col) => {
    let value = row[col.key];
    let color = COLORS.slate700;
    let font = 'Helvetica';
    let fontSize = 9;

    // Rendu custom
    if (col.render) {
      const rendered = col.render(row);
      if (typeof rendered === 'object' && rendered !== null) {
        value = rendered.text;
        color = rendered.color || color;
        font = rendered.font || font;
      } else {
        value = rendered;
      }
    } else {
      // Format auto
      if (col.format === 'money') value = formatMoney(value);
      else if (col.format === 'date') value = formatDate(value);
      else if (col.format === 'number') value = formatNumber(value);
      else value = safe(value) || '—';
    }

    doc
      .fillColor(color)
      .fontSize(fontSize)
      .font(font)
      .text(String(value ?? '—'), x + 8, y + 8, {
        width: col.width - 16,
        align: col.align || 'left',
        ellipsis: true,
        height: rowHeight - 8,
      });

    x += col.width;
  });

  return y + rowHeight;
}

// ═══════════════════════════════════════════════
// GÉNÉRATION PDF PRINCIPALE
// ═══════════════════════════════════════════════
function generateTablePDF({
  title = 'Rapport',
  subtitle = '',
  columns = [],
  rows = [],
  meta = {},
  period = '',
  footer = '',
}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 0,
        info: {
          Title: title,
          Author: 'KHAMIS GLOBALE GROUPES',
          Subject: subtitle || title,
          Creator: 'Plateforme KHAMIS',
        },
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ─────────────────────────────────────
      // Calcul du nombre de pages (estimation)
      // ─────────────────────────────────────
      const ROW_HEIGHT = 26;
      const HEADER_HEIGHT = 90 + 4 + 20 + (subtitle ? 20 : 0) + (Object.keys(meta).length > 0 ? 76 : 0);
      const TABLE_HEADER = 32;
      const FOOTER_HEIGHT = 40;
      const AVAILABLE_FIRST_PAGE = PAGE_HEIGHT - HEADER_HEIGHT - TABLE_HEADER - FOOTER_HEIGHT - 20;
      const AVAILABLE_OTHER_PAGES = PAGE_HEIGHT - 40 - TABLE_HEADER - FOOTER_HEIGHT - 20;
      const ROWS_FIRST = Math.floor(AVAILABLE_FIRST_PAGE / ROW_HEIGHT);
      const ROWS_OTHER = Math.floor(AVAILABLE_OTHER_PAGES / ROW_HEIGHT);

      let totalPages = 1;
      if (rows.length > ROWS_FIRST) {
        totalPages = 1 + Math.ceil((rows.length - ROWS_FIRST) / ROWS_OTHER);
      }

      // ─────────────────────────────────────
      // RENDU PAGE 1
      // ─────────────────────────────────────
      let y = drawHeader(doc, { title, subtitle, period, meta });
      let pageNumber = 1;

      // Tableau : en-tête
      y = drawTableHeader(doc, { columns, y });

      // Lignes
      let rowIndex = 0;
      let rowsOnCurrentPage = 0;
      const maxRowsFirstPage = ROWS_FIRST;

      for (const row of rows) {
        // Vérifier s'il faut changer de page
        if (
          (pageNumber === 1 && rowsOnCurrentPage >= maxRowsFirstPage) ||
          (pageNumber > 1 && y + ROW_HEIGHT > PAGE_HEIGHT - FOOTER_HEIGHT - 20)
        ) {
          drawFooter(doc, pageNumber, totalPages);
          doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
          pageNumber++;

          // En-tête compact pour les pages suivantes
          doc.rect(0, 0, PAGE_WIDTH, 40).fill(COLORS.primary);
          doc
            .fillColor(COLORS.white)
            .fontSize(12)
            .font('Helvetica-Bold')
            .text('KHAMIS GLOBALE GROUPES', MARGIN, 14);
          doc
            .fontSize(9)
            .font('Helvetica')
            .fillColor('#cbd5e1')
            .text(title, MARGIN, 30);
          doc
            .fontSize(8)
            .fillColor('#cbd5e1')
            .font('Helvetica')
            .text(
              `Page ${pageNumber}`,
              PAGE_WIDTH - MARGIN - 100,
              16,
              { width: 100, align: 'right' }
            );

          y = 55;
          y = drawTableHeader(doc, { columns, y });
          rowsOnCurrentPage = 0;
        }

        // Dessiner la ligne
        y = drawTableRow(doc, { row, columns, y, rowIndex, rowHeight: ROW_HEIGHT });
        rowIndex++;
        rowsOnCurrentPage++;
      }

      // Message si aucune donnée
      if (rows.length === 0) {
        doc
          .fillColor(COLORS.slate500)
          .fontSize(11)
          .font('Helvetica-Oblique')
          .text('Aucune donnée à afficher', MARGIN, y + 40, {
            width: PAGE_WIDTH - 2 * MARGIN,
            align: 'center',
          });
      }

      // Pied de page dernière page
      drawFooter(doc, pageNumber, totalPages);

      // Watermark "KHAMIS" en bas à droite (discret)
      doc.save();
      doc.opacity(0.05);
      doc
        .fontSize(80)
        .font('Helvetica-Bold')
        .fillColor(COLORS.primary)
        .text('KHAMIS', 500, 480, { width: 400, align: 'right' });
      doc.restore();

      // Footer custom (optionnel)
      if (footer) {
        doc
          .fillColor(COLORS.slate500)
          .fontSize(8)
          .font('Helvetica-Oblique')
          .text(footer, MARGIN, PAGE_HEIGHT - 18, {
            width: PAGE_WIDTH - 2 * MARGIN,
            align: 'center',
          });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateTablePDF };