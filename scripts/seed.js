// backend/scripts/seed.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { initDatabase, get, run, closeDatabase } = require('../database/db');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

// Utilitaires
function nowISO() {
  return new Date().toISOString();
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Création utilisateur
async function createUser({ phone, fullname, password, role, email, province, city }) {
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const res = await run(
    `INSERT INTO users (phone, fullname, email, password_hash, role, province, city, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [phone, fullname, email || null, hash, role, province || "N'Djamena", city || "N'Djamena"]
  );
  return res.lastID;
}

async function seed() {
  console.log('🌱 Seed khamis GLOBALE GROUPES...\n');

  try {
    await initDatabase();

    // Vérifier si déjà seedé
    const existing = await get('SELECT COUNT(*) as c FROM users');
    if (existing && existing.c > 0) {
      console.log(`⚠️  ${existing.c} utilisateurs existent déjà.`);
      console.log('   → Lancez `npm run reset` puis `npm run seed` pour repartir de zéro.');
      await closeDatabase();
      return;
    }

    // ────────────────────────────────────────
    // 1. ADMIN PRINCIPAL
    // ────────────────────────────────────────
    const adminId = await createUser({
      phone: '62787307',
      fullname: 'Administrateur khamis',
      password: '$2a$10$z4XMcVt2h03Dg0SAG7iXW.19ctrijP1kZlMND3q.NQih1KG5e41zW',
      role: 'admin',
      email: 'admin@khamis.com',
      province: "N'Djamena",
      city: "N'Djamena",
    });
    console.log('✅ Admin créé       → 62787307 / 08093Ali');

    // ────────────────────────────────────────
    // 2. GÉRANTS
    // ────────────────────────────────────────
    const gerant1 = await createUser({
      phone: '66000001',
      fullname: 'Ahmed Gérant Boutique Centre',
      password: 'gerant1234',
      role: 'gerant',
      email: 'gerant1@khamis.com',
    });

    const gerant2 = await createUser({
      phone: '66000004',
      fullname: 'Fatimé Gérante Boutique Nord',
      password: 'gerant1234',
      role: 'gerant',
      email: 'gerant2@khamis.com',
    });
    console.log('✅ 2 Gérants créés  → 66000001 / 66000004 (gerant1234)');

    // ────────────────────────────────────────
    // 3. AGENTS
    // ────────────────────────────────────────
    const agent1 = await createUser({
      phone: '66000002',
      fullname: 'Moussa Agent Revendeur',
      password: 'agent1234',
      role: 'agent',
    });

    const agent2 = await createUser({
      phone: '66000005',
      fullname: 'Aïcha Agent Revendeuse',
      password: 'agent1234',
      role: 'agent',
    });

    const agent3 = await createUser({
      phone: '66000006',
      fullname: 'Ibrahim Agent Revendeur',
      password: 'agent1234',
      role: 'agent',
    });
    console.log('✅ 3 Agents créés   → 66000002 / 66000005 / 66000006 (agent1234)');

    // ────────────────────────────────────────
    // 4. USER STANDARD
    // ────────────────────────────────────────
    const userId = await createUser({
      phone: '66000003',
      fullname: 'Client Démo',
      password: 'user1234',
      role: 'user',
    });
    console.log('✅ User créé        → 66000003 / user1234');

    // ────────────────────────────────────────
    // 5. CATÉGORIES
    // ────────────────────────────────────────
    const categoriesData = [
      { name: 'Alimentation',       color: '#16a34a', description: 'Produits alimentaires et boissons' },
      { name: 'Électronique',       color: '#2563eb', description: 'Appareils électroniques et accessoires' },
      { name: 'Habillement',        color: '#db2777', description: 'Vêtements et chaussures' },
      { name: 'Cosmétiques',        color: '#f59e0b', description: 'Produits de beauté et soins' },
      { name: 'Quincaillerie',      color: '#6b7280', description: 'Outils et matériaux' },
    ];
    const categoryIds = [];
    for (const c of categoriesData) {
      const r = await run(
        'INSERT INTO categories (name, description, color) VALUES (?, ?, ?)',
        [c.name, c.description, c.color]
      );
      categoryIds.push(r.lastID);
    }
    console.log(`✅ ${categoryIds.length} Catégories créées`);

    // ────────────────────────────────────────
    // 6. DÉPARTEMENTS
    // ────────────────────────────────────────
    const departementsData = [
      { name: 'Commerce Général',     responsable_id: gerant1 },
      { name: 'Électronique & Tech',  responsable_id: gerant2 },
      { name: 'Textile & Mode',       responsable_id: gerant1 },
    ];
    const departementIds = [];
    for (const d of departementsData) {
      const r = await run(
        'INSERT INTO departements (name, responsable_id) VALUES (?, ?)',
        [d.name, d.responsable_id]
      );
      departementIds.push(r.lastID);
    }
    console.log(`✅ ${departementIds.length} Départements créés`);

    // ────────────────────────────────────────
    // 7. BOUTIQUES
    // ────────────────────────────────────────
    const boutiquesData = [
      { name: 'Boutique Centre-Ville',   category_id: categoryIds[0], departement_id: departementIds[0], gerant_id: gerant1, address: "Av. Charles de Gaulle, N'Djamena", phone: '66000011' },
      { name: 'Boutique Marché Central', category_id: categoryIds[0], departement_id: departementIds[0], gerant_id: gerant1, address: "Marché central, N'Djamena",        phone: '66000012' },
      { name: 'Boutique Électro Plus',   category_id: categoryIds[1], departement_id: departementIds[1], gerant_id: gerant2, address: "Rue 12, Moursal",                    phone: '66000013' },
      { name: 'Boutique Mode & Style',   category_id: categoryIds[2], departement_id: departementIds[2], gerant_id: gerant2, address: "Chagoua, N'Djamena",                 phone: '66000014' },
      { name: 'Boutique Beauté Divine',  category_id: categoryIds[3], departement_id: departementIds[0], gerant_id: gerant1, address: "Avenue Hassan Djamous",              phone: '66000015' },
    ];
    const boutiqueIds = [];
    for (const b of boutiquesData) {
      const r = await run(
        `INSERT INTO boutiques (name, category_id, departement_id, gerant_id, address, phone)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [b.name, b.category_id, b.departement_id, b.gerant_id, b.address, b.phone]
      );
      boutiqueIds.push(r.lastID);
    }
    console.log(`✅ ${boutiqueIds.length} Boutiques créées`);

    // ────────────────────────────────────────
    // 8. PERSONNEL
    // ────────────────────────────────────────
    const personnelData = [
      { fullname: 'Hassan Vendeur',     poste: 'Vendeur',      departement_id: departementIds[0], boutique_id: boutiqueIds[0], salaire_base: 150000 },
      { fullname: 'Mariam Caissière',   poste: 'Caissière',    departement_id: departementIds[0], boutique_id: boutiqueIds[1], salaire_base: 175000 },
      { fullname: 'Youssouf Technicien',poste: 'Technicien',   departement_id: departementIds[1], boutique_id: boutiqueIds[2], salaire_base: 250000 },
      { fullname: 'Nadia Couturière',   poste: 'Couturière',   departement_id: departementIds[2], boutique_id: boutiqueIds[3], salaire_base: 160000 },
      { fullname: 'Salma Esthéticienne',poste: 'Esthéticienne',departement_id: departementIds[0], boutique_id: boutiqueIds[4], salaire_base: 145000 },
    ];
    const personnelIds = [];
    for (const p of personnelData) {
      const r = await run(
        `INSERT INTO personnel (fullname, poste, departement_id, boutique_id, salaire_base, type_contrat, date_embauche, statut)
         VALUES (?, ?, ?, ?, ?, 'CDI', DATE('now','-6 months'), 'actif')`,
        [p.fullname, p.poste, p.departement_id, p.boutique_id, p.salaire_base]
      );
      personnelIds.push(r.lastID);
    }
    console.log(`✅ ${personnelIds.length} Membres du personnel créés`);

    // ────────────────────────────────────────
    // 9. PAIEMENTS PERSONNEL
    // ────────────────────────────────────────
    for (const pId of personnelIds) {
      const pers = await get('SELECT salaire_base FROM personnel WHERE id = ?', [pId]);
      await run(
        `INSERT INTO paiements_personnel (personnel_id, montant, type, moyen_paiement, justification, periode, created_by)
         VALUES (?, ?, 'salaire', 'virement', 'Salaire mensuel', ?, ?)`,
        [pId, pers.salaire_base, new Date().toISOString().slice(0, 7), adminId]
      );
    }
    console.log('✅ Paiements salaires créés');

    // ────────────────────────────────────────
    // 10. PRODUITS (double prix)
    // ────────────────────────────────────────
    const produitsData = [
      // Alimentation — Boutique 0
      { ref: 'ALI-001', name: 'Riz 5kg',             cat: 0, bout: 0, pp: 3500,  pv: 4500,  stock: 50 },
      { ref: 'ALI-002', name: 'Huile 1L',            cat: 0, bout: 0, pp: 1200,  pv: 1600,  stock: 80 },
      { ref: 'ALI-003', name: 'Sucre 1kg',           cat: 0, bout: 0, pp: 600,   pv: 850,   stock: 120 },
      { ref: 'ALI-004', name: 'Lait en poudre 500g', cat: 0, bout: 1, pp: 1800,  pv: 2400,  stock: 60 },
      { ref: 'ALI-005', name: 'Café 250g',           cat: 0, bout: 1, pp: 1500,  pv: 2100,  stock: 40 },
      // Électronique — Boutique 2
      { ref: 'ELE-001', name: 'Écouteurs Bluetooth', cat: 1, bout: 2, pp: 5000,  pv: 8500,  stock: 25 },
      { ref: 'ELE-002', name: 'Chargeur USB-C',      cat: 1, bout: 2, pp: 2000,  pv: 3500,  stock: 45 },
      { ref: 'ELE-003', name: 'Câble HDMI 2m',       cat: 1, bout: 2, pp: 2500,  pv: 4000,  stock: 30 },
      { ref: 'ELE-004', name: 'Powerbank 10000mAh',  cat: 1, bout: 2, pp: 8000,  pv: 13000, stock: 15 },
      { ref: 'ELE-005', name: 'Souris sans fil',     cat: 1, bout: 2, pp: 3500,  pv: 6000,  stock: 22 },
      // Habillement — Boutique 3
      { ref: 'HAB-001', name: 'T-shirt Homme',       cat: 2, bout: 3, pp: 3000,  pv: 5000,  stock: 60 },
      { ref: 'HAB-002', name: 'Pantalon Femme',      cat: 2, bout: 3, pp: 6000,  pv: 9500,  stock: 35 },
      { ref: 'HAB-003', name: 'Robe été',            cat: 2, bout: 3, pp: 8000,  pv: 13500, stock: 20 },
      { ref: 'HAB-004', name: 'Chaussures sport',    cat: 2, bout: 3, pp: 10000, pv: 16000, stock: 18 },
      { ref: 'HAB-005', name: 'Sac à main',          cat: 2, bout: 3, pp: 7000,  pv: 12000, stock: 12 },
      // Cosmétiques — Boutique 4
      { ref: 'COS-001', name: 'Crème visage',        cat: 3, bout: 4, pp: 2500,  pv: 4500,  stock: 40 },
      { ref: 'COS-002', name: 'Parfum 50ml',         cat: 3, bout: 4, pp: 8000,  pv: 14000, stock: 15 },
      { ref: 'COS-003', name: 'Savon naturel',       cat: 3, bout: 4, pp: 500,   pv: 1000,  stock: 100 },
      { ref: 'COS-004', name: 'Huile de coco',       cat: 3, bout: 4, pp: 1500,  pv: 2800,  stock: 55 },
      { ref: 'COS-005', name: 'Rouge à lèvres',      cat: 3, bout: 4, pp: 2000,  pv: 3800,  stock: 30 },
    ];
    const produitIds = [];
    for (const p of produitsData) {
      const r = await run(
        `INSERT INTO produits (reference, name, category_id, boutique_id, prix_partenaire, prix_vente, stock, seuil_alerte)
         VALUES (?, ?, ?, ?, ?, ?, ?, 10)`,
        [p.ref, p.name, categoryIds[p.cat], boutiqueIds[p.bout], p.pp, p.pv, p.stock]
      );
      produitIds.push(r.lastID);
    }
    console.log(`✅ ${produitIds.length} Produits créés`);

    // ────────────────────────────────────────
    // 11. COMMANDES + LIGNES
    // ────────────────────────────────────────
    const agents = [agent1, agent2, agent3];
    const statuts = ['en_attente', 'validee', 'livree', 'en_attente'];
    let commandeCount = 0;

    for (let i = 0; i < 12; i++) {
      const agentId = randomChoice(agents);
      const boutiqueId = randomChoice(boutiqueIds);
      const statut = randomChoice(statuts);
      const ref = `CMD-${Date.now()}-${i}-${uuidv4().slice(0, 6).toUpperCase()}`;

      const cmdRes = await run(
        `INSERT INTO commandes (reference, agent_id, boutique_id, statut, created_at)
         VALUES (?, ?, ?, ?, datetime('now', '-${randomInt(1, 30)} days'))`,
        [ref, agentId, boutiqueId, statut]
      );
      const commandeId = cmdRes.lastID;

      // 1 à 3 lignes
      const nbLignes = randomInt(1, 3);
      let totalPart = 0;
      let totalVente = 0;

      for (let j = 0; j < nbLignes; j++) {
        const prod = await get(
          'SELECT * FROM produits WHERE boutique_id = ? ORDER BY RANDOM() LIMIT 1',
          [boutiqueId]
        );
        if (!prod) continue;
        const qte = randomInt(1, 10);
        const partLine = prod.prix_partenaire * qte;
        const venteLine = prod.prix_vente * qte;
        totalPart += partLine;
        totalVente += venteLine;

        await run(
          `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_partenaire_applique, prix_vente_applique)
           VALUES (?, ?, ?, ?, ?)`,
          [commandeId, prod.id, qte, prod.prix_partenaire, prod.prix_vente]
        );
      }

      await run(
        'UPDATE commandes SET total_partenaire = ?, total_vente = ? WHERE id = ?',
        [totalPart, totalVente, commandeId]
      );

      // Si validée, créer une vente
      if (statut === 'validee' || statut === 'livree') {
        const venteRef = `VNT-${Date.now()}-${i}-${uuidv4().slice(0, 6).toUpperCase()}`;
        const marge = totalVente - totalPart;

        await run(
          `INSERT INTO ventes (reference, agent_id, commande_id, total_vente, total_marge, statut, valide_par, valide_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'validee', ?, datetime('now'), datetime('now'))`,
          [venteRef, agentId, commandeId, totalVente, marge, gerant1]
        );

        await run(
          'UPDATE commandes SET valide_par = ?, valide_at = datetime(\'now\') WHERE id = ?',
          [gerant1, commandeId]
        );
      }

      commandeCount++;
    }
    console.log(`✅ ${commandeCount} Commandes créées (avec lignes + ventes liées)`);

    // ────────────────────────────────────────
    // 12. RAVITAILLEMENTS
    // ────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
      const produitId = randomChoice(produitIds);
      const prod = await get('SELECT boutique_id FROM produits WHERE id = ?', [produitId]);
      const statut = randomChoice(['demande', 'en_cours', 'recu', 'annule']);

      await run(
        `INSERT INTO ravitaillements (boutique_id, produit_id, quantite_demandee, quantite_recue, statut, lance_par, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-${randomInt(1, 20)} days'))`,
        [
          prod.boutique_id,
          produitId,
          randomInt(10, 100),
          statut === 'recu' ? randomInt(10, 100) : 0,
          statut,
          gerant1,
        ]
      );
    }
    console.log('✅ 8 Ravitaillements créés');

    // ────────────────────────────────────────
    // 13. CHARGES
    // ────────────────────────────────────────
    const chargesData = [
      { type: 'loyer',        montant: 250000, just: 'Loyer mensuel boutique Centre',      moyen: 'virement' },
      { type: 'transport',    montant: 45000,  just: 'Livraison produits marché central',  moyen: 'especes'  },
      { type: 'electricite',  montant: 85000,  just: 'Facture électricité Novembre',       moyen: 'mobile_money' },
      { type: 'fournitures',  montant: 32000,  just: 'Achat papier & stylos',              moyen: 'especes'  },
      { type: 'maintenance',  montant: 120000, just: 'Réparation climatiseur boutique',    moyen: 'virement' },
      { type: 'salaires',     montant: 880000, just: 'Salaires Novembre personnel',        moyen: 'virement' },
      { type: 'internet',     montant: 25000,  just: 'Abonnement internet fibre',          moyen: 'mobile_money' },
      { type: 'marketing',    montant: 60000,  just: 'Publicité Facebook',                 moyen: 'carte'    },
    ];
    for (const c of chargesData) {
      await run(
        `INSERT INTO charges (boutique_id, type, montant, justification, moyen_paiement, statut, created_by, valide_par, valide_at, date_charge)
         VALUES (?, ?, ?, ?, ?, 'validee', ?, ?, datetime('now'), DATE('now','-${randomInt(1, 30)} days'))`,
        [
          randomChoice(boutiqueIds),
          c.type,
          c.montant,
          c.just,
          c.moyen,
          adminId,
          adminId,
        ]
      );
    }
    console.log(`✅ ${chargesData.length} Charges créées`);

    // ────────────────────────────────────────
    // 14. PARAMÈTRES
    // ────────────────────────────────────────
    const defaultSettings = [
      ['company_name', 'khamis GLOBALE GROUPES', 'string'],
      ['company_logo', null, 'string'],
      ['default_currency', 'XAF', 'string'],
      ['stock_alert_threshold', '10', 'number'],
      ['charge_validation_required', '1', 'boolean'],
      ['alkherpay_enabled', '1', 'boolean'],
      ['commission_rate', '2', 'number'],
    ];
    for (const [key, value, type] of defaultSettings) {
      await run(
        'INSERT OR IGNORE INTO app_settings (key, value, type, updated_by) VALUES (?, ?, ?, ?)',
        [key, value, type, adminId]
      );
    }
    console.log('✅ Paramètres par défaut créés');

    // ────────────────────────────────────────
    // 15. NOTIFICATIONS DÉMO
    // ────────────────────────────────────────
    await run(
      `INSERT INTO notifications (user_id, title, message, type, category)
       VALUES (?, '🎉 Bienvenue', 'Bienvenue sur khamis GLOBAL GROUP !', 'success', 'general')`,
      [adminId]
    );
    console.log('✅ Notifications de démo créées');

    // ────────────────────────────────────────
    // RÉSUMÉ
    // ────────────────────────────────────────
    console.log('\n════════════════════════════════════════════');
    console.log('  ✅ SEED TERMINÉ AVEC SUCCÈS');
    console.log('════════════════════════════════════════════');
    console.log('  📋 COMPTES DE CONNEXION :');
    console.log('  ─────────────────────────────────────────');
    console.log('  🔑 Admin    : 62787307 / 08093Ali');
    console.log('  🔑 Gérant 1 : 66000001 / gerant1234');
    console.log('  🔑 Gérant 2 : 66000004 / gerant1234');
    console.log('  🔑 Agent 1  : 66000002 / agent1234');
    console.log('  🔑 Agent 2  : 66000005 / agent1234');
    console.log('  🔑 Agent 3  : 66000006 / agent1234');
    console.log('  🔑 User     : 66000003 / user1234');
    console.log('════════════════════════════════════════════\n');

  } catch (err) {
    console.error('❌ Erreur seed:', err);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

seed();