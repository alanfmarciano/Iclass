const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount, adminCanAccessClass, adminCanAccessCourse, guarded, sendInternalError, sendRouteError, publicErrorMessage } = require('../middlewares.js');
const { logError } = require('../utils/errorLog.js');
const fileStore = require('../utils/storage.js');
const backupUtil = require('../utils/backup.js');
const backupAudit = require('../utils/backupAudit.js');
const { recordAudit } = require('../utils/audit.js');

// uploadErrorMessage e isUploadRequestError vêm de admin.js: o envio recusado (multer,
// formulário cortado) responde 400 em português; o resto é falha do disco (500 com código).
function createAdminRecoveryRouter({ uploadForRequest, rejectInvalidUpload, uploadErrorMessage, isUploadRequestError, uploadDir }) {
    if (typeof uploadForRequest !== 'function' || typeof rejectInvalidUpload !== 'function' || typeof uploadErrorMessage !== 'function' || typeof isUploadRequestError !== 'function' || !uploadDir) {
        throw new Error('Dependências de upload inválidas para adminRecovery.');
    }

    const router = express.Router();

    // Lixeira para quem não é administrador: só o que está no escopo dele.
    // - SEG-X1: arquivo de backup (.json/.zip vindo de /uploads) só aparece para o
    //   administrador (restaurá-lo devolvia o banco inteiro a /uploads);
    // - pasta de aluno (alunos/...: documentos e atestados) também, como "Excluir aluno"
    //   e os atestados (antes o professor de outra turma via, restaurava e apagava);
    // - material da biblioteca guarda curso e turma ao ir para a lixeira e segue o
    //   escopo do professor; o resto só para quem excluiu. Item antigo sem essa
    //   informação fica com o administrador.
    function hiddenFromAccount(entry, matchedAdmin) {
        if (!isProfessorAccount(matchedAdmin) || !entry) return false;
        if (fileStore.isAdminOnlyTrashEntry(entry)) return true;
        const courseId = String(entry.courseId || '').trim();
        if (courseId) {
            const className = String(entry.studentClass || '').trim();
            return className ? !adminCanAccessClass(matchedAdmin, className, courseId) : !adminCanAccessCourse(matchedAdmin, courseId);
        }
        const owner = String(entry.deletedBy || '').trim().toLowerCase();
        return !owner || owner !== String(matchedAdmin.email || '').trim().toLowerCase();
    }

    // O que a auditoria guarda de um item da lixeira de arquivos (SEG-07): nome, tamanho,
    // se é pasta e o curso/turma, nunca o conteúdo. O nome é o que a pessoa conhece (o do
    // material ou o do arquivo enviado); o nome gerado em /uploads vai junto em file.
    function trashAuditItem(entry) {
        const storedName = String((entry && entry.name) || '');
        const originalName = String((entry && entry.originalName) || '');
        const item = { name: originalName || storedName, size: Number(entry && entry.size) || 0, isDir: !!(entry && entry.isDir) };
        if (originalName && originalName !== storedName) item.file = storedName;
        if (entry && entry.courseId) item.courseId = entry.courseId;
        if (entry && entry.studentClass) item.studentClass = entry.studentClass;
        return item;
    }

    // Item da lixeira com o tamanho (o índice não guarda o tamanho; listTrash mede).
    function trashEntryWithSize(id) {
        const safeId = String(id || '');
        return fileStore.listTrash().find(entry => entry.id === safeId) || fileStore.getTrashEntry(safeId);
    }

    function recordTrashAudit(req, matchedAdmin, action, fields) {
        recordAudit(db.memory, { req, actor: matchedAdmin, action, category: 'system', ...fields });
    }

    router.get('/api/admin/trash', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            res.json(fileStore.listTrash().filter(entry => !hiddenFromAccount(entry, matchedAdmin)));
        });
    });

    router.post('/api/admin/trash/restore', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const id = String((req.body && req.body.id) || '');
            if (hiddenFromAccount(fileStore.getTrashEntry(id), matchedAdmin)) {
                return res.status(403).json({ error: 'Este item da lixeira está fora do seu escopo.' });
            }
            const entry = trashEntryWithSize(id);
            const result = fileStore.restoreTrash(id);
            if (!result.ok) return res.status(400).json({ error: result.error });
            recordTrashAudit(req, matchedAdmin, 'trash_restored', {
                courseId: (entry && entry.courseId) || undefined,
                studentClass: (entry && entry.studentClass) || undefined,
                details: { item: trashAuditItem(entry), restoredTo: result.restoredTo },
            });
            await db.save();
            res.json({ success: true, restoredTo: result.restoredTo });
        });
    });

    router.post('/api/admin/trash/delete', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            try {
                const id = String((req.body && req.body.id) || '');
                if (hiddenFromAccount(fileStore.getTrashEntry(id), matchedAdmin)) {
                    return res.status(403).json({ error: 'Este item da lixeira está fora do seu escopo.' });
                }
                const entry = trashEntryWithSize(id);
                const removed = fileStore.deleteTrashItem(id);
                if (!removed) return res.status(404).json({ error: 'Item não encontrado na lixeira.' });
                recordTrashAudit(req, matchedAdmin, 'trash_deleted', {
                    courseId: (entry && entry.courseId) || undefined,
                    studentClass: (entry && entry.studentClass) || undefined,
                    details: { item: trashAuditItem(entry) },
                });
                await db.save();
                res.json({ success: true });
            } catch (error) {
                // Identificador inválido (safePath) continua 400; falha do disco (arquivo
                // preso por outro programa no Windows) vira 500 com o código do erro.
                return sendRouteError(error, req, res);
            }
        });
    });

    // Itens listados na auditoria do esvaziar (o resto entra só na contagem).
    const TRASH_EMPTY_LISTED = 200;

    router.post('/api/admin/trash/empty', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            // O professor esvazia só o que ele vê.
            const visible = fileStore.listTrash().filter(entry => !hiddenFromAccount(entry, matchedAdmin));
            const removed = fileStore.emptyTrash(entry => !hiddenFromAccount(entry, matchedAdmin));
            if (removed > 0 || visible.length > 0) {
                recordTrashAudit(req, matchedAdmin, 'trash_emptied', {
                    details: {
                        removed,
                        totalSize: visible.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0),
                        scope: isProfessorAccount(matchedAdmin) ? 'itens do escopo do professor' : 'lixeira inteira',
                        items: visible.slice(0, TRASH_EMPTY_LISTED).map(trashAuditItem),
                        moreItems: Math.max(0, visible.length - TRASH_EMPTY_LISTED),
                    },
                });
                await db.save();
            }
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
                if (!res.headersSent) return sendInternalError(error, req, res, 'Falha ao gerar backup completo.');
                // O ZIP já começou a descer: registra e corta a conexão, para o navegador
                // acusar o download como falho em vez de guardar um ZIP pela metade.
                logError('erro interno', error, { req, details: { contexto: 'Falha ao gerar backup completo (ZIP cortado no meio do envio).' } });
                res.destroy(error);
            }
        });
    });

    // O arquivo enviado para restaurar é apagado em seguida, com ou sem sucesso: ele traz
    // o banco inteiro com os hashes de senha e não pode reaparecer pela lixeira nem
    // ficar em /uploads (SEG-X1). O administrador guarda o original.
    function discardUpload(file) {
        try { fs.rmSync(file, { force: true }); } catch (e) {}
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
            uploadForRequest().single('file')(req, res, guarded(req, res, async (error) => {
                // Recusas antes da restauração (arquivo grande demais, formato inválido,
                // sem a confirmação) também ficam no histórico de backup.
                const uploadInfo = () => (req.file ? { file: String(req.file.originalname || '').slice(0, 200), size: req.file.size || 0 } : {});
                const recordRefusal = async message => {
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...uploadInfo(), error: String(message || '').slice(0, 300) });
                    await db.save().catch(() => {});
                };
                if (error) {
                    // Envio recusado (tamanho, tipo, formulário cortado): 400 em português.
                    // Falha do disco ao gravar o arquivo recebido: 500 com o código do erro,
                    // e o histórico de backup guarda o mesmo texto que a tela mostrou.
                    if (!isUploadRequestError(error)) {
                        await recordRefusal(publicErrorMessage(error, req));
                        return sendInternalError(error, req, res, 'Falha ao gravar no disco o backup enviado para restaurar.');
                    }
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
                try {
                    const summary = await backupUtil.restoreFromFile(temporaryFile, req.file.originalname, { replaceAccounts, acceptLegacy });
                    discardUpload(temporaryFile);
                    // A trilha de auditoria do backup foi juntada com a atual (mergeAuditTrails
                    // em utils/backup.js): o histórico de backup e tudo o que foi feito depois
                    // do backup continuam no registro.
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
                    // networkKept: a regra de rede (quem abre o painel em outros aparelhos) continua
                    // a de hoje, não a do backup (decisões §7); a tela diz isso em uma linha.
                    res.json({ success: true, replaceAccounts, accountsNotRestored, networkKept: true, ...legacyInfo });
                } catch (restoreError) {
                    discardUpload(temporaryFile);
                    if (restoreError.legacyBackup) {
                        // Nada foi restaurado: a tela mostra o aviso e pede a confirmação.
                        return res.status(409).json({ error: backupUtil.LEGACY_BACKUP_WARNING, legacyBackup: true, exportedAt: restoreError.exportedAt });
                    }
                    // A falha no meio volta tudo ao estado de antes (applySnapshot exact),
                    // inclusive a auditoria: o histórico de backup continua lá.
                    // Recusa prevista do arquivo (formato, versão, JSON ou ZIP cortado, contas:
                    // status 400 em utils/backup.js) volta com a própria mensagem. O resto
                    // (disco cheio, arquivo preso por outro programa, falha inesperada) é erro
                    // interno: 500 com o código do erro e o stack no crash.log. Antes tudo
                    // saía em 400 com a mensagem crua ("Unterminated string in JSON at
                    // position 300", "ENOSPC: no space left on device"), sem código (ENG-04).
                    const shownError = publicErrorMessage(restoreError, req);
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...fileInfo, error: shownError.slice(0, 300) });
                    await db.save().catch(() => {});
                    return sendRouteError(restoreError, req, res, 'Falha ao restaurar o backup enviado.');
                }
            }));
        });
    });

    return router;
}

module.exports = { createAdminRecoveryRouter };
