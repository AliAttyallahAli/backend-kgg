// backend/services/auditService.js
const { run } = require('../database/db');

async function logAction({ userId = null, action, resource = null, resourceId = null, details = null, ip = null }) {
  try {
    await run(
      `INSERT INTO audit_logs (user_id, action, resource, resource_id, details, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        action,
        resource,
        resourceId,
        details ? JSON.stringify(details) : null,
        ip,
      ]
    );
  } catch (err) {
    // Ne jamais casser la requête à cause du log
    console.warn('⚠️  audit log failed:', err.message);
  }
}

module.exports = { logAction };