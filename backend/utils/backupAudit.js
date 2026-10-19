const db = require('../database.js');

// Registro de backup no mesmo formato dos outros registros de auditoria
// (action/actor/timestamp, como notas e cadastro), com os dados em `details`.
// Fica num módulo próprio porque também é usado pela guarda de permissões
// (middlewares.js), que recusa a restauração antes de a rota rodar.
function recordBackupAudit(req, account, action, details = {}) {
    if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
    const entry = {
        id: `audit_backup_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        action,
        actor: (account && account.email) || 'admin',
        timestamp: Date.now(),
        ip: (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '',
        device: (req && req.headers && req.headers['user-agent']) || '',
        category: 'backup',
        details,
    };
    db.memory.auditLogs.push(entry);
    return entry;
}

const RESTORE_PATH = /^\/backup\/restore\/?$/i;

function isBackupRestoreRequest(req) {
    return !!req && String(req.method || '').toUpperCase() === 'POST' && RESTORE_PATH.test(String(req.path || ''));
}

module.exports = { recordBackupAudit, isBackupRestoreRequest };
