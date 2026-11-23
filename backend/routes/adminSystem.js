const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const buildIntegrity = require('../utils/buildIntegrity.js');
const { DATA_DIR } = runtimePaths;
const schemaMigrations = require('../utils/schemaMigrations.js');
const { recordAudit } = require('../utils/audit.js');
const {
    DB_CLASSES_FILE,
    readJSON,
    validateAdmin,
    adminCanAccessClass,
    findClassByNameAndCourse,
    getCourseItemKeys,
    getReleasedItemsForClass,
    sendHandledFailure,
    sendInternalError,
    sendRouteError,
} = require('../middlewares.js');
const settingsUtil = require('../utils/settings.js');
const { shape, int } = require('../utils/inputSchema.js');
const { isFullAdmin } = require('../utils/adminRoles.js');
const serverLifecycle = require('../utils/serverLifecycle.js');
const { connectionInfo, httpsAvailable, networkHttpsStatus, studentsHttpsEnabled } = require('../utils/networkPolicy.js');
const secureConnection = require('../utils/secureConnection.js');
const { networkAddresses } = require('../utils/networkAddresses.js');
const { encodeQr } = require('../utils/qrCode.js');
const { createSafetyBackup } = require('../utils/backup.js');
const { revokeStudentSession } = require('../utils/authSessions.js');
const { ACTIVE_APPLICATION_STATUSES } = require('../utils/examApplications.js');
const { canReadExamVersions, onlineExamConfigsWithoutAnswerKeys } = require('../utils/examAnswerKeyView.js');
const { finishApplication } = require('../utils/examFinish.js');
const { manualAssessmentTitle } = require('../utils/gradebook.js');
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
    const manual = manualAssessmentTitle(db.memory.classes || [], examKey);
    if (manual) return manual;
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

// Backup dos dados antes de apagar qualquer coisa: a limpeza pode ser desfeita. Desde o
// H4a é o ZIP formato 2 dos dados (<prefixo>_dados_<carimbo>.zip, com o histórico de
// digitação), gerado sem travar o servidor (antes o JSON síncrono parava todos por
// segundos num banco grande). Outro backup em andamento: busy (a rota responde 409).
async function safetyBackup(prefix) {
    try {
        const saved = await createSafetyBackup(prefix);
        return { ok: true, file: saved.name };
    } catch (error) {
        if (error && error.code === 'ICLASS_BACKUP_BUSY') return { ok: false, busy: true, file: null, error };
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

// Bloco 'entregas' do cartão Armazenamento (C11 / P1-i). Falha na leitura da pasta não
// derruba o cartão: o bloco vem null e o resto aparece.
async function assignmentStorageSummary(matchedAdmin) {
    try {
        return await require('../utils/assignmentMirror.js').storageSummary(db.memory, { full: isFullAdmin(matchedAdmin) });
    } catch (error) {
        require('../utils/errorLog.js').logError('armazenamento: arquivos das entregas', error);
        return null;
    }
}

// --- Sobre o IClass (fase 3, A1 / P6-S2: OPS-02, ENG-10, OPS-21; D22 do P6) -------------

// O build que este servidor serve (web/dist/build-meta.json): id curto, quando foi feito e
// com que Node. Sem o arquivo (não deveria acontecer: o boot confere o build), tudo null.
function buildInfo() {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(runtimePaths.WEB_DIST_DIR, 'build-meta.json'), 'utf8'));
        const id = typeof meta.sourceHash === 'string' && /^[0-9a-f]{12,128}$/.test(meta.sourceHash) ? meta.sourceHash.slice(0, 12) : null;
        return {
            id,
            geradoEm: typeof meta.builtAt === 'string' && Number.isFinite(Date.parse(meta.builtAt)) ? meta.builtAt : null,
            node: typeof meta.node === 'string' ? meta.node : null,
        };
    } catch (err) {
        return { id: null, geradoEm: null, node: null };
    }
}

// 'pacote' quando o IClass veio do pacote de release (release-manifest.json na pasta do
// programa e sem o código da interface, D14 do P6); senão 'desenvolvimento' (pasta do git,
// como a do Alan hoje).
function installMode() {
    return buildIntegrity.buildMode(runtimePaths.PROJECT_ROOT);
}

// Versão dos dados (schemaMeta, A0): quantas migrações este banco tem, a última (com o
// nome do registro) e quantas faltam ou são desconhecidas (só acontece em TEST_MODE: fora
// dele o boot recusa banco de versão mais nova).
function schemaSummary(value) {
    const meta = schemaMigrations.normalizeSchemaMeta(value);
    const plan = schemaMigrations.planSchema(meta);
    const names = new Map(schemaMigrations.registry().migrations.map(row => [row.id, row.nome]));
    const ordered = schemaMigrations.sortApplied(meta.aplicadas);
    const last = ordered.length ? ordered[ordered.length - 1] : null;
    return {
        aplicadas: meta.aplicadas.length,
        ultima: last ? { id: last.id, nome: names.get(last.id) || null, em: Number.isFinite(last.em) ? last.em : null } : null,
        pendentes: plan.pending.length,
        desconhecidas: plan.unknown.length,
    };
}

// A última atualização registrada (schemaMeta.atualizacoes, A0) ou null.
function lastUpdate(value) {
    const updates = schemaMigrations.normalizeSchemaMeta(value).atualizacoes;
    const last = updates.length ? updates[updates.length - 1] : null;
    if (!last) return null;
    return {
        de: typeof last.de === 'string' && last.de ? last.de : null,
        para: typeof last.para === 'string' && last.para ? last.para : null,
        em: Number.isFinite(last.em) ? last.em : null,
        backup: typeof last.backup === 'string' && last.backup ? last.backup : null,
        semBackup: last.semBackup === true,
        instalacaoNova: last.instalacaoNova === true,
        migracoes: Array.isArray(last.migracoes) ? last.migracoes.length : 0,
    };
}

// GET /api/admin/system/about: o cartão "Sobre o IClass" da tela Sistema. Tudo o que o
// suporte pergunta primeiro, num lugar só. As pastas do computador só para o administrador
// pleno (contrato C2 do P4); o resto, para toda conta com page.system.
function systemAbout(account, memory = db.memory) {
    const install = settingsUtil.installSettings(memory && memory.config && memory.config.settings && typeof memory.config.settings === 'object' ? memory.config.settings : {});
    const about = {
        versao: schemaMigrations.appVersion() || null,
        build: buildInfo(),
        modo: installMode(),
        node: process.version,
        plataforma: `${os.type()} ${os.release()} (${process.arch})`,
        esquema: schemaSummary(memory && memory.schemaMeta),
        ultimaAtualizacao: lastUpdate(memory && memory.schemaMeta),
        instalacao: install,
    };
    if (isFullAdmin(account)) {
        about.pastas = {
            programa: runtimePaths.PROJECT_ROOT,
            dados: runtimePaths.DATA_DIR,
            conteudo: runtimePaths.CONTENT_DIR,
            cursosArquivados: runtimePaths.ARCHIVE_DIR,
        };
    }
    return about;
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
// Bloco 'entregas' do POST /api/admin/settings (fase 3, P1 D17): cada limite é um número
// inteiro (a tela manda texto do campo numérico: coerce) dentro de ENTREGAS_LIMITS.
// Campo ausente fica como está; null no bloco inteiro também (nada muda).
const ENTREGAS_SCHEMA = shape(Object.fromEntries(Object.keys(settingsUtil.ENTREGAS_LIMITS).map(key => [
    key,
    int({ coerce: true, min: settingsUtil.ENTREGAS_LIMITS[key].min, max: settingsUtil.ENTREGAS_LIMITS[key].max, label: settingsUtil.ENTREGAS_LABELS[key] }),
])), { label: 'Limites das entregas', nullable: true });

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
    // desligada (studentsHttps, padrão), https quando ligada (H6c), e só nos endereços que
    // estão no certificado (um adaptador virtual continua em http).
    function studentAddresses(req) {
        return networkAddresses({
            port: listeningPort(req),
            scheme: studentsHttpsEnabled() ? 'https' : 'http',
            httpsIps: secureConnection.serverIps(),
        });
    }

    // Conexão segura (H6c) para a tela: se funciona (ou o motivo), se serve aos outros
    // aparelhos (networkReady: o IP recomendado está no certificado; senão, networkError
    // diz por quê e o https vale só neste computador, em localUrl), o endereço seguro, a
    // impressão digital e as validades da CA e do certificado do servidor.
    function httpsPayload(port) {
        const status = secureConnection.status();
        const network = networkHttpsStatus();
        return {
            available: status.available,
            error: status.available ? null : secureConnection.unavailableText(),
            networkReady: network.usable,
            networkError: status.available && !network.usable ? network.reason : null,
            studentsHttps: studentsHttpsEnabled(),
            studentsHttpsSetting: settingsUtil.networkSettings().studentsHttps,
            url: network.usable ? `https://${network.address}:${port}` : null,
            localUrl: status.available ? `https://localhost:${port}` : null,
            ca: status.ca,
            server: status.server,
        };
    }

    // Cartão Rede da tela Sistema (H6a, OPS-10): todos os adaptadores, cada um com o
    // endereço completo (esquema, IP e porta) e o tipo ('rede', 'virtual', 'link-local'),
    // e o recomendado para os alunos; a conexão segura (H6c) em https. hostname (nome
    // fixo, H6d) já vem no formato final, desligado nesta versão.
    router.get('/api/admin/network-info', (req, res) => {
        validateAdmin(req, res, () => {
            const snapshot = studentAddresses(req);
            res.json({
                port: snapshot.port,
                recommended: snapshot.recommended,
                addresses: snapshot.addresses,
                hostname: null,
                https: httpsPayload(snapshot.port),
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

    // Sobre o IClass (A1 / P6-S2): versão, build, modo, Node, versão dos dados, última
    // atualização e a identidade da instalação (page.system; pastas só do administrador).
    router.get('/api/admin/system/about', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            res.set('Cache-Control', 'no-store');
            res.json({ success: true, ...systemAbout(matchedAdmin) });
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
                canCompact: isFullAdmin(matchedAdmin),
                // Arquivos das entregas de tarefa (C11 / P1-i): tamanho, sem registro, os
                // registrados que faltam aqui e a cópia no destino externo (sem o caminho).
                entregas: await assignmentStorageSummary(matchedAdmin),
            });
        });
    });

    // Compactar o banco (VACUUM): só administrador, com COMPACTAR digitado, sem prova em
    // andamento (o VACUUM para a fila de gravação por alguns segundos) e com espaço no
    // disco. Grava a auditoria 'storage_compacted' com o tamanho antes e depois.
    router.post('/api/admin/storage/compact', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!isFullAdmin(matchedAdmin)) {
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
        validateAdmin(req, res, (config, matchedAdmin) => {
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
                // As versões da prova levam o gabarito: só para quem prepara prova
                // (page.exams). O Professor auxiliar, a Secretaria e a Coordenação recebem a
                // configuração sem elas, como em GET /classes (B1, papel "sem notas").
                responseData.onlineExamConfigs = canReadExamVersions(matchedAdmin)
                    ? (cls.onlineExamConfigs || {})
                    : onlineExamConfigsWithoutAnswerKeys(cls.onlineExamConfigs || {});
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
            const backup = await safetyBackup('antes-limpeza-prova');
            if (backup.busy) return sendRouteError(backup.error, req, res);
            if (!backup.ok) return sendHandledFailure(backup.error, req, res, 'Não foi possível salvar o backup de segurança; nada foi apagado.');
            // O backup roda sem travar o servidor: o plano é refeito com o estado de agora
            // (uma prova pode ter começado na turma enquanto ele era gravado).
            const current = planExamStateFlush(db.memory, { cls, application, examKey, studentEmail, ...classHelpers(cls) });
            if (current.blockedBy.length) {
                const names = current.blockedBy.map(item => item.examTitle).join(', ');
                return res.status(409).json({
                    error: `Há uma aplicação em andamento nesta turma (${names}). Encerre-a pelo Monitor antes de limpar o estado de prova.`,
                    blockedBy: current.blockedBy,
                });
            }
            const removed = applyExamStateFlush(db.memory, current);
            recordMaintenanceAudit(req, matchedAdmin, 'exam_state_flushed', cls, {
                applicationId: current.applicationId,
                examKey: current.examKey || (examKey ? String(examKey) : null),
                studentEmail: current.studentEmail,
                ...removed,
                pendingAnswers: current.counts.pendingAnswers,
                preserved: current.preserved,
                backup: backup.file,
            });
            await db.save();
            console.log(`[FLUSH] Estado de prova limpo na turma ${cls.name}: ${current.counts.examStates + current.counts.messages} registros removidos.`);
            res.json({
                success: true,
                clearedCount: current.counts.examStates + current.counts.messages,
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
            const backup = await safetyBackup('antes-resetar-sala');
            if (backup.busy) return sendRouteError(backup.error, req, res);
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

    // Rede (SEG-03): quem abre o painel do professor em outros aparelhos (adminAccess) e
    // se os alunos entram pela conexão segura (studentsHttps, H6c). Só o administrador
    // troca (o professor recebe 403 mesmo com system.manage), com registro na auditoria.
    // O POST genérico de configurações nunca mexe neste bloco (PROTECTED_SETTINGS_SECTIONS
    // em utils/settings.js).
    function networkSettingsPayload(req) {
        const connection = connectionInfo(req);
        const network = networkHttpsStatus();
        return {
            ...settingsUtil.networkSettings(),
            modes: settingsUtil.ADMIN_ACCESS_MODES,
            httpsAvailable: httpsAvailable(),
            // Serve aos outros aparelhos (o IP recomendado está no certificado)? É o que
            // libera 'rede' e studentsHttps; httpsError diz por que não.
            httpsReady: network.usable,
            httpsError: network.usable ? null : network.reason,
            httpsUrl: connection.httpsUrl,
            thisComputer: connection.thisComputer,
            secure: connection.secure,
        };
    }

    // Provas em andamento (aberta ou pausada), pelo nome, para a recusa de trocar o https
    // dos alunos: a troca muda o endereço, e quem está com a prova aberta perderia a sessão.
    function activeApplicationTitles() {
        return (db.memory.examApplications || [])
            .filter(item => item && ACTIVE_APPLICATION_STATUSES.has(item.status))
            .map(item => {
                const title = item.title || item.examTitle || examTitleFor(item.examKey);
                return item.studentClass ? `${title} (${item.studentClass})` : title;
            });
    }

    router.get('/api/admin/network-settings', (req, res) => {
        validateAdmin(req, res, () => res.json(networkSettingsPayload(req)));
    });

    router.post('/api/admin/network-settings', (req, res) => {
        validateAdmin(req, res, async (config, account) => {
            if (!isFullAdmin(account)) {
                return res.status(403).json({ error: 'Só o administrador pode mudar as configurações de rede.' });
            }
            const body = req.body || {};
            const hasAccess = body.adminAccess !== undefined;
            const hasStudents = body.studentsHttps !== undefined;
            if (!hasAccess && !hasStudents) {
                return res.status(400).json({ success: false, error: 'Escolha onde o painel do professor pode abrir.', field: 'adminAccess' });
            }
            if (hasAccess && (typeof body.adminAccess !== 'string' || !settingsUtil.ADMIN_ACCESS_MODES.includes(body.adminAccess))) {
                return res.status(400).json({ success: false, error: 'Escolha onde o painel do professor pode abrir.', field: 'adminAccess' });
            }
            if (hasStudents && typeof body.studentsHttps !== 'boolean') {
                return res.status(400).json({ success: false, error: 'Diga se os alunos entram pela conexão segura (sim ou não).', field: 'studentsHttps' });
            }
            const before = settingsUtil.networkSettings();
            const after = {
                adminAccess: hasAccess ? body.adminAccess : before.adminAccess,
                studentsHttps: hasStudents ? body.studentsHttps : before.studentsHttps,
            };
            // 'rede' e os alunos pelo https só com a conexão segura funcionando para os
            // outros aparelhos: o certificado existe E tem o IP recomendado. Com a rede da
            // escola fora das faixas locais, o https por IP não abriria em aparelho nenhum.
            const network = (hasAccess || hasStudents) ? networkHttpsStatus() : { usable: true };
            // Com a CA funcionando mas o IP da rede fora do certificado (faixa que não é
            // local, adaptador virtual), o https existe só neste computador: a recusa diz
            // isso e onde conferir, em vez de parecer que a conexão segura não existe
            // (decisões §12, sobra do H6c).
            const onlyHere = !network.usable && httpsAvailable()
                ? ' Agora a conexão segura só funciona neste computador (https://localhost). Confira o endereço da rede em Sistema → Rede e escolha de novo quando ele aparecer como endereço seguro.'
                : '';
            const why = network.usable ? '' : ` ${network.reason}${onlyHere}`;
            if (hasAccess && after.adminAccess === 'rede' && before.adminAccess !== 'rede' && !network.usable) {
                return res.status(409).json({
                    success: false,
                    field: 'adminAccess',
                    error: `A opção "Outros aparelhos só com conexão segura" precisa da conexão segura (https) funcionando para os outros aparelhos da rede.${why} Por enquanto, escolha "Todos os aparelhos da rede" ou "Só o computador do IClass".`,
                });
            }
            if (hasStudents && after.studentsHttps && !before.studentsHttps && !network.usable) {
                return res.status(409).json({
                    success: false,
                    field: 'studentsHttps',
                    error: `Os alunos só podem entrar pela conexão segura com ela funcionando para os outros aparelhos da rede.${why}`,
                });
            }
            if (after.studentsHttps !== before.studentsHttps) {
                // A troca muda o endereço dos alunos (http e https não dividem a sessão no
                // navegador): com prova em andamento, a turma inteira teria de entrar de novo.
                const active = activeApplicationTitles();
                if (active.length) {
                    return res.status(409).json({
                        success: false,
                        field: 'studentsHttps',
                        error: `Há prova em andamento: ${active.join('; ')}. Troque a conexão dos alunos depois que as provas terminarem (ao trocar, quem estiver com o IClass aberto precisa entrar de novo).`,
                        activeApplications: active,
                    });
                }
            }
            const changes = ['adminAccess', 'studentsHttps'].filter(key => before[key] !== after[key]);
            if (!changes.length) {
                return res.json({ success: true, unchanged: true, network: networkSettingsPayload(req) });
            }
            if (!db.memory.config) db.memory.config = {};
            const settings = db.memory.config.settings && typeof db.memory.config.settings === 'object' ? db.memory.config.settings : {};
            const storedNetwork = settings.network && typeof settings.network === 'object' ? settings.network : {};
            // Só os campos que mudaram são gravados; o resto do bloco (inclusive campos que
            // esta versão não conhece) fica como estava.
            const patch = Object.fromEntries(changes.map(field => [field, after[field]]));
            db.memory.config.settings = { ...settings, network: { ...storedNetwork, ...patch } };
            // Uma entrada por campo que mudou (campo, antes e depois), como as da tela.
            changes.forEach(field => {
                recordAudit(db.memory, {
                    req,
                    actor: account,
                    action: 'network_settings_changed',
                    category: 'system',
                    field,
                    oldValue: before[field],
                    newValue: after[field],
                    before: { [field]: before[field] },
                    after: { [field]: after[field] },
                });
            });
            await db.save();
            res.json({ success: true, network: networkSettingsPayload(req) });
        });
    });

    // O caminho do destino externo do backup (settings.backup.destino, H4b) é só do
    // administrador, como em GET /api/admin/backup/status: o professor vê que há um
    // destino, não onde.
    const settingsForAccount = (settings, account) => (!isFullAdmin(account) && settings && settings.backup && settings.backup.destino
        ? { ...settings, backup: { ...settings.backup, destino: '' } }
        : settings);

    router.get('/api/admin/settings', (req, res) => {
        validateAdmin(req, res, (config, account) => res.json(settingsForAccount(settingsUtil.getSettings(), account)));
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
            // O prazo da lixeira faz parte da retenção (H8b, SEG-13): o administrador grava
            // em POST /api/admin/lgpd/retention. Aqui o professor não muda (sem erro: o
            // resto do pedido vale) e o administrador ainda muda, como antes.
            const patch = { ...(req.body && typeof req.body === 'object' ? req.body : {}) };
            if (!isFullAdmin(account)) delete patch.trash;
            // Limites das entregas de tarefa (fase 3, P1 D17): entrada nova, validada pelo
            // schema (número inteiro na faixa de cada campo) e pela combinação (teto do
            // upload, envio nunca menor que um arquivo). Recusa = 400 com field, nada gravado.
            if (patch.entregas !== undefined) {
                const checked = ENTREGAS_SCHEMA.run(patch.entregas, 'entregas', 'entregas');
                if (!checked.ok) return res.status(400).json({ success: false, error: checked.error, field: checked.field });
                if (checked.value === null) delete patch.entregas;
            }
            const next = settingsUtil.mergeSettings(patch);
            const combination = settingsUtil.entregasPatchError(patch.entregas, { before: before.entregas, next });
            if (combination) return res.status(400).json({ success: false, error: combination.error, field: combination.field });
            db.memory.config.settings = next;
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
            // entregas na resposta como no GET (com o teto do upload na leitura): a tela vê o
            // mesmo número nos dois.
            const saved = { ...db.memory.config.settings, entregas: settingsUtil.getSettings().entregas };
            res.json({ success: true, settings: settingsForAccount(saved, account) });
        });
    });

    return router;
}

module.exports = { createAdminSystemRouter, systemAbout };
