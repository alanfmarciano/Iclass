// Cadastros encerrados (H7c; FUN-03, decisão 4 do Alan): a tela /encerrados lista quem
// foi desligado (Inativo, Concluído, Transferido, Evadido) e os anonimizados, e é ali que
// o administrador decide, caso a caso, reativar, anonimizar ou apagar de vez.
//
// GET  /api/admin/students/closed      cadastros encerrados, do mais antigo para o mais novo
// POST /api/admin/students/anonymize   { email, confirm: 'ANONIMIZAR', reason }
// POST /api/admin/students/purge       { email, confirm: 'APAGAR', reason }
//
// Só o administrador: a regra de ADMIN_API_PERMISSION_RULES pede students.destroy, que é
// exclusiva dele, e cada rota confere de novo. Nada disso é automático: não existe tarefa
// que anonimize ou apague depois de um prazo. Reativar é o bulk-status com 'Ativo'.
//
// Antes de anonimizar ou apagar não roda backup de segurança (a resposta diz a data do
// último backup automático, para a tela lembrar que o backup antigo ainda tem os dados).
const express = require('express');
const db = require('../database.js');
const { validateAdminPermission } = require('../middlewares.js');
const { lastStatusChangeIndex, studentStatusSince } = require('../utils/students.js');
const { lastAutomaticBackupAt } = require('../utils/backup.js');
const {
    ANONYMIZE_WORD,
    PURGE_WORD,
    StudentLifecycleError,
    closedStudentRows,
    lifecycleBody,
    runStudentLifecycle,
    validateLifecycleRequest,
} = require('../utils/studentLifecycle.js');

const PERMISSION = 'students.destroy';

// Data do último backup automático (ms) ou null, para a resposta e a tela.
function lastBackupAt() {
    try {
        const at = Number(lastAutomaticBackupAt());
        return Number.isFinite(at) && at > 0 ? Math.round(at) : null;
    } catch (e) { return null; }
}

function sendLifecycleError(res, err) {
    if (!(err instanceof StudentLifecycleError)) throw err;
    return res.status(err.status).json(lifecycleBody(err));
}

function createAdminStudentRecordsRouter() {
    const router = express.Router();

    router.get('/api/admin/students/closed', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, () => {
            const index = lastStatusChangeIndex(db.memory.auditLogs);
            const items = closedStudentRows(db.memory, { sinceOf: student => studentStatusSince(student, index) });
            res.json({ success: true, items, total: items.length, lastBackupAt: lastBackupAt() });
        });
    });

    router.post('/api/admin/students/anonymize', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async (config, matchedAdmin) => {
            try {
                const { email, reason } = validateLifecycleRequest(req.body, ANONYMIZE_WORD);
                const result = await runStudentLifecycle(db, { mode: 'anonymize', email, actor: matchedAdmin, reason, req });
                res.json({
                    success: true,
                    message: 'Cadastro anonimizado. Notas, presença e certificados ficam guardados sem os dados pessoais.',
                    email: result.email,
                    name: result.name,
                    anonymizedAt: result.at,
                    kept: result.counts,
                    lastBackupAt: lastBackupAt(),
                });
            } catch (err) {
                return sendLifecycleError(res, err);
            }
        });
    });

    router.post('/api/admin/students/purge', (req, res) => {
        validateAdminPermission(req, res, PERMISSION, async (config, matchedAdmin) => {
            try {
                const { email, reason } = validateLifecycleRequest(req.body, PURGE_WORD);
                const result = await runStudentLifecycle(db, { mode: 'purge', email, actor: matchedAdmin, reason, req });
                res.json({
                    success: true,
                    message: 'Cadastro apagado de vez.',
                    removed: result.counts,
                    lastBackupAt: lastBackupAt(),
                });
            } catch (err) {
                return sendLifecycleError(res, err);
            }
        });
    });

    return router;
}

module.exports = { createAdminStudentRecordsRouter };
