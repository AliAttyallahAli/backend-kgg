// backend/scripts/migrate-fresh.js
// ⚠️ ATTENTION : efface TOUTES les données
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DB_PATH = process.env.DB_PATH || './database/khamis.db';
const absolutePath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(__dirname, '..', DB_PATH.replace(/^\.\//, ''));

async function confirm() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      '⚠️  Cette action va EFFACER toutes les données. Continuer ? (oui/non) : ',
      (answer) => {
        rl.close();
        resolve(answer.toLowerCase() === 'oui' || answer.toLowerCase() === 'yes');
      }
    );
  });
}

async function migrateFresh() {
  if (!(await confirm())) {
    console.log('❌ Annulé');
    process.exit(0);
  }

  console.log('');
  console.log('🗑️  Suppression de la base :', absolutePath);

  // Supprimer les fichiers
  ['', '-wal', '-shm'].forEach((suffix) => {
    const file = absolutePath + suffix;
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log('   ✅ Supprimé :', file);
    }
  });

  console.log('');
  console.log('🚀 Lancement de la migration...');
  console.log('');

  // Lancer migrate.js
  const { execSync } = require('child_process');
  execSync('node scripts/migrate.js', { stdio: 'inherit' });
}

migrateFresh();