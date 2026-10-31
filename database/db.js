// backend/database/db.js
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './database/khamis.db';
const absolutePath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(__dirname, '..', DB_PATH.replace(/^\.\//, ''));

let db = null;

// ─────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────
async function initDatabase() {
  if (db) return db;

  // Créer le dossier si absent
  const dir = path.dirname(absolutePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = await open({
    filename: absolutePath,
    driver: sqlite3.Database,
  });

  // PRAGMA recommandés
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);

  console.log(`🗄️  SQLite connecté : ${absolutePath}`);
  return db;
}

// ─────────────────────────────────────────────
// Accès à l'instance brute
// ─────────────────────────────────────────────
function getDb() {
  if (!db) throw new Error('DB non initialisée. Appelez initDatabase() d\'abord.');
  return db;
}

// ─────────────────────────────────────────────
// Helpers async
// ─────────────────────────────────────────────
async function query(sql, params = []) {
  return getDb().all(sql, params);
}

async function get(sql, params = []) {
  return getDb().get(sql, params);
}

async function run(sql, params = []) {
  return getDb().run(sql, params);
}

async function exec(sql) {
  return getDb().exec(sql);
}

// ─────────────────────────────────────────────
// Transaction helper (BEGIN / COMMIT / ROLLBACK)
// ─────────────────────────────────────────────
async function transaction(callback) {
  const d = getDb();
  await d.run('BEGIN TRANSACTION');
  try {
    const result = await callback(d);
    await d.run('COMMIT');
    return result;
  } catch (err) {
    try { await d.run('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

// ─────────────────────────────────────────────
// Fermeture propre
// ─────────────────────────────────────────────
async function closeDatabase() {
  if (db) {
    await db.close();
    db = null;
    console.log('🔒 SQLite fermé');
  }
}

module.exports = {
  initDatabase,
  getDb,
  query,
  get,
  run,
  exec,
  transaction,
  closeDatabase,
};