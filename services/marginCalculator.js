// backend/services/marginCalculator.js
const { get, query, run } = require('../database/db');
const { AppError } = require('../middlewares/errorHandler');

// ─────────────────────────────────────────────
// Marge unitaire d'un produit
// ─────────────────────────────────────────────
function calcUnitMargin(prixPartenaire, prixVente) {
  if (typeof prixPartenaire !== 'number' || typeof prixVente !== 'number') {
    throw new AppError('Les prix doivent être numériques', 400, 'INVALID_PRICES');
  }
  if (prixPartenaire < 0 || prixVente < 0) {
    throw new AppError('Les prix ne peuvent pas être négatifs', 400, 'NEGATIVE_PRICE');
  }
  if (prixVente < prixPartenaire) {
    throw new AppError(
      'Le prix de vente doit être supérieur ou égal au prix partenaire',
      400,
      'PRICE_INCONSISTENT'
    );
  }
  return prixVente - prixPartenaire;
}

// ─────────────────────────────────────────────
// Marge totale d'une commande (calculé sur les lignes)
// ─────────────────────────────────────────────
function calcCommandeMargin(lignes) {
  if (!Array.isArray(lignes)) {
    throw new AppError('lignes doit être un tableau', 400, 'INVALID_LIGNES');
  }

  let totalPart = 0;
  let totalVente = 0;
  let totalMarge = 0;

  for (const l of lignes) {
    const qte = parseInt(l.quantite, 10);
    const pp = parseInt(l.prix_partenaire_applique, 10);
    const pv = parseInt(l.prix_vente_applique, 10);

    if (
      isNaN(qte) || qte <= 0 ||
      isNaN(pp) || pp < 0 ||
      isNaN(pv) || pv < 0
    ) {
      throw new AppError('Ligne invalide (quantité ou prix)', 400, 'INVALID_LINE');
    }
    if (pv < pp) {
      throw new AppError(
        'Prix de vente < prix partenaire sur une ligne',
        400,
        'LINE_PRICE_INCONSISTENT'
      );
    }

    totalPart += pp * qte;
    totalVente += pv * qte;
    totalMarge += (pv - pp) * qte;
  }

  return {
    total_partenaire: totalPart,
    total_vente: totalVente,
    total_marge: totalMarge,
    marge_pourcentage:
      totalVente > 0 ? Math.round((totalMarge / totalVente) * 10000) / 100 : 0,
  };
}

// ─────────────────────────────────────────────
// ✅ NOUVEAU : Calcul de marge pour vente manuelle
// Prend { produit_id, quantite } et charge les prix depuis la DB
// Retourne aussi les lignes enrichies prêtes pour INSERT
// ─────────────────────────────────────────────
async function calcVenteManuelleMargin({ lignes, boutiqueId }) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    throw new AppError('Au moins une ligne est requise', 400, 'EMPTY_LIGNES');
  }

  if (!boutiqueId) {
    throw new AppError('Boutique requise', 400, 'BOUTIQUE_REQUIRED');
  }

  // Vérifier que la boutique existe
  const boutique = await get(
    'SELECT id, name FROM boutiques WHERE id = ? AND is_active = 1',
    [boutiqueId]
  );
  if (!boutique) {
    throw new AppError('Boutique introuvable ou inactive', 404, 'BOUTIQUE_NOT_FOUND');
  }

  // Charger chaque produit + valider stock + cohérence boutique
  const lignesEnrichies = [];
  const produitsMap = new Map();

  for (const ligne of lignes) {
    const produitId = parseInt(ligne.produit_id, 10);
    const quantite = parseInt(ligne.quantite, 10);

    if (isNaN(produitId) || isNaN(quantite) || quantite <= 0) {
      throw new AppError(
        'Ligne invalide : produit_id et quantite doivent être des entiers positifs',
        400,
        'INVALID_LINE'
      );
    }

    const produit = await get(
      `SELECT id, name, reference, prix_partenaire, prix_vente, stock
       FROM produits
       WHERE id = ? AND boutique_id = ? AND is_active = 1`,
      [produitId, boutiqueId]
    );

    if (!produit) {
      throw new AppError(
        `Produit #${produitId} introuvable ou n'appartient pas à cette boutique`,
        404,
        'PRODUIT_NOT_FOUND'
      );
    }

    if (produit.stock < quantite) {
      throw new AppError(
        `Stock insuffisant pour "${produit.name}" : disponible ${produit.stock}, demandé ${quantite}`,
        400,
        'INSUFFICIENT_STOCK'
      );
    }

    // Vérifier la cohérence des prix (au cas où)
    calcUnitMargin(produit.prix_partenaire, produit.prix_vente);

    produitsMap.set(produitId, produit);
    lignesEnrichies.push({
      produit_id: produitId,
      quantite,
      prix_partenaire_applique: produit.prix_partenaire,
      prix_vente_applique: produit.prix_vente,
      produit_name: produit.name,
      produit_ref: produit.reference,
    });
  }

  // Calculer les totaux (réutilise calcCommandeMargin)
  const totals = calcCommandeMargin(
    lignesEnrichies.map((l) => ({
      quantite: l.quantite,
      prix_partenaire_applique: l.prix_partenaire_applique,
      prix_vente_applique: l.prix_vente_applique,
    }))
  );

  return {
    boutique,
    lignes: lignesEnrichies,
    produitsMap,
    ...totals,
  };
}

// ─────────────────────────────────────────────
// Calcul de marge depuis la DB (source de vérité)
// ─────────────────────────────────────────────
async function calcMarginFromCommande(commandeId) {
  const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);
  if (!commande) {
    throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');
  }

  const lignes = await query(
    'SELECT * FROM lignes_commande WHERE commande_id = ?',
    [commandeId]
  );

  if (lignes.length === 0) {
    throw new AppError('Commande sans lignes', 400, 'EMPTY_COMMANDE');
  }

  const totals = calcCommandeMargin(lignes);
  return { commande, lignes, ...totals };
}

// ─────────────────────────────────────────────
// Valider une commande (génère une vente + marge figée)
// ─────────────────────────────────────────────
async function validerCommandeEtCalculerMarge(commandeId, valideParId) {
  const commande = await get('SELECT * FROM commandes WHERE id = ?', [commandeId]);
  if (!commande) {
    throw new AppError('Commande introuvable', 404, 'COMMANDE_NOT_FOUND');
  }

  if (commande.statut === 'validee') {
    throw new AppError('Commande déjà validée', 400, 'ALREADY_VALIDATED');
  }
  if (commande.statut === 'annulee') {
    throw new AppError('Impossible de valider une commande annulée', 400, 'CANCELLED');
  }

  const lignes = await query(
    'SELECT * FROM lignes_commande WHERE commande_id = ?',
    [commandeId]
  );

  if (lignes.length === 0) {
    throw new AppError('Commande sans lignes', 400, 'EMPTY_COMMANDE');
  }

  const totals = calcCommandeMargin(lignes);

  const { v4: uuidv4 } = require('uuid');
  const venteRef = `VNT-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;

  const venteResult = await run(
    `INSERT INTO ventes (reference, agent_id, commande_id, total_vente, total_marge, statut, valide_par, valide_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'validee', ?, datetime('now'), datetime('now'))`,
    [venteRef, commande.agent_id, commandeId, totals.total_vente, totals.total_marge, valideParId]
  );

  await run(
    `UPDATE commandes SET statut = 'validee', valide_par = ?, valide_at = datetime('now'),
     total_partenaire = ?, total_vente = ? WHERE id = ?`,
    [valideParId, totals.total_partenaire, totals.total_vente, commandeId]
  );

  return {
    vente_id: venteResult.lastID,
    vente_reference: venteRef,
    ...totals,
  };
}

// ─────────────────────────────────────────────
// ✅ NOUVEAU : Exécuter une vente manuelle complète
// Crée la commande fantôme + lignes + vente + décrément stock
// Retourne les IDs et les totaux
// ─────────────────────────────────────────────
async function executerVenteManuelle({
  lignes,
  boutiqueId,
  agentId,
  valideParId,
  clientName,
  clientPhone,
  notes,
}) {
  const { transaction } = require('../database/db');
  const { v4: uuidv4 } = require('uuid');

  // 1. Calculer et valider les marges + charger les produits
  const calc = await calcVenteManuelleMargin({ lignes, boutiqueId });

  const venteRef = `VNT-MAN-${Date.now()}-${uuidv4().slice(0, 6).toUpperCase()}`;
  const cmdRef = `CMD-MAN-${Date.now()}-${uuidv4().slice(0, 4).toUpperCase()}`;

  // 2. Transaction atomique
  const result = await transaction(async (db) => {
    // a) Créer la commande (traçabilité, auto-validée)
    const cmdRes = await db.run(
      `INSERT INTO commandes
       (reference, agent_id, boutique_id, statut, total_partenaire, total_vente,
        valide_par, valide_at, motif_annulation)
       VALUES (?, ?, ?, 'validee', ?, ?, ?, datetime('now'), ?)`,
      [
        cmdRef,
        agentId,
        boutiqueId,
        calc.total_partenaire,
        calc.total_vente,
        valideParId || agentId,
        notes || 'Vente manuelle',
      ]
    );
    const commandeId = cmdRes.lastID;

    // b) Créer les lignes de commande
    for (const l of calc.lignes) {
      await db.run(
        `INSERT INTO lignes_commande
         (commande_id, produit_id, quantite, prix_partenaire_applique, prix_vente_applique)
         VALUES (?, ?, ?, ?, ?)`,
        [
          commandeId,
          l.produit_id,
          l.quantite,
          l.prix_partenaire_applique,
          l.prix_vente_applique,
        ]
      );
    }

    // c) Décrémenter le stock
    for (const l of calc.lignes) {
      await db.run(
        `UPDATE produits SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [l.quantite, l.produit_id]
      );
    }

    // d) Créer la vente
    const venteRes = await db.run(
      `INSERT INTO ventes
       (reference, agent_id, commande_id, total_vente, total_marge,
        statut, valide_par, valide_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'validee', ?, datetime('now'), datetime('now'))`,
      [
        venteRef,
        agentId,
        commandeId,
        calc.total_vente,
        calc.total_marge,
        valideParId || agentId,
      ]
    );

    return {
      venteId: venteRes.lastID,
      commandeId,
    };
  });

  return {
    vente_id: result.venteId,
    commande_id: result.commandeId,
    vente_reference: venteRef,
    commande_reference: cmdRef,
    boutique: calc.boutique,
    lignes: calc.lignes,
    total_partenaire: calc.total_partenaire,
    total_vente: calc.total_vente,
    total_marge: calc.total_marge,
    marge_pourcentage: calc.marge_pourcentage,
    client_name: clientName || null,
    client_phone: clientPhone || null,
    notes: notes || null,
  };
}

// ─────────────────────────────────────────────
// Statistiques marges (pour dashboards)
// ─────────────────────────────────────────────
async function getMarginStats({ from, to, boutiqueId, agentId, categoryId } = {}) {
  let sql = `
    SELECT
      COALESCE(SUM(v.total_vente), 0) AS total_vente,
      COALESCE(SUM(v.total_marge), 0) AS total_marge,
      COUNT(DISTINCT v.id) AS nb_ventes,
      CASE WHEN SUM(v.total_vente) > 0
           THEN ROUND(SUM(v.total_marge) * 100.0 / SUM(v.total_vente), 2)
           ELSE 0
      END AS marge_pourcentage
    FROM ventes v
    JOIN commandes c ON v.commande_id = c.id
    WHERE v.statut = 'validee'
  `;
  const params = [];

  if (from) {
    sql += ' AND date(v.created_at) >= date(?)';
    params.push(from);
  }
  if (to) {
    sql += ' AND date(v.created_at) <= date(?)';
    params.push(to);
  }
  if (boutiqueId) {
    sql += ' AND c.boutique_id = ?';
    params.push(boutiqueId);
  }
  if (agentId) {
    sql += ' AND v.agent_id = ?';
    params.push(agentId);
  }
  if (categoryId) {
    sql += ` AND c.id IN (
      SELECT DISTINCT commande_id FROM lignes_commande lc
      JOIN produits p ON lc.produit_id = p.id
      WHERE p.category_id = ?
    )`;
    params.push(categoryId);
  }

  const stats = await get(sql, params);
  return stats || {
    total_vente: 0,
    total_marge: 0,
    nb_ventes: 0,
    marge_pourcentage: 0,
  };
}

// ─────────────────────────────────────────────
// Évolution marge par période (graphe)
// ─────────────────────────────────────────────
async function getMarginEvolution({ from, to, boutiqueId, agentId, granularity = 'day' } = {}) {
  const format =
    granularity === 'month'
      ? "strftime('%Y-%m', v.created_at)"
      : "strftime('%Y-%m-%d', v.created_at)";

  let sql = `
    SELECT
      ${format} AS period,
      COALESCE(SUM(v.total_vente), 0) AS total_vente,
      COALESCE(SUM(v.total_marge), 0) AS total_marge,
      COUNT(*) AS nb_ventes
    FROM ventes v
    JOIN commandes c ON v.commande_id = c.id
    WHERE v.statut = 'validee'
  `;
  const params = [];

  if (from) { sql += ' AND date(v.created_at) >= date(?)'; params.push(from); }
  if (to)   { sql += ' AND date(v.created_at) <= date(?)'; params.push(to); }
  if (boutiqueId) { sql += ' AND c.boutique_id = ?'; params.push(boutiqueId); }
  if (agentId)    { sql += ' AND v.agent_id = ?';    params.push(agentId); }

  sql += ' GROUP BY period ORDER BY period ASC';

  return await query(sql, params);
}

// ─────────────────────────────────────────────
// Top/Flop produits par marge
// ─────────────────────────────────────────────
async function getProductRanking({ from, to, boutiqueId, limit = 10 } = {}) {
  let sql = `
    SELECT
      p.id,
      p.reference,
      p.name,
      p.prix_partenaire,
      p.prix_vente,
      p.marge_unitaire,
      COALESCE(SUM(lc.quantite), 0) AS quantite_vendue,
      COALESCE(SUM((lc.prix_vente_applique - lc.prix_partenaire_applique) * lc.quantite), 0) AS marge_totale,
      COALESCE(SUM(lc.prix_vente_applique * lc.quantite), 0) AS ca_total
    FROM produits p
    LEFT JOIN lignes_commande lc ON lc.produit_id = p.id
    LEFT JOIN commandes c ON lc.commande_id = c.id AND c.statut IN ('validee','livree')
    WHERE p.is_active = 1
  `;
  const params = [];

  if (boutiqueId) { sql += ' AND p.boutique_id = ?'; params.push(boutiqueId); }
  if (from) { sql += ' AND date(c.created_at) >= date(?)'; params.push(from); }
  if (to)   { sql += ' AND date(c.created_at) <= date(?)'; params.push(to); }

  sql += ' GROUP BY p.id ORDER BY marge_totale DESC LIMIT ?';
  params.push(parseInt(limit, 10));

  return await query(sql, params);
}

module.exports = {
  calcUnitMargin,
  calcCommandeMargin,
  calcVenteManuelleMargin,      // ✅ nouveau
  calcMarginFromCommande,
  validerCommandeEtCalculerMarge,
  executerVenteManuelle,        // ✅ nouveau
  getMarginStats,
  getMarginEvolution,
  getProductRanking,
};