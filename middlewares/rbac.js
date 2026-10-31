// backend/middlewares/rbac.js
const { get, query } = require('../database/db');

// ─────────────────────────────────────────────
// Matrice de permissions par rôle
// ─────────────────────────────────────────────
const PERMISSIONS = {
  admin: {
    // Catégories, départements, boutiques
    categories:     ['create', 'read', 'update', 'delete'],
    departements:   ['create', 'read', 'update', 'delete'],
    boutiques:      ['create', 'read', 'update', 'delete'],
    // Utilisateurs / personnel
    users:          ['create', 'read', 'update', 'delete'],
    personnel:      ['create', 'read', 'update', 'delete'],
    paiements:      ['create', 'read', 'update', 'delete'],
    // Produits / commandes / ventes
    produits:       ['create', 'read', 'update', 'delete'],
    commandes:      ['create', 'read', 'update', 'delete'],
    ventes:         ['create', 'read', 'update', 'delete'],
    ravitaillements: ['create', 'read', 'update', 'delete'],
    // Finances
    charges:        ['create', 'read', 'update', 'delete'],
    dashboards:     ['read'],
    rapports:       ['read', 'export'],
    parametres:     ['read', 'update'],
    // AlkherPay
    paiements_alkherpay: ['read', 'execute'],
  },
  gerant: {
    categories:     ['read'],
    departements:   ['read'],
    boutiques:      ['read', 'update'],              // seulement ses boutiques
    users:          ['read'],
    personnel:      ['create', 'read', 'update'],
    paiements:      ['create', 'read'],
    produits:       ['read', 'update'],              // évaluation, pas de création
    commandes:      ['create', 'read', 'update'],    // ✅ peut créer (pour soi) + valider
    ventes:         ['read', 'update'],              // valider vente
    ravitaillements: ['create', 'read', 'update'],
    charges:        ['create', 'read'],
    dashboards:     ['read'],
    rapports:       ['read', 'export'],
    parametres:     [],
    paiements_alkherpay: ['read'],
  },
  agent: {
    categories:     ['read'],
    boutiques:      ['read'],                        // ✅ peut lire TOUTES les boutiques actives
    produits:       ['read'],                        // ✅ peut voir les produits pour commander
    commandes:      ['create', 'read'],              // ✅ peut créer ses commandes
    ventes:         ['create', 'read'],              // ✅ enregistre ses ventes
    personnel:      ['read'],                        // ✅ peut voir (dropdowns éventuels)
    paiements:      [],
    charges:        [],
    ravitaillements: ['read'],                       // ✅ peut voir (info stock)
    dashboards:     ['read'],
    rapports:       ['read', 'export'],              // ✅ seulement ses données
    paiements_alkherpay: ['read', 'execute'],
  },
  user: {
    categories:     ['read'],
    boutiques:      ['read'],
    produits:       ['read'],
    commandes:      [],
    ventes:         [],
    personnel:      [],
    paiements:      [],
    charges:        [],
    ravitaillements: [],
    dashboards:     ['read'],
    rapports:       [],
    paiements_alkherpay: ['read'],
  },
};

// ─────────────────────────────────────────────
// Vérifier une permission
// ─────────────────────────────────────────────
function hasPermission(role, resource, action) {
  const rolePerms = PERMISSIONS[role];
  if (!rolePerms) return false;
  const resourcePerms = rolePerms[resource];
  if (!resourcePerms) return false;
  return resourcePerms.includes(action);
}

// ─────────────────────────────────────────────
// Middleware : requireRole('admin', 'gerant')
// ─────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise',
        code: 'RBAC_NO_AUTH',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Accès réservé aux rôles : ${roles.join(', ')}`,
        code: 'RBAC_ROLE_FORBIDDEN',
        your_role: req.user.role,
      });
    }
    next();
  };
}

// ─────────────────────────────────────────────
// Middleware : requirePermission('produits', 'create')
// ─────────────────────────────────────────────
function requirePermission(resource, action) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise',
        code: 'RBAC_NO_AUTH',
      });
    }

    if (!hasPermission(req.user.role, resource, action)) {
      return res.status(403).json({
        success: false,
        error: `Permission refusée : ${action} sur ${resource}`,
        code: 'RBAC_PERMISSION_DENIED',
        role: req.user.role,
        resource,
        action,
      });
    }
    next();
  };
}

// ─────────────────────────────────────────────
// Middleware : requireAdmin
// ─────────────────────────────────────────────
const requireAdmin = requireRole('admin');

// ─────────────────────────────────────────────
// Middleware : requireGerantOrAdmin
// ─────────────────────────────────────────────
const requireGerantOrAdmin = requireRole('admin', 'gerant');

// ─────────────────────────────────────────────
// Middleware : requireAgent
// ─────────────────────────────────────────────
const requireAgent = requireRole('agent');

// ─────────────────────────────────────────────
// Vérification d'appartenance (scoping)
// ─────────────────────────────────────────────

// Vérifier que l'utilisateur a accès à une boutique
async function canAccessBoutique(user, boutiqueId) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  if (user.role === 'gerant') {
    const boutique = await get(
      `SELECT id FROM boutiques 
       WHERE id = ? AND (
         gerant_id = ? 
         OR departement_id IN (SELECT id FROM departements WHERE responsable_id = ?)
       )`,
      [boutiqueId, user.userId, user.userId]
    );
    return !!boutique;
  }

  if (user.role === 'agent') {
    // ✅ Un agent peut accéder à toute boutique active
    // (pour créer sa première commande, puis la validation gérant contrôle)
    const boutique = await get(
      'SELECT id FROM boutiques WHERE id = ? AND is_active = 1',
      [boutiqueId]
    );
    return !!boutique;
  }

  if (user.role === 'user') {
    // Un user peut voir les boutiques actives en lecture seule
    const boutique = await get(
      'SELECT id FROM boutiques WHERE id = ? AND is_active = 1',
      [boutiqueId]
    );
    return !!boutique;
  }

  return false;
}

// Vérifier qu'un agent a accès à une ressource qui lui appartient
function ownsResource(user, resourceOwnerId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return parseInt(resourceOwnerId, 10) === user.userId;
}

// Middleware : requireBoutiqueAccess (lit req.params.boutiqueId ou req.body.boutique_id)
async function requireBoutiqueAccess(req, res, next) {
  const boutiqueId =
    req.params.boutiqueId ||
    req.params.id ||
    req.body?.boutique_id;

  if (!boutiqueId) {
    return res.status(400).json({
      success: false,
      error: 'ID boutique requis',
    });
  }

  const ok = await canAccessBoutique(req.user, parseInt(boutiqueId, 10));
  if (!ok) {
    return res.status(403).json({
      success: false,
      error: 'Accès non autorisé à cette boutique',
      code: 'RBAC_BOUTIQUE_FORBIDDEN',
    });
  }
  next();
}

// ─────────────────────────────────────────────
// Helper : obtenir la liste des boutiques accessibles
// ─────────────────────────────────────────────
async function getAccessibleBoutiques(user) {
  if (!user) return [];

  // ✅ Admin : toutes les boutiques
  if (user.role === 'admin') {
    return await query(
      'SELECT id, name FROM boutiques WHERE is_active = 1 ORDER BY name ASC'
    );
  }

  // ✅ Gérant : ses boutiques + celles de son département
  if (user.role === 'gerant') {
    return await query(
      `SELECT DISTINCT b.id, b.name FROM boutiques b
       LEFT JOIN departements d ON b.departement_id = d.id
       WHERE b.is_active = 1
         AND (b.gerant_id = ? OR d.responsable_id = ?)
       ORDER BY b.name ASC`,
      [user.userId, user.userId]
    );
  }

  // ✅ Agent : TOUTES les boutiques actives (peut commander partout)
  if (user.role === 'agent') {
    return await query(
      `SELECT id, name FROM boutiques 
       WHERE is_active = 1 
       ORDER BY name ASC`
    );
  }

  // ✅ User : toutes les boutiques actives (lecture seule)
  if (user.role === 'user') {
    return await query(
      `SELECT id, name FROM boutiques 
       WHERE is_active = 1 
       ORDER BY name ASC`
    );
  }

  return [];
}

module.exports = {
  PERMISSIONS,
  hasPermission,
  requireRole,
  requirePermission,
  requireAdmin,
  requireGerantOrAdmin,
  requireAgent,
  requireBoutiqueAccess,
  canAccessBoutique,
  ownsResource,
  getAccessibleBoutiques,
};