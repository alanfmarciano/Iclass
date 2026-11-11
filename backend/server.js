const childProcess = require('child_process');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const path = require('path');
const db = require('./database.js');
const settingsUtil = require('./utils/settings.js');
const { parseEvaluationMarkdown } = require('./utils/parser.js');
const runtimePaths = require('./runtimePaths.js');
const { resolveInside } = require('./utils/safePath.js');
const { BUILD_ID_HEADER, currentBuildId, verifyBuild } = require('./utils/buildIntegrity.js');
const { localIpAddresses, studentBelongsToClass, getReleasedItemsForClass, isProfessorAccount, resolveAdminSession, assignRequestId } = require('./middlewares.js');
const { crashLogPath, logError } = require('./utils/errorLog.js');
const { safeImageSegments, studentHasApprovedClass, uploadReferencedInReleasedContent, uploadAttachedToContent } = require('./utils/contentMedia.js');
const { fileLooksLikeBackup } = require('./utils/backup.js');
const { studentCanDownloadLibraryFile } = require('./utils/studentLibrary.js');
const { createPersistenceContext } = require('./utils/persistenceContext.js');
const { checkAdminSessionToken, checkStudentSessionToken, restoreSessions } = require('./utils/authSessions.js');
const { SERVER_INSTANCE_ID, SESSION_RESUME_MAX_DOWNTIME_MS } = require('./utils/sessionConfig.js');
const { compressTextResponses } = require('./utils/httpCompression.js');
const { serveBuildAssets, sendAssetNotFound, setNoStore } = require('./utils/staticAssets.js');
const serverLifecycle = require('./utils/serverLifecycle.js');
const { SYNCED_FOLDER_WARNING } = require('./utils/syncedFolder.js');
const { createNetworkPolicy } = require('./utils/networkPolicy.js');

// Registro de falhas do servidor: o único é utils/errorLog.js (data/crash.log, 5 MB), e o
// stack inteiro também vai para o console (janela do launcher). Os tratadores de exceção
// não tratada e os sinais são instalados pelo startServer (installProcessHandlers, H3c),
// não no carregamento do módulo: os testes que só importam o createApp não os ganham.
function logCrash(kind, err) {
    logError(kind, err, { printStack: true });
}

// Corpo JSON: até 10 MB só para o instrutor com sessão válida (apostila com imagem
// embutida). Aluno, rotas públicas e o login legado ficam com 512 KB: o maior corpo
// legítimo do aluno (lote de 500 teclas) fica abaixo de 100 KB, e um aparelho da rede
// sem login não manda mais 10 MB por pedido (ENG-03). O lote de teclas da prova também:
// desde o H2-C o ExamRunner manda no máximo 500 teclas por envio e envia o resto em
// seguida, então a exceção de 10 MB que ele tinha saiu.
const ADMIN_JSON_LIMIT = '10mb';
const DEFAULT_JSON_LIMIT = '512kb';

// Query string com parâmetro repetido (?email=a&email=b) vira o último valor, sempre
// texto: com a lista, 9 rotas do professor respondiam 500 ao chamar .trim() (ENG-03).
// Mesma forma do leitor 'simple' do Express 5 (objeto sem protótipo, sem aninhamento).
function parseQueryLastValue(queryString) {
    const out = Object.create(null);
    if (!queryString) return out;
    for (const [key, value] of new URLSearchParams(String(queryString))) out[key] = value;
    return out;
}

const PORT = process.env.PORT || 3000;

// Só nos testes: options.network = { isThisComputer, isSecure, httpsUrl } (ou só
// options.isThisComputer) troca as regras da política de acesso do painel do professor
// (utils/networkPolicy.js): o supertest sempre conecta pelo loopback e sem cifra.
function createApp(options = {}) {
const app = express();
const { errorHandler, adminRbacGuard } = require('./middlewares.js');
app.set('query parser', parseQueryLastValue);
// 1) Código do pedido (X-Request-Id e "Código do erro" no 500), antes de tudo.
app.use(assignRequestId);
// CORS restrito: a app é servida na mesma origem (Express serve o build React),
// então só liberamos requisições sem Origin (mesma origem/apps nativos) e de
// hosts locais/LAN. Bloqueia sites arbitrários da internet.
app.use(cors({
    origin(origin, cb) {
        if (!origin) return cb(null, true);
        try {
            const host = new URL(origin).hostname;
            const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
                || /^10\./.test(host) || /^192\.168\./.test(host)
                || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
            return cb(null, isLocal);
        } catch { return cb(null, false); }
    },
}));
// Versão do build servido em toda resposta da API (inclusive 401 e erros): o navegador
// com o bundle de antes de uma atualização recarrega sozinho (utils/buildIntegrity.js).
app.use('/api', (req, res, next) => {
    const buildId = currentBuildId();
    if (buildId) res.set(BUILD_ID_HEADER, buildId);
    next();
});
// 5) Cache por tipo de resposta (H2-A, DES-05): a API e o index.html sempre frescos (a
// recarga automática depois de uma atualização depende disso); os arquivos do app em
// /assets, com hash no nome, ficam no aparelho (serveBuildAssets, mais abaixo). Rota que
// define o próprio Cache-Control continua definindo (vem depois).
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});
// .html e .js fora de /assets (/data.js, /index.html): sem cache, como antes.
app.use((req, res, next) => {
    if (/^\/assets\//i.test(req.path)) return next();
    if (req.path.endsWith('.html') || req.path.endsWith('.js')) setNoStore(res);
    next();
});
// 6) Respostas de texto acima de 1 KB em gzip (H2-A, DES-13): JSON da API, data.js,
// apostilas .md e CSV. Fica ANTES do persistenceContext (H1-a): o envio dele, que espera
// o COMMIT e troca a resposta pelo 503, roda primeiro, e a compressão só vê o que sai.
app.use(compressTextResponses({ minBytes: 1024, maxBytes: 32 * 1024 * 1024, level: 6 }));
const adminJsonParser = express.json({ limit: ADMIN_JSON_LIMIT });
const defaultJsonParser = express.json({ limit: DEFAULT_JSON_LIMIT });
function jsonParserFor(req) {
    if (resolveAdminSession(req)) return adminJsonParser;
    return defaultJsonParser;
}
app.use((req, res, next) => jsonParserFor(req)(req, res, next));
// Corpo sempre objeto: sem corpo, o Express 5 deixava req.body undefined e as rotas que
// leem req.body.x respondiam 500 ou ficavam sem resposta. O express.text de
// /api/student/leave e o multer continuam lendo o corpo (eles olham o fluxo, não o campo).
app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
});
// 8) Resposta só depois do COMMIT (H1-a, CONF-04): toda gravação pedida durante o pedido
// (db.save com ou sem await) é esperada antes de res.send; se falhou, sai 503 retryable
// em vez do "salvo". Antes de qualquer rota ou guarda. A foto da memória é do
// verificador de gravação parcial (ICLASS_VERIFY_SAVES).
app.use(createPersistenceContext({
    snapshot: () => db.captureSaveSnapshot(),
    onWriteFailure: (err, req, res) => errorHandler(err, req, res, () => {}),
}));
// 9) Painel do professor conforme o aparelho (H6b, SEG-03): settings.network.adminAccess
// decide se outro aparelho da rede abre o painel. Antes de /assets, dos arquivos
// (/uploads com ?access= de professor) e de qualquer rota de professor.
app.use(createNetworkPolicy({
    ...(options.network && typeof options.network === 'object' ? options.network : {}),
    ...(typeof options.isThisComputer === 'function' ? { isThisComputer: options.isThisComputer } : {}),
}));
// 10) Arquivos do app (/assets), antes de /uploads, /imagens e do express.static: o
// handler é terminal, com cache imutável e as versões .br/.gz do build; nome que não
// existe é 404 com no-store, nunca o index.html (utils/staticAssets.js, H2-A, DES-05).
// Build da nova interface React (Vite -> web/dist). Em desenvolvimento o Vite roda em
// :5173 com proxy para /api; para uso local normal, rode `npm run build` na pasta web/
// e o Express entrega tudo aqui.
const WEB_DIST = runtimePaths.WEB_DIST_DIR;
app.use('/assets', serveBuildAssets(WEB_DIST));

// Extensões que nunca saem como arquivo (viram vetor de script ou executável).
const BLOCKED_FILE_EXTENSIONS = ['.html', '.htm', '.js', '.mjs', '.exe', '.bat', '.cmd', '.ps1'];
const INLINE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
// Formatos de arquivo de backup: em /uploads, quem não é administrador só os recebe
// quando o conteúdo não é um backup (e, o professor, ligados ao conteúdo).
const BACKUP_FILE_EXTENSIONS = ['.json', '.zip'];

// `relativePath` já validado: um nome (uploads) ou segmentos de subpasta (imagens).
async function sendControlledFile(baseDir, relativePath, req, res) {
    let target;
    try {
        target = resolveInside(baseDir, relativePath);
    } catch (e) {
        return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const filename = path.basename(target);
    // `?access=` repetido (link antigo com a sessão do instrutor gravada na apostila):
    // vale o último, que é o que o navegador do usuário acrescentou.
    const queryAccess = Array.isArray(req.query.access) ? req.query.access[req.query.access.length - 1] : req.query.access;
    const accessToken = String(req.get('x-admin-session') || req.get('x-session-token') || queryAccess || '');
    // Só sessão gravada, dentro do prazo e de conta que existe (utils/authSessions.js):
    // '?access=__proto__' entregava arquivo protegido, e o token de instrutor vencido ou
    // de conta apagada continuava abrindo arquivo. O aluno precisa de conta ativa.
    const now = Date.now();
    const adminCheck = accessToken ? checkAdminSessionToken(accessToken, now) : null;
    const adminSession = adminCheck && adminCheck.ok ? adminCheck.session : null;
    const studentCheck = accessToken && !adminSession ? checkStudentSessionToken(accessToken, now) : null;
    const studentEmail = studentCheck && studentCheck.ok ? studentCheck.email : undefined;
    const publicBrandingFile = baseDir === runtimePaths.UPLOADS_DIR && Object.values(db.memory.branding || {}).some(value => {
        if (typeof value !== 'string' || !value.startsWith('/uploads/')) return false;
        return path.basename(value.split('?')[0]) === filename;
    });
    if (!adminSession && !studentEmail && !publicBrandingFile) return res.status(401).json({ error: 'Autenticação necessária para acessar este arquivo.' });
    const ext = path.extname(target).toLowerCase();
    // SVG só das imagens do conteúdo (content/imagens); enviado pelo usuário, não.
    const isContentImage = baseDir !== runtimePaths.UPLOADS_DIR;
    if (BLOCKED_FILE_EXTENSIONS.includes(ext) || (ext === '.svg' && !isContentImage)) {
        return res.status(415).json({ error: 'Este formato não pode ser servido pela aplicação.' });
    }
    if (!isContentImage && BACKUP_FILE_EXTENSIONS.includes(ext)) {
        // SEG-X1: um .json/.zip em /uploads pode ser o banco inteiro (backup que voltou
        // da lixeira) com os hashes das senhas; só o administrador baixa esse arquivo.
        // A decisão é pelo conteúdo: o professor cria o vínculo sozinho (estrutura da
        // turma ou link de material com '/uploads/<nome>.json'), então o vínculo não basta.
        const sessionEmail = adminSession ? String(adminSession.email || '').toLowerCase() : '';
        const account = sessionEmail ? (db.memory.admins || []).find(item => item && item.email && item.email.toLowerCase() === sessionEmail) : null;
        const isAdministrator = !!account && !isProfessorAccount(account);
        if (!isAdministrator) {
            let backupLike = true;
            try { backupLike = await fileLooksLikeBackup(target); } catch (error) { backupLike = true; }
            if (backupLike || (adminSession && !uploadAttachedToContent(filename))) {
                return res.status(403).json({ error: 'Arquivo disponível só para o administrador.' });
            }
        }
    }
    if (studentEmail && !adminSession && !publicBrandingFile) {
        const student = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === studentEmail.toLowerCase());
        if (isContentImage) {
            // Imagens das apostilas: aluno com matrícula aprovada (UXA-09).
            if (!studentHasApprovedClass(student, studentBelongsToClass)) return res.status(403).json({ error: 'Arquivo não disponível para alunos.' });
        } else {
            const libraryFile = (db.memory.library || []).some(item => item && item.filename === filename);
            if (libraryFile) {
                // Mesma regra da listagem da biblioteca: turma do item ('class') e itens ocultos.
                const allowed = studentCanDownloadLibraryFile({
                    student, filename, library: db.memory.library, classes: db.memory.classes, belongsToClass: studentBelongsToClass,
                });
                if (!allowed) return res.status(403).json({ error: 'Arquivo fora dos materiais da sua turma.' });
            } else {
                // Upload sem item de biblioteca só sai para o aluno quando é imagem citada
                // numa apostila liberada para a turma dele (imagem inserida pelo editor,
                // UXA-X2). Sem esse guard, qualquer upload era servido a qualquer aluno.
                const allowed = INLINE_IMAGE_EXTENSIONS.includes(ext) && await uploadReferencedInReleasedContent({
                    student, studentEmail, filename, studentBelongsToClass, getReleasedItemsForClass,
                });
                if (!allowed) return res.status(403).json({ error: 'Arquivo não disponível para alunos.' });
            }
        }
    }
    const inline = INLINE_IMAGE_EXTENSIONS.includes(ext) || ext === '.svg'
        || (ext === '.pdf' && req.query.preview === '1');
    res.set('X-Content-Type-Options', 'nosniff');
    // sandbox + default-src 'none': um SVG aberto direto na aba não roda script.
    res.set('Content-Security-Policy', ext === '.svg'
        ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox"
        : "default-src 'none'; sandbox");
    res.set('Cache-Control', 'private, no-store');
    if (!inline) res.set('Content-Disposition', `attachment; filename="${filename.replace(/["\r\n]/g, '_')}"`);
    res.type(ext === '.svg' ? 'image/svg+xml' : (ext || 'application/octet-stream'));
    return res.sendFile(target);
}

app.get('/uploads/:filename', (req, res) => {
    const filename = String(req.params.filename || '');
    if (!filename || path.basename(filename) !== filename) return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
    return sendControlledFile(runtimePaths.UPLOADS_DIR, filename, req, res);
});
// As apostilas citam imagens em subpastas (imagens/fecop/cap1/x.svg).
app.get('/imagens/*path', (req, res) => {
    const segments = safeImageSegments(req.params.path);
    if (!segments) return res.status(400).json({ error: 'Caminho de arquivo inválido.' });
    return sendControlledFile(path.join(runtimePaths.CONTENT_DIR, 'imagens'), segments.join('/'), req, res);
});
// IclassV3: o resto da raiz do build (web/dist) sai pelo express.static, sem servir o
// index.html sozinho: quem entrega o index é o fallback do app, sempre com no-store.
app.use(express.static(WEB_DIST, { index: false }));


// Carregar os Roteadores Modulares
const commonRoutes = require('./routes/common.js');
const studentRoutes = require('./routes/student.js');
const adminRoutes = require('./routes/admin.js');

// Registrar Rotas no Express
const proctoringRoutes = require('./routes/proctoring.js');
// Modo manutenção: quando ligado nas Configurações, bloqueia o acesso do ALUNO
// (login e APIs do aluno). O painel do instrutor segue funcionando para desligar.
app.use((req, res, next) => {
    const st = settingsUtil.getSettings();
    const adminToken = String(req.get('x-admin-session') || '');
    // Sessão de instrutor gravada, no prazo e de conta que existe (utils/authSessions.js).
    const isAuthenticatedAdmin = !!adminToken && checkAdminSessionToken(adminToken).ok;
    const isStudentFlow = req.path.startsWith('/api/student') || req.path.startsWith('/api/forum')
        || req.path === '/api/ping' || req.path === '/data.js' || req.path === '/api/data.js'
        || (/^\/[^/]+\.md$/.test(req.path) && !isAuthenticatedAdmin);
    if (isStudentFlow && st.maintenance && st.maintenance.enabled && !isAuthenticatedAdmin) {
        return res.status(503).json({ error: st.maintenance.message || 'Sistema em manutenção.', maintenance: true });
    }
    next();
});

// Camada 5.3: toda rota /api/admin exige autenticação, capability e escopo.
app.use('/api/admin', adminRbacGuard);
app.use(proctoringRoutes);
// Modo teste (ativo só com TEST_MODE=1)
const testRoutes = require('./routes/testmode.js');
app.use(testRoutes);
const setupModeRoutes = require('./routes/setupMode.js');
app.use(setupModeRoutes);
app.use(commonRoutes);
// Termos e Privacidade (H8a-1): rotas públicas e, no H8a-2, as do aluno; antes das do aluno.
app.use(require('./routes/privacy.js'));
app.use(studentRoutes);
app.use(adminRoutes);

// Fallback SPA: qualquer rota que não seja /api ou /uploads devolve o index.html
// da nova interface, e o React Router resolve a navegação (instrutor/aluno). Também
// atende '/'. O index.html sai sempre com no-store: é ele que aponta para os arquivos
// do build atual. /assets nunca chega aqui (o handler de lá é terminal); se chegasse,
// o HTML ficaria gravado como .js no cache imutável.
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/imagens')) return next();
    if (req.path === '/assets' || req.path.startsWith('/assets/')) return sendAssetNotFound(res);
    setNoStore(res);
    res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
        if (!err || res.headersSent) return;
        // Build sendo refeito com o servidor ligado (o Vite esvazia web/dist antes de
        // gravar): pede para tentar de novo em instantes, em vez de um erro.
        if (err.code === 'ENOENT' || err.status === 404 || err.statusCode === 404) {
            res.set('Retry-After', '3');
            return res.status(503).type('text/plain').send('O IClass está sendo atualizado. Recarregue a página em instantes.');
        }
        next(err);
    });
});

// Registrar o middleware global de tratamento de erros
app.use(errorHandler);

return app;
}

// Retomada das sessões gravadas (passo 3 do boot), com o tempo fora do ar do heartbeat da
// execução anterior. Sem heartbeat (primeiro boot desta versão, pasta runtime apagada) o
// tempo é desconhecido e nenhuma volta. Outro servidor ainda no ar nesta pasta: o tempo é
// o do heartbeat dele (segundos), e este processo não grava nada por causa da retomada.
// Devolve { students, admins, dropped, reason, clockWentBack, otherInstanceAlive }.
function resumeSessions(run) {
    const rows = db.takeBootAuthSessionRows();
    const downtimeMs = run && run.found ? run.downtimeMs : null;
    const result = restoreSessions(db.memory, rows, {
        now: Date.now(),
        downtimeMs,
        setupMode: process.env.ICLASS_ADMIN_SETUP_MODE === '1',
    });
    result.otherInstanceAlive = !!(run && run.otherInstanceAlive);
    if (!rows.length) return result;
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    if (result.reason === 'downtime_unknown') {
        console.log(`🔑 Sessões não retomadas: não há registro de quando o servidor parou (runtime/heartbeat.json). Alunos e professores entram de novo (${plural(result.dropped, 'sessão descartada', 'sessões descartadas')}).`);
    } else if (result.reason === 'downtime_too_long') {
        console.log(`🔑 Sessões não retomadas: o servidor ficou mais de ${Math.round(SESSION_RESUME_MAX_DOWNTIME_MS / 60000)} min fora do ar. Alunos e professores entram de novo (${plural(result.dropped, 'sessão descartada', 'sessões descartadas')}).`);
    } else {
        console.log(`🔑 Sessões retomadas: ${plural(result.students, 'aluno', 'alunos')} e ${plural(result.admins, 'professor', 'professores')} (${plural(result.dropped, 'descartada', 'descartadas')}).`);
    }
    return result;
}

// Estado do servidor antes de atender (H3b, ordem do boot): banco, tempo fora do ar,
// sessões, migração do fórum, lixeira, devolução do tempo das provas em andamento,
// gravação, primeira varredura do fim do tempo e heartbeat, nesta ordem. A devolução vem
// antes da varredura: sem ela, quem teve o prazo vencido enquanto o servidor estava fora
// do ar era entregue automaticamente logo no boot. Separado do startServer para os
// testes subirem o mesmo boot sem o build e sem abrir a porta.
async function prepareServer() {
    // 1) Banco (carga e migrações). A falha aqui sai com o código próprio (H3c,
    // describeBootFailure): banco danificado 3, as outras 1 (o supervisor tenta de novo).
    serverLifecycle.setBootPhase('loading');
    try {
        await db.init();
    } catch (err) {
        if (err && typeof err === 'object') err.bootStage = 'database';
        throw err;
    }
    serverLifecycle.setBootPhase('restoring');
    // Restauração de backup interrompida no meio (o processo caiu durante o applyRestore;
    // decisões §12): o marcador em data/.restauracao/desfazer está lá, e tudo volta ao que
    // era antes dela (banco, teclas, pastas e cursos arquivados), com o registro na
    // auditoria e no crash.log. Antes de tudo o que lê a memória (sessões, provas).
    await require('./utils/backup.js').recoverInterruptedRestore();
    // Pasta de dados dentro do OneDrive (H1-c, CONF-05): aviso no console (e no cartão
    // Armazenamento da tela Sistema).
    if (db.storageStatus().inSyncedFolder) console.warn(`⚠️ ${SYNCED_FOLDER_WARNING}`);
    // 2) Quanto tempo o servidor ficou fora do ar: o heartbeat da execução anterior.
    serverLifecycle.loadPreviousRun();
    // 3) Sessões de aluno e de instrutor gravadas em auth_sessions (H3a-2): voltam depois
    // de um reinício rápido, e ninguém precisa entrar de novo. Ficam de fora (como antes
    // desta versão, todos entram de novo) quando o servidor ficou mais de 60 min fora do ar
    // (desligado entre turnos) ou não se sabe quanto tempo ficou (sem heartbeat), e a
    // sessão com mais que o prazo absoluto (8 h) ou do acesso rápido local sem o modo
    // setup (utils/authSessions.js restoreSessions).
    const sessions = resumeSessions(serverLifecycle.previousRun());
    if (sessions.dropped && !sessions.otherInstanceAlive) {
        // As que não voltaram saem da tabela já no boot: senão um reinício rápido logo
        // depois (sem nenhuma gravação no meio) as traria de volta. Falha de gravação não
        // impede o boot: o motor regrava sozinho.
        try { await db.save(); } catch (e) { if (!e || e.code !== 'ICLASS_DB_WRITE') logCrash('retomada das sessões', e); }
    }

    // 4) Garante IDs e e-mails de autor consistentes no fórum (migração automática)
    if (db.memory && db.memory.forum) {
        let migrated = false;
        db.memory.forum.forEach(comment => {
            if (!comment.id) {
                comment.id = 'comment_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
                migrated = true;
            }
            if (comment.replies) {
                comment.replies.forEach((reply, idx) => {
                    if (!reply.id) {
                        reply.id = 'reply_' + (Date.now() + idx) + '_' + Math.random().toString(36).substr(2, 5);
                        migrated = true;
                    }
                    if (!reply.authorEmail) {
                        reply.authorEmail = reply.authorRole === 'Instrutor' ? db.defaultAdminEmail() : (comment.studentEmail || '');
                        migrated = true;
                    }
                });
            }
        });
        if (migrated) {
            db.save();
        }
    }

    // 5) Varredura da lixeira conforme a retenção configurada (boot + a cada 6h).
    const _fileStore = require('./utils/storage.js');
    function sweepTrash() { try { const n = _fileStore.purgeTrash(settingsUtil.getSettings().trash.retentionDays); if (n) console.log('🗑️  Lixeira: ' + n + ' item(ns) antigos removidos.'); } catch (e) {} }
    sweepTrash();
    serverLifecycle.registerTimer('trash', setInterval(sweepTrash, 6 * 3600000));

    // 6) e 7) O tempo em que o servidor ficou fora do ar (do último heartbeat até agora)
    // vira pausa das provas em andamento, até 15 min (utils/serverLifecycle.js), e é
    // gravado antes da primeira varredura. Falha de gravação não impede o boot: a memória
    // já tem a pausa e o motor regrava sozinho.
    const outage = serverLifecycle.compensateBootOutage(db.memory);
    if (outage.changed) {
        try { await db.save(); } catch (e) { if (!e || e.code !== 'ICLASS_DB_WRITE') logCrash('tempo fora do ar das provas', e); }
    }

    // 8) Fim do tempo das provas: tentativa vencida sem envio vira entrega com as últimas
    // respostas salvas, mesmo que o aluno nunca mais sincronize (sem rede, sem bateria).
    // No boot também recupera tentativas 'expired' deixadas por versões antigas.
    const { settleExpiredAttempts } = require('./utils/examDeadline.js');
    function sweepExpiredAttempts() {
        try {
            // Computador suspenso ou processo parado desde a última volta: o tempo parado
            // é devolvido antes de qualquer tentativa ser finalizada.
            serverLifecycle.detectGap(Date.now());
            const { finalized, discarded, changed } = settleExpiredAttempts(db.memory);
            const recovered = finalized.filter(item => item.recoveredAfterFinish).length;
            if (finalized.length > recovered) console.log('⏱️  Fim do tempo: ' + (finalized.length - recovered) + ' tentativa(s) entregue(s) automaticamente.');
            // Tentativas sem entrega deixadas por versões antigas em aplicações já encerradas:
            // viram entregas "em revisão", avisadas no "Precisa de você" e no sino.
            if (recovered) console.log('⏱️  Recuperada(s) ' + recovered + ' tentativa(s) com tempo esgotado de aplicação já encerrada. Confira em Resultados (em revisão).');
            // Sobras de versões antigas em aplicação encerrada com "desconsiderar": ficam
            // registradas como desconsideradas (com as respostas), nunca "em instantes".
            if (discarded) console.log('⏱️  ' + discarded + ' tentativa(s) antiga(s) de aplicação encerrada com "desconsiderar" registrada(s) como desconsiderada(s).');
            // Tarefa de fundo: { detached: true }. Falha de gravação já vai para o
            // crash.log pelo motor (uma linha por minuto) e é regravada sozinha.
            if (changed) db.save({ detached: true }).catch(err => { if (!err || err.code !== 'ICLASS_DB_WRITE') logCrash('finalização de tentativas vencidas', err); });
        } catch (e) { logCrash('finalização de tentativas vencidas', e); }
    }
    serverLifecycle.setBootPhase('checking');
    sweepExpiredAttempts();
    serverLifecycle.registerTimer('exam-deadline-sweep', setInterval(sweepExpiredAttempts, 10000));

    // 9) Heartbeat a cada 5 s (runtime/heartbeat.json) e, com ele, a verificação de tempo
    // parado antes das contas de prazo. Começa depois da devolução do tempo do boot.
    serverLifecycle.startHeartbeat({
        getMemory: () => db.memory,
        save: () => db.save({ detached: true }),
    });

    // Rede de segurança da gravação parcial (H1-c, DES-01): de 10 em 10 min, uma gravação
    // completa quando houve gravação parcial desde a última (database.js runSafetyNetSave).
    serverLifecycle.registerTimer('save-safety-net', setInterval(() => {
        db.runSafetyNetSave().catch(err => logCrash('rede de segurança da gravação', err));
    }, db.SAFETY_NET_INTERVAL_MS));

    // Pastas de trabalho do backup e da restauração deixadas por uma execução interrompida
    // (cópia do banco, envios e prévias extraídas) saem no boot, e uma troca de pasta
    // interrompida no meio volta ao que era (H4a). Os tokens de prévia ficam na memória:
    // os vencidos (1 h) saem de hora em hora, com a pasta da prévia.
    const backupUtil = require('./utils/backup.js');
    backupUtil.cleanWorkDirs();
    // Segunda passada das sobras do backup (H4b): o .parcial de uma queda logo antes deste
    // boot (com menos de 1 min, que a primeira deixou por poder ser de outra gravação) sai
    // um pouco depois, sem esperar o próximo backup.
    serverLifecycle.registerTimer('backup-leftovers', setTimeout(() => {
        try { backupUtil.cleanStaleLeftovers(); } catch (err) { logCrash('limpeza das sobras do backup', err); }
    }, backupUtil.BOOT_LEFTOVER_RECHECK_MS));
    serverLifecycle.registerTimer('restore-tokens', setInterval(() => backupUtil.sweepRestoreTokens(), 3600000));

    // Backup automático (H4b, OPS-03): conferido no boot e de hora em hora. Está devido
    // quando o último backup local bem-sucedido tem 20 h ou mais (o servidor ligado de
    // manhã faz o backup antes da aula). Grava o ZIP dos dados em data/backups
    // (automatico_dados_<carimbo>.zip, ficam 14) e, com o destino externo configurado na
    // tela Sistema, o completo em <destino>/IClass-<computador> (ficam "Guardar no
    // destino"), os dois da mesma cópia do banco (VACUUM INTO na fila de gravação). Com
    // prova em andamento fica para depois, salvo quando o último passou de 48 h. O
    // resultado vai para data/backups/estado.json e para a auditoria (ator 'sistema').
    // Desligado em TEST_MODE (demonstração e testes usam dados descartáveis).
    if (process.env.TEST_MODE !== '1') {
        const backupIfDue = async () => {
            try {
                const outcome = await backupUtil.runAutomaticIfDue();
                if (outcome.ran) {
                    const { local, externo, externoErro } = outcome.result;
                    console.log('💾 Backup automático criado: ' + local.name + (externo ? ` (cópia externa: ${externo.name})` : ''));
                    if (externoErro) console.warn('⚠️ Backup automático: a cópia externa falhou: ' + externoErro);
                } else if (outcome.reason === 'exam') {
                    console.log('💾 Backup automático adiado: há prova em andamento.');
                } else if (outcome.reason === 'failed') {
                    console.error('⚠️ Backup automático falhou: ' + backupUtil.failureMessage(outcome.error));
                }
            } catch (e) {
                logCrash('backup automático', e);
            }
        };
        backupIfDue();
        serverLifecycle.registerTimer('backup', setInterval(backupIfDue, 3600000));
    }
    return { outage, sessions };
}

// ---------------------------------------------------------------------------
// Processo do servidor (H3c: CONF-12, OPS-06, OPS-07)
// ---------------------------------------------------------------------------
// Ordem do startServer:
// 1. tratadores de exceção não tratada, sinais e a mensagem do supervisor;
// 2. conferência do build (ausente ou desatualizado: saída 2);
// 3. a porta abre logo, com o handler de boot (porta ocupada: saída 2, antes de ler o
//    banco). Quem chega durante o boot recebe "o IClass está iniciando", nunca conexão
//    recusada nem um 401 de sessão que ainda não foi retomada;
// 4. o boot (prepareServer): banco (danificado: saída 3; outra falha: saída 1), sessões,
//    tempo fora do ar, varredura do fim do tempo e heartbeat;
// 5. o handler passa a ser o app (createApp), e o banner com os endereços sai só aqui.
// O handler é trocável (createSwitchableHandler): o mesmo (req, res) => handler(req, res)
// serve ao http e, depois, ao https na mesma porta (H6c).
const { EXIT_CODES } = serverLifecycle;
// Tentativas a mais do listen com a porta ocupada, quando este processo nasceu de um
// reinício: o processo anterior pode levar um instante para liberar a porta.
const RELAUNCH_LISTEN_RETRIES = 5;
const RELAUNCH_LISTEN_RETRY_MS = 1000;
// Teto da gravação no desligamento depois de um erro fatal (o processo está em estado
// incerto: grava o que der e sai).
const FATAL_SHUTDOWN_SAVE_MS = 5000;
// Conexões que continuam abertas depois do server.close (aba aberta mantendo a conexão).
const CLOSE_CONNECTIONS_AFTER_MS = 2000;
// Quedas fatais seguidas (informadas pelo supervisor) a partir das quais o processo fica
// no ar com problemas em vez de sair (evita um laço de quedas).
const MAX_RECENT_FATALS = 3;

// Handler de requisições trocável: começa com o de boot e passa ao app quando o servidor
// fica pronto. handler.set(next) troca; handler.current() devolve o atual.
function createSwitchableHandler(initial) {
    let current = initial;
    const handler = (req, res) => current(req, res);
    handler.set = next => { current = next; };
    handler.current = () => current;
    return handler;
}

const BOOT_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3"><title>IClass iniciando…</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#1f2937;padding:16px;box-sizing:border-box}main{max-width:420px;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#4b5563}</style>
</head><body><main><h1>O IClass está iniciando…</h1><p>Aguarde alguns segundos. Esta página atualiza sozinha.</p></main></body></html>`;

// App de boot (contrato da ordem do createApp): /assets com o mesmo serveBuildAssets do
// app; /api/health com a fase do boot; o resto de /api com 503 {starting:true} e
// Retry-After 3; as páginas com o aviso "iniciando" em HTML que se recarrega sozinho.
function createBootApp() {
    const { startingHealthBody, handleSystemControl } = require('./routes/systemHealth.js');
    const { errorHandler } = require('./middlewares.js');
    const boot = express();
    boot.disable('x-powered-by');
    boot.use(assignRequestId);
    boot.use('/assets', serveBuildAssets(runtimePaths.WEB_DIST_DIR));
    // A rota de controle do launcher vale também durante o boot: parar ou reiniciar um
    // servidor que ainda carrega o banco sem precisar do taskkill.
    boot.post('/api/system/control', express.json({ limit: '1kb' }), handleSystemControl);
    boot.get('/api/health', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', '3');
        res.status(503).json(startingHealthBody());
    });
    boot.use('/api', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.set('Retry-After', '3');
        res.status(503).json({ error: 'O IClass está iniciando. Aguarde alguns segundos.', starting: true });
    });
    boot.use((req, res) => {
        setNoStore(res);
        res.set('Retry-After', '3');
        res.status(503).type('html').send(BOOT_HTML);
    });
    boot.use(errorHandler);
    return boot;
}

const DB_CORRUPT_CODES = new Set(['ICLASS_DB_CORRUPT', 'SQLITE_CORRUPT', 'SQLITE_NOTADB']);

// Mensagem e código de saída de cada falha de boot (causa: 'build', 'listen' ou a do
// prepareServer). Antes toda falha saía como "Falha ao inicializar o banco de dados
// SQLite: <erro>", inclusive o build desatualizado, e a porta ocupada saía com 0 e
// "iniciado com sucesso" (OPS-07).
function describeBootFailure(cause, err, { port = PORT } = {}) {
    const code = err && typeof err === 'object' ? String(err.code || '') : '';
    const detail = err && typeof err === 'object' && err.message ? err.message : String(err);
    if (cause === 'build') {
        const what = code === 'ICLASS_BUILD_OUTDATED'
            ? 'O site do IClass está desatualizado: o código foi atualizado e o site não foi compilado de novo.'
            : 'O site do IClass não está compilado (falta a pasta web/dist ou ela está incompleta).';
        return { exitCode: EXIT_CODES.CONFIG, kind: 'boot-build', message: `⛔ ${what} Rode a opção [4] do launcher (ou npm run build) e abra o IClass de novo.` };
    }
    if (cause === 'listen') {
        if (code === 'EADDRINUSE') {
            return { exitCode: EXIT_CODES.CONFIG, kind: 'listen', message: `⛔ A porta ${port} já está em uso por outro programa (talvez outra janela do IClass ou o modo demonstração). Feche-o e abra de novo.` };
        }
        if (code === 'EACCES') {
            return { exitCode: EXIT_CODES.CONFIG, kind: 'listen', message: `⛔ Sem permissão para usar a porta ${port}. Escolha outra porta (variável PORT) e abra de novo.` };
        }
        return { exitCode: EXIT_CODES.CONFIG, kind: 'listen', message: `⛔ Não foi possível abrir a porta ${port} (${code || detail}). Confira a configuração de rede e abra de novo.` };
    }
    const dbFile = path.join(runtimePaths.DATA_DIR, 'database.db');
    if (DB_CORRUPT_CODES.has(code)) {
        return {
            exitCode: EXIT_CODES.DB_CORRUPT,
            kind: 'database',
            // H4a (OPS-05): o arquivo fica como está; a backup-cli lista os backups e
            // restaura o mais recente com o servidor parado.
            message: `⛔ O banco de dados (${dbFile}) está danificado e o IClass não consegue abri-lo. Nada foi apagado.\n`
                + '   Para ver os backups: node backend/scripts/backup-cli.js listar\n'
                + '   Para restaurar o mais recente: node backend/scripts/backup-cli.js restaurar --ultimo\n'
                + '   Depois abra o IClass de novo.',
        };
    }
    if (err && err.bootStage === 'database') {
        return {
            exitCode: EXIT_CODES.ERROR,
            kind: 'database',
            message: `⛔ Não foi possível abrir o banco de dados (${dbFile}): ${code || detail}. Feche outros programas que possam estar usando a pasta de dados (outra janela do IClass, antivírus, OneDrive) e abra de novo.`,
        };
    }
    return { exitCode: EXIT_CODES.ERROR, kind: 'boot', message: `⛔ O servidor não conseguiu terminar de iniciar: ${detail}` };
}

let serverInstance = null;
let processHandlersInstalled = false;

function failBoot(cause, err, options) {
    const failure = describeBootFailure(cause, err, options);
    logError(failure.kind, err, { details: { saida: failure.exitCode } });
    console.error(failure.message);
    // O token da rota de controle (gravado logo depois de a porta abrir) não fica no disco
    // de um servidor que não está no ar: o launcher não lê um token velho.
    serverLifecycle.removeControlToken();
    process.exit(failure.exitCode);
}

function listenOnce(server, port, host) {
    return new Promise((resolve, reject) => {
        const onError = err => {
            server.off('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

// Abre a porta. Porta ocupada logo depois de um reinício (supervisor ou o Reiniciar sem
// supervisor): tenta mais 5 vezes, 1 s entre elas; nos outros casos falha na hora.
async function listenWithRetry(server, port, host) {
    const retries = serverLifecycle.supervisorInfo().relaunched ? RELAUNCH_LISTEN_RETRIES : 0;
    for (let attempt = 0; ; attempt += 1) {
        try {
            await listenOnce(server, port, host);
            return;
        } catch (err) {
            if (!err || err.code !== 'EADDRINUSE' || attempt >= retries) throw err;
            await new Promise(resolve => setTimeout(resolve, RELAUNCH_LISTEN_RETRY_MS));
        }
    }
}

function printBanner(port) {
    // Cria um hyperlink clicável no terminal (OSC 8). Terminais modernos como
    // o Windows Terminal abrem a URL no navegador com Ctrl+Clique. Terminais
    // sem suporte simplesmente exibem o texto (2º argumento) normalmente.
    // O alvo do clique (url) pode diferir do texto exibido (text) — assim um
    // token de acesso rápido pode ir no clique sem ficar visível no console.
    const link = (url, text = url) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
    // Modo ADMIN (opção 5 do launcher): o link do localhost carrega o token de
    // acesso rápido (#local-quick=) para abrir o login já com os botões
    // Administrador/Professor/Aluno. O token só funciona no loopback
    // (ver routes/setupMode.js), por isso NÃO entra nos links de IP de rede.
    const SETUP_MODE = process.env.ICLASS_ADMIN_SETUP_MODE === '1';
    const SETUP_TOKEN = process.env.ICLASS_ADMIN_SETUP_TOKEN || '';
    const quickHash = (SETUP_MODE && SETUP_TOKEN)
        ? `/login#local-quick=${encodeURIComponent(SETUP_TOKEN)}`
        : '';
    console.log(`===========================================`);
    console.log(`🟢 Servidor IClass V3 iniciado com sucesso!`);
    console.log(` Porta local: ${port}`);
    console.log(`===========================================`);
    console.log(`Para acessar deste computador:`);
    const localhostUrl = `http://localhost:${port}`;
    console.log(` -> ${link(localhostUrl + quickHash, localhostUrl)}`);
    if (quickHash) console.log(`    (clique abre o login com acesso rápido)`);
    console.log(`\nPara os alunos acessarem pelo celular ou outros PCs na mesma rede WiFi:`);

    localIpAddresses.forEach(ip => {
        const isVBox = ip.name.toLowerCase().includes('virtualbox') || ip.address.startsWith('192.168.56.');
        const url = link(`http://${ip.address}:${port}`);
        if (isVBox) {
            console.log(` -> ${url}  (⚠️ Ignorar: Rede VirtualBox)`);
        } else {
            console.log(` -> ${url}  (✅ Recomendado: ${ip.name})`);
        }
    });

    console.log(`===========================================`);
    console.log(`⚠️ IMPORTANTE: Lembre-se de liberar a porta ${port} no Firewall do Windows, se necessário!`);
}

// Reiniciar sem o supervisor: o próprio servidor dispara o novo processo antes de sair
// (com ICLASS_RESTARTED=1, que tenta a porta de novo se ela ainda estiver presa). No
// Windows continua o caminho de antes (cmd.exe espera 3 s e abre o node numa janela
// própria); fora dele, o node direto, com a saída em data/logs/servidor.log.
function relaunchWithoutSupervisor() {
    const env = { ...process.env, ICLASS_RESTARTED: '1' };
    console.log('🔁 Iniciando o novo processo do servidor...');
    if (process.platform === 'win32') {
        const child = childProcess.spawn('cmd.exe', ['/c', 'ping 127.0.0.1 -n 3 >nul && node backend/server.js'], {
            detached: true,
            stdio: 'ignore',
            cwd: runtimePaths.PROJECT_ROOT,
            shell: true,
            env,
        });
        child.unref();
        return;
    }
    let output = 'ignore';
    try {
        const logsDir = path.join(runtimePaths.DATA_DIR, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        output = fs.openSync(path.join(logsDir, 'servidor.log'), 'a');
    } catch (err) { output = 'ignore'; }
    const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'server.js')], {
        detached: true,
        stdio: ['ignore', output, output],
        cwd: runtimePaths.PROJECT_ROOT,
        env,
    });
    child.unref();
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error(`passou de ${ms / 1000} s`), { code: 'ICLASS_TIMEOUT' })), ms);
        }),
    ]);
}

// Fecha a porta: não aceita conexões novas, fecha as ociosas na hora e, passados 2 s,
// as que continuam abertas. hold (promessa): as abertas só caem depois que ela terminar
// (e mais um instante para a resposta sair), por exemplo o backup em andamento, para o
// "Fazer backup agora" interrompido receber o 503 retryable em vez de conexão cortada.
const RESPONSE_FLUSH_MS = 300;

async function closeHttpServer(server, { hold = null } = {}) {
    if (!server || !server.listening) return;
    const closed = new Promise(resolve => server.close(() => resolve()));
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    let flushTimer = null;
    const forceClose = () => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    };
    const timer = setTimeout(() => {
        if (!hold) return forceClose();
        Promise.resolve(hold).catch(() => {}).then(() => {
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
            flushTimer = setTimeout(forceClose, RESPONSE_FLUSH_MS);
        });
    }, CLOSE_CONNECTIONS_AFTER_MS);
    await closed;
    clearTimeout(timer);
    if (flushTimer) clearTimeout(flushTimer);
}

const SHUTDOWN_MESSAGES = {
    stop: '🛑 Desligando o servidor: gravando os dados...',
    restart: '🔁 Reiniciando o servidor: gravando os dados...',
    admin_restart: '🔁 Reinício pedido pela tela Sistema: gravando os dados...',
    fatal: '⛔ Erro inesperado: gravando o que for possível e saindo para o servidor voltar sozinho...',
};

// O desligamento ordenado de verdade (serverLifecycle.requestShutdown chama este). Ordem:
// timers parados, porta fechada (as conexões abertas caem em até 2 s), gravação completa
// e banco fechado (db.close), heartbeat com parada limpa, token de controle apagado,
// novo processo (Reiniciar sem supervisor) e a saída: 0 (parada), 75 (reinício sob o
// supervisor) ou 1 (erro fatal). Teto de 10 s; passado isso, sai com 1.
async function performShutdown({ restart = false, reason = 'stop' } = {}) {
    const supervised = serverLifecycle.isSupervised();
    const exitCode = reason === 'fatal'
        ? EXIT_CODES.ERROR
        : (restart && supervised ? EXIT_CODES.RESTART : EXIT_CODES.OK);
    const hardStop = setTimeout(() => {
        console.error(`⛔ O desligamento passou de ${serverLifecycle.SHUTDOWN_TIMEOUT_MS / 1000} s; saindo assim mesmo.`);
        process.exit(EXIT_CODES.ERROR);
    }, serverLifecycle.SHUTDOWN_TIMEOUT_MS);
    serverLifecycle.clearTimers();
    // Ainda no boot: a memória pode não estar carregada, e uma gravação completa agora
    // apagaria do disco o que não foi lido. Sai sem gravar (o que o boot já gravou foi em
    // transações completas) e sem marcar parada limpa: o heartbeat para (stopHeartbeat),
    // e nem o ouvinte de 'exit' do serverLifecycle grava clean:true. O próximo boot conta
    // o tempo fora do ar pelo último heartbeat gravado (o desta execução, se já começou,
    // ou o da anterior). Sai com o código do pedido: 0, 75 (reinício sob o supervisor) ou
    // 1 (erro fatal); o reinício sem supervisor relança o processo.
    if (!serverLifecycle.bootState().ready) {
        console.log(reason === 'fatal'
            ? SHUTDOWN_MESSAGES.fatal
            : (restart ? '🔁 Reiniciando antes de terminar de iniciar: nada a gravar.' : '🛑 Desligando antes de terminar de iniciar: nada a gravar.'));
        serverLifecycle.stopHeartbeat();
        try { if (serverInstance && serverInstance.listening) serverInstance.close(); } catch (e) { /* saindo */ }
        serverLifecycle.removeControlToken();
        if (restart && !supervised && reason !== 'fatal') {
            try { relaunchWithoutSupervisor(); } catch (err) { logCrash('reinício sem supervisor', err); }
        }
        clearTimeout(hardStop);
        process.exit(exitCode);
        return;
    }
    console.log(SHUTDOWN_MESSAGES[reason] || SHUTDOWN_MESSAGES.stop);
    // Backup em andamento (H4b, decisões §12): espera um pouco; se não terminar, a
    // gravação do ZIP é interrompida e o .parcial sai (nada pela metade no pendrive nem em
    // data/backups). Corre junto com o fechamento da porta, e as conexões abertas só caem
    // depois dele: quem pediu "Fazer backup agora" recebe a resposta (o 503 retryable da
    // interrupção) em vez de conexão cortada. Cabe no teto de 10 s do desligamento.
    const backupSettled = require('./utils/backup.js')
        .settleForShutdown(reason === 'fatal' ? { waitMs: 1000, abortWaitMs: 1000 } : { waitMs: 4000, abortWaitMs: 1500 })
        .then(settled => {
            if (settled.aborted) console.warn('⚠️ Backup em andamento interrompido pelo desligamento; o arquivo pela metade foi apagado.');
        }, err => logCrash('desligamento (backup em andamento)', err));
    try { await closeHttpServer(serverInstance, { hold: backupSettled }); } catch (err) { logCrash('desligamento (porta)', err); }
    await backupSettled;
    try {
        await (reason === 'fatal' ? withTimeout(db.close(), FATAL_SHUTDOWN_SAVE_MS) : db.close());
    } catch (err) {
        logCrash('desligamento (gravação)', err);
    }
    serverLifecycle.markCleanShutdown(reason);
    serverLifecycle.removeControlToken();
    if (restart && !supervised) {
        try { relaunchWithoutSupervisor(); } catch (err) { logCrash('reinício sem supervisor', err); }
    }
    clearTimeout(hardStop);
    console.log(exitCode === EXIT_CODES.RESTART ? '🔁 Dados gravados. O supervisor inicia o servidor de novo.' : '✅ Dados gravados. Servidor desligado.');
    process.exit(exitCode);
}

// Exceção não tratada, sinais e a mensagem do supervisor (uma vez por processo). server:
// o servidor http que o desligamento fecha (os processos de teste que sobem o createApp
// sem o startServer passam o deles).
function installProcessHandlers({ server } = {}) {
    if (server) serverInstance = server;
    if (processHandlersInstalled) return;
    processHandlersInstalled = true;
    serverLifecycle.setShutdownHandler(performShutdown);
    process.on('uncaughtException', err => {
        logCrash('uncaughtException', err);
        serverLifecycle.markDegraded(err && err.message ? err.message : String(err));
        const info = serverLifecycle.supervisorInfo();
        // Sob o supervisor, sair e voltar em segundos (com as sessões e o tempo das provas
        // preservados) é melhor que seguir num estado incerto. Sem ele, sair derrubaria a
        // aula; depois de 3 quedas em 10 min, também fica (evita um laço de quedas).
        if (info.supervised && info.recentFatals < MAX_RECENT_FATALS) {
            serverLifecycle.requestShutdown({ reason: 'fatal' });
        } else {
            console.error(`⚠️ O servidor continua no ar depois do erro, mas pode estar com problemas. Reinicie o IClass assim que possível (detalhes em ${path.basename(crashLogPath())}).`);
        }
    });
    // Promessa rejeitada sem tratamento: só o registro (não deixa o processo incerto).
    process.on('unhandledRejection', reason => logCrash('unhandledRejection', reason));
    // Ctrl+C, SIGTERM, fechar a janela do console (SIGHUP no Windows) e Ctrl+Break.
    ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(signal => {
        try { process.on(signal, () => serverLifecycle.requestShutdown({ reason: 'stop' })); } catch (e) { /* sinal inexistente nesta plataforma */ }
    });
    // Supervisor (backend/supervisor.js): pede a parada pelo canal IPC.
    process.on('message', message => {
        if (message && typeof message === 'object' && message.type === 'shutdown') {
            serverLifecycle.requestShutdown({ restart: message.restart === true, reason: message.restart === true ? 'restart' : 'stop' });
        }
    });
    // O supervisor morreu sozinho (kill -9, "Finalizar tarefa" no node.exe dele, taskkill
    // sem /T): o canal IPC fecha. Sem isto o servidor ficava no ar sem dono e sem log,
    // segurando a porta, e a próxima abertura pelo launcher saía com 2 (porta ocupada).
    if (serverLifecycle.isSupervised() && typeof process.send === 'function') {
        const supervisorPid = process.ppid;
        process.once('disconnect', () => {
            if (serverLifecycle.shutdownRequested()) return; // parada pedida pelo supervisor
            // A saída ia para o supervisor (pipe fechado): escrever nela não pode derrubar o
            // desligamento com EPIPE.
            [process.stdout, process.stderr].forEach(stream => { try { stream.on('error', () => {}); } catch (e) { /* sem saída */ } });
            logError('supervisor', new Error(`O supervisor (processo ${supervisorPid}) parou sem desligar o servidor; desligamento ordenado.`));
            // runtime/supervisor.pid ainda aponta para o supervisor morto: o launcher não
            // pode encerrar pela árvore de um PID que talvez já seja de outro programa.
            serverLifecycle.removeSupervisorPid(supervisorPid);
            serverLifecycle.requestShutdown({ reason: 'stop' });
        });
    }
}

function sendToSupervisor(message) {
    if (typeof process.send !== 'function' || !process.connected) return;
    try { process.send(message); } catch (e) { /* supervisor já saiu */ }
}

async function startServer({ port = PORT, host = '0.0.0.0' } = {}) {
    installProcessHandlers();
    try {
        verifyBuild();
    } catch (err) {
        return failBoot('build', err, { port });
    }

    const handler = createSwitchableHandler(createBootApp());
    serverInstance = http.createServer(handler);
    try {
        await listenWithRetry(serverInstance, Number(port), host);
    } catch (err) {
        return failBoot('listen', err, { port });
    }
    serverInstance.on('error', err => logCrash('servidor http', err));
    const actualPort = serverInstance.address() && serverInstance.address().port;
    serverLifecycle.writeControlToken();
    console.log(`⏳ Carregando os dados do IClass (porta ${actualPort} já respondendo "iniciando")...`);

    let prepared;
    try {
        prepared = await prepareServer();
    } catch (err) {
        return failBoot(err && err.bootStage === 'database' ? 'database' : 'boot', err, { port: actualPort });
    }
    // Só em TEST_MODE: segura o boot na fase 'checking' (testes do handler de boot).
    const bootDelay = process.env.TEST_MODE === '1' ? Number(process.env.ICLASS_TEST_BOOT_DELAY_MS || 0) : 0;
    if (bootDelay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(bootDelay, 60000)));
    // Pediram para desligar durante o boot: o desligamento já está em andamento.
    if (serverLifecycle.shutdownRequested()) return serverInstance;

    const app = createApp();
    app.set('serverInstance', serverInstance);
    handler.set(app);
    const { sessions: restored } = prepared || {};
    const resumed = restored || {};
    serverLifecycle.markReady({ sessionsRestored: { students: resumed.students || 0, admins: resumed.admins || 0, dropped: resumed.dropped || 0 } });
    printBanner(actualPort);
    if (serverLifecycle.isSupervised()) console.log('🔁 Reinício automático ligado (supervisor).');
    sendToSupervisor({ type: 'ready', instanceId: SERVER_INSTANCE_ID, port: actualPort, pid: process.pid });
    return serverInstance;
}

if (require.main === module) {
    startServer().catch(err => {
        // Não devia chegar aqui (cada etapa trata a própria falha): registra e sai com 1.
        logCrash('boot', err);
        process.exit(EXIT_CODES.ERROR);
    });
}

module.exports = {
    createApp,
    createBootApp,
    createSwitchableHandler,
    describeBootFailure,
    installProcessHandlers,
    prepareServer,
    startServer,
};
