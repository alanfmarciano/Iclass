const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount, adminCanAccessClass, adminCanAccessCourse, guarded, sendInternalError, sendRouteError, sendHandledFailure, publicErrorMessage } = require('../middlewares.js');
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

    // Cópias manuais no servidor: ficam as 20 mais recentes (antes eram ilimitadas). Desde
    // o H4a é o ZIP formato 2 dos dados (manual_dados_<carimbo>.zip), gerado sem travar o
    // servidor; os .json manuais antigos contam juntos na retenção.
    const MANUAL_BACKUPS_KEPT = 20;

    router.post('/api/admin/backup/server', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            let file;
            try {
                file = await backupUtil.runAutomaticBackup({ prefix: 'manual', keep: MANUAL_BACKUPS_KEPT });
            } catch (error) {
                return sendRouteError(error, req, res, 'Falha ao gerar a cópia de segurança no servidor.');
            }
            recordBackupAudit(req, matchedAdmin, 'backup_server_created', { file: path.basename(file), format: 'zip' });
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

    // JSON de dados: a memória, os .md de content/ e, desde o H4a, o histórico de
    // digitação (examKeystrokes). A tela oferece o ZIP; o JSON continua para quem o usa.
    router.get('/api/admin/backup/data', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            let snapshot;
            try {
                await db.save();
                snapshot = await backupUtil.buildFullDataSnapshot();
            } catch (error) {
                return sendRouteError(error, req, res, 'Falha ao gerar o backup dos dados.');
            }
            recordBackupAudit(req, matchedAdmin, 'backup_downloaded', { format: 'json' });
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-dados_${stamp}.json"`);
            res.send(JSON.stringify(snapshot));
        });
    });

    // Download do backup ZIP formato 2 (manifesto iclass-backup.json com o SHA-256 do
    // banco e data/database.db, cópia consistente pelo VACUUM INTO): variante 'completo'
    // (padrão, com a biblioteca data/uploads) ou ?variante=dados (sem ela).
    router.get('/api/admin/backup/full', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const variante = String(req.query.variante || '').trim().toLowerCase() === 'dados' ? 'dados' : 'completo';
            if (backupUtil.backupInProgress()) return res.status(409).json({ error: backupUtil.BACKUP_BUSY_MESSAGE });
            recordBackupAudit(req, matchedAdmin, 'backup_downloaded', { format: 'zip', variante });
            await db.save();
            const stamp = new Date().toISOString().slice(0, 10);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="iclass-backup-${variante}_${stamp}.zip"`);
            try {
                await backupUtil.streamFullZip(res, { variante, origem: 'download' });
            } catch (error) {
                if (!res.headersSent && error && error.code === 'ICLASS_BACKUP_BUSY') {
                    res.removeHeader('Content-Disposition');
                    res.removeHeader('Content-Type');
                    return sendRouteError(error, req, res);
                }
                // O navegador desistiu do download no meio (aba fechada): não é falha do servidor.
                if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
                if (!res.headersSent) return sendInternalError(error, req, res, 'Falha ao gerar backup completo.');
                // O ZIP já começou a descer: registra e corta a conexão, para o navegador
                // acusar o download como falho em vez de guardar um ZIP pela metade.
                logError('erro interno', error, { req, details: { contexto: 'Falha ao gerar backup completo (ZIP cortado no meio do envio).' } });
                res.destroy(error);
            }
        });
    });

    // --- envio do backup para restaurar (multer próprio, H4a) ------------------------
    // O arquivo de backup não passa pelo multer geral: ele vai para DATA_DIR/.restauracao/
    // envios (nunca para data/uploads, de onde a lixeira e os vínculos o devolveriam,
    // SEG-X1), aceita até 8 GB (o limite de envio de materiais, settings.upload.maxSizeMb,
    // não vale aqui: um backup de um ano passa dele) e só .json ou .zip com a assinatura
    // certa. Apagado em seguida, com ou sem sucesso; a prévia extrai numa pasta só dela.
    const RESTORE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;
    const RESTORE_UPLOAD_EXTENSIONS = new Set(['.json', '.zip']);

    function restoreUpload() {
        const storage = multer.diskStorage({
            destination: (req, file, cb) => {
                fs.promises.mkdir(backupUtil.UPLOADS_INBOX_DIR, { recursive: true })
                    .then(() => cb(null, backupUtil.UPLOADS_INBOX_DIR), cb);
            },
            filename: (req, file, cb) => {
                cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`);
            },
        });
        return multer({
            storage,
            limits: { fileSize: RESTORE_UPLOAD_MAX_BYTES, files: 1, fields: 10 },
            fileFilter: (req, file, cb) => {
                // O nome vai para o histórico mesmo quando o envio é recusado aqui.
                req.backupUploadName = String(file.originalname || '').slice(0, 200);
                if (!RESTORE_UPLOAD_EXTENSIONS.has(path.extname(String(file.originalname || '')).toLowerCase())) {
                    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
                }
                cb(null, true);
            },
        }).single('file');
    }

    function restoreUploadErrorMessage(error) {
        if (error && error.code === 'LIMIT_FILE_SIZE') return 'Erro no envio do backup: o arquivo passa de 8 GB.';
        return uploadErrorMessage(error);
    }

    // Assinatura do arquivo recebido: ZIP começa com "PK"; o JSON não tem byte zero no
    // começo (a mesma regra do envio geral, utils/uploadSecurity.js).
    async function uploadSignatureMatches(file) {
        const handle = await fs.promises.open(file.path, 'r');
        try {
            const buffer = Buffer.alloc(32);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const head = buffer.subarray(0, bytesRead);
            if (path.extname(String(file.originalname || '')).toLowerCase() === '.zip') return head[0] === 0x50 && head[1] === 0x4b;
            return bytesRead > 0 && !head.includes(0);
        } finally {
            await handle.close();
        }
    }

    // O arquivo enviado para restaurar é apagado em seguida, com ou sem sucesso: ele traz
    // o banco inteiro com os hashes de senha e não pode reaparecer pela lixeira nem
    // ficar em /uploads (SEG-X1). O administrador guarda o original.
    function discardUpload(file) {
        try { if (file) fs.rmSync(file, { force: true }); } catch (e) {}
    }

    const TRUE_VALUES = ['1', 'true', 'sim', 'on'];
    function flag(value) {
        return value === true || TRUE_VALUES.includes(String(value || '').trim().toLowerCase());
    }

    // Recebe o arquivo (multipart, campo file) e confere o envio. Devolve o arquivo
    // gravado ou null quando já respondeu (recusa registrada no histórico de backup).
    function receiveBackupUpload(req, res, matchedAdmin, etapa) {
        return new Promise(resolve => {
            restoreUpload()(req, res, guarded(req, res, async (error) => {
                const uploadInfo = () => {
                    const file = req.file ? String(req.file.originalname || '').slice(0, 200) : req.backupUploadName;
                    return file ? { file, size: (req.file && req.file.size) || 0 } : {};
                };
                const recordRefusal = async message => {
                    recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...uploadInfo(), ...(etapa ? { etapa } : {}), error: String(message || '').slice(0, 300) });
                    await db.save().catch(() => {});
                };
                if (error) {
                    // Envio recusado (tamanho, tipo, formulário cortado): 400 em português.
                    // Falha do disco ao gravar o arquivo recebido: 500 com o código do erro,
                    // e o histórico de backup guarda o mesmo texto que a tela mostrou.
                    if (req.file) discardUpload(req.file.path);
                    if (!isUploadRequestError(error)) {
                        await recordRefusal(publicErrorMessage(error, req));
                        sendInternalError(error, req, res, 'Falha ao gravar no disco o backup enviado para restaurar.');
                        return resolve(null);
                    }
                    const message = restoreUploadErrorMessage(error);
                    await recordRefusal(message);
                    res.status(400).json({ error: message });
                    return resolve(null);
                }
                if (!req.file) {
                    await recordRefusal('Restauração sem arquivo de backup.');
                    res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
                    return resolve(null);
                }
                let matches = false;
                try { matches = await uploadSignatureMatches(req.file); } catch (e) { matches = false; }
                if (!matches) {
                    discardUpload(req.file.path);
                    await recordRefusal('Arquivo recusado (formato ou conteúdo inválido).');
                    res.status(400).json({ error: 'A assinatura do arquivo não corresponde ao formato informado.' });
                    return resolve(null);
                }
                resolve({ path: req.file.path, originalName: String(req.file.originalname || ''), size: req.file.size || 0, recordRefusal });
            }));
        });
    }

    // Tentativa de restaurar sem ser administrador é evento de segurança: fica no histórico.
    async function refuseProfessorRestore(req, res, matchedAdmin) {
        if (!isProfessorAccount(matchedAdmin)) return false;
        recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { error: 'Tentativa de restauração por conta de professor (recusada).' });
        await db.save().catch(() => {});
        rejectProfessor(res, matchedAdmin);
        return true;
    }

    // Registro e resposta da restauração que deu certo (os dois caminhos: token da prévia e
    // envio único).
    async function finishRestore(req, res, matchedAdmin, summary, fileInfo) {
        // A trilha de auditoria do backup foi juntada com a atual (mergeAuditTrails em
        // utils/backup.js): o histórico de backup e tudo o que foi feito depois do backup
        // continuam no registro. Contas do backup que não existem aqui e ficaram de fora
        // (só sem a substituição).
        const replaceAccounts = summary.replaceAccounts === true;
        const current = new Set((db.memory.admins || []).map(account => String((account && account.email) || '').toLowerCase()));
        const accountsNotRestored = replaceAccounts ? 0 : (summary.accountEmails || []).filter(email => !current.has(email)).length;
        const legacyInfo = summary.legacyApplications
            ? { legacyApplications: true, applicationsDiscarded: summary.applicationsDiscarded || 0, applicationsRebuilt: summary.applicationsRebuilt || 0 }
            : {};
        recordBackupAudit(req, matchedAdmin, 'backup_restored', {
            ...fileInfo,
            replaceAccounts,
            format: summary.format, formato: summary.formato, exportedAt: summary.exportedAt, collections: summary.collections, accountsNotRestored,
            safetyBackup: summary.safetyBackup,
            ...legacyInfo,
        });
        await db.save();
        // networkKept: a regra de rede (quem abre o painel em outros aparelhos) continua a de
        // hoje, não a do backup (decisões §7); a tela diz isso em uma linha.
        res.json({ success: true, replaceAccounts, accountsNotRestored, networkKept: true, safetyBackup: summary.safetyBackup, ...legacyInfo });
    }

    // Falha da restauração: a falha no meio volta tudo ao estado de antes (applySnapshot
    // exact), inclusive a auditoria. Recusa prevista do arquivo (formato, versão, JSON ou
    // ZIP cortado, soma de verificação, contas: status 400 em utils/backup.js) volta com a
    // própria mensagem; backup em andamento: 409; backup de segurança que não pôde ser
    // salvo: 503 com a mensagem própria (nada mudou). O resto é erro interno: 500 com o
    // código do erro e o stack no crash.log (ENG-04).
    async function failRestore(req, res, matchedAdmin, restoreError, fileInfo) {
        if (restoreError && restoreError.legacyBackup) {
            // Nada foi restaurado: a tela mostra o aviso e pede a confirmação.
            return res.status(409).json({ error: backupUtil.LEGACY_BACKUP_WARNING, legacyBackup: true, exportedAt: restoreError.exportedAt });
        }
        const safety = restoreError && restoreError.code === 'ICLASS_SAFETY_BACKUP';
        const shownError = safety ? backupUtil.SAFETY_BACKUP_FAILED_MESSAGE : publicErrorMessage(restoreError, req);
        recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...fileInfo, error: shownError.slice(0, 300) });
        await db.save().catch(() => {});
        if (safety) return sendHandledFailure(restoreError.cause || restoreError, req, res, backupUtil.SAFETY_BACKUP_FAILED_MESSAGE);
        return sendRouteError(restoreError, req, res, 'Falha ao restaurar o backup enviado.');
    }

    // Prévia da restauração (H4a, CONF-08, CONF-11): o arquivo é conferido e extraído numa
    // pasta só dele, sem mudar nada. A resposta traz o token (uso único, 1 h, só para quem
    // fez a prévia) e o que vai acontecer: o backup ao lado de hoje por coleção, o que
    // ficará vazio, as pastas trocadas, as contas, as provas em andamento, os alunos
    // anonimizados que voltam com dados pessoais e a conferência de integridade.
    router.post('/api/admin/backup/restore/preview', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (await refuseProfessorRestore(req, res, matchedAdmin)) return;
            if (backupUtil.backupInProgress()) return res.status(409).json({ error: backupUtil.BACKUP_BUSY_MESSAGE });
            const upload = await receiveBackupUpload(req, res, matchedAdmin, 'previa');
            if (!upload) return;
            try {
                const { prepared, preview } = await backupUtil.prepareRestore(upload.path, { originalName: upload.originalName });
                prepared.uploadSize = upload.size;
                const { token, expiraEm } = backupUtil.createRestoreToken(prepared, matchedAdmin.email);
                res.json({ success: true, token, expiraEm, arquivo: prepared.originalName, ...preview });
            } catch (error) {
                discardUpload(upload.path);
                const shownError = publicErrorMessage(error, req);
                recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { file: upload.originalName.slice(0, 200), size: upload.size, etapa: 'previa', error: shownError.slice(0, 300) });
                await db.save().catch(() => {});
                return sendRouteError(error, req, res, 'Falha ao conferir o backup enviado.');
            }
        });
    });

    // Restaurar. Dois caminhos:
    // - JSON { token, confirm: 'RESTAURAR', replaceAccounts }: o backup que a prévia
    //   conferiu (a tela). O aviso de versão anterior já foi mostrado na prévia;
    // - multipart (file, confirm, replaceAccounts, acceptLegacy): o envio único de antes,
    //   para scripts e para quem não passa pela prévia.
    router.post('/api/admin/backup/restore', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (await refuseProfessorRestore(req, res, matchedAdmin)) return;
            if (!req.is('multipart/form-data')) return restoreWithToken(req, res, matchedAdmin);
            const upload = await receiveBackupUpload(req, res, matchedAdmin, null);
            if (!upload) return;
            if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
                discardUpload(upload.path);
                await upload.recordRefusal('Restauração sem a confirmação RESTAURAR.');
                return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
            }
            // Contas de acesso atuais ficam como estão, salvo pedido explícito.
            const replaceAccounts = flag(req.body.replaceAccounts);
            // Backup de versão anterior: só depois de a tela mostrar o aviso (acceptLegacy).
            const acceptLegacy = flag(req.body.acceptLegacy);
            const fileInfo = { file: upload.originalName.slice(0, 200), size: upload.size, replaceAccounts };
            try {
                const summary = await backupUtil.restoreFromFile(upload.path, upload.originalName, { replaceAccounts, acceptLegacy });
                discardUpload(upload.path);
                return finishRestore(req, res, matchedAdmin, { replaceAccounts, ...summary }, fileInfo);
            } catch (restoreError) {
                discardUpload(upload.path);
                return failRestore(req, res, matchedAdmin, restoreError, fileInfo);
            }
        });
    });

    async function restoreWithToken(req, res, matchedAdmin) {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const replaceAccounts = flag(body.replaceAccounts);
        if (!body.token) {
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { error: 'Restauração sem arquivo de backup.' });
            await db.save().catch(() => {});
            return res.status(400).json({ error: 'Envie o arquivo de backup (.json ou .zip).' });
        }
        if (String(body.confirm || '').trim().toUpperCase() !== 'RESTAURAR') {
            // O token continua valendo: a tela pode mandar de novo com a confirmação.
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { error: 'Restauração sem a confirmação RESTAURAR.' });
            await db.save().catch(() => {});
            return res.status(400).json({ error: 'Confirme digitando RESTAURAR.' });
        }
        if (backupUtil.backupInProgress()) return res.status(409).json({ error: backupUtil.BACKUP_BUSY_MESSAGE });
        const taken = backupUtil.takeRestoreToken(body.token, matchedAdmin.email);
        if (!taken.prepared) {
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { error: taken.error });
            await db.save().catch(() => {});
            return res.status(taken.status).json({ error: taken.error });
        }
        const prepared = taken.prepared;
        const fileInfo = { file: String(prepared.originalName || '').slice(0, 200), size: Number(prepared.uploadSize) || 0, replaceAccounts };
        try {
            // A prévia já mostrou o aviso do backup de versão anterior.
            const summary = await backupUtil.applyPreparedRestore(prepared, { replaceAccounts, acceptLegacy: true });
            return finishRestore(req, res, matchedAdmin, summary, fileInfo);
        } catch (restoreError) {
            return failRestore(req, res, matchedAdmin, restoreError, fileInfo);
        }
    }

    return router;
}

module.exports = { createAdminRecoveryRouter };
