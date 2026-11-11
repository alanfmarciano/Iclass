const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { DATA_DIR } = require('../runtimePaths.js');
const { recordAudit } = require('../utils/audit.js');
const {
    DB_CLASSES_FILE,
    readJSON,
    validateAdmin,
    adminCanAccessClass,
    findClassByNameAndCourse,
    getCourseItemKeys,
    getReleasedItemsForClass,
    isProfessorAccount,
    sendHandledFailure,
    sendInternalError,
} = require('../middlewares.js');
const settingsUtil = require('../utils/settings.js');
const serverLifecycle = require('../utils/serverLifecycle.js');
const { connectionInfo, httpsAvailable, studentsHttpsEnabled } = require('../utils/networkPolicy.js');
const { networkAddresses } = require('../utils/networkAddresses.js');
const { encodeQr } = require('../utils/qrCode.js');
const { saveServerBackup } = require('../utils/backup.js');
const { revokeStudentSession } = require('../utils/authSessions.js');
const { ACTIVE_APPLICATION_STATUSES } = require('../utils/examApplications.js');
const { finishApplication } = require('../utils/examFinish.js');
const {
    applicationBelongsToClass,
    applicationSummary,
    applyExamStateFlush,
    classApplications,
    classSessionsToDrop,
    planClassReset,
    planExamStateFlush,
    sameClassName,
} = require('../utils/examMaintenance.js');

function normalizedEmail(value) {
    return String(value || '').trim().toLowerCase();
}

// Nome legível da prova (título da avaliação ou nome da unidade no curso).
function examTitleFor(examKey) {
    const evaluation = db.memory.evaluations?.[examKey];
    if (evaluation?.title || evaluation?.name) return evaluation.title || evaluation.name;
    for (const course of db.memory.courses || []) {
        for (const module of course?.structure || []) {
            const unit = (module?.units || module?.items || []).find(item => item?.avaliacaoKey === examKey);
            if (unit?.name || unit?.title) return unit.name || unit.title;
        }
    }
    return String(examKey || 'Prova').replace(/_/g, ' ');
}

function studentInClass(student, cls) {
    const memberships = Array.isArray(student?.classes) && student.classes.length
        ? student.classes
        : (student?.studentClass ? [student.studentClass] : []);
    return memberships.some(item => {
        const name = typeof item === 'string' ? item : (item && (item.name || item.className));
        const courseId = item && typeof item === 'object' ? item.courseId : (student.courseId || null);
        return !!name && sameClassName(name, cls.name) && (!courseId || !cls.courseId || String(courseId) === String(cls.courseId));
    });
}

// Alunos matriculados e provas do curso da turma (para estados de prova antigos,
// gravados sem aplicação nem turma).
function classHelpers(cls) {
    const emails = new Set((db.memory.students || []).filter(student => studentInClass(student, cls)).map(student => normalizedEmail(student.email)));
    return {
        isClassStudent: email => emails.has(normalizedEmail(email)),
        courseExamKeys: getCourseItemKeys(cls),
        examTitle: examTitleFor,
        // Teclas preservadas: pelos contadores do histórico de digitação (tabela própria).
        keystrokeEntries: () => db.keystrokes.statsEntries(),
    };
}

// Turma (e aplicação) das ações de manutenção, conferida no servidor.
function maintenanceScope(req, matchedAdmin, { studentClass, courseId, applicationId }) {
    const cls = findClassByNameAndCourse(db.memory.classes || [], studentClass, courseId);
    if (!cls) return { status: 404, error: 'Turma não encontrada.' };
    if (!adminCanAccessClass(matchedAdmin, cls.name, cls.courseId)) return { status: 403, error: 'A turma solicitada não está atribuída a esta conta.' };
    let application = null;
    if (applicationId) {
        application = (db.memory.examApplications || []).find(item => item && item.id === String(applicationId).trim()) || null;
        if (!application || !applicationBelongsToClass(application, cls)) return { status: 404, error: 'Aplicação de prova não encontrada nesta turma.' };
    }
    return { cls, application };
}

// Backup dos dados antes de apagar qualquer coisa: a limpeza pode ser desfeita.
function safetyBackup(prefix) {
    try {
        return { ok: true, file: path.basename(saveServerBackup(prefix)) };
    } catch (error) {
        // A rota responde 503 com a mensagem própria (sendHandledFailure): o stack vai para o
        // crash.log com o código do pedido.
        return { ok: false, file: null, error };
    }
}

// Manutenção (limpar estado de prova, resetar sala, reiniciar): atalho para recordAudit,
// na categoria 'system', gravando também type/actorEmail/at como as entradas antigas.
function recordMaintenanceAudit(req, account, type, cls, details) {
    const timestamp = Date.now();
    recordAudit(db.memory, {
        req,
        actor: account,
        action: type,
        category: 'system',
        studentClass: cls ? cls.name : null,
        courseId: cls ? cls.courseId || null : null,
        details,
    }, { timestamp, legacy: { type, actorEmail: account && account.email, at: timestamp } });
}

// Armazenamento (H1-c: CONF-06, DES-11, CONF-05). O VACUUM reescreve o arquivo inteiro
// e precisa de espaço livre no disco (o arquivo novo é montado antes de o antigo sair):
// pelo menos o tamanho do banco (com o -wal) mais 10%.
const COMPACT_DISK_MARGIN = 1.1;

function activeApplicationCount() {
    return (db.memory.examApplications || []).filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status)).length;
}

function storageTotalBytes(status) {
    return (Number(status && status.databaseBytes) || 0) + (Number(status && status.walBytes) || 0);
}

function formatMegabytes(bytes) {
    return `${(Math.max(0, Number(bytes) || 0) / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

// Espaço livre no disco da pasta de dados (null quando o sistema não informa).
async function diskFreeBytes(dir) {
    try {
        const stats = await fs.promises.statfs(dir);
        const free = Number(stats.bavail) * Number(stats.bsize);
        return Number.isFinite(free) ? free : null;
    } catch (e) {
        return null;
    }
}

// Chaves das configurações achatadas por ponto ('trash.retentionDays'), com o valor.
// Lista (tipos de arquivo permitidos) é um valor só.
function flattenSettings(value, prefix = '', out = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.keys(value).forEach(key => flattenSettings(value[key], prefix ? `${prefix}.${key}` : key, out));
        return out;
    }
    if (prefix) out[prefix] = value;
    return out;
}

// O que mudou entre duas versões das configurações: [{ key, before, after }], na ordem
// das chaves (as de antes primeiro).
function settingsChanges(before, after) {
    const flatBefore = flattenSettings(before);
    const flatAfter = flattenSettings(after);
    const keys = [...new Set([...Object.keys(flatBefore), ...Object.keys(flatAfter)])];
    return keys
        .filter(key => JSON.stringify(flatBefore[key]) !== JSON.stringify(flatAfter[key]))
        .map(key => ({ key, before: flatBefore[key] === undefined ? null : flatBefore[key], after: flatAfter[key] === undefined ? null : flatAfter[key] }));
}

function createAdminSystemRouter({ port = process.env.PORT || 3000 } = {}) {
    const router = express.Router();

    // Porta que os alunos usam: a do servidor que está escutando (startServer guarda em
    // app.set('serverInstance')); sem ele (testes com supertest), a configurada.
    function listeningPort(req) {
        const server = req.app && req.app.get('serverInstance');
        const address = server && typeof server.address === 'function' ? server.address() : null;
        return address && typeof address === 'object' && address.port ? address.port : Number(port) || 3000;
    }

    // Endereços desta máquina (utils/networkAddresses.js, relidos a cada 2 s), com o
    // esquema que os alunos usam: http enquanto a conexão segura para os alunos estiver
    // desligada (studentsHttps, padrão; H6c).
    function studentAddresses(req) {
        return networkAddresses({ port: listeningPort(req), scheme: studentsHttpsEnabled() ? 'https' : 'http' });
    }

    // Cartão Rede da tela Sistema (H6a, OPS-10): todos os adaptadores, cada um com o
    // endereço completo (esquema, IP e porta) e o tipo ('rede', 'virtual', 'link-local'),
    // e o recomendado para os alunos. hostname (nome fixo, H6d) e https (conexão segura,
    // H6c) já vêm no formato final, desligados nesta versão.
    router.get('/api/admin/network-info', (req, res) => {
        validateAdmin(req, res, () => {
            const snapshot = studentAddresses(req);
            res.json({
                port: snapshot.port,
                recommended: snapshot.recommended,
                addresses: snapshot.addresses,
                hostname: null,
                https: { available: httpsAvailable(), studentsHttps: studentsHttpsEnabled() },
                adminAccess: settingsUtil.networkSettings().adminAccess,
            });
        });
    });

    // Endereço da sala (H6a, OPS-10): o endereço que os alunos digitam e o QR code dele,
    // para o botão "Endereço da sala" do Dashboard e do Monitor e a página /endereco
    // (projetada no quadro). O professor vê (page.dashboard ou page.monitor). O QR codifica
    // sempre studentUrl; sem rede nenhuma, os dois vêm null e a tela explica.
    let lastQr = { url: null, qr: null };
    function qrFor(url) {
        if (lastQr.url !== url) lastQr = { url, qr: encodeQr(url) };
        return lastQr.qr;
    }
    router.get('/api/admin/room-address', (req, res) => {
        validateAdmin(req, res, () => {
            const snapshot = studentAddresses(req);
            const recommended = snapshot.recommended;
            const studentUrl = recommended ? recommended.url : null;
            const qr = studentUrl ? qrFor(studentUrl) : null;
            res.json({
                success: true,
                studentUrl,
                port: snapshot.port,
                adapter: recommended ? { name: recommended.name, address: recommended.address, kind: recommended.kind } : null,
                nameUrl: null,
                hostnameInUse: null,
                mdnsState: 'desligado',
                studentsHttps: snapshot.scheme === 'https',
                qr: qr ? { version: qr.version, size: qr.size, rows: qr.rows } : null,
            });
        });
    });

    // Cartão Armazenamento da tela Sistema: tamanho do banco e do -wal, espaço
    // recuperável, linhas por coleção, teclas, gravação completa, p95 de gravação, último
    // erro, aviso de OneDrive (db.storageStatus(), fonte única) e se dá para compactar.
    router.get('/api/admin/storage', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            await db.refreshStorageStats();
            res.json({
                success: true,
                storage: db.storageStatus(),
                activeApplications: activeApplicationCount(),
                diskFreeBytes: await diskFreeBytes(DATA_DIR),
                // Compactar é só do administrador (o professor vê o cartão sem o botão).
                canCompact: !isProfessorAccount(matchedAdmin),
            });
        });
    });

    // Compactar o banco (VACUUM): só administrador, com COMPACTAR digitado, sem prova em
    // andamento (o VACUUM para a fila de gravação por alguns segundos) e com espaço no
    // disco. Grava a auditoria 'storage_compacted' com o tamanho antes e depois.
    router.post('/api/admin/storage/compact', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (isProfessorAccount(matchedAdmin)) {
                return res.status(403).json({ error: 'Apenas administradores podem compactar o banco.' });
            }
            // Só texto: um array ['COMPACTAR'] viraria 'COMPACTAR' no String().
            const confirm = (req.body || {}).confirm;
            if (typeof confirm !== 'string' || confirm.trim().toUpperCase() !== 'COMPACTAR') {
                return res.status(400).json({ error: 'Digite COMPACTAR para confirmar.', confirmationRequired: true });
            }
            const active = activeApplicationCount();
            if (active) {
                return res.status(409).json({
                    error: 'Há prova em andamento. Compacte o banco depois que as provas terminarem.',
                    activeApplications: active,
                });
            }
            await db.refreshStorageStats();
            const neededBytes = Math.ceil(storageTotalBytes(db.storageStatus()) * COMPACT_DISK_MARGIN);
            const freeOnDisk = await diskFreeBytes(DATA_DIR);
            if (freeOnDisk !== null && freeOnDisk < neededBytes) {
                return res.status(409).json({
                    error: `Espaço livre em disco insuficiente para compactar: são necessários ${formatMegabytes(neededBytes)} e há ${formatMegabytes(freeOnDisk)}.`,
                    diskFreeBytes: freeOnDisk,
                    neededBytes,
                });
            }
            let result;
            try {
                // A conferência de prova em andamento de cima vem antes das esperas (PRAGMAs,
                // espaço em disco, fila de gravação): uma prova iniciada nesse meio-tempo
                // pararia no VACUUM. Por isso ela é refeita dentro do runExclusive, logo antes
                // dele (sobra do H1-c na J2).
                result = await db.compactDatabase({
                    beforeVacuum: () => {
                        const activeNow = activeApplicationCount();
                        return activeNow ? Object.assign(new Error('active_application'), { code: 'ACTIVE_APPLICATION', activeApplications: activeNow }) : null;
                    },
                });
            } catch (error) {
                if (error && error.code === 'ACTIVE_APPLICATION') {
                    return res.status(409).json({
                        error: 'Há prova em andamento. Compacte o banco depois que as provas terminarem.',
                        activeApplications: error.activeApplications,
                    });
                }
                if (error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) {
                    return res.status(409).json({ error: 'O banco está em uso por outro programa agora. Feche o programa que abriu o banco e tente de novo.' });
                }
                return sendInternalError(error, req, res, 'compactar o banco');
            }
            const antes = storageTotalBytes(result.before);
            const depois = storageTotalBytes(result.after);
            // O antes soma o -wal, que o checkpoint zera de qualquer jeito: o espaço vazio
            // devolvido ao disco é o freeBytes que sumiu do arquivo.
            const recuperadoBytes = Math.max(0, (Number(result.before.freeBytes) || 0) - (Number(result.after.freeBytes) || 0));
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'storage_compacted',
                category: 'system',
                before: { bytes: antes, freeBytes: result.before.freeBytes },
                after: { bytes: depois, freeBytes: result.after.freeBytes },
                details: { antes, depois, recuperadoBytes, ms: result.ms },
            });
            await db.save();
            res.json({ success: true, antes, depois, recuperadoBytes, ms: result.ms, storage: db.storageStatus() });
        });
    });

    router.post('/api/admin/config', (req, res) => {
        validateAdmin(req, res, config => {
            const { studentClass, studentEmail, courseId } = req.body;
            // O mesmo endereço recomendado do cartão Rede e do QR da sala (H6a).
            const snapshot = studentAddresses(req);
            const responseData = {
                activeExamKey: config.activeExamKey,
                releasedItems: config.releasedItems || {},
                serverUrl: snapshot.recommended ? snapshot.recommended.url : `${snapshot.scheme}://localhost:${snapshot.port}`,
            };

            if (studentClass) {
                const classes = readJSON(DB_CLASSES_FILE);
                const cls = findClassByNameAndCourse(classes, studentClass, courseId);
                if (!cls) return res.status(404).json({ error: 'Turma não encontrada.' });
                responseData.activeExamKey = cls.activeExamKey;
                responseData.activeExamQuestionCount = cls.activeExamQuestionCount || 20;
                responseData.examConfigs = cls.examConfigs || {};
                responseData.onlineExamConfigs = cls.onlineExamConfigs || {};
                responseData.releasedItems = getReleasedItemsForClass(cls, studentEmail);
            }
            res.json(responseData);
        });
    });

    // Prévia das ações de manutenção para a turma escolhida: o que cada uma apaga ou
    // encerra, para a confirmação mostrar ao professor antes de qualquer mudança.
    router.get('/api/admin/maintenance/preview', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            // Reiniciar derruba TODOS os alunos conectados: a confirmação lista todas as
            // provas em andamento do servidor (turma e prova, sem dado de aluno), qualquer
            // que seja o escopo da conta. Antes o professor de uma turma lia "Nenhuma prova
            // em andamento" com outra turma no meio da prova.
            const restart = {
                activeApplications: (db.memory.examApplications || [])
                    .filter(application => application && ACTIVE_APPLICATION_STATUSES.has(application.status))
                    .map(application => ({
                        ...applicationSummary(application, examTitleFor),
                        studentClass: application.studentClass,
                        outsideScope: !adminCanAccessClass(matchedAdmin, application.studentClass, application.courseId),
                    })),
            };
            const studentClass = String(req.query.studentClass || '').trim();
            if (!studentClass) return res.json({ success: true, restart, flush: null, reset: null, applications: [] });
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId: req.query.courseId, applicationId: req.query.applicationId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            const { cls, application } = scope;
            const helpers = classHelpers(cls);
            const flushPlan = planExamStateFlush(db.memory, { cls, application, ...helpers });
            const resetPlan = planClassReset(db.memory, { cls, ...helpers });
            res.json({
                success: true,
                studentClass: cls.name,
                courseId: cls.courseId || null,
                restart,
                applications: classApplications(db.memory, cls).map(item => applicationSummary(item, examTitleFor)),
                flush: {
                    applicationId: flushPlan.applicationId,
                    blockedBy: flushPlan.blockedBy,
                    counts: flushPlan.counts,
                    preserved: flushPlan.preserved,
                },
                reset: {
                    activeApplications: resetPlan.activeApplications,
                    counts: resetPlan.counts,
                    preserved: resetPlan.preserved,
                },
            });
        });
    });

    // "Limpar estado de prova": só na turma escolhida (e, se informada, numa aplicação
    // dela), com confirmação digitada, nunca com prova em andamento e sem apagar logs
    // de monitoramento, histórico de digitação, entregas ou notas (UXI-02, CONF-10, OPS-X3).
    router.post('/api/admin/flush-exam-state', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { studentClass, courseId, applicationId, examKey, studentEmail } = req.body || {};
            if (!String(studentClass || '').trim()) {
                return res.status(400).json({ error: 'Escolha a turma: a limpeza do estado de prova vale só para uma turma.' });
            }
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId, applicationId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            if (String(req.body.confirm || '').trim().toUpperCase() !== 'LIMPAR') {
                return res.status(400).json({ error: 'Digite LIMPAR para confirmar a limpeza do estado de prova.', confirmationRequired: true });
            }
            const { cls, application } = scope;
            const plan = planExamStateFlush(db.memory, { cls, application, examKey, studentEmail, ...classHelpers(cls) });
            if (plan.blockedBy.length) {
                const names = plan.blockedBy.map(item => item.examTitle).join(', ');
                return res.status(409).json({
                    error: `Há uma aplicação em andamento nesta turma (${names}). Encerre-a pelo Monitor antes de limpar o estado de prova.`,
                    blockedBy: plan.blockedBy,
                });
            }
            const clearedCount = plan.counts.examStates + plan.counts.messages;
            if (clearedCount === 0) {
                return res.json({ success: true, clearedCount: 0, message: `Nada para limpar na turma ${cls.name}.` });
            }
            const backup = safetyBackup('antes-limpeza-prova');
            if (!backup.ok) return sendHandledFailure(backup.error, req, res, 'Não foi possível salvar o backup de segurança; nada foi apagado.');
            const removed = applyExamStateFlush(db.memory, plan);
            recordMaintenanceAudit(req, matchedAdmin, 'exam_state_flushed', cls, {
                applicationId: plan.applicationId,
                examKey: plan.examKey || (examKey ? String(examKey) : null),
                studentEmail: plan.studentEmail,
                ...removed,
                pendingAnswers: plan.counts.pendingAnswers,
                preserved: plan.preserved,
                backup: backup.file,
            });
            await db.save();
            console.log(`[FLUSH] Estado de prova limpo na turma ${cls.name}: ${clearedCount} registros removidos.`);
            res.json({
                success: true,
                clearedCount,
                ...removed,
                backup: backup.file,
                message: `Estado de prova limpo na turma ${cls.name}: ${removed.removedStates} estado(s) de tentativa e ${removed.removedMessages} mensagem(ns) removidos. Logs de monitoramento e histórico de digitação foram preservados.`,
            });
        });
    });

    // Reiniciar (H3c, CONF-12, OPS-06): o desligamento ordenado único do servidor
    // (serverLifecycle.requestShutdown), o mesmo dos sinais e do launcher: fecha a porta,
    // para os timers, grava tudo e fecha o banco (db.close) e marca a parada limpa no
    // heartbeat. Sob o supervisor o processo sai com 75 e volta na hora; sem ele, o próprio
    // servidor dispara o novo processo antes de sair. As sessões (H3a-2) e o tempo das
    // provas (H3b) voltam com ele: ninguém precisa entrar de novo. Antes saía sem db.close
    // e, fora do Windows, não voltava.
    router.post('/api/admin/server/restart', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            // Reiniciar deixa todos sem conexão por alguns segundos: só com confirmação explícita.
            if (String((req.body || {}).confirm || '').trim().toUpperCase() !== 'REINICIAR') {
                return res.status(400).json({ error: 'Confirme o reinício do servidor.', confirmationRequired: true });
            }
            // Sem o desligamento registrado (app montado pelos testes, sem o startServer)
            // não há como voltar: nada é feito.
            if (!serverLifecycle.hasShutdownHandler()) {
                return res.status(503).json({ error: 'Reinício indisponível neste modo.' });
            }
            recordMaintenanceAudit(req, matchedAdmin, 'server_restart_requested', null, {
                activeApplications: (db.memory.examApplications || []).filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status)).length,
                supervised: serverLifecycle.isSupervised(),
            });
            // Falha de gravação aqui não impede o reinício: o db.close do desligamento grava
            // de novo, e a resposta não vira o 503 de gravação.
            try { await db.save(); } catch (_) {}
            const supervised = serverLifecycle.isSupervised();
            res.json({ success: true, ok: true, supervised, message: 'Servidor reiniciando...' });
            // Depois que a resposta saiu (o desligamento fecha as conexões).
            res.once('finish', () => setImmediate(() => {
                serverLifecycle.requestShutdown({ restart: true, reason: 'admin_restart' });
            }));
        });
    });

    // "Resetar sala": só na turma escolhida e com a confirmação RESETAR conferida no
    // servidor. As provas em andamento da turma são encerradas salvando as respostas
    // (viram entrega), o que sobrar de estado de prova e as mensagens da turma são
    // limpos e os alunos dela são desconectados. Logs, digitação e notas ficam (CONF-X3).
    router.post('/api/admin/reset', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            const { studentClass, courseId } = req.body || {};
            if (!String(studentClass || '').trim()) {
                return res.status(400).json({ error: 'Escolha a turma: o reset vale só para uma turma.' });
            }
            const scope = maintenanceScope(req, matchedAdmin, { studentClass, courseId });
            if (scope.error) return res.status(scope.status).json({ error: scope.error });
            if (String(req.body.confirm || '').trim().toUpperCase() !== 'RESETAR') {
                return res.status(400).json({ error: 'Digite RESETAR para confirmar o reset da sala.', confirmationRequired: true });
            }
            const { cls } = scope;
            const helpers = classHelpers(cls);
            const backup = safetyBackup('antes-resetar-sala');
            if (!backup.ok) return sendHandledFailure(backup.error, req, res, 'Não foi possível salvar o backup de segurança; nada foi alterado.');

            const actor = (matchedAdmin && (matchedAdmin.email || matchedAdmin.name)) || 'Administrador';
            const finished = [];
            classApplications(db.memory, cls)
                .filter(application => ACTIVE_APPLICATION_STATUSES.has(application.status))
                .forEach(application => {
                    const processed = finishApplication(db.memory, { application, cls, policy: 'submit', actor, reason: 'reset_sala' });
                    if (!processed) return;
                    finished.push({ applicationId: application.id, examKey: application.examKey, submitted: processed.submitted, deliveredAtDeadline: processed.deliveredAtDeadline });
                });

            // Sobras: estados de prova sem aplicação em andamento e mensagens da turma.
            const removed = applyExamStateFlush(db.memory, planExamStateFlush(db.memory, { cls, ...helpers }));

            // Configurações antigas (sem aplicação) que ficaram marcadas como ativas.
            let legacyConfigs = 0;
            Object.values(cls.onlineExamConfigs || {}).forEach(examConfig => {
                if (!examConfig || !['running', 'waiting', 'paused'].includes(examConfig.status)) return;
                const application = examConfig.applicationId
                    ? (db.memory.examApplications || []).find(item => item && item.id === examConfig.applicationId)
                    : null;
                if (application) return;
                examConfig.status = 'not_applied';
                examConfig.onlineActive = false;
                examConfig.startTime = null;
                examConfig.waitingRoomStartTimestamp = null;
                examConfig.updatedAt = new Date().toISOString();
                legacyConfigs += 1;
            });
            const stillActive = classApplications(db.memory, cls).some(item => ACTIVE_APPLICATION_STATUSES.has(item.status));
            if (!stillActive) {
                cls.activeExamKey = null;
                cls.activeApplicationId = null;
            }

            // Quem também faz prova em andamento em outra turma continua conectado.
            const sessions = classSessionsToDrop(db.memory, cls, helpers.isClassStudent);
            const disconnected = sessions.drop;
            disconnected.forEach(email => { revokeStudentSession(db.memory, email); });

            const submitted = finished.reduce((total, item) => total + item.submitted + item.deliveredAtDeadline, 0);
            recordMaintenanceAudit(req, matchedAdmin, 'class_reset', cls, {
                finishedApplications: finished,
                ...removed,
                disconnectedStudents: disconnected.length,
                keptInOtherExam: sessions.keptInOtherExam.length,
                legacyConfigs,
                backup: backup.file,
            });
            await db.save();
            res.json({
                success: true,
                finishedApplications: finished.length,
                submitted,
                ...removed,
                disconnectedStudents: disconnected.length,
                keptInOtherExam: sessions.keptInOtherExam.length,
                backup: backup.file,
                message: `Sala ${cls.name} resetada: ${finished.length} prova(s) em andamento encerrada(s) com as respostas salvas (${submitted} entrega(s)), ${disconnected.length} aluno(s) desconectado(s)${sessions.keptInOtherExam.length ? ` (${sessions.keptInOtherExam.length} continua(m) conectado(s) por estar(em) em prova de outra turma)` : ''}, ${removed.removedStates} estado(s) de prova e ${removed.removedMessages} mensagem(ns) limpos. Conteúdos liberados, notas e logs foram preservados.`,
            });
        });
    });

    // Rede (SEG-03): quem abre o painel do professor em outros aparelhos. Só o
    // administrador troca (o professor recebe 403 mesmo com system.manage), com registro
    // na auditoria. O POST genérico de configurações nunca mexe neste bloco
    // (PROTECTED_SETTINGS_SECTIONS em utils/settings.js).
    function networkSettingsPayload(req) {
        const connection = connectionInfo(req);
        return {
            ...settingsUtil.networkSettings(),
            modes: settingsUtil.ADMIN_ACCESS_MODES,
            httpsAvailable: httpsAvailable(),
            thisComputer: connection.thisComputer,
            secure: connection.secure,
        };
    }

    router.get('/api/admin/network-settings', (req, res) => {
        validateAdmin(req, res, () => res.json(networkSettingsPayload(req)));
    });

    router.post('/api/admin/network-settings', (req, res) => {
        validateAdmin(req, res, async (config, account) => {
            if (isProfessorAccount(account)) {
                return res.status(403).json({ error: 'Só o administrador pode mudar onde o painel do professor abre.' });
            }
            const requested = req.body.adminAccess;
            if (typeof requested !== 'string' || !settingsUtil.ADMIN_ACCESS_MODES.includes(requested)) {
                return res.status(400).json({ success: false, error: 'Escolha onde o painel do professor pode abrir.', field: 'adminAccess' });
            }
            if (requested === 'rede' && !httpsAvailable()) {
                return res.status(409).json({
                    success: false,
                    field: 'adminAccess',
                    error: 'A opção "Outros aparelhos só com conexão segura" ainda não pode ser usada: esta versão do IClass ainda não tem a conexão segura (https). Por enquanto, escolha "Todos os aparelhos da rede" ou "Só o computador do IClass".',
                });
            }
            const before = settingsUtil.networkSettings();
            if (before.adminAccess === requested) {
                return res.json({ success: true, unchanged: true, network: networkSettingsPayload(req) });
            }
            if (!db.memory.config) db.memory.config = {};
            const settings = db.memory.config.settings && typeof db.memory.config.settings === 'object' ? db.memory.config.settings : {};
            const storedNetwork = settings.network && typeof settings.network === 'object' ? settings.network : {};
            db.memory.config.settings = { ...settings, network: { ...storedNetwork, adminAccess: requested } };
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'network_settings_changed',
                category: 'system',
                field: 'adminAccess',
                oldValue: before.adminAccess,
                newValue: requested,
                before: { adminAccess: before.adminAccess },
                after: { adminAccess: requested },
            });
            await db.save();
            res.json({ success: true, network: networkSettingsPayload(req) });
        });
    });

    router.get('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, () => res.json(settingsUtil.getSettings()));
    });

    // Configurações gerais: cada chave que mudou vai para a auditoria (settings_updated,
    // SEG-07) com o valor de antes e o de depois. Salvar sem mudar nada não grava entrada.
    router.post('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, async (config, account) => {
            // Fuso que o Intl não conhece não é gravado: cada data feita com ele quebrava.
            const timezone = req.body && req.body.timezone;
            if (typeof timezone === 'string' && timezone.trim() && !settingsUtil.isValidTimeZone(timezone.trim())) {
                return res.status(400).json({ success: false, error: 'Fuso horário desconhecido. Escolha um fuso da lista.', field: 'timezone' });
            }
            if (!db.memory.config) db.memory.config = {};
            const before = settingsUtil.getSettings();
            db.memory.config.settings = settingsUtil.mergeSettings(req.body || {});
            const changes = settingsChanges(before, settingsUtil.getSettings());
            if (changes.length) {
                recordAudit(db.memory, {
                    req,
                    actor: account,
                    action: 'settings_updated',
                    category: 'system',
                    details: { changes },
                });
            }
            await db.save();
            res.json({ success: true, settings: db.memory.config.settings });
        });
    });

    return router;
}

module.exports = { createAdminSystemRouter };
