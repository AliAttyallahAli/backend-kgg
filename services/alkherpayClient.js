// backend/services/alkherpayClient.js
const axios = require('axios');
const { get, run } = require('../database/db');

// ═══════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════
const ALKHERPAY_BASE_URL = process.env.ALKHERPAY_BASE_URL || 'http://localhost:5000';
const ALKHERPAY_ADMIN_PHONE = process.env.ALKHERPAY_ADMIN_PHONE;
const ALKHERPAY_ADMIN_PASSWORD = process.env.ALKHERPAY_ADMIN_PASSWORD;
const TIMEOUT = parseInt(process.env.ALKHERPAY_API_TIMEOUT, 10) || 15000;
const SHORT_TIMEOUT = 5000;

// Cache de tokens user : Map<userId, {token, expiry}>
const tokenCache = new Map();

// Token admin
let adminToken = null;
let adminTokenExpiry = 0;

const client = axios.create({
  baseURL: ALKHERPAY_BASE_URL,
  timeout: TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
});

// ═══════════════════════════════════════════════
// LOG DE DÉMARRAGE
// ═══════════════════════════════════════════════
console.log('');
console.log('═══════════════════════════════════════════════');
console.log('🔍 [AlkherPay Client] INITIALISATION');
console.log('   BASE_URL   :', ALKHERPAY_BASE_URL);
console.log('   ADMIN_PHONE:', ALKHERPAY_ADMIN_PHONE || '⚠️ NON DÉFINI');
console.log('   ADMIN_PWD  :', ALKHERPAY_ADMIN_PASSWORD ? '✓ défini' : '❌ MANQUANT');
console.log('   TIMEOUT    :', TIMEOUT, 'ms');
console.log('═══════════════════════════════════════════════');
console.log('');

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════
function extractError(err) {
  const data = err.response?.data || {};
  const isHtml = typeof data === 'string' && data.trim().startsWith('<');
  return {
    message: isHtml
      ? `Route non trouvée (${err.response?.status})`
      : (data.error || data.message || err.message || 'Erreur inconnue'),
    code: isHtml ? 'ROUTE_NOT_FOUND' : (data.code || err.code || 'ALKHERPAY_ERROR'),
    status: err.response?.status || err.status || 500,
    attemptsRemaining: data.attemptsRemaining,
    blockedUntil: data.blockedUntil,
    originalError: err,
  };
}

function log(level, msg, data) {
  const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
  const icon = icons[level] || 'ℹ️';
  if (data && process.env.NODE_ENV === 'development') {
    console.log(`${icon} [AlkherPay] ${msg}`, data);
  } else {
    console.log(`${icon} [AlkherPay] ${msg}`);
  }
}

// ═══════════════════════════════════════════════
// USER : récupérer les infos + lien AlkherPay
// ═══════════════════════════════════════════════
async function getUserWithAlkherPay(userId) {
  const user = await get(
    `SELECT id, phone, fullname, email,
            alkherpay_user_id, alkherpay_phone, alkherpay_linked_at,
            alkherpay_link_status
     FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) throw new Error('Utilisateur introuvable');
  return user;
}

// ═══════════════════════════════════════════════
// AUTHENTIFICATION ADMIN
// ═══════════════════════════════════════════════
async function getAdminToken(forceRefresh = false) {
  if (!forceRefresh && adminToken && Date.now() < adminTokenExpiry - 60_000) {
    return adminToken;
  }

  if (!ALKHERPAY_ADMIN_PHONE || !ALKHERPAY_ADMIN_PASSWORD) {
    throw new Error('Admin AlkherPay non configuré (vérifiez .env)');
  }

  try {
    log('info', `Login admin sur ${ALKHERPAY_BASE_URL} avec ${ALKHERPAY_ADMIN_PHONE}`);

    const { data } = await client.post('/api/auth/login', {
      phone: ALKHERPAY_ADMIN_PHONE,
      password: ALKHERPAY_ADMIN_PASSWORD,
    });

    if (!data?.tokens?.accessToken) {
      throw new Error('Réponse AlkherPay invalide (pas de token)');
    }

    adminToken = data.tokens.accessToken;
    adminTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    log('success', `Token admin obtenu (${adminToken.length} car.)`);
    return adminToken;
  } catch (err) {
    log('error', 'Login admin échoué', extractError(err).message);
    throw err;
  }
}

// ═══════════════════════════════════════════════
// REQUEST AUTHENTIFIÉ (avec retry 401)
// ═══════════════════════════════════════════════
async function authedRequest(method, url, data = null, opts = {}, retried = false) {
  const token = await getAdminToken();

  try {
    return await client.request({
      method,
      url,
      data,
      ...opts,
      headers: {
        ...opts.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    if (err.response?.status === 401 && !retried) {
      log('warn', 'Token expiré, rafraîchissement...');
      adminToken = null;
      await getAdminToken(true);
      return authedRequest(method, url, data, opts, true);
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════
// VÉRIFIER SI UN TÉLÉPHONE EXISTE DANS ALKHERPAY
// ═══════════════════════════════════════════════
async function checkPhoneExists(phone) {
  try {
    const { data } = await client.get(`/api/user/check-phone/${phone}`, {
      timeout: SHORT_TIMEOUT,
    });
    if (typeof data === 'object' && data !== null) {
      return { exists: data.exists === true, user: data.user || null };
    }
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      log('warn', 'Route check-phone absente, fallback login');
      try {
        await client.post(
          '/api/auth/login',
          { phone, password: '__check__' },
          { timeout: SHORT_TIMEOUT }
        );
        return { exists: true };
      } catch (loginErr) {
        const loginStatus = loginErr.response?.status;
        if (loginStatus === 401) return { exists: true };
        if (loginStatus === 404) return { exists: false };
        return { exists: true };
      }
    }
    return { exists: true };
  }
  return { exists: false };
}

// ═══════════════════════════════════════════════
// API EXPORTÉE
// ═══════════════════════════════════════════════
module.exports = {
  // ─────────────────────────────────────────
  // LIER UN COMPTE ALKHERPAY
  // ─────────────────────────────────────────
  async linkAlkherPayAccount(userId, alkherpayPhone) {
    log('info', `Liaison user ${userId} → AlkherPay ${alkherpayPhone}`);

    const check = await checkPhoneExists(alkherpayPhone);

    if (!check.exists) {
      throw Object.assign(
        new Error(`Aucun compte AlkherPay avec le numéro ${alkherpayPhone}`),
        { code: 'PHONE_NOT_FOUND', status: 404 }
      );
    }

    await run(
      `UPDATE users SET
         alkherpay_phone = ?,
         alkherpay_link_status = 'linked',
         alkherpay_linked_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [alkherpayPhone, userId]
    );

    log('success', `Compte AlkherPay ${alkherpayPhone} lié`);

    return {
      success: true,
      alkherpay_phone: alkherpayPhone,
      message: 'Compte AlkherPay lié',
    };
  },

  // ─────────────────────────────────────────
  // SOLDE DU USER — NE DOIT JAMAIS PLANTER
  // ─────────────────────────────────────────
  async getUserSolde(userId) {
    let user;
    try {
      user = await getUserWithAlkherPay(userId);
    } catch (err) {
      log('error', 'getUserSolde — user introuvable', err.message);
      return {
        linked: false,
        balance: 0,
        currency: 'XAF',
        fullname: null,
        phone: null,
        alkherpay_phone: null,
        message: 'Utilisateur introuvable',
      };
    }

    // 1️⃣ Pas de compte lié
    if (!user.alkherpay_phone) {
      log('info', `User ${user.phone} non lié à AlkherPay`);
      return {
        linked: false,
        balance: 0,
        currency: 'XAF',
        fullname: user.fullname,
        phone: user.phone,
        alkherpay_phone: null,
        message: 'Aucun compte AlkherPay lié. Créez-en un pour effectuer des transferts.',
        requiresLink: true,
      };
    }

    log('info', `Solde demandé pour ${user.alkherpay_phone}`);

    // ✅ FORCER un token frais avant les appels (évite les vieux tokens en cache)
    adminToken = null;
    adminTokenExpiry = 0;

    let token;
    try {
      token = await getAdminToken(true);
      log('info', `Token admin frais : ${token.length} car.`);
    } catch (err) {
      log('error', 'Impossible d\'obtenir un token admin', err.message);
      return {
        linked: true,
        degraded: true,
        balance: 0,
        currency: 'XAF',
        fullname: user.fullname,
        phone: user.alkherpay_phone,
        alkherpay_phone: user.alkherpay_phone,
        message: 'Service AlkherPay indisponible (login admin échoué).',
        error: err.message,
      };
    }

    // 2️⃣ Essayer la route spécifique au phone
    try {
      const response = await client.get(
        `/api/wallet/balance/${user.alkherpay_phone}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: SHORT_TIMEOUT,
        }
      );

      const data = response.data;
      if (data && typeof data === 'object' && data.balance !== undefined) {
        log('success', `Solde spécifique OK : ${data.balance} FCFA`);
        return {
          linked: true,
          balance: data.balance || 0,
          currency: data.currency || 'XAF',
          fullname: data.fullname || user.fullname,
          phone: data.phone || user.alkherpay_phone,
          alkherpay_phone: user.alkherpay_phone,
          province: data.province,
        };
      }
    } catch (err) {
      const info = extractError(err);
      log('warn', `Route /balance/:phone échouée (${info.status}) — fallback`);
    }

    // 3️⃣ Fallback : route générique
    try {
      log('info', 'Tentative fallback /api/wallet/balance');

      const response = await client.get('/api/wallet/balance', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: SHORT_TIMEOUT,
      });

      const data = response.data;
      log('info', 'Réponse fallback brute reçue');

      if (data && typeof data === 'object' && data.balance !== undefined) {
        log('success', `Fallback OK : ${data.balance} FCFA`);
        return {
          linked: true,
          balance: data.balance || 0,
          currency: data.currency || 'XAF',
          fullname: data.fullname || user.fullname,
          phone: user.alkherpay_phone,
          alkherpay_phone: user.alkherpay_phone,
          province: data.province,
          fallback: true,
        };
      }
    } catch (err) {
      log('error', 'Fallback échoué — DÉTAILS :', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        url: err.config?.url,
        baseURL: err.config?.baseURL,
        method: err.config?.method?.toUpperCase(),
        hasAuth: !!err.config?.headers?.Authorization,
        responseType: typeof err.response?.data,
        responseData: typeof err.response?.data === 'string'
          ? err.response.data.slice(0, 200)
          : err.response?.data,
        message: err.message,
        code: err.code,
      });
    }

    // 4️⃣ Échec total → renvoyer un solde dégradé (PAS un throw)
    log('error', 'Solde totalement indisponible');
    return {
      linked: true,
      degraded: true,
      balance: 0,
      currency: 'XAF',
      fullname: user.fullname,
      phone: user.alkherpay_phone,
      alkherpay_phone: user.alkherpay_phone,
      message: 'Service AlkherPay temporairement indisponible.',
    };
  },

  // ─────────────────────────────────────────
  // TRANSFERT
  // ─────────────────────────────────────────
  async transfert(userId, { receiver_phone, amount, description, pin }) {
    const user = await getUserWithAlkherPay(userId);

    if (!user.alkherpay_phone) {
      throw Object.assign(
        new Error('Compte AlkherPay non lié. Créez-en un pour effectuer des transferts.'),
        { code: 'NO_ALKHERPAY_ACCOUNT', status: 403, requiresLink: true }
      );
    }

    if (!pin || !/^\d{4}$/.test(pin)) {
      throw Object.assign(
        new Error('PIN 4 chiffres requis'),
        { code: 'PIN_REQUIRED', status: 400 }
      );
    }

    // Étape 1 : vérifier le PIN (best-effort)
    try {
      await authedRequest(
        'POST',
        `/api/user/verify-transaction-pin/${user.alkherpay_phone}`,
        { pin },
        { timeout: SHORT_TIMEOUT }
      );
      log('success', 'PIN vérifié avant transfert');
    } catch (pinErr) {
      const info = extractError(pinErr);
      if (info.status === 404) {
        log('warn', 'Route verify-pin absente, la vérif sera faite par /transfer');
      } else {
        log('error', 'Vérification PIN échouée', info);
        throw Object.assign(
          new Error(info.message),
          {
            code: info.code,
            status: info.status,
            attemptsRemaining: info.attemptsRemaining,
            blockedUntil: info.blockedUntil,
          }
        );
      }
    }

    // Étape 2 : effectuer le transfert
    try {
      const { data } = await authedRequest('POST', '/api/transfer', {
        sender_phone: user.alkherpay_phone,
        receiver_phone,
        amount,
        description,
        pin,
      });

      log('success', `Transfert réussi vers ${receiver_phone}`);
      return data;
    } catch (err) {
      const info = extractError(err);
      log('error', 'Transfert échoué', info.message);
      throw err;
    }
  },

  // ─────────────────────────────────────────
  // HISTORIQUE
  // ─────────────────────────────────────────
  async getUserHistorique(userId, { limit = 50, offset = 0 } = {}) {
    const user = await getUserWithAlkherPay(userId);

    if (!user.alkherpay_phone) {
      return {
        transactions: [],
        total: 0,
        linked: false,
        message: 'Compte AlkherPay non lié',
      };
    }

    // Essayer route spécifique
    try {
      const { data } = await authedRequest(
        'GET',
        `/api/wallet/history/${user.alkherpay_phone}?limit=${limit}&offset=${offset}`,
        null,
        { timeout: SHORT_TIMEOUT }
      );
      if (data && typeof data === 'object') {
        return { ...data, linked: true };
      }
    } catch (err) {
      log('warn', 'Route /history/:phone indisponible, fallback');
    }

    // Fallback générique
    try {
      const { data } = await authedRequest(
        'GET',
        `/api/wallet/history?limit=${limit}&offset=${offset}`,
        null,
        { timeout: SHORT_TIMEOUT }
      );
      if (data && typeof data === 'object') {
        return { ...data, linked: true, fallback: true };
      }
    } catch (err) {
      log('error', 'Historique indisponible');
    }

    return { transactions: [], total: 0, linked: true };
  },

  // ─────────────────────────────────────────
  // STATUT PIN DU USER
  // ─────────────────────────────────────────
  async getUserPinStatus(userId) {
    const user = await getUserWithAlkherPay(userId);

    if (!user.alkherpay_phone) {
      return { hasPin: false, isPinSet: false, linked: false };
    }

    // Essayer route spécifique
    try {
      const { data } = await authedRequest(
        'GET',
        `/api/user/pin-status/${user.alkherpay_phone}`,
        null,
        { timeout: SHORT_TIMEOUT }
      );
      if (data && typeof data === 'object') {
        const hasPin = data.hasPin === true || data.isPinSet === true;
        return { hasPin, isPinSet: hasPin, linked: true };
      }
    } catch (err) {
      log('warn', 'Route /pin-status/:phone indisponible, fallback');
    }

    // Fallback générique
    try {
      const { data } = await authedRequest(
        'GET',
        '/api/user/pin-status',
        null,
        { timeout: SHORT_TIMEOUT }
      );
      if (data && typeof data === 'object') {
        const hasPin = data.hasPin === true || data.isPinSet === true;
        return { hasPin, isPinSet: hasPin, linked: true, fallback: true };
      }
    } catch (err) {
      log('error', 'PIN status indisponible');
    }

    return { hasPin: false, isPinSet: false, linked: true };
  },

  // ─────────────────────────────────────────
  // DÉFINIR LE PIN
  // ─────────────────────────────────────────
  async setUserPin(userId, { pin }) {
    const user = await getUserWithAlkherPay(userId);

    if (!user.alkherpay_phone) {
      throw Object.assign(
        new Error('Compte AlkherPay non lié'),
        { code: 'NO_ALKHERPAY_ACCOUNT', status: 403 }
      );
    }

    try {
      const { data } = await authedRequest(
        'POST',
        `/api/user/set-transaction-pin/${user.alkherpay_phone}`,
        { pin }
      );
      log('success', 'PIN défini (route spécifique)');
      return data;
    } catch (err) {
      const info = extractError(err);
      if (info.status === 404) {
        const { data } = await authedRequest(
          'POST',
          '/api/user/set-transaction-pin',
          { pin }
        );
        log('success', 'PIN défini (route générique)');
        return data;
      }
      throw err;
    }
  },

  // ─────────────────────────────────────────
  // VÉRIFIER LE PIN
  // ─────────────────────────────────────────
  async verifyUserPin(userId, { pin }) {
    const user = await getUserWithAlkherPay(userId);

    if (!user.alkherpay_phone) {
      throw Object.assign(
        new Error('Compte AlkherPay non lié'),
        { code: 'NO_ALKHERPAY_ACCOUNT', status: 403 }
      );
    }

    try {
      const { data } = await authedRequest(
        'POST',
        `/api/user/verify-transaction-pin/${user.alkherpay_phone}`,
        { pin }
      );
      return data;
    } catch (err) {
      const info = extractError(err);
      if (info.status === 404) {
        const { data } = await authedRequest(
          'POST',
          '/api/user/verify-transaction-pin',
          { pin }
        );
        return data;
      }
      throw err;
    }
  },

  // ─────────────────────────────────────────
  // EXPORTS UTILITAIRES
  // ─────────────────────────────────────────
  checkPhoneExists,
  getAdminToken,
};