const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./database.js');
const settingsUtil = require('./utils/settings.js');
const { parseEvaluationMarkdown } = require('./utils/parser.js');
const runtimePaths = require('./runtimePaths.js');
const { resolveInside } = require('./utils/safePath.js');
const { verifyBuild } = require('./utils/buildIntegrity.js');
const { localIpAddresses, studentBelongsToClass, getReleasedItemsForClass } = require('./middlewares.js');
const { safeImageSegments, studentHasApprovedClass, uploadReferencedInReleasedContent } = require('./utils/contentMedia.js');

// ---------------------------------------------------------------------------
// Rede de proteção contra quedas do servidor.
// Registra qualquer erro não-tratado em data/crash.log (com stack trace) em vez
// de derrubar o processo silenciosamente. O servidor é MANTIDO vivo para que
// uma única falha de rota/intervalo não interrompa uma prova em andamento.
// ---------------------------------------------------------------------------
const CRASH_LOG = path.join(runtimePaths.DATA_DIR, 'crash.log');
function logCrash(kind, err) {
    const ts = new Date().toISOString();
    const detail = (err && err.stack) ? err.stack : String(err);
    const line = `\n[${ts}] ${kind}\n${detail}\n`;
    try { fs.appendFileSync(CRASH_LOG, line); } catch (e) { /* sem fallback: não derrubar por causa do log */ }
    console.error(`🛑 ${kind} @ ${ts}\n${detail}`);
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));

const PORT = process.env.PORT || 3000;

function createApp() {
const app = express();
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
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path.endsWith('.js')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

// Extensões que nunca saem como arquivo (viram vetor de script ou executável).
const BLOCKED_FILE_EXTENSIONS = ['.html', '.htm', '.js', '.mjs', '.exe', '.bat', '.cmd', '.ps1'];
const INLINE_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

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
    const adminSession = accessToken && db.memory.adminSessions && db.memory.adminSessions[accessToken];
    const studentEmail = Object.keys(db.memory.sessions || {}).find(email => {
        const session = db.memory.sessions[email];
        return session && typeof session === 'object' && session.token === accessToken;
    });
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
    if (studentEmail && !adminSession && !publicBrandingFile) {
        const student = (db.memory.students || []).find(item => item.email && item.email.toLowerCase() === studentEmail.toLowerCase());
        if (isContentImage) {
            // Imagens das apostilas: aluno com matrícula aprovada (UXA-09).
            if (!studentHasApprovedClass(student, studentBelongsToClass)) return res.status(403).json({ error: 'Arquivo não disponível para alunos.' });
        } else {
            const entry = (db.memory.library || []).find(item => item.filename === filename);
            if (entry) {
                if (entry.courseId) {
                    const rawClasses = student && Array.isArray(student.classes) ? student.classes : [];
                    const courseIds = new Set(rawClasses.filter(item => item && typeof item === 'object').map(item => item.courseId).filter(Boolean));
                    rawClasses.filter(item => typeof item === 'string').forEach(className => {
                        const matches = (db.memory.classes || []).filter(cls => cls.name === className);
                        if (matches.length === 1 && matches[0].courseId) courseIds.add(matches[0].courseId);
                    });
                    if (!courseIds.has(entry.courseId)) return res.status(403).json({ error: 'Arquivo fora dos cursos autorizados.' });
                }
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
// IclassV3: serve o build da nova interface React (Vite -> web/dist).
// Em desenvolvimento o Vite roda em :5173 com proxy para /api; para uso local
// normal, rode `npm run build` na pasta web/ e o Express entrega tudo aqui.
const WEB_DIST = runtimePaths.WEB_DIST_DIR;
app.use(express.static(WEB_DIST));


// Carregar os Roteadores Modulares
const { errorHandler, adminRbacGuard } = require('./middlewares.js');
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
    const isAuthenticatedAdmin = adminToken && db.memory.adminSessions && db.memory.adminSessions[adminToken];
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
app.use(studentRoutes);
app.use(adminRoutes);

// Fallback SPA: qualquer rota que não seja /api ou /uploads devolve o index.html
// da nova interface, e o React Router resolve a navegação (instrutor/aluno).
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/imagens')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'));
});

// Registrar o middleware global de tratamento de erros
app.use(errorHandler);

return app;
}

let serverInstance;

async function startServer() {
    verifyBuild();
    await db.init();
    db.memory.sessions = {};
    db.memory.adminSessions = {}; // sessoes de instrutor (memoria; zeradas a cada boot)

    // Garante IDs e e-mails de autor consistentes no fórum (migração automática)
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

    // Inicia o servidor e informa o endereço IP da rede local
    // Varredura da lixeira conforme a retenção configurada (boot + a cada 6h).
    const _fileStore = require('./utils/storage.js');
    function sweepTrash() { try { const n = _fileStore.purgeTrash(settingsUtil.getSettings().trash.retentionDays); if (n) console.log('🗑️  Lixeira: ' + n + ' item(ns) antigos removidos.'); } catch (e) {} }
    sweepTrash();
    const trashInterval = setInterval(sweepTrash, 6 * 3600000);
    trashInterval.unref();

    // Backup automático diário dos dados em data/backups (guarda os 14 mais recentes).
    // Checa a cada hora se o último tem mais de 24h, então sobrevive a reinícios do servidor.
    // Desligado em TEST_MODE (demonstração e testes usam dados descartáveis).
    if (process.env.TEST_MODE !== '1') {
        const backupUtil = require('./utils/backup.js');
        const backupIfDue = async () => {
            try {
                const last = backupUtil.lastAutomaticBackupAt();
                if (last && Date.now() - last < 24 * 3600000) return;
                await db.save();
                const file = backupUtil.runAutomaticBackup();
                console.log('💾 Backup automático criado: ' + path.basename(file));
            } catch (e) { logCrash('backup automático', e); }
        };
        backupIfDue();
        const backupInterval = setInterval(backupIfDue, 3600000);
        backupInterval.unref();
    }

    const app = createApp();
    serverInstance = app.listen(PORT, '0.0.0.0', () => {
        app.set('serverInstance', serverInstance);
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
        console.log(` Porta local: ${PORT}`);
        console.log(`===========================================`);
        console.log(`Para acessar deste computador:`);
        const localhostUrl = `http://localhost:${PORT}`;
        console.log(` -> ${link(localhostUrl + quickHash, localhostUrl)}`);
        if (quickHash) console.log(`    (clique abre o login com acesso rápido)`);
        console.log(`\nPara os alunos acessarem pelo celular ou outros PCs na mesma rede WiFi:`);

        localIpAddresses.forEach(ip => {
            const isVBox = ip.name.toLowerCase().includes('virtualbox') || ip.address.startsWith('192.168.56.');
            const url = link(`http://${ip.address}:${PORT}`);
            if (isVBox) {
                console.log(` -> ${url}  (⚠️ Ignorar: Rede VirtualBox)`);
            } else {
                console.log(` -> ${url}  (✅ Recomendado: ${ip.name})`);
            }
        });

        console.log(`===========================================`);
        console.log(`⚠️ IMPORTANTE: Lembre-se de liberar a porta ${PORT} no Firewall do Windows, se necessário!`);
    });
    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const serverClosed = new Promise(resolve => serverInstance.close(resolve));
        if (typeof serverInstance.closeIdleConnections === 'function') serverInstance.closeIdleConnections();
        const forceCloseTimer = setTimeout(() => {
            if (typeof serverInstance.closeAllConnections === 'function') serverInstance.closeAllConnections();
        }, 1000);
        forceCloseTimer.unref();
        await serverClosed;
        clearTimeout(forceCloseTimer);
        await db.close();
    };
    process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
    return serverInstance;
}

if (require.main === module) {
    startServer().catch(err => {
        console.error("Falha ao inicializar o banco de dados SQLite:", err);
        process.exit(1);
    });
}

module.exports = { createApp, startServer };
