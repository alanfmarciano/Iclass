const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount } = require('../middlewares.js');
const fileStore = require('../utils/storage.js');
const backupUtil = require('../utils/backup.js');

function createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadDir }) {
    if (typeof uploadForRequest !== 'function' || typeof rejectInvalidUpload !== 'function' || !uploadDir) {
        throw new Error('Dependências de upload inválidas para adminRecovery.');
    }

    const router = express.Router();

    // SEG-X1: arquivo de backup (.json/.zip vindo de /uploads) que esteja na lixeira só
    // aparece para o administrador; o professor com "Executar manutenção" não lista,
    // não restaura nem apaga esse item (restaurá-lo devolvia o banco inteiro a /uploads).
    function hiddenFromAccount(entry, matchedAdmin) {
        return isProfessorAccount(matchedAdmin) && fileStore.isAdminOnlyTrashEntry(entry);
    }

    router.get('/api/admin/trash', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            res.json(fileStore.listTrash().filter(entry => !hiddenFromAccount(entry, matchedAdmin)));
        });
    });

    router.post('/api/admin/trash/restore', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const id = String((req.body && req.body.id) || '');
            if (hiddenFromAccount(fileStore.getTrashEntry(id), matchedAdmin)) {
                return res.status(403).json({ error: 'Este item da lixeira é exclusivo do administrador.' });
            }
            const result = fileStore.restoreTrash(id);
            if (!result.ok) return res.status(400).json({ error: result.error });
            res.json({ success: true, restoredTo: result.restoredTo });
        });
    });

    router.post('/api/admin/trash/delete', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            try {
                const id = String((req.body && req.body.id) || '');
                if (hiddenFromAccount(fileStore.getTrashEntry(id), matchedAdmin)) {
                    return res.status(403).json({ error: 'Este item da lixeira é exclusivo do administrador.' });
                }
                const removed = fileStore.deleteTrashItem(id);
                if (!removed) return res.status(404).json({ error: 'Item não encontrado na lixeira.' });
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ error: error.message || 'Identificador inválido.' });
            }
        });
    });

    router.post('/api/admin/trash/empty', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            // O professor esvazia só o que ele vê.
            const removed = fileStore.emptyTrash(entry => !hiddenFromAccount(entry, matchedAdmin));
            res.json({ success: true, removed });
        });
    });

    // SEG-X1: o arquivo de backup leva todos os alunos, atestados e os hashes de senha
    // das contas; baixar e restaurar é exclusivo do administrador. Professor com
    // "Executar manutenção" só gera a cópia de segurança, que fica no servidor.
    function rejectProfessor(res, matchedAdmin) {
        if (!isProfessorAccount(matchedAdmin)) return false;
        res.status(403).json({ error: 'Baixar ou restaurar backup é exclusivo do administrador.' });
        return true;
    }

    // Registro de backup no mesmo formato dos outros registros de auditoria
    // (action/actor/timestamp, como notas e cadastro), com os dados em `details`.
    // Registros antigos (type/actorEmail/at, dados soltos) são lidos por
    // normalizeBackupAuditEntry.
    function recordBackupAudit(req, matchedAdmin, action, details = {}) {
        if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
        const entry = {
            id: `audit_backup_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            action,
            actor: (matchedAdmin && matchedAdmin.email) || 'admin',
            timestamp: Date.now(),
            ip: req.ip || (req.socket && req.socket.remoteAddress) || '',
            device: (req.headers && req.headers['user-agent']) || '',
            category: 'backup',
            details,
        };
        db.memory.auditLogs.push(entry);
        return entry;
    }

    function isBackupAuditEntry(entry) {
        return !!entry && /^backup_/.test(String(entry.action || entry.type || ''));
    }

    function normalizeBackupAuditEntry(entry) {
        const details = entry.details && typeof entry.details === 'object' ? entry.details : entry;
        return {
            id: entry.id,
            action: String(entry.action || entry.type || ''),
            actor: entry.actor || entry.actorEmail || '',
            timestamp: Number(entry.timestamp || entry.at) || 0,
            ip: entry.ip || '',
            file: details.file || details.fileName || '',
            format: details.format || '',
            replaceAccounts: details.replaceAccounts === true,
            accountsNotRestored: Number(details.accountsNotRestored) || 0,
            exportedAt: details.exportedAt || '',
            error: details.error || '',
        };
    }

    // Cópias manuais no servidor: ficam as 20 mais recentes (antes eram ilimitadas).
    const MANUAL_BACKUPS_KEPT = 20;

    router.post('/api/admin/backup/server', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            await db.save();
            const file = backupUtil.runAutomaticBackup({ prefix: 'manual', keep: MANUAL_BACKUPS_KEPT });
            recordBackupAudit(req, matchedAdmin, 'backup_server_created', { file: path.basename(file) });
            await db.save();
            res.json({ success: true, fileName: path.basename(file), createdAt: Date.now(), kept: MANUAL_BACKUPS_KEPT });
        });
    });

    // Histórico de backup (restaurações, falhas, cópias e downloads), só do administrador.
    router.get('/api/admin/backup/history', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const entries = (db.memory.auditLogs || []).filter(isBackupAuditEntry).map(normalizeBackupAuditEntry)
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 50);
            res.json({ success: true, entries });
        });
    });

    router.get('/api/admin/backup/data', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            recordBackupAudit(req, matchedAdmin, 'backup_downloaded', { format: 'json' });
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-dados_${stamp}.json"`);
            res.send(JSON.stringify(backupUtil.buildDataSnapshot()));
        });
    });

    router.get('/api/admin/backup/full', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            recordBackupAudit(req, matchedAdmin, 'backup_downloaded', { format: 'zip' });
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-completo_${stamp}.zip"`);
            try {
                await backupUtil.streamFullZip(res);
            } catch (error) {
                if (!res.headersSent) res.status(500).json({ error: 'Falha ao gerar backup completo.' });
                else res.destroy(error);
            }
        });
    });

    // O arquivo enviado para restaurar é apagado em seguida, com ou sem sucesso: ele traz
    // o banco inteiro com os hashes de senha e não pode reaparecer pela lixeira nem
    // ficar em /uploads (SEG-X1). O administrador guarda o original.
    function discardUpload(file) {
        try { fs.rmSync(file, { force: true }); } catch (e) {}
    }

    // A restauração troca o registro de auditoria pelo do backup; o histórico de
    // backup (inclusive as falhas anteriores) volta para o registro restaurado.
    function keepBackupHistory(history) {
        if (!Array.isArray(db.memory.auditLogs)) db.memory.auditLogs = [];
        const present = new Set(db.memory.auditLogs.map(entry => entry && entry.id).filter(Boolean));
        history.forEach(entry => { if (!entry.id || !present.has(entry.id)) db.memory.auditLogs.push(entry); });
    }

    router.post('/api/admin/backup/restore', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            uploadForRequest().single('file')(req, res, async (error) => {
                if (error) return res.status(400).json({ error: `Erro no upload: ${error.message}` });
                if (!req.file) return res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
                if (rejectInvalidUpload(req, res, { discard: true })) return;

                const temporaryFile = path.join(uploadDir, req.file.filename);
                if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
                    discardUpload(temporaryFile);
                    return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
                }
                // Contas de acesso atuais ficam como estão, salvo pedido explícito.
                const replaceAccounts = ['1', 'true', 'sim', 'on'].includes(String(req.body.replaceAccounts || '').trim().toLowerCase());
                const fileInfo = { file: String(req.file.originalname || '').slice(0, 200), size: req.file.size || 0, replaceAccounts };
                const backupHistory = (db.memory.auditLogs || []).filter(isBackupAuditEntry).map(entry => structuredClone(entry));
                try {
                    const summary = await backupUtil.restoreFromFile(temporaryFile, req.file.originalname, { replaceAccounts });
                    discardUpload(temporaryFile);
                    keepBackupHistory(backupHistory);
                    // Contas do backup que não existem aqui e ficaram de fora (só sem a substituição).
                    const current = new Set((db.memory.admins || []).map(account => String((account && account.email) || '').toLowerCase()));
                    const accountsNotRestored = replaceAccounts ? 0 : (summary.accountEmails || []).filter(email => !current.has(email)).length;
                    recordBackupAudit(req, matchedAdmin, 'backup_restored', {
                        ...fileInfo,
                        format: summary.format, exportedAt: summary.exportedAt, collections: summary.collections, accountsNotRestored,
                    });
                    await db.save();
                    res.json({ success: true, replaceAccounts, accountsNotRestored });
                } catch (restoreError) {
                    discardUpload(temporaryFile);
                    keepBackupHistory(backupHistory);
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...fileInfo, error: String(restoreError.message || '').slice(0, 300) });
                    await db.save().catch(() => {});
                    res.status(400).json({ error: restoreError.message || 'Falha ao restaurar backup.' });
                }
            });
        });
    });

    return router;
}

module.exports = { createAdminRecoveryRouter };
