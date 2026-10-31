// backend/routes/rapports.routes.js
const express = require('express');
const { query: qv } = require('express-validator');
const XLSX = require('xlsx');
const router = express.Router();

const { query, get } = require('../database/db');
const { authenticateToken } = require('../middlewares/auth');
const { requirePermission, getAccessibleBoutiques } = require('../middlewares/rbac');
const { validate } = require('../middlewares/validate');
const { asyncHandler } = require('../middlewares/errorHandler');
const { generateTablePDF } = require('../services/pdfService');
const { generateTableSVG } = require('../services/svgService');

router.use(authenticateToken);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function fCFA(n) {
  return new Intl.NumberFormat('fr-FR').format(n || 0) + ' FCFA';
}

function fDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('fr-FR');
}

function cleanDate(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '' || s === 'null' || s === 'undefined' || s === 'all') return undefined;
  return s;
}

function cleanId(value) {
  if (value === undefined || value === null || value === '' || value === 'null') return undefined;
  const n = parseInt(value, 10);
  return isNaN(n) ? undefined : n;
}

async function resolveBoutiqueScope(user) {
  if (user.role === 'admin') return null;
  const acc = await getAccessibleBoutiques(user);
  return acc.map((b) => b.id);
}

// ═══════════════════════════════════════════════
// GET /api/rapports/ventes
// ═══════════════════════════════════════════════
router.get(
  '/ventes',
  requirePermission('rapports', 'export'),
  validate([
    qv('format').optional({ values: 'falsy' }).isIn(['pdf', 'svg', 'xlsx']),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('agent_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('statut').optional({ values: 'falsy' }).isIn(['validee', 'en_attente', 'annulee', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const format = req.query.format || 'pdf';
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const boutiqueId = cleanId(req.query.boutique_id);
    const agentId = cleanId(req.query.agent_id);
    const statut = req.query.statut;

    const conditions = ["v.statut = 'validee'"];
    const params = [];

    const allowedIds = await resolveBoutiqueScope(req.user);
    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Aucune boutique accessible' });
      }
      conditions.push(`cmd.boutique_id IN (${allowedIds.map(() => '?').join(',')})`);
      params.push(...allowedIds);
    }

    if (boutiqueId) { conditions.push('cmd.boutique_id = ?'); params.push(boutiqueId); }
    if (agentId) { conditions.push('v.agent_id = ?'); params.push(agentId); }
    if (req.user.role === 'agent') {
      conditions.push('v.agent_id = ?'); params.push(req.user.userId);
    }
    if (statut && statut !== 'all') { conditions.push('v.statut = ?'); params.push(statut); }
    if (from) { conditions.push('date(v.created_at) >= date(?)'); params.push(from); }
    if (to)   { conditions.push('date(v.created_at) <= date(?)'); params.push(to); }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT v.reference, v.created_at AS date,
              u.fullname AS agent, b.name AS boutique,
              v.total_vente, v.total_marge,
              ROUND(CASE WHEN v.total_vente > 0
                    THEN v.total_marge * 100.0 / v.total_vente ELSE 0 END, 2) AS marge_pct
       FROM ventes v
       JOIN commandes cmd ON v.commande_id = cmd.id
       JOIN users u ON v.agent_id = u.id
       JOIN boutiques b ON cmd.boutique_id = b.id
       WHERE ${where}
       ORDER BY v.created_at DESC
       LIMIT 5000`,
      params
    );

    const totalVente = rows.reduce((s, r) => s + r.total_vente, 0);
    const totalMarge = rows.reduce((s, r) => s + r.total_marge, 0);

    const columns = [
      { header: 'Référence', key: 'reference', width: 170 },
      { header: 'Date', key: 'date_fr', width: 100 },
      { header: 'Agent', key: 'agent', width: 160 },
      { header: 'Boutique', key: 'boutique', width: 160 },
      { header: 'Vente', key: 'vente_fr', width: 130, align: 'right' },
      { header: 'Marge', key: 'marge_fr', width: 130, align: 'right' },
      { header: 'Marge %', key: 'marge_pct', width: 70, align: 'right' },
    ];

    const data = rows.map((r) => ({
      ...r,
      date_fr: fDate(r.date),
      vente_fr: fCFA(r.total_vente),
      marge_fr: fCFA(r.total_marge),
      marge_pct: `${r.marge_pct}%`,
    }));

    const meta = {
      Période: `${from || 'début'} → ${to || 'aujourd\'hui'}`,
      'Nombre de ventes': rows.length,
      'CA total': fCFA(totalVente),
      'Marge totale': fCFA(totalMarge),
    };

    if (format === 'pdf') {
      const buffer = await generateTablePDF({
        title: 'Rapport Ventes',
        subtitle: 'khamis GLOBALE GROUPES',
        columns, rows: data, meta,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${Date.now()}.pdf"`);
      return res.send(buffer);
    }

    if (format === 'svg') {
      const svg = generateTableSVG({
        title: 'Rapport Ventes',
        subtitle: 'khamis GLOBALE GROUPES',
        columns, rows: data, meta,
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${Date.now()}.svg"`);
      return res.send(svg);
    }

    // xlsx
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(
      data.map((r) => ({
        Référence: r.reference,
        Date: r.date_fr,
        Agent: r.agent,
        Boutique: r.boutique,
        'Vente (FCFA)': r.total_vente,
        'Marge (FCFA)': r.total_marge,
        'Marge %': r.marge_pct,
      }))
    );
    XLSX.utils.book_append_sheet(wb, ws, 'Ventes');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-ventes-${Date.now()}.xlsx"`);
    return res.send(buffer);
  })
);

// ═══════════════════════════════════════════════
// GET /api/rapports/charges
// ═══════════════════════════════════════════════
router.get(
  '/charges',
  requirePermission('rapports', 'export'),
  validate([
    qv('format').optional({ values: 'falsy' }).isIn(['pdf', 'svg', 'xlsx']),
    qv('from').optional({ values: 'falsy' }).isISO8601(),
    qv('to').optional({ values: 'falsy' }).isISO8601(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('type').optional({ values: 'falsy' }).trim(),
    qv('moyen_paiement').optional({ values: 'falsy' }).trim(),
  ]),
  asyncHandler(async (req, res) => {
    const format = req.query.format || 'pdf';
    const from = cleanDate(req.query.from);
    const to = cleanDate(req.query.to);
    const boutiqueId = cleanId(req.query.boutique_id);
    const type = req.query.type;
    const moyen = req.query.moyen_paiement;

    const conditions = ["ch.statut = 'validee'"];
    const params = [];
    const allowedIds = await resolveBoutiqueScope(req.user);

    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Aucune boutique accessible' });
      }
      conditions.push(`(ch.boutique_id IN (${allowedIds.map(() => '?').join(',')}) OR ch.boutique_id IS NULL)`);
      params.push(...allowedIds);
    }
    if (boutiqueId) { conditions.push('ch.boutique_id = ?'); params.push(boutiqueId); }
    if (type && type !== 'all') { conditions.push('ch.type = ?'); params.push(type); }
    if (moyen && moyen !== 'all') { conditions.push('ch.moyen_paiement = ?'); params.push(moyen); }
    if (from) { conditions.push('date(ch.date_charge) >= date(?)'); params.push(from); }
    if (to)   { conditions.push('date(ch.date_charge) <= date(?)'); params.push(to); }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT ch.id, ch.date_charge, ch.type, ch.montant, ch.moyen_paiement,
              ch.justification, b.name AS boutique
       FROM charges ch
       LEFT JOIN boutiques b ON ch.boutique_id = b.id
       WHERE ${where}
       ORDER BY ch.date_charge DESC
       LIMIT 5000`,
      params
    );

    const total = rows.reduce((s, r) => s + r.montant, 0);

    const columns = [
      { header: 'Date', key: 'date_fr', width: 100 },
      { header: 'Type', key: 'type', width: 120 },
      { header: 'Boutique', key: 'boutique', width: 160 },
      { header: 'Moyen', key: 'moyen_paiement', width: 120 },
      { header: 'Montant', key: 'montant_fr', width: 130, align: 'right' },
      { header: 'Justification', key: 'justification', width: 300 },
    ];

    const data = rows.map((r) => ({
      ...r,
      date_fr: fDate(r.date_charge),
      montant_fr: fCFA(r.montant),
    }));

    const meta = {
      Période: `${from || 'début'} → ${to || 'aujourd\'hui'}`,
      'Nombre de charges': rows.length,
      'Total dépenses': fCFA(total),
    };

    if (format === 'pdf') {
      const buffer = await generateTablePDF({
        title: 'Rapport Charges',
        subtitle: 'khamis GLOBALE GROUPES',
        columns, rows: data, meta,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-charges-${Date.now()}.pdf"`);
      return res.send(buffer);
    }
    if (format === 'svg') {
      const svg = generateTableSVG({ title: 'Rapport Charges', columns, rows: data, meta });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-charges-${Date.now()}.svg"`);
      return res.send(svg);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(
      data.map((r) => ({
        Date: r.date_fr,
        Type: r.type,
        Boutique: r.boutique || '-',
        'Moyen paiement': r.moyen_paiement,
        'Montant (FCFA)': r.montant,
        Justification: r.justification,
      }))
    );
    XLSX.utils.book_append_sheet(wb, ws, 'Charges');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-charges-${Date.now()}.xlsx"`);
    res.send(buffer);
  })
);

// ═══════════════════════════════════════════════
// GET /api/rapports/produits
// ═══════════════════════════════════════════════
router.get(
  '/produits',
  requirePermission('rapports', 'export'),
  validate([
    qv('format').optional({ values: 'falsy' }).isIn(['pdf', 'svg', 'xlsx']),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('category_id').optional({ values: 'falsy' }).isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const format = req.query.format || 'pdf';
    const boutiqueId = cleanId(req.query.boutique_id);
    const categoryId = cleanId(req.query.category_id);

    const conditions = ['p.is_active = 1'];
    const params = [];
    const allowedIds = await resolveBoutiqueScope(req.user);

    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Aucune boutique accessible' });
      }
      conditions.push(`p.boutique_id IN (${allowedIds.map(() => '?').join(',')})`);
      params.push(...allowedIds);
    }
    if (boutiqueId) { conditions.push('p.boutique_id = ?'); params.push(boutiqueId); }
    if (categoryId) { conditions.push('p.category_id = ?'); params.push(categoryId); }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT p.reference, p.name, c.name AS categorie, b.name AS boutique,
              p.prix_partenaire, p.prix_vente, p.marge_unitaire, p.stock, p.seuil_alerte
       FROM produits p
       JOIN categories c ON p.category_id = c.id
       JOIN boutiques b ON p.boutique_id = b.id
       WHERE ${where}
       ORDER BY p.name
       LIMIT 5000`,
      params
    );

    const columns = [
      { header: 'Référence', key: 'reference', width: 120 },
      { header: 'Nom', key: 'name', width: 200 },
      { header: 'Catégorie', key: 'categorie', width: 120 },
      { header: 'Boutique', key: 'boutique', width: 140 },
      { header: 'Prix part.', key: 'pp_fr', width: 110, align: 'right' },
      { header: 'Prix vente', key: 'pv_fr', width: 110, align: 'right' },
      { header: 'Marge', key: 'marge_fr', width: 110, align: 'right' },
      { header: 'Stock', key: 'stock', width: 70, align: 'right' },
    ];

    const data = rows.map((r) => ({
      ...r,
      pp_fr: fCFA(r.prix_partenaire),
      pv_fr: fCFA(r.prix_vente),
      marge_fr: fCFA(r.marge_unitaire),
    }));

    const meta = {
      'Nombre de produits': rows.length,
      'Valeur stock total': fCFA(rows.reduce((s, r) => s + r.prix_partenaire * r.stock, 0)),
    };

    if (format === 'pdf') {
      const buffer = await generateTablePDF({
        title: 'Rapport Produits & Stock',
        columns, rows: data, meta,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-produits-${Date.now()}.pdf"`);
      return res.send(buffer);
    }
    if (format === 'svg') {
      const svg = generateTableSVG({ title: 'Rapport Produits & Stock', columns, rows: data, meta });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-produits-${Date.now()}.svg"`);
      return res.send(svg);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(
      rows.map((r) => ({
        Référence: r.reference,
        Nom: r.name,
        Catégorie: r.categorie,
        Boutique: r.boutique,
        'Prix partenaire': r.prix_partenaire,
        'Prix vente': r.prix_vente,
        Marge: r.marge_unitaire,
        Stock: r.stock,
        'Seuil alerte': r.seuil_alerte,
      }))
    );
    XLSX.utils.book_append_sheet(wb, ws, 'Produits');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-produits-${Date.now()}.xlsx"`);
    res.send(buffer);
  })
);

// ═══════════════════════════════════════════════
// GET /api/rapports/personnel
// ═══════════════════════════════════════════════
router.get(
  '/personnel',
  requirePermission('rapports', 'export'),
  validate([
    qv('format').optional({ values: 'falsy' }).isIn(['pdf', 'svg', 'xlsx']),
    qv('statut').optional({ values: 'falsy' }).isIn(['actif', 'suspendu', 'sorti', 'all']),
    qv('departement_id').optional({ values: 'falsy' }).isInt().toInt(),
    qv('boutique_id').optional({ values: 'falsy' }).isInt().toInt(),
  ]),
  asyncHandler(async (req, res) => {
    const format = req.query.format || 'pdf';
    const statut = req.query.statut;
    const departementId = cleanId(req.query.departement_id);
    const boutiqueId = cleanId(req.query.boutique_id);

    const conditions = ['1=1'];
    const params = [];

    if (statut && statut !== 'all') { conditions.push('p.statut = ?'); params.push(statut); }
    if (departementId) { conditions.push('p.departement_id = ?'); params.push(departementId); }
    if (boutiqueId) { conditions.push('p.boutique_id = ?'); params.push(boutiqueId); }

    const allowedIds = await resolveBoutiqueScope(req.user);
    if (allowedIds) {
      if (allowedIds.length === 0) {
        return res.status(400).json({ success: false, error: 'Aucune boutique accessible' });
      }
      conditions.push(`(p.boutique_id IN (${allowedIds.map(() => '?').join(',')}) OR p.boutique_id IS NULL)`);
      params.push(...allowedIds);
    }

    const where = conditions.join(' AND ');

    const rows = await query(
      `SELECT p.fullname, p.phone, p.poste, p.type_contrat, p.date_embauche,
              p.salaire_base, p.statut, d.name AS departement, b.name AS boutique,
              (SELECT COALESCE(SUM(montant), 0) FROM paiements_personnel WHERE personnel_id = p.id) AS total_paye
       FROM personnel p
       LEFT JOIN departements d ON p.departement_id = d.id
       LEFT JOIN boutiques b ON p.boutique_id = b.id
       WHERE ${where}
       ORDER BY p.fullname
       LIMIT 5000`,
      params
    );

    const columns = [
      { header: 'Nom', key: 'fullname', width: 180 },
      { header: 'Téléphone', key: 'phone', width: 100 },
      { header: 'Poste', key: 'poste', width: 130 },
      { header: 'Département', key: 'departement', width: 130 },
      { header: 'Boutique', key: 'boutique', width: 130 },
      { header: 'Contrat', key: 'type_contrat', width: 70 },
      { header: 'Salaire base', key: 'salaire_fr', width: 120, align: 'right' },
      { header: 'Total payé', key: 'paye_fr', width: 120, align: 'right' },
      { header: 'Statut', key: 'statut', width: 80 },
    ];

    const data = rows.map((r) => ({
      ...r,
      salaire_fr: fCFA(r.salaire_base),
      paye_fr: fCFA(r.total_paye),
    }));

    const meta = {
      'Nombre de personnel': rows.length,
      'Masse salariale totale': fCFA(rows.reduce((s, r) => s + r.salaire_base, 0)),
    };

    if (format === 'pdf') {
      const buffer = await generateTablePDF({
        title: 'Rapport Personnel',
        columns, rows: data, meta,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-personnel-${Date.now()}.pdf"`);
      return res.send(buffer);
    }
    if (format === 'svg') {
      const svg = generateTableSVG({ title: 'Rapport Personnel', columns, rows: data, meta });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="rapport-personnel-${Date.now()}.svg"`);
      return res.send(svg);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Personnel');
    const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rapport-personnel-${Date.now()}.xlsx"`);
    res.send(buffer);
  })
);

module.exports = router;