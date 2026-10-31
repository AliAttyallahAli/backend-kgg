// backend/scripts/check-migration.js
require('dotenv').config();
const { initDatabase, getDb, closeDatabase } = require('../database/db');

async function check() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  🔍 DIAGNOSTIC DE LA BASE DE DONNÉES');
  console.log('═══════════════════════════════════════════════');
  console.log('');

  try {
    await initDatabase();
    const db = getDb();

    // 1. Tables
    const tables = await db.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    console.log('📊 TABLES :', tables.length);
    tables.forEach((t) => console.log('   •', t.name));
    console.log('');

    // 2. Vues
    const views = await db.all(
      "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name"
    );
    console.log('👁️  VUES :', views.length);
    views.forEach((v) => console.log('   •', v.name));
    console.log('');

    // 3. Triggers
    const triggers = await db.all(
      "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name"
    );
    console.log('⚡ TRIGGERS :', triggers.length);
    triggers.forEach((t) => console.log('   •', t.name));
    console.log('');

    // 4. Colonnes AlkherPay sur users
    console.log('🔗 COLONNES ALKHERPAY (users) :');
    const userCols = await db.all('PRAGMA table_info(users)');
    const alkherCols = userCols.filter((c) => c.name.startsWith('alkherpay'));
    if (alkherCols.length === 0) {
      console.log('   ❌ Aucune colonne AlkherPay');
    } else {
      alkherCols.forEach((c) => console.log(`   ✅ ${c.name} (${c.type})`));
    }
    console.log('');

    // 5. Données
    console.log('📊 DONNÉES :');
    const users = await db.get('SELECT COUNT(*) as c FROM users');
    console.log(`   👥 Utilisateurs : ${users.c}`);

    const linked = await db.get(
      'SELECT COUNT(*) as c FROM users WHERE alkherpay_phone IS NOT NULL'
    );
    console.log(`   🔗 Comptes AlkherPay liés : ${linked.c}`);

    const requests = await db.get(
      'SELECT COUNT(*) as c FROM alkherpay_account_requests'
    );
    console.log(`   📬 Demandes AlkherPay : ${requests.c}`);

    const pending = await db.get(
      "SELECT COUNT(*) as c FROM alkherpay_account_requests WHERE status = 'pending'"
    );
    console.log(`   ⏳ Demandes en attente : ${pending.c}`);
    console.log('');

    // 6. Utilisateurs non liés
    console.log('👤 UTILISATEURS SANS COMPTE ALKHERPAY :');
    const unlinked = await db.all(
      `SELECT id, phone, fullname, role 
       FROM users 
       WHERE alkherpay_phone IS NULL AND is_active = 1
       ORDER BY role, fullname
       LIMIT 20`
    );
    if (unlinked.length === 0) {
      console.log('   ✅ Tous les users sont liés');
    } else {
      unlinked.forEach((u) => {
        console.log(`   ⚠️  ${u.fullname} (${u.phone}) — ${u.role}`);
      });
    }
    console.log('');

    // 7. Health check
    console.log('═══════════════════════════════════════════════');
    const hasAlkherTable = tables.some((t) => t.name === 'alkherpay_account_requests');
    const hasAlkherCols = alkherCols.length >= 4;

    if (hasAlkherTable && hasAlkherCols) {
      console.log('  ✅ MIGRATION 002 APPLIQUÉE CORRECTEMENT');
    } else {
      console.log('  ❌ MIGRATION 002 NON APPLIQUÉE');
      console.log('  → Lance : npm run migrate');
    }
    console.log('═══════════════════════════════════════════════');
    console.log('');

  } catch (err) {
    console.error('❌ Erreur diagnostic :', err);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

check();