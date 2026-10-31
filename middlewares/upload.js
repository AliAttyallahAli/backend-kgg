// backend/middlewares/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 5 * 1024 * 1024;

function makeStorage(subfolder) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, subfolder);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safe = `${Date.now()}-${uuidv4().slice(0, 8)}${ext}`;
      cb(null, safe);
    },
  });
}

function fileFilter(req, file, cb) {
  const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'application/pdf'];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error('Type de fichier non autorisé (image/PDF uniquement)'), false);
  }
  cb(null, true);
}

const uploadCharge    = multer({ storage: makeStorage('charges'),    fileFilter, limits: { fileSize: MAX_FILE_SIZE } });
const uploadPersonnel = multer({ storage: makeStorage('personnel'),  fileFilter, limits: { fileSize: MAX_FILE_SIZE } });
const uploadPaiement  = multer({ storage: makeStorage('paiements'),  fileFilter, limits: { fileSize: MAX_FILE_SIZE } });

// Uploader dédié aux images produits (10 max, uniquement images)
const uploadProduit = multer({
  storage: makeStorage('produits'),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Format d\'image non supporté (JPG, PNG, WebP uniquement)'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_FILE_SIZE, files: 10 },
});

// backend/middlewares/upload.js — ajouter à la fin

// ─────────────────────────────────────────────
// Uploader pour les guides d'aide (PDF, DOCX, etc.)
// ─────────────────────────────────────────────
const uploadGuide = multer({
  storage: makeStorage('guides'),
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg', 'image/png', 'image/jpg', 'image/webp',
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Type de fichier non autorisé (PDF, DOCX, XLSX, images)'), false);
    }
    cb(null, true);
  },
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 Mo
});

module.exports = { uploadCharge, uploadPersonnel, uploadPaiement, uploadProduit, uploadGuide };
