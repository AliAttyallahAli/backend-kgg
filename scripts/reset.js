// backend/scripts/reset.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './database/khamis.db';
const absolutePath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(__dirname, '..', DB_PATH.replace(/^\.\//, ''));

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Reset interdit en production.');
  process.exit(1);
}

console.log('⚠️  Suppression de la base :', absolutePath);

['', '-wal', '-shm'].forEach((suffix) => {
  const file = absolutePath + suffix;
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log('   supprimé :', file);
  }
});

console.log('✅ Reset effectué. Lancez `npm run migrate` puis `npm run seed`.');