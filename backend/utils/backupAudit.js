const db = require('../database.js');
const { recordAudit } = require('./audit.js');

// Registro de backup no formato canônico da auditoria (action/actor/timestamp, como
// notas e cadastro), com os dados em `details`: atalho para recordAudit, na categoria
// 'backup'. Fica num módulo próprio porque também é usado pela guarda de permissões
// (middlewares.js), que recusa a restauração antes de a rota rodar.
function recordBackupAudit(req, account, action, details = {}) {
    return recordAudit(db.memory, {
        req,
        actor: account && account.email ? account : 'admin',
        action,
        category: 'backup',
        details,
    });
}

const RESTORE_PATH = /^\/backup\/restore\/?$/i;

function isBackupRestoreRequest(req) {
    return !!req && String(req.method || '').toUpperCase() === 'POST' && RESTORE_PATH.test(String(req.path || ''));
}

module.exports = { recordBackupAudit, isBackupRestoreRequest };
