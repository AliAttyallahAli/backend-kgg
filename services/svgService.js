// backend/services/svgService.js
// Génère un rapport SVG A4 paysage moderne
// A4 paysage : 1123 x 794 px (ratio 842x595 pt à 96 DPI ≈ 1123x794)

// ═══════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════
const PAGE_WIDTH = 1123;
const PAGE_HEIGHT = 794;
const MARGIN = 50;

const COLORS = {
  primary: '#1e3a5f',
  primaryLight: '#3b6db8',
  accent: '#f59e0b',
  success: '#10b981',
  danger: '#ef4444',
  warning: '#f59e0b',
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
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
// TRONCATURE TEXTE
// ═══════════════════════════════════════════════
function truncate(str, maxChars) {
  const s = String(str ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1) + '…';
}

// ═══════════════════════════════════════════════
// EN-TÊTE DU RAPPORT
// ═══════════════════════════════════════════════
function renderHeader({ title, subtitle, period, meta }) {
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;
  const yHeader = 0;
  const headerHeight = 120;

  // Bandeau principal
  let svg = `
    <rect x="0" y="${yHeader}" width="${PAGE_WIDTH}" height="${headerHeight}" fill="${COLORS.primary}"/>
    <rect x="0" y="${headerHeight}" width="${PAGE_WIDTH}" height="5" fill="${COLORS.accent}"/>
  `;

  // Cercle décoratif droit
  svg += `
    <circle cx="${PAGE_WIDTH - 70}" cy="60" r="55" fill="${COLORS.white}" fill-opacity="0.08"/>
  `;

  // Logo "KGG"
  svg += `
    <rect x="${MARGIN}" y="35" width="52" height="52" rx="10" fill="${COLORS.accent}"/>
    <text x="${MARGIN + 26}" y="70" font-family="Helvetica, Arial, sans-serif"
          font-size="20" font-weight="800" fill="${COLORS.primary}" text-anchor="middle">
      KGG
    </text>
  `;

  // Titre
  svg += `
    <text x="${MARGIN + 68}" y="55" font-family="Helvetica, Arial, sans-serif"
          font-size="24" font-weight="800" fill="${COLORS.white}">
      KHAMIS GLOBALE GROUPES
    </text>
    <text x="${MARGIN + 68}" y="80" font-family="Helvetica, Arial, sans-serif"
          font-size="13" fill="#cbd5e1">
      ${escapeXml(title || 'Rapport')}
    </text>
  `;

  // Période à droite
  if (period) {
    svg += `
      <text x="${PAGE_WIDTH - MARGIN}" y="50" font-family="Helvetica, Arial, sans-serif"
            font-size="12" fill="#cbd5e1" text-anchor="end">
        ${escapeXml(period)}
      </text>
    `;
  }
  svg += `
    <text x="${PAGE_WIDTH - MARGIN}" y="70" font-family="Helvetica, Arial, sans-serif"
          font-size="12" fill="#cbd5e1" text-anchor="end">
      Généré le ${new Date().toLocaleDateString('fr-FR')}
    </text>
  `;

  // Sous-titre
  let y = headerHeight + 25;
  if (subtitle) {
    svg += `
      <text x="${MARGIN}" y="${y}" font-family="Helvetica, Arial, sans-serif"
            font-size="14" fill="${COLORS.slate700}">
        ${escapeXml(subtitle)}
      </text>
    `;
    y += 25;
  }

  // KPIs en cartes
  if (meta && Object.keys(meta).length > 0) {
    const cards = Object.entries(meta).slice(0, 4);
    const cardWidth = (contentWidth - 15 * (cards.length - 1)) / cards.length;
    const cardHeight = 75;

    cards.forEach(([key, value], i) => {
      const x = MARGIN + i * (cardWidth + 15);

      svg += `
        <rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}"
              rx="10" fill="${COLORS.slate50}" stroke="${COLORS.slate300}" stroke-width="1"/>
        <text x="${x + 15}" y="${y + 22}" font-family="Helvetica, Arial, sans-serif"
              font-size="10" font-weight="600" fill="${COLORS.slate500}"
              letter-spacing="0.8">
          ${escapeXml(key.toUpperCase())}
        </text>
        <text x="${x + 15}" y="${y + 52}" font-family="Helvetica, Arial, sans-serif"
              font-size="18" font-weight="700" fill="${COLORS.primary}">
          ${escapeXml(value)}
        </text>
      `;
    });

    y += cardHeight + 20;
  }

  return { svg, nextY: y };
}

// ═══════════════════════════════════════════════
// PIED DE PAGE
// ═══════════════════════════════════════════════
function renderFooter({ pageNumber, totalPages, pageOffsetY = 0 }) {
  const footerY = PAGE_HEIGHT - 35 + pageOffsetY;
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  return `
    <line x1="${MARGIN}" y1="${footerY - 10}" x2="${PAGE_WIDTH - MARGIN}" y2="${footerY - 10}"
          stroke="${COLORS.slate300}" stroke-width="0.5"/>
    <text x="${MARGIN}" y="${footerY + 4}" font-family="Helvetica, Arial, sans-serif"
          font-size="10" fill="${COLORS.slate500}">
      KHAMIS GLOBALE GROUPES — Document confidentiel
    </text>
    <text x="${PAGE_WIDTH - MARGIN}" y="${footerY + 4}" font-family="Helvetica, Arial, sans-serif"
          font-size="10" fill="${COLORS.slate500}" text-anchor="end">
      Page ${pageNumber} / ${totalPages}
    </text>
  `;
}

// ═══════════════════════════════════════════════
// WATERMARK
// ═══════════════════════════════════════════════
function renderWatermark({ pageOffsetY = 0 }) {
  return `
    <text x="${PAGE_WIDTH - 80}" y="${PAGE_HEIGHT - 80 + pageOffsetY}"
          font-family="Helvetica, Arial, sans-serif"
          font-size="100" font-weight="800" fill="${COLORS.primary}"
          fill-opacity="0.04" text-anchor="end">
      KHAMIS
    </text>
  `;
}

// ═══════════════════════════════════════════════
// EN-TÊTE TABLEAU
// ═══════════════════════════════════════════════
function renderTableHeader({ columns, y }) {
  const rowHeight = 38;
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  let svg = `
    <rect x="${MARGIN}" y="${y}" width="${contentWidth}" height="${rowHeight}"
          fill="${COLORS.primary}" rx="6"/>
  `;

  let x = MARGIN;
  columns.forEach((col) => {
    const anchor = col.align === 'right' ? 'end' : col.align === 'center' ? 'middle' : 'start';
    const textX =
      col.align === 'right'
        ? x + col.width - 10
        : col.align === 'center'
        ? x + col.width / 2
        : x + 10;

    svg += `
      <text x="${textX}" y="${y + 24}" font-family="Helvetica, Arial, sans-serif"
            font-size="11" font-weight="700" fill="${COLORS.white}"
            letter-spacing="0.5" text-anchor="${anchor}">
        ${escapeXml(col.header.toUpperCase())}
      </text>
    `;
    x += col.width;
  });

  return { svg, nextY: y + rowHeight };
}

// ═══════════════════════════════════════════════
// LIGNE TABLEAU
// ═══════════════════════════════════════════════
function renderTableRow({ row, columns, y, rowIndex, rowHeight = 30 }) {
  const isEven = rowIndex % 2 === 0;
  const contentWidth = PAGE_WIDTH - 2 * MARGIN;

  let svg = '';

  // Alternance
  if (isEven) {
    svg += `
      <rect x="${MARGIN}" y="${y}" width="${contentWidth}" height="${rowHeight}"
            fill="${COLORS.slate50}"/>
    `;
  }

  // Séparateur bas
  svg += `
    <line x1="${MARGIN}" y1="${y + rowHeight}" x2="${PAGE_WIDTH - MARGIN}" y2="${y + rowHeight}"
          stroke="#e2e8f0" stroke-width="0.5"/>
  `;

  // Cellules
  let x = MARGIN;
  columns.forEach((col) => {
    let value = row[col.key];
    let color = COLORS.slate700;
    let fontWeight = '400';

    // Rendu custom
    if (col.render) {
      const rendered = col.render(row);
      if (typeof rendered === 'object' && rendered !== null) {
        value = rendered.text;
        color = rendered.color || color;
        fontWeight = rendered.font === 'Helvetica-Bold' ? '700' : '400';
      } else {
        value = rendered;
      }
    } else {
      // Format auto
      if (col.format === 'money') value = formatMoney(value);
      else if (col.format === 'date') value = formatDate(value);
      else if (col.format === 'number') value = formatNumber(value);
      else value = String(value ?? '—');
    }

    // Troncature selon largeur
    const maxChars = Math.floor((col.width - 20) / 7);
    const displayValue = truncate(value, maxChars);

    const anchor =
      col.align === 'right' ? 'end' : col.align === 'center' ? 'middle' : 'start';
    const textX =
      col.align === 'right'
        ? x + col.width - 10
        : col.align === 'center'
        ? x + col.width / 2
        : x + 10;

    svg += `
      <text x="${textX}" y="${y + 20}" font-family="Helvetica, Arial, sans-serif"
            font-size="11" font-weight="${fontWeight}" fill="${color}"
            text-anchor="${anchor}">
        ${escapeXml(displayValue)}
      </text>
    `;
    x += col.width;
  });

  return { svg, nextY: y + rowHeight };
}

// ═══════════════════════════════════════════════
// GÉNÉRATION PRINCIPALE
// ═══════════════════════════════════════════════
function generateTableSVG({
  title = 'Rapport',
  subtitle = '',
  columns = [],
  rows = [],
  meta = {},
  period = '',
  footer = '',
}) {
  const ROW_HEIGHT = 30;
  const TABLE_HEADER = 38;
  const FOOTER_HEIGHT = 45;
  const PAGE_PADDING_TOP = 20;

  // Calcul des pages
  const firstPageHeader = renderHeader({ title, subtitle, period, meta });
  const firstPageTableTop = firstPageHeader.nextY + PAGE_PADDING_TOP;
  const firstPageAvailable = PAGE_HEIGHT - FOOTER_HEIGHT - firstPageTableTop - TABLE_HEADER;
  const rowsFirst = Math.floor(firstPageAvailable / ROW_HEIGHT);

  const otherPageTableTop = 40 + TABLE_HEADER + PAGE_PADDING_TOP;
  const otherPageAvailable = PAGE_HEIGHT - FOOTER_HEIGHT - otherPageTableTop;
  const rowsOther = Math.floor(otherPageAvailable / ROW_HEIGHT);

  let totalPages = 1;
  if (rows.length > rowsFirst) {
    totalPages = 1 + Math.ceil((rows.length - rowsFirst) / rowsOther);
  }

  // Construire toutes les pages
  let pagesSvg = '';
  let currentPage = 1;
  let rowIndex = 0;

  // ═══════ PAGE 1 ═══════
  let page1 = firstPageHeader.svg;
  let page1Y = firstPageTableTop;

  const header1 = renderTableHeader({ columns, y: page1Y });
  page1 += header1.svg;
  page1Y = header1.nextY;

  let rowsOnPage1 = 0;
  while (rowIndex < rows.length && rowsOnPage1 < rowsFirst) {
    const rowSvg = renderTableRow({
      row: rows[rowIndex],
      columns,
      y: page1Y,
      rowIndex: rowsOnPage1,
      rowHeight: ROW_HEIGHT,
    });
    page1 += rowSvg.svg;
    page1Y = rowSvg.nextY;
    rowIndex++;
    rowsOnPage1++;
  }

  // Message vide
  if (rows.length === 0) {
    page1 += `
      <text x="${PAGE_WIDTH / 2}" y="${page1Y + 60}" font-family="Helvetica, Arial, sans-serif"
            font-size="14" font-style="italic" fill="${COLORS.slate500}" text-anchor="middle">
        Aucune donnée à afficher
      </text>
    `;
  }

  // Watermark + footer page 1
  page1 += renderWatermark({});
  page1 += renderFooter({ pageNumber: 1, totalPages });

  pagesSvg += `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${page1}
  </svg>`;

  // ═══════ PAGES SUIVANTES ═══════
  while (rowIndex < rows.length) {
    currentPage++;

    let pageContent = `
      <!-- En-tête compact -->
      <rect x="0" y="0" width="${PAGE_WIDTH}" height="50" fill="${COLORS.primary}"/>
      <rect x="0" y="50" width="${PAGE_WIDTH}" height="3" fill="${COLORS.accent}"/>
      <text x="${MARGIN}" y="32" font-family="Helvetica, Arial, sans-serif"
            font-size="14" font-weight="700" fill="${COLORS.white}">
        KHAMIS GLOBALE GROUPES
      </text>
      <text x="${PAGE_WIDTH - MARGIN}" y="32" font-family="Helvetica, Arial, sans-serif"
            font-size="12" fill="#cbd5e1" text-anchor="end">
        ${escapeXml(title)} — Page ${currentPage}
      </text>
    `;

    let pageY = 40 + PAGE_PADDING_TOP;
    const pageHeader = renderTableHeader({ columns, y: pageY });
    pageContent += pageHeader.svg;
    pageY = pageHeader.nextY;

    let rowsOnPage = 0;
    while (rowIndex < rows.length && rowsOnPage < rowsOther) {
      const rowSvg = renderTableRow({
        row: rows[rowIndex],
        columns,
        y: pageY,
        rowIndex: rowsOnPage,
        rowHeight: ROW_HEIGHT,
      });
      pageContent += rowSvg.svg;
      pageY = rowSvg.nextY;
      rowIndex++;
      rowsOnPage++;
    }

    pageContent += renderWatermark({});
    pageContent += renderFooter({ pageNumber: currentPage, totalPages });

    pagesSvg += `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">
      <rect width="100%" height="100%" fill="#ffffff"/>
      ${pageContent}
    </svg>`;
  }

  // Footer custom
  if (footer) {
    pagesSvg += `<!-- ${escapeXml(footer)} -->`;
  }

  return pagesSvg;
}

module.exports = { generateTableSVG };