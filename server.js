// backend/server.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const { initDatabase, get, closeDatabase } = require('./database/db');
const { notFoundHandler, errorHandler } = require('./middlewares/errorHandler');

// ════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════
const PORT = process.env.PORT || 9000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const ALKHERPAY_BASE_URL = process.env.ALKHERPAY_BASE_URL || 'http://localhost:5000';
const JWT_SECRET = process.env.JWT_SECRET || 'khamis_super_secret_key';

// ════════════════════════════════════════════════════
// APPLICATION
// ════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);

// ════════════════════════════════════════════════════
// SOCKET.IO
// ════════════════════════════════════════════════════
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://192.168.1.199:5173',
  FRONTEND_URL,
  /\.vercel\.app$/,
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true,
});

// Rendre io accessible partout
app.set('io', io);
global.io = io;

// ════════════════════════════════════════════════════
// MIDDLEWARES GLOBAUX
// ════════════════════════════════════════════════════
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));

// ════════════════════════════════════════════════════
// RATE LIMITING INTELLIGENT
// ════════════════════════════════════════════════════
const limiter = rateLimit({
  windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 15) * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || (NODE_ENV === 'development' ? 10000 : 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Trop de requêtes. Réessayez dans quelques minutes.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  // ✅ Ne pas limiter les routes critiques
  skip: (req) => {
    const path = req.path;
    const skipPaths = [
      '/api/health',
      '/api/auth/me',
      '/api/auth/refresh',
      '/api/notifications',
    ];
    return skipPaths.some((p) => path.startsWith(p));
  },
});

app.use('/api/', limiter);

// ════════════════════════════════════════════════════
// FICHIERS STATIQUES
// ════════════════════════════════════════════════════
const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || './uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ════════════════════════════════════════════════════
// INJECTION DE `io` DANS CHAQUE REQUÊTE
// ════════════════════════════════════════════════════
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ════════════════════════════════════════════════════
// HEALTH CHECK (enrichi)
// ════════════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const startTime = Date.now();

  // Test DB
  let dbStatus = 'unknown';
  let dbLatency = null;
  try {
    const t = Date.now();
    await get('SELECT 1 AS ok');
    dbLatency = Date.now() - t;
    dbStatus = 'ok';
  } catch (err) {
    dbStatus = 'error';
  }

  // Test AlkherPay (optionnel, timeout court)
  let alkherStatus = 'unknown';
  try {
    await axios.get(`${ALKHERPAY_BASE_URL}/api/health`, { timeout: 2000 });
    alkherStatus = 'ok';
  } catch (err) {
    alkherStatus = err.response ? 'reachable' : 'unreachable';
  }

  const uptime = process.uptime();

  res.json({
    success: true,
    status: 'ok',
    app: 'khamis GLOBALE GROUPES',
    version: '1.0.0',
    environment: NODE_ENV,
    time: new Date().toISOString(),
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
    latency: `${Date.now() - startTime}ms`,
    services: {
      database: {
        status: dbStatus,
        latency: dbLatency ? `${dbLatency}ms` : null,
      },
      alkherpay: {
        status: alkherStatus,
        url: ALKHERPAY_BASE_URL,
      },
    },
    memory: {
      used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
    },
  });
});

// ════════════════════════════════════════════════════
// ROUTES API
// ════════════════════════════════════════════════════
app.use('/api/auth',            require('./routes/auth.routes'));
app.use('/api/users',           require('./routes/users.routes'));
app.use('/api/categories',      require('./routes/categories.routes'));
app.use('/api/departements',    require('./routes/departements.routes'));
app.use('/api/boutiques',       require('./routes/boutiques.routes'));
app.use('/api/produits',        require('./routes/produits.routes'));
app.use('/api/commandes',       require('./routes/commandes.routes'));
app.use('/api/ventes',          require('./routes/ventes.routes'));
app.use('/api/personnel',       require('./routes/personnel.routes'));
app.use('/api/paiements',       require('./routes/paiements.routes'));
app.use('/api/charges',         require('./routes/charges.routes'));
app.use('/api/ravitaillements', require('./routes/ravitaillements.routes'));
app.use('/api/dashboards',      require('./routes/dashboards.routes'));
app.use('/api/rapports',        require('./routes/rapports.routes'));
app.use('/api/notifications',   require('./routes/notifications.routes'));
app.use('/api/parametres',      require('./routes/parametres.routes'));
app.use('/api/khamis/paiements', require('./routes/khamis-alkherpay.routes'));

// ════════════════════════════════════════════════════
// SOCKET.IO — AUTHENTIFICATION
// ════════════════════════════════════════════════════
io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.split(' ')[1];

    if (!token) {
      return next(new Error('Token requis'));
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.role = decoded.role;
    socket.phone = decoded.phone;
    next();
  } catch (err) {
    console.warn('⚠️ Socket auth échouée :', err.message);
    next(new Error('Token invalide'));
  }
});

// ════════════════════════════════════════════════════
// SOCKET.IO — CONNEXION
// ════════════════════════════════════════════════════
io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`🔌 Socket connecté : user ${userId} (${socket.id})`);

  // Rejoindre une room personnelle
  socket.join(`user_${userId}`);

  // Les admins rejoignent aussi la room "admins"
  if (socket.role === 'admin') {
    socket.join('admins');
  }

  // Événement : "je suis en ligne"
  socket.emit('connected', {
    userId,
    timestamp: new Date().toISOString(),
  });

  // Déconnexion
  socket.on('disconnect', (reason) => {
    console.log(`🔌 Socket déconnecté : user ${userId} (${reason})`);
  });

  // Erreur
  socket.on('error', (err) => {
    console.error(`❌ Socket erreur user ${userId} :`, err.message);
  });
});

const marketRoutes = require('./routes/market.routes');
app.use('/api/market', marketRoutes);
// ════════════════════════════════════════════════
// ROUTES AGENT (ventes personnelles)
// ════════════════════════════════════════════════
const agentRoutes = require('./routes/agent.routes');
app.use('/api/agent', agentRoutes);
// ════════════════════════════════════════════════
// ADMIN AGENTS
// ════════════════════════════════════════════════
const adminAgentsRoutes = require('./routes/admin-agents.routes');
app.use('/api/admin/agents', adminAgentsRoutes);
// ════════════════════════════════════════════════════
// UTILITAIRES DE NOTIFICATION
// ════════════════════════════════════════════════════
// ════════════════════════════════════════════════
// AIDE (ressources : guides, vidéos, liens)
// ════════════════════════════════════════════════
const helpRoutes = require('./routes/help.routes');
app.use('/api/help', helpRoutes);

// ════════════════════════════════════════════════
// LIVREURS & LIVRAISONS
// ════════════════════════════════════════════════
const livreursRoutes = require('./routes/livreurs.routes');
const livraisonsRoutes = require('./routes/livraisons.routes');
app.use('/api/livreurs', livreursRoutes);
app.use('/api/livraisons', livraisonsRoutes);

// ════════════════════════════════════════════════
// PARTENAIRES
// ════════════════════════════════════════════════
const partenairesRoutes = require('./routes/partenaires.routes');
app.use('/api/partenaires', partenairesRoutes);



function notifyUser(userId, notification) {
  io.to(`user_${userId}`).emit('notification', {
    ...notification,
    timestamp: notification.timestamp || new Date().toISOString(),
  });
}

function notifyAdmins(notification) {
  io.to('admins').emit('notification', {
    ...notification,
    timestamp: notification.timestamp || new Date().toISOString(),
  });
}

function notifyRole(role, notification) {
  // Attention : ne fonctionne que si les users de ce rôle sont connectés
  io.emit(`notification_${role}`, {
    ...notification,
    timestamp: notification.timestamp || new Date().toISOString(),
  });
}

global.notifyUser = notifyUser;
global.notifyAdmins = notifyAdmins;
global.notifyRole = notifyRole;

// ════════════════════════════════════════════════════
// 404 + GESTION D'ERREURS
// ════════════════════════════════════════════════════
app.use(notFoundHandler);
app.use(errorHandler);

// ════════════════════════════════════════════════════
// DÉMARRAGE
// ════════════════════════════════════════════════════
(async () => {
  try {
    // 1. Initialiser la DB
    await initDatabase();

    // 2. Démarrer le serveur HTTP
    server.listen(PORT, () => {
      console.log('');
      console.log('═══════════════════════════════════════════════════');
      console.log('  🚀 khamis GLOBALE GROUPES — Backend v1.0');
      console.log('═══════════════════════════════════════════════════');
      console.log(`  🌍 Environnement : ${NODE_ENV}`);
      console.log(`  🌐 API           : http://localhost:${PORT}/api`);
      console.log(`  🩺 Health        : http://localhost:${PORT}/api/health`);
      console.log(`  🔌 WebSocket     : ws://localhost:${PORT}`);
      console.log(`  🎨 Frontend      : ${FRONTEND_URL}`);
      console.log(`  💳 AlkherPay     : ${ALKHERPAY_BASE_URL}`);
      console.log(`  📁 Uploads       : ${uploadDir}`);
      console.log('═══════════════════════════════════════════════════');
      console.log('  ✅ Backend prêt à recevoir des requêtes');
      console.log('═══════════════════════════════════════════════════');
      console.log('');
    });

    // 3. Gestion propre de l'arrêt
    const shutdown = async (signal) => {
      console.log('');
      console.log(`⚠️  Signal ${signal} reçu, arrêt en cours...`);

      // Fermer Socket.IO
      io.close(() => {
        console.log('🔌 Socket.IO fermé');
      });

      // Fermer HTTP
      server.close(() => {
        console.log('🌐 HTTP fermé');
      });

      // Fermer DB
      try {
        await closeDatabase();
        console.log('🗄️  Base de données fermée');
      } catch (err) {
        console.error('❌ Erreur fermeture DB :', err.message);
      }

      console.log('✅ Arrêt terminé');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    console.error('');
    console.error('❌ ERREUR FATALE AU DÉMARRAGE');
    console.error('═══════════════════════════════════════════════════');
    console.error(err);
    console.error('═══════════════════════════════════════════════════');
    console.error('');
    process.exit(1);
  }
})();

// ════════════════════════════════════════════════════
// EXPORTS
// ════════════════════════════════════════════════════
module.exports = { app, server, io };