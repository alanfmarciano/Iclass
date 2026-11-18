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
const backupStore = require('../utils/backupStore.js');
const settingsUtil = require('../utils/settings.js');
const { attemptPasswordLogin, waitText } = require('../utils/passwordLogin.js');

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
            // H4b: backup automático (ator 'sistema'), destino externo e download da lista.
            variante: details.variante || '',
            local: details.local || '',
            externo: details.externo || '',
            externoErro: details.externoErro || '',
            etapa: details.etapa || '',
            destino: typeof details.destino === 'string' ? details.destino : '',
        };
    }

    // Texto de falha sem o caminho do destino, para o professor. As mensagens novas já
    // saem sem caminho (backup.js failureMessage); esta troca cobre o estado.json gravado
    // antes disso e qualquer texto que ainda traga a pasta.
    function withoutDestination(text, ...destinations) {
        let value = String(text || '');
        destinations.filter(item => typeof item === 'string' && item.trim()).forEach(destino => {
            value = value.split(destino).join('o destino externo');
        });
        return value;
    }

    // "Fazer backup agora" (H4b, OPS-03): o mesmo serviço do automático, com origem
    // 'manual': o ZIP dos dados em data/backups (manual_dados_<carimbo>.zip, ficam os 20
    // mais recentes) e, com o destino externo configurado, o completo na pasta deste
    // computador no destino (a falha do externo não desfaz o local: externoErro).
    // Professor com "Executar manutenção" também pode: o arquivo fica no servidor.
    const MANUAL_BACKUPS_KEPT = backupStore.RETENTION_RULES.find(rule => rule.grupo === 'manual').local;

    router.post('/api/admin/backup/server', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            let result;
            try {
                result = await backupUtil.runBackupJob({ origem: 'manual' });
            } catch (error) {
                // Interrompido pelo desligamento do servidor (o .parcial já saiu): não é erro
                // interno; 503 retryable, para a tela pedir que tente quando o IClass voltar.
                if (error && error.code === 'ICLASS_BACKUP_ABORTED') {
                    return res.status(503).json({ success: false, error: 'O backup foi interrompido porque o servidor está sendo desligado. Tente de novo quando o IClass voltar.', retryable: true });
                }
                return sendRouteError(error, req, res, 'Falha ao gerar a cópia de segurança no servidor.');
            }
            recordBackupAudit(req, matchedAdmin, 'backup_server_created', {
                // Desligamento no meio da cópia externa: o local foi gravado e vale.
                ...(result.externoInterrompido ? { interrompido: true } : {}),
                file: result.local.name,
                format: 'zip',
                variante: 'dados',
                ...(result.externo ? { externo: result.externo.name } : {}),
                ...(result.externoErro ? { externoErro: result.externoErro.slice(0, 300) } : {}),
            });
            await db.save();
            // O professor vê que a cópia externa saiu (ou falhou), não onde (o caminho do
            // destino é do administrador).
            const professor = isProfessorAccount(matchedAdmin);
            const destino = backupUtil.backupStatus().destino;
            res.json({
                success: true,
                fileName: result.local.name,
                createdAt: Date.now(),
                kept: MANUAL_BACKUPS_KEPT,
                externo: result.externo ? { fileName: result.externo.name, pasta: professor ? '' : result.externo.pasta } : null,
                externoErro: result.externoErro ? (professor ? withoutDestination(result.externoErro, destino) : result.externoErro) : null,
            });
        });
    });

    // Situação do backup (H4b): último local, último externo, falha aberta, adiamento por
    // prova e o destino. Para quem tem "Executar manutenção"; o caminho do destino só vai
    // para o administrador (o professor vê que há um destino, não onde).
    router.get('/api/admin/backup/status', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            const status = backupUtil.backupStatus();
            if (isProfessorAccount(matchedAdmin)) {
                const failure = status.ultimaFalha
                    ? { ...status.ultimaFalha, destino: '', mensagem: withoutDestination(status.ultimaFalha.mensagem, status.destino, status.ultimaFalha.destino) }
                    : null;
                return res.json({ success: true, ...status, destino: '', pasta: '', ultimaFalha: failure });
            }
            res.json({ success: true, ...status });
        });
    });

    // Destino externo (H4b): pasta absoluta que existe, fora da pasta do IClass; o IClass
    // grava em <destino>/IClass-<computador>. Só o administrador. '' desliga a cópia
    // externa. A sugestão vem do backup_path.txt do launcher, quando há.
    const DATA_WARNING = 'O backup traz dados pessoais de alunos e senhas protegidas; guarde o pendrive ou a pasta em local seguro.';

    router.get('/api/admin/backup/config', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const current = settingsUtil.backupSettings();
            res.json({
                success: true,
                destino: current.destino,
                pasta: current.destino ? backupStore.externalDir(current.destino) : '',
                guardarExterno: current.guardarExterno,
                limites: { guardarExterno: { min: settingsUtil.BACKUP_KEEP_EXTERNAL_MIN, max: settingsUtil.BACKUP_KEEP_EXTERNAL_MAX } },
                sugestao: current.destino ? '' : backupStore.launcherPathSuggestion(),
                aviso: DATA_WARNING,
            });
        });
    });

    router.post('/api/admin/backup/config', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            // Corpo que não é objeto (uma lista, por exemplo) não é "nada a mudar": 400.
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ success: false, error: 'Envie o destino e o número de backups guardados como objeto { destino, guardarExterno }.', field: 'destino' });
            }
            const body = req.body;
            const before = settingsUtil.backupSettings();
            if (body.destino !== undefined && typeof body.destino !== 'string') {
                return res.status(400).json({ success: false, error: 'Informe a pasta do destino como texto.', field: 'destino' });
            }
            let keep = before.guardarExterno;
            if (body.guardarExterno !== undefined && body.guardarExterno !== null && body.guardarExterno !== '') {
                const value = Number(body.guardarExterno);
                if (!Number.isInteger(value) || value < settingsUtil.BACKUP_KEEP_EXTERNAL_MIN || value > settingsUtil.BACKUP_KEEP_EXTERNAL_MAX) {
                    return res.status(400).json({ success: false, error: `Guardar no destino: de ${settingsUtil.BACKUP_KEEP_EXTERNAL_MIN} a ${settingsUtil.BACKUP_KEEP_EXTERNAL_MAX} backups.`, field: 'guardarExterno' });
                }
                keep = value;
            }
            let checked = { destino: before.destino, pasta: before.destino ? backupStore.externalDir(before.destino) : '', livreBytes: null, mesmoDisco: false };
            if (body.destino !== undefined) {
                try {
                    checked = await backupStore.checkDestination(body.destino);
                } catch (error) {
                    if (error && error.status === 400) return res.status(400).json({ success: false, error: publicErrorMessage(error, req), field: error.field || 'destino' });
                    return sendRouteError(error, req, res, 'Falha ao conferir a pasta do destino.');
                }
            }
            if (!db.memory.config) db.memory.config = {};
            const stored = db.memory.config.settings && typeof db.memory.config.settings === 'object' ? db.memory.config.settings : {};
            const next = { destino: checked.destino, guardarExterno: keep };
            db.memory.config.settings = { ...stored, backup: next };
            if (checked.destino) await backupUtil.noteDestinationConfigured(checked.destino).catch(e => logError('backup: gravação do estado', e));
            if (before.destino !== next.destino || before.guardarExterno !== next.guardarExterno) {
                recordBackupAudit(req, matchedAdmin, 'backup_config_changed', {
                    destino: next.destino,
                    antes: { destino: before.destino, guardarExterno: before.guardarExterno },
                    guardarExterno: next.guardarExterno,
                });
            }
            await db.save();
            res.json({
                success: true,
                destino: next.destino,
                pasta: checked.pasta,
                guardarExterno: next.guardarExterno,
                livreBytes: checked.livreBytes,
                mesmoDisco: checked.mesmoDisco === true,
                aviso: DATA_WARNING,
            });
        });
    });

    // Backups guardados (H4b): os do servidor (data/backups) e os da pasta deste
    // computador no destino externo, o mais novo primeiro. Só o administrador; listar não
    // pede a senha (baixar pede).
    router.get('/api/admin/backup/list', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const { itens, destino, pasta } = backupUtil.listStoredBackups();
            let externoAcessivel = false;
            try { externoAcessivel = !!pasta && fs.statSync(pasta).isDirectory(); } catch (e) { externoAcessivel = false; }
            res.json({ success: true, itens, destino, pasta, externoAcessivel });
        });
    });

    // --- senha de novo para baixar (H4b, decisões §3 SEG-15) -------------------------
    // Baixar um backup (completo, só os dados, o JSON ou um arquivo da lista) pede a senha
    // do administrador de novo: o arquivo leva os dados pessoais de todos os alunos e os
    // hashes das senhas, e uma sessão esquecida aberta no computador da sala não baixa a
    // escola inteira. A senha é conferida pelo attemptPasswordLogin (o único caminho que
    // confere senha: scrypt assíncrono, teto por IP e atraso da conta, finalidade
    // 'backup_download'); a resposta é um bilhete de uso único, preso à conta e ao
    // arquivo, que vale 2 min e vai no ?ticket= do download.
    const DOWNLOAD_TICKET_TTL_MS = 2 * 60 * 1000;
    const DOWNLOAD_TICKETS_MAX = 200;
    const downloadTickets = new Map();
    const PASSWORD_REQUIRED_MESSAGE = 'Para baixar um backup, confirme de novo a senha do administrador.';
    const DOWNLOAD_KINDS = new Set(['completo', 'dados', 'json', 'arquivo']);

    function ticketTarget(kind, local, nome) {
        return kind === 'arquivo' ? `arquivo:${local}:${nome}` : kind;
    }

    function pruneTickets(now = Date.now()) {
        for (const [key, ticket] of downloadTickets) if (ticket.expiresAt <= now) downloadTickets.delete(key);
        while (downloadTickets.size > DOWNLOAD_TICKETS_MAX) downloadTickets.delete(downloadTickets.keys().next().value);
    }

    // Confere o bilhete sem gastar (peek) ou gastando. Devolve true ou responde 403.
    function checkTicket(req, res, matchedAdmin, target, { consume = false } = {}) {
        const raw = typeof req.query.ticket === 'string' ? req.query.ticket.trim() : '';
        pruneTickets();
        const ticket = raw ? downloadTickets.get(raw) : null;
        const email = String((matchedAdmin && matchedAdmin.email) || '').toLowerCase();
        if (!ticket || ticket.email !== email || ticket.target !== target) {
            res.status(403).json({ success: false, passwordRequired: true, error: raw ? 'A confirmação da senha expirou ou não vale para este arquivo. Confirme de novo para baixar.' : PASSWORD_REQUIRED_MESSAGE });
            return false;
        }
        if (consume) downloadTickets.delete(raw);
        return true;
    }

    router.post('/api/admin/backup/download-ticket', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
            const kind = typeof body.tipo === 'string' ? body.tipo.trim().toLowerCase() : '';
            if (!DOWNLOAD_KINDS.has(kind)) {
                return res.status(400).json({ success: false, error: 'Tipo de download desconhecido (completo, dados, json ou arquivo).', field: 'tipo' });
            }
            const local = typeof body.local === 'string' ? body.local.trim() : '';
            const nome = typeof body.nome === 'string' ? body.nome.trim() : '';
            if (kind === 'arquivo' && !backupUtil.resolveStoredBackup(local, nome)) {
                return res.status(400).json({ success: false, error: 'Backup não encontrado na lista. Atualize a lista e tente de novo.', field: 'nome' });
            }
            const password = typeof body.password === 'string' ? body.password : '';
            if (!password.trim()) return res.status(400).json({ success: false, error: 'Informe a senha do administrador.', field: 'password' });
            const check = await attemptPasswordLogin({ kind: 'admin', email: matchedAdmin.email, password, req, purpose: 'backup_download' });
            // A espera é a do login desta conta (mesma senha: errar aqui conta como errar no
            // login, para a sessão esquecida aberta não servir de atalho para adivinhar a
            // senha), com o texto do download.
            if (!check.ok && check.status === 429) {
                const wait = Math.max(1, Number(check.body && check.body.retryAfterSeconds) || 1);
                return res.status(429).json({
                    ...check.body,
                    success: false,
                    error: `Muitas tentativas com a senha errada. Espere ${waitText(wait)} para baixar o backup; o login desta conta também espera esse tempo.`,
                    field: 'password',
                });
            }
            if (!check.ok && check.passwordChanged) {
                return res.status(409).json({ success: false, error: 'A senha desta conta acabou de ser alterada. Confira e tente de novo.' });
            }
            // Senha errada: 400 (não 401), para a tela não tratar como sessão encerrada.
            if (!check.ok) return res.status(400).json({ success: false, error: check.status === 400 ? 'Informe a senha do administrador.' : 'Senha incorreta.', field: 'password', ...(check.body && check.body.loginDelayed ? { loginDelayed: true, retryAfterSeconds: check.body.retryAfterSeconds } : {}) });
            if (check.account !== matchedAdmin) {
                return res.status(409).json({ success: false, error: 'A senha desta conta acabou de ser alterada. Confira e tente de novo.' });
            }
            if (check.rehashed) await db.save().catch(() => {});
            pruneTickets();
            const ticket = crypto.randomBytes(24).toString('hex');
            const expiresAt = Date.now() + DOWNLOAD_TICKET_TTL_MS;
            downloadTickets.set(ticket, { email: String(matchedAdmin.email || '').toLowerCase(), target: ticketTarget(kind, local, nome), expiresAt });
            res.json({ success: true, ticket, expiraEm: new Date(expiresAt).toISOString() });
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
            if (!checkTicket(req, res, matchedAdmin, 'json', { consume: true })) return;
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
            // Sem variante: completo. Variante desconhecida: 400 (antes virava completo calado).
            const rawVariant = String(req.query.variante || '').trim().toLowerCase();
            if (rawVariant && rawVariant !== 'dados' && rawVariant !== 'completo') {
                return res.status(400).json({ success: false, error: 'Variante do backup desconhecida: use completo ou dados.', field: 'variante' });
            }
            const variante = rawVariant === 'dados' ? 'dados' : 'completo';
            if (!checkTicket(req, res, matchedAdmin, variante)) return;
            if (backupUtil.backupInProgress()) return res.status(409).json({ error: backupUtil.BACKUP_BUSY_MESSAGE });
            checkTicket(req, res, matchedAdmin, variante, { consume: true });
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

    // Download de um backup da lista (H4b): ?local=servidor|externo&nome=<arquivo>&ticket=.
    // O nome precisa seguir o padrão dos backups do IClass e estar na pasta (nada de
    // caminho: '../x.zip' é 400). Vai para a auditoria como backup_downloaded.
    router.get('/api/admin/backup/file', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (rejectProfessor(res, matchedAdmin)) return;
            const local = typeof req.query.local === 'string' ? req.query.local.trim() : '';
            const nome = typeof req.query.nome === 'string' ? req.query.nome.trim() : '';
            if (local !== 'servidor' && local !== 'externo') {
                return res.status(400).json({ success: false, error: 'Informe de onde é o backup (servidor ou externo).', field: 'local' });
            }
            if (!backupStore.isBackupName(nome)) {
                return res.status(400).json({ success: false, error: 'Nome de backup inválido.', field: 'nome' });
            }
            const file = backupUtil.resolveStoredBackup(local, nome);
            if (!file) return res.status(404).json({ success: false, error: 'Backup não encontrado. Atualize a lista e tente de novo.' });
            if (!checkTicket(req, res, matchedAdmin, ticketTarget('arquivo', local, nome), { consume: true })) return;
            let stat;
            try {
                stat = await fs.promises.stat(file);
            } catch (error) {
                return res.status(404).json({ success: false, error: 'Backup não encontrado. Atualize a lista e tente de novo.' });
            }
            const info = backupStore.parseBackupName(nome);
            recordBackupAudit(req, matchedAdmin, 'backup_downloaded', { file: nome, local, format: info && info.formato === 'json' ? 'json' : 'zip', ...(info && info.variante ? { variante: info.variante } : {}) });
            await db.save();
            res.setHeader('Content-Type', /\.json$/i.test(nome) ? 'application/json; charset=utf-8' : 'application/zip');
            res.setHeader('Content-Length', String(stat.size));
            res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
            const stream = fs.createReadStream(file);
            stream.on('error', error => {
                if (!res.headersSent) return sendInternalError(error, req, res, 'Falha ao ler o backup no disco.');
                logError('erro interno', error, { req, details: { contexto: 'Falha ao ler o backup no disco (download cortado no meio).' } });
                res.destroy(error);
            });
            stream.pipe(res);
            res.on('close', () => stream.destroy());
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

    // O que a restauração que deu certo leva ao registro e à resposta.
    function restoredInfo(summary) {
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
        return { replaceAccounts, accountsNotRestored, legacyInfo };
    }

    // Registro e resposta da restauração que deu certo (os dois caminhos: token da prévia e
    // envio único). O backup_restored entra antes de o marcador da restauração sair
    // (decisões §12): applyRestore chama onApplied com tudo gravado; uma queda logo depois
    // não deixa a restauração sem registro (o boot completa com o que o marcador guardou).
    function restoreRecorder(req, matchedAdmin, fileInfo) {
        const registro = {
            actor: { email: matchedAdmin && matchedAdmin.email, role: matchedAdmin && matchedAdmin.role },
            ip: req.ip || '',
            device: String((req.headers && req.headers['user-agent']) || '').slice(0, 160),
            details: { ...fileInfo },
        };
        const onApplied = async (summary, { restoreId } = {}) => {
            const { replaceAccounts, accountsNotRestored, legacyInfo } = restoredInfo(summary);
            recordBackupAudit(req, matchedAdmin, 'backup_restored', {
                ...fileInfo,
                replaceAccounts,
                format: summary.format, formato: summary.formato, exportedAt: summary.exportedAt, collections: summary.collections, accountsNotRestored,
                safetyBackup: summary.safetyBackup,
                ...(restoreId ? { restoreId } : {}),
                ...legacyInfo,
            });
            await db.save();
        };
        return { registro, onApplied };
    }

    function finishRestore(req, res, matchedAdmin, summary) {
        const { replaceAccounts, accountsNotRestored, legacyInfo } = restoredInfo(summary);
        // networkKept: a regra de rede (quem abre o painel em outros aparelhos) continua a de
        // hoje, não a do backup (decisões §7); a tela diz isso em uma linha.
        res.json({ success: true, replaceAccounts, accountsNotRestored, networkKept: true, safetyBackup: summary.safetyBackup, ...legacyInfo });
    }

    // Restauração anterior ainda a desfazer (decisões §12): 409 com o código, sem mexer em
    // nada; fica na Auditoria como tentativa recusada.
    async function refuseUndoPending(req, res, matchedAdmin, fileInfo = {}) {
        recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...fileInfo, error: backupUtil.RESTORE_UNDO_PENDING_MESSAGE });
        await db.save().catch(() => {});
        return res.status(409).json({ success: false, error: backupUtil.RESTORE_UNDO_PENDING_MESSAGE, code: 'restore_undo_pending' });
    }

    // Falha da restauração: a falha no meio volta tudo ao estado de antes (applySnapshot
    // exact), inclusive a auditoria. Recusa prevista do arquivo (formato, versão, JSON ou
    // ZIP cortado, soma de verificação, contas: status 400 em utils/backup.js) volta com a
    // própria mensagem; backup em andamento: 409; backup de segurança que não pôde ser
    // salvo: 503 com a mensagem própria (nada mudou). O resto é erro interno: 500 com o
    // código do erro e o stack no crash.log (ENG-04).
    async function failRestore(req, res, matchedAdmin, restoreError, fileInfo) {
        if (restoreError && restoreError.code === 'restore_undo_pending') return refuseUndoPending(req, res, matchedAdmin, fileInfo);
        if (restoreError && restoreError.legacyBackup) {
            // Nada foi restaurado: a tela mostra o aviso e pede a confirmação.
            return res.status(409).json({ error: backupUtil.LEGACY_BACKUP_WARNING, legacyBackup: true, exportedAt: restoreError.exportedAt });
        }
        if (restoreError && restoreError.restoreAborted) {
            // Desligamento do servidor no meio: a restauração parou e foi desfeita (ou o
            // boot desfaz). Não é erro interno: 503 retryable, como o "Fazer backup agora".
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...fileInfo, error: backupUtil.RESTORE_ABORTED_MESSAGE });
            await db.save().catch(() => {});
            return res.status(503).json({ success: false, error: backupUtil.RESTORE_ABORTED_MESSAGE, retryable: true });
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
            if (backupUtil.undoPending()) {
                if (req.is('multipart/form-data')) {
                    const upload = await receiveBackupUpload(req, res, matchedAdmin, 'previa');
                    if (!upload) return;
                    discardUpload(upload.path);
                    return refuseUndoPending(req, res, matchedAdmin, { file: upload.originalName.slice(0, 200), size: upload.size, etapa: 'previa' });
                }
                return refuseUndoPending(req, res, matchedAdmin, { etapa: 'previa' });
            }
            if (!req.is('multipart/form-data')) return previewStoredBackup(req, res, matchedAdmin);
            const upload = await receiveBackupUpload(req, res, matchedAdmin, 'previa');
            if (!upload) return;
            try {
                const { prepared, preview } = await backupUtil.prepareRestore(upload.path, { originalName: upload.originalName });
                prepared.uploadSize = upload.size;
                const { token, expiraEm } = backupUtil.createRestoreToken(prepared, matchedAdmin.email);
                res.json({ success: true, token, expiraEm, arquivo: prepared.originalName, ...preview });
            } catch (error) {
                discardUpload(upload.path);
                if (error && error.code === 'restore_undo_pending') return refuseUndoPending(req, res, matchedAdmin, { file: upload.originalName.slice(0, 200), size: upload.size, etapa: 'previa' });
                const shownError = publicErrorMessage(error, req);
                recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { file: upload.originalName.slice(0, 200), size: upload.size, etapa: 'previa', error: shownError.slice(0, 300) });
                await db.save().catch(() => {});
                return sendRouteError(error, req, res, 'Falha ao conferir o backup enviado.');
            }
        });
    });

    // Prévia de um backup da lista (H4b): JSON { local, nome }. O arquivo é conferido pela
    // soma .sha256 ao lado (quando há) e extraído numa pasta só da prévia; o original fica
    // onde está (não é apagado como o enviado) e não sai pela retenção durante a
    // restauração.
    async function previewStoredBackup(req, res, matchedAdmin) {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const local = typeof body.local === 'string' ? body.local.trim() : '';
        const nome = typeof body.nome === 'string' ? body.nome.trim() : '';
        const refuse = async (status, error, field) => {
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { ...(nome ? { file: nome.slice(0, 200) } : {}), ...(local ? { local } : {}), etapa: 'previa', error });
            await db.save().catch(() => {});
            return res.status(status).json({ success: false, error, ...(field ? { field } : {}) });
        };
        if (!local && !nome) return refuse(400, 'Envie o arquivo de backup (.json ou .zip) ou escolha um da lista.', 'file');
        if (local !== 'servidor' && local !== 'externo') return refuse(400, 'Informe de onde é o backup (servidor ou externo).', 'local');
        if (!backupStore.isBackupName(nome)) return refuse(400, 'Nome de backup inválido.', 'nome');
        const file = backupUtil.resolveStoredBackup(local, nome);
        if (!file) return refuse(404, 'Backup não encontrado. Atualize a lista e tente de novo.');
        let size = 0;
        try {
            size = (await fs.promises.stat(file)).size;
            const checksum = await backupStore.verifyChecksum(file);
            if (checksum === 'diferente') return refuse(400, 'O arquivo não confere com a soma de verificação (.sha256) ao lado dele: pode estar danificado ou incompleto. Escolha outro backup.');
            const { prepared, preview } = await backupUtil.prepareRestore(file, { originalName: nome, keepSource: true });
            prepared.uploadSize = size;
            prepared.sourceName = nome;
            const { token, expiraEm } = backupUtil.createRestoreToken(prepared, matchedAdmin.email);
            res.json({ success: true, token, expiraEm, arquivo: nome, local, ...preview });
        } catch (error) {
            if (error && error.code === 'restore_undo_pending') return refuseUndoPending(req, res, matchedAdmin, { file: nome, local, size, etapa: 'previa' });
            const shownError = publicErrorMessage(error, req);
            recordBackupAudit(req, matchedAdmin, 'backup_restore_failed', { file: nome, local, size, etapa: 'previa', error: shownError.slice(0, 300) });
            await db.save().catch(() => {});
            return sendRouteError(error, req, res, 'Falha ao conferir o backup escolhido.');
        }
    }

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
                const summary = await backupUtil.restoreFromFile(upload.path, upload.originalName, { replaceAccounts, acceptLegacy, ...restoreRecorder(req, matchedAdmin, fileInfo) });
                discardUpload(upload.path);
                return finishRestore(req, res, matchedAdmin, { replaceAccounts, ...summary });
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
        // O token continua valendo: depois de fechar e abrir o IClass, a prévia some (fica só
        // na memória), mas nada foi apagado.
        if (backupUtil.undoPending()) return refuseUndoPending(req, res, matchedAdmin);
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
            const summary = await backupUtil.applyPreparedRestore(prepared, { replaceAccounts, acceptLegacy: true, ...restoreRecorder(req, matchedAdmin, fileInfo) });
            return finishRestore(req, res, matchedAdmin, summary);
        } catch (restoreError) {
            return failRestore(req, res, matchedAdmin, restoreError, fileInfo);
        }
    }

    return router;
}

module.exports = { createAdminRecoveryRouter };
