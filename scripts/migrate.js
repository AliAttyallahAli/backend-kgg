// backend/scripts/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDatabase, getDb, closeDatabase } = require('../database/db');

// ═══════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

function logSection(title) {
  console.log('');
  log('═'.repeat(60), 'cyan');
  log(`  ${title}`, 'bright');
  log('═'.repeat(60), 'cyan');
}

// ═══════════════════════════════════════════════
// VÉRIFICATION D'UNE COLONNE
// ═══════════════════════════════════════════════
async function columnExists(db, table, column) {
  try {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
  } catch (err) {
    return false;
  }
}

// ═══════════════════════════════════════════════
// VÉRIFICATION D'UNE TABLE
// ═══════════════════════════════════════════════
async function tableExists(db, table) {
  const row = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [table]
  );
  return !!row;
}

// ═══════════════════════════════════════════════
// MIGRATION 1 : SCHÉMA PRINCIPAL
// ═══════════════════════════════════════════════
async function migrateSchema(db) {
  logSection('MIGRATION 1 — SCHÉMA PRINCIPAL (schema.sql)');

  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`schema.sql introuvable : ${schemaPath}`);
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');
  if (schema.length < 1000) {
    throw new Error(`schema.sql trop petit (${schema.length} octets)`);
  }

  log(`📄 Chargement du schéma (${schema.length} octets)...`, 'yellow');
  await db.exec(schema);
  log('✅ Schéma principal appliqué', 'green');
}

// ═══════════════════════════════════════════════
// MIGRATION 2 : FICHIERS SQL DU DOSSIER migrations/
// ═══════════════════════════════════════════════
async function runMigrations(db) {
  logSection('MIGRATION 2 — FICHIERS SQL (database/migrations/)');

  const migrationsDir = path.join(__dirname, '..', 'database', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    log('📁 Dossier migrations/ absent → ignoré', 'yellow');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    log('📁 Aucun fichier de migration trouvé', 'yellow');
    return;
  }

  log(`📄 ${files.length} fichier(s) de migration trouvé(s)`, 'yellow');
  console.log('');

  for (const file of files) {
    const filepath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filepath, 'utf8');

    try {
      log(`▶️  Application de ${file}...`, 'blue');
      await db.exec(sql);
      log(`   ✅ ${file} appliqué`, 'green');
    } catch (err) {
      const msg = err.message || '';

      // Erreurs tolérées (migration déjà appliquée)
      if (
        msg.includes('duplicate column') ||
        msg.includes('already exists') ||
        msg.includes('UNIQUE constraint')
      ) {
        log(`   ⚠️  ${file} — déjà appliqué (skip)`, 'yellow');
      } else {
        log(`   ❌ ${file} — ERREUR : ${msg}`, 'red');
        throw err;
      }
    }
  }
}

// ═══════════════════════════════════════════════
// MIGRATION 3 : COLONNES MANQUANTES (fallback manuel)
// ═══════════════════════════════════════════════
async function migrateMissingColumns(db) {
  logSection('MIGRATION 3 — COLONNES MANQUANTES');

  const missingColumns = [
    // AlkherPay link
    { table: 'users', column: 'alkherpay_user_id', type: 'INTEGER' },
    { table: 'users', column: 'alkherpay_phone', type: 'TEXT' },
    { table: 'users', column: 'alkherpay_linked_at', type: 'DATETIME' },
    { table: 'users', column: 'alkherpay_link_status', type: 'TEXT' },
    { table: 'users', column: 'alkherpay_link_note', type: 'TEXT' },

    // Paiements personnel
    { table: 'paiements_personnel', column: 'piece_jointe', type: 'TEXT' },

    // Charges (au cas où)
    { table: 'charges', column: 'piece_jointe', type: 'TEXT' },
  ];

  let added = 0;
  let skipped = 0;

  for (const { table, column, type } of missingColumns) {
    if (!(await tableExists(db, table))) {
      log(`   ⚠️  Table ${table} inexistante — skip ${column}`, 'yellow');
      skipped++;
      continue;
    }

    if (await columnExists(db, table, column)) {
      skipped++;
      continue;
    }

    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      log(`   ✅ ${table}.${column} ajoutée`, 'green');
      added++;
    } catch (err) {
      log(`   ⚠️  ${table}.${column} — ${err.message}`, 'yellow');
      skipped++;
    }
  }

  log('');
  log(`   📊 ${added} colonne(s) ajoutée(s), ${skipped} ignorée(s)`, 'cyan');
}

// ═══════════════════════════════════════════════
// VÉRIFICATION FINALE
// ═══════════════════════════════════════════════
async function verifyMigration(db) {
  logSection('VÉRIFICATION FINALE');

  const expectedTables = [
    'users',
    'refresh_tokens',
    'categories',
    'departements',
    'boutiques',
    'produits',
    'personnel',
    'paiements_personnel',
    'commandes',
    'lignes_commande',
    'ventes',
    'ravitaillements',
    'charges',
    'notifications',
    'audit_logs',
    'app_settings',
    'alkherpay_wallets',
    'alkherpay_account_requests',
    'alkherpay_link_logs',
  ];

  const expectedViews = [
    'v_produits_full',
    'v_commandes_full',
    'v_ventes_full',
    'v_charges_full',
    'v_users_alkherpay_status',
  ];

  // Vérifier les tables
  let missingTables = 0;
  for (const table of expectedTables) {
    const exists = await tableExists(db, table);
    if (exists) {
      log(`   ✅ ${table}`, 'green');
    } else {
      log(`   ❌ ${table} — MANQUANT`, 'red');
      missingTables++;
    }
  }

  console.log('');

  // Vérifier les vues
  let missingViews = 0;
  for (const view of expectedViews) {
    const row = await db.get(
      "SELECT name FROM sqlite_master WHERE type='view' AND name=?",
      [view]
    );
    if (row) {
      log(`   ✅ ${view} (vue)`, 'green');
    } else {
      log(`   ⚠️  ${view} (vue) — absente`, 'yellow');
      missingViews++;
    }
  }

  console.log('');

  // Vérifier les colonnes AlkherPay
  log('   🔗 Colonnes AlkherPay sur users :', 'cyan');
  const alkherColumns = [
    'alkherpay_user_id',
    'alkherpay_phone',
    'alkherpay_linked_at',
    'alkherpay_link_status',
    'alkherpay_link_note',
  ];

  let missingAlkherCols = 0;
  for (const col of alkherColumns) {
    const exists = await columnExists(db, 'users', col);
    if (exists) {
      log(`      ✅ ${col}`, 'green');
    } else {
      log(`      ❌ ${col} — MANQUANT`, 'red');
      missingAlkherCols++;
    }
  }

  console.log('');

  // Résumé
  const allOk = missingTables === 0 && missingAlkherCols === 0;

  if (allOk) {
    log('✅ TOUTES LES VÉRIFICATIONS SONT PASSÉES', 'green');
    if (missingViews > 0) {
      log(`⚠️  ${missingViews} vue(s) manquante(s) — non bloquant`, 'yellow');
    }
  } else {
    log(
      `❌ ${missingTables} table(s) et ${missingAlkherCols} colonne(s) manquante(s)`,
      'red'
    );
  }

  // Stats globales
  logSection('STATISTIQUES');

  const userCount = await db.get('SELECT COUNT(*) as c FROM users');
  const alkherLinkedCount = await db.get(
    'SELECT COUNT(*) as c FROM users WHERE alkherpay_phone IS NOT NULL'
  );
  const pendingRequestsCount = await db.get(
    "SELECT COUNT(*) as c FROM alkherpay_account_requests WHERE status = 'pending'"
  );

  log(`   👥 Utilisateurs : ${userCount.c}`, 'cyan');
  log(`   🔗 Comptes AlkherPay liés : ${alkherLinkedCount.c}`, 'cyan');
  log(`   📬 Demandes AlkherPay en attente : ${pendingRequestsCount.c}`, 'cyan');

  return allOk;
}

// ═══════════════════════════════════════════════
// FONCTION PRINCIPALE
// ═══════════════════════════════════════════════
async function migrate() {
  console.log('');
  log('════════════════════════════════════════════════════════════', 'bright');
  log('  🚀 MIGRATION khamis GLOBALE GROUPES', 'bright');
  log('════════════════════════════════════════════════════════════', 'bright');

  const startTime = Date.now();

  try {
    // 1. Connexion
    await initDatabase();
    const db = getDb();

    // 2. Schéma principal
    await migrateSchema(db);

    // 3. Fichiers de migration
    await runMigrations(db);

    // 4. Colonnes manquantes (fallback)
    await migrateMissingColumns(db);

    // 5. Vérification finale
    const ok = await verifyMigration(db);

    // 6. Durée
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('');
    log('════════════════════════════════════════════════════════════', 'bright');
    if (ok) {
      log(`  ✅ MIGRATION TERMINÉE AVEC SUCCÈS en ${duration}s`, 'green');
      log('  👉 Prochaine étape : npm run seed', 'cyan');
    } else {
      log(`  ⚠️  MIGRATION TERMINÉE AVEC AVERTISSEMENTS en ${duration}s`, 'yellow');
      log('  👉 Vérifie les tables/colonnes manquantes ci-dessus', 'yellow');
    }
    log('════════════════════════════════════════════════════════════', 'bright');
    console.log('');

  } catch (err) {
    console.log('');
    log('════════════════════════════════════════════════════════════', 'red');
    log(`  ❌ MIGRATION ÉCHOUÉE`, 'red');
    log('════════════════════════════════════════════════════════════', 'red');
    console.error(err);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

// Lancement
migrate();