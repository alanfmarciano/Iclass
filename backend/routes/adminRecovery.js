const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount } = require('../middlewares.js');
const fileStore = require('../utils/storage.js');
const backupUtil = require('../utils/backup.js');
const backupAudit = require('../utils/backupAudit.js');

function createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadErrorMessage = error => `Erro no upload: ${error.message}`, uploadDir }) {
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

    // Registros antigos (type/actorEmail/at, dados soltos) são lidos por
    // normalizeBackupAuditEntry; os novos saem de utils/backupAudit.js.
    function recordBackupAudit(req, matchedAdmin, action, details = {}) {
        return backupAudit.recordBackupAudit(req, matchedAdmin, action, details);
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
            // Backup de versão anterior (sem as aplicações de prova): quantas aplicações
            // atuais saíram e quantas foram refeitas a partir das turmas do backup.
            legacyApplications: details.legacyApplications === true,
            applicationsDiscarded: Number(details.applicationsDiscarded) || 0,
            applicationsRebuilt: Number(details.applicationsRebuilt) || 0,
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
        validateAdmin(req, res, async (config, matchedAdmin) => {
            // Tentativa de restaurar sem ser administrador é evento de segurança: fica no histórico.
            if (isProfessorAccount(matchedAdmin)) {
                recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { error: 'Tentativa de restauração por conta de professor (recusada).' });
                await db.save().catch(() => {});
                rejectProfessor(res, matchedAdmin);
                return;
            }
            uploadForRequest().single('file')(req, res, async (error) => {
                // Recusas antes da restauração (arquivo grande demais, formato inválido,
                // sem a confirmação) também ficam no histórico de backup.
                const uploadInfo = () => (req.file ? { file: String(req.file.originalname || '').slice(0, 200), size: req.file.size || 0 } : {});
                const recordRefusal = async message => {
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...uploadInfo(), error: String(message || '').slice(0, 300) });
                    await db.save().catch(() => {});
                };
                if (error) {
                    const message = uploadErrorMessage(error);
                    await recordRefusal(message);
                    return res.status(400).json({ error: message });
                }
                if (!req.file) {
                    await recordRefusal('Restauração sem arquivo de backup.');
                    return res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
                }
                const refusedFile = uploadInfo();
                if (rejectInvalidUpload(req, res, { discard: true })) {
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...refusedFile, error: 'Arquivo recusado (formato ou conteúdo inválido).' });
                    await db.save().catch(() => {});
                    return;
                }

                const temporaryFile = path.join(uploadDir, req.file.filename);
                if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
                    discardUpload(temporaryFile);
                    await recordRefusal('Restauração sem a confirmação RESTAURAR.');
                    return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
                }
                // Contas de acesso atuais ficam como estão, salvo pedido explícito.
                const replaceAccounts = ['1', 'true', 'sim', 'on'].includes(String(req.body.replaceAccounts || '').trim().toLowerCase());
                // Backup de versão anterior: só depois de a tela mostrar o aviso (acceptLegacy).
                const acceptLegacy = ['1', 'true', 'sim', 'on'].includes(String(req.body.acceptLegacy || '').trim().toLowerCase());
                const fileInfo = { file: String(req.file.originalname || '').slice(0, 200), size: req.file.size || 0, replaceAccounts };
                const backupHistory = (db.memory.auditLogs || []).filter(isBackupAuditEntry).map(entry => structuredClone(entry));
                try {
                    const summary = await backupUtil.restoreFromFile(temporaryFile, req.file.originalname, { replaceAccounts, acceptLegacy });
                    discardUpload(temporaryFile);
                    keepBackupHistory(backupHistory);
                    // Contas do backup que não existem aqui e ficaram de fora (só sem a substituição).
                    const current = new Set((db.memory.admins || []).map(account => String((account && account.email) || '').toLowerCase()));
                    const accountsNotRestored = replaceAccounts ? 0 : (summary.accountEmails || []).filter(email => !current.has(email)).length;
                    const legacyInfo = summary.legacyApplications
                        ? { legacyApplications: true, applicationsDiscarded: summary.applicationsDiscarded || 0, applicationsRebuilt: summary.applicationsRebuilt || 0 }
                        : {};
                    recordBackupAudit(req, matchedAdmin, 'backup_restored', {
                        ...fileInfo,
                        format: summary.format, exportedAt: summary.exportedAt, collections: summary.collections, accountsNotRestored,
                        ...legacyInfo,
                    });
                    await db.save();
                    res.json({ success: true, replaceAccounts, accountsNotRestored, ...legacyInfo });
                } catch (restoreError) {
                    discardUpload(temporaryFile);
                    if (restoreError.legacyBackup) {
                        // Nada foi restaurado: a tela mostra o aviso e pede a confirmação.
                        return res.status(409).json({ error: restoreError.message, legacyBackup: true, exportedAt: restoreError.exportedAt });
                    }
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
