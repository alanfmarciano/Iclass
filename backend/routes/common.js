const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { SERVER_INSTANCE_ID } = require('../utils/sessionConfig.js');
const settingsUtil = require('../utils/settings.js');
const { connectionInfo } = require('../utils/networkPolicy.js');
const secureConnection = require('../utils/secureConnection.js');
const { CONTENT_DIR } = require('../runtimePaths.js');
const { effectiveStructure } = require('../utils/classContent.js');
const {
    SAFE_CONTENT_KEY,
    classStructure,
    findContentFile,
    isRestrictedContentKey,
    readApostila,
    releasedApostilaKeysForClass,
    stripStoredAccessTokens,
} = require('../utils/contentAccess.js');
const {
    sanitizeEvaluationForStudent,
    validateAdmin,
    validateAdminPermission,
    validateAnySession,
    studentBelongsToClass,
    findClassByNameAndCourse,
    getReleasedItemsForClass,
    isProfessorAccount,
    adminAllowedCourseIds
} = require('../middlewares.js');
const { logError, oneLine } = require('../utils/errorLog.js');
const { rateLimit } = require('../utils/rateLimit.js');
const { body, oneOf, str } = require('../utils/inputSchema.js');

// Status leve do servidor (SEM auth): identidade da instancia + relogio.
// O cliente compara o instanceId; se mudou (servidor reiniciado), forca novo login.
router.get('/api/settings/public', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const st = settingsUtil.getSettings();
    res.json({
        timezone: st.timezone, locale: st.locale,
        session: { idleMinutes: st.session.idleMinutes, absoluteHours: st.session.absoluteHours },
        maintenance: { enabled: st.maintenance.enabled, message: st.maintenance.message },
        today: settingsUtil.today(),
    });
});

router.get('/api/session/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ instanceId: SERVER_INSTANCE_ID, now: Date.now() });
});

// Como esta conexão é tratada (SEG-03), sem login: a tela de login e o painel do
// professor mostram se o painel abre neste aparelho e o aviso de conexão sem proteção.
// { secure, thisComputer, adminAccess: 'ok'|'local-only'|'https-required',
//   adminAccessMode, insecureAdmin, tlsAvailable, studentsHttps, httpsUrl }.
router.get('/api/connection', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(connectionInfo(req));
});

// Conexão segura (H6c, SEG-03 e OPS-08), sem login, em http e em https: o aparelho baixa
// o certificado da CA deste IClass antes de confiar no https (guia /certificado).
// - GET /iclass-ca.crt: o certificado da CA (DER), para instalar no aparelho;
// - GET /api/connection/certificate: a impressão digital (para comparar com a de Sistema
//   → Rede, no computador do IClass) e as validades. Sem conexão segura, 200 com
//   available:false e o motivo (sem resposta de estado nova: contrato 9).
router.get('/iclass-ca.crt', (req, res) => {
    const der = secureConnection.caCertificateDer();
    res.set('Cache-Control', 'no-store');
    if (!der) return res.status(404).type('text/plain; charset=utf-8').send(`${secureConnection.unavailableText()} O certificado do IClass não pode ser baixado agora.`);
    res.set('Content-Type', 'application/x-x509-ca-cert');
    res.set('Content-Disposition', 'attachment; filename="iclass-ca.crt"');
    return res.send(Buffer.from(der));
});

router.get('/api/connection/certificate', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const status = secureConnection.status();
    if (!status.available) {
        return res.json({ available: false, error: secureConnection.unavailableText() });
    }
    return res.json({
        available: true,
        fingerprintSha256: status.ca.fingerprintSha256,
        validFrom: status.ca.validFrom,
        validTo: status.ca.validTo,
        recreatedAt: status.ca.recreatedAt,
        server: status.server,
        httpsUrl: connectionInfo(req).httpsUrl,
    });
});

// Erro de tela do navegador (fase 2, H9c: ENG-05): a área de erro dos layouts e a tela
// de erro da raiz (web/src/lib/clientErrors.js) avisam aqui, e o aviso vira uma linha
// "erro de tela" no crash.log da pasta de dados, com quem estava na tela, a área, o
// caminho da página e a versão do build. Não grava no banco. Pede sessão (aluno ou
// instrutor) e aceita até 10 avisos por minuto por e-mail (acima disso, 429): com o
// limite do arquivo (5 MB, utils/errorLog.js) e o tamanho dos campos, um aparelho não
// enche o disco. Só o aviso aceito conta no limite: o recusado (400) não grava nada.
// Cada campo vira uma linha só (quebras de linha e caracteres de controle saem), para
// o texto mandado pelo navegador não forjar no arquivo um bloco com cabeçalho de outro
// usuário. Fora de /api/admin: o aluno também avisa.
// Campos conferidos pelo schema (utils/inputSchema.js, H9b) depois da sessão: o aviso
// recusado (400) não grava nada nem conta no limite.
const CLIENT_ERROR_AREAS = ['raiz', 'admin', 'aluno', 'prova'];
const CLIENT_ERROR_SCHEMA = body({
    area: oneOf(CLIENT_ERROR_AREAS, { required: true, label: 'área' }),
    message: str({ max: 300, required: true, label: 'mensagem' }),
    path: str({ max: 200, label: 'caminho' }),
    build: str({ max: 64, label: 'versão' }),
});
const CLIENT_ERROR_RATE_LIMIT = { max: 10, windowMs: 60000 };

router.post('/api/client-error', validateAnySession, CLIENT_ERROR_SCHEMA, (req, res) => {
    const email = String((req.requester && req.requester.email) || '').toLowerCase();
    const limit = rateLimit(`client-error:${email}`, CLIENT_ERROR_RATE_LIMIT);
    if (!limit.allowed) {
        res.set('Retry-After', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
        return res.status(429).json({ success: false, error: 'Muitos avisos de erro seguidos. Aguarde um instante.' });
    }
    const text = (name) => (typeof req.body[name] === 'string' ? oneLine(req.body[name]) : '');
    // Objeto sem stack: o stack do servidor não diz nada sobre o erro do navegador.
    logError('erro de tela', { message: text('message') || '(sem mensagem)' }, {
        req,
        details: { 'área': text('area'), caminho: text('path'), build: text('build') },
    });
    return res.status(204).end();
});


// Rota dinamica para servir data.js com conteudo atualizado em tempo real.
// Exige sessão (aluno ou instrutor). Para o aluno, só entram as apostilas liberadas
// para a turma em que ele está matriculado e a estrutura desse curso; avaliações
// (questões e gabarito) nunca vão por aqui — a prova chega só pela tentativa iniciada.
router.get(['/data.js', '/api/data.js'], validateAnySession, async (req, res) => {
    res.set('Content-Type', 'application/javascript');
    if (req.requester.role === 'student') return sendStudentCourseData(req, res);
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    const dataObj = {};
    
    // Find the course if courseId is provided
    let allowedApostilas = null;
    let allowedAvaliacoes = null;

    if (courseId) {
        allowedApostilas = [];
        allowedAvaliacoes = [];
    }

    if (courseId && db.memory.courses) {
        const course = db.memory.courses.find(c => c.id === courseId);
        const structure = effectiveStructure(courseId, studentClass)?.structure || course?.structure || [];
        if (course) {
            structure.forEach(mod => {
                (mod.units || mod.items || []).forEach(unit => {
                    if (unit.apostilaKey) allowedApostilas.push(unit.apostilaKey);
                    if (unit.avaliacaoKey) allowedAvaliacoes.push(unit.avaliacaoKey);
                });
            });
        }
    }

    try {
        const files = await fs.promises.readdir(CONTENT_DIR);
        const ignoredFiles = [
            'implementation_plan.md',
            'task.md',
            'walkthrough.md',
            'manual_novas_unidades.md',
            'readme.md',
            'project_analysis.md',
            'folder_structure_analysis.md'
        ];
        
        await Promise.all(files.map(async (file) => {
            if (file.endsWith('.md') && !ignoredFiles.includes(file.toLowerCase())) {
                const key = file.replace('.md', '');
                // Se um curso for especificado, só envie as apostilas associadas a ele
                if (!allowedApostilas || allowedApostilas.includes(key)) {
                    const filePath = path.join(CONTENT_DIR, file);
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    dataObj[key] = content;
                }
            }
        }));
    } catch (e) {
        console.error("Erro ao gerar data.js dinamico:", e);
    }

    if (db.memory && db.memory.evaluations) {
        for (const evalKey in db.memory.evaluations) {
            if (!allowedAvaliacoes || allowedAvaliacoes.includes(evalKey)) {
                dataObj[evalKey] = sanitizeEvaluationForStudent(db.memory.evaluations[evalKey]);
            }
        }
    }

    dataObj["courseStructure"] = db.memory.courseStructure || []; // Legado
    
    // Send only the requested course, or all if no courseId
    if (courseId) {
        dataObj["courses"] = db.memory.courses
            ? db.memory.courses.filter(c => c.id === courseId && !isCourseDeleted(c)).map(course => ({
                ...course,
                structure: effectiveStructure(course.id, studentClass)?.structure || course.structure || [],
            }))
            : [];
    } else {
        dataObj["courses"] = (db.memory.courses || []).filter(c => !isCourseDeleted(c));
    }
    
    dataObj["branding"] = db.memory.branding || {};

    const fileContent = `const courseData = ${JSON.stringify(dataObj, null, 2)};`;
    res.send(fileContent);
});

// data.js do aluno: curso obrigatório, matrícula aprovada numa turma desse curso e
// só as apostilas liberadas para ela. Curso excluído não é servido.
async function sendStudentCourseData(req, res) {
    const courseId = String(req.query.courseId || '').trim();
    const studentClass = String(req.query.studentClass || '').trim();
    if (!courseId) {
        return res.status(400).type('application/json').json({ error: 'Informe o curso para carregar os materiais.' });
    }
    const course = (db.memory.courses || []).find(item => item.id === courseId);
    if (!course || isCourseDeleted(course)) {
        return res.status(404).type('application/json').json({ error: 'Curso não encontrado.' });
    }
    const classes = db.memory.classes || [];
    const cls = studentClass
        ? findClassByNameAndCourse(classes, studentClass, courseId)
        : classes.find(item => item.courseId === courseId && studentBelongsToClass(req.studentAccount, item));
    if (!cls || !studentBelongsToClass(req.studentAccount, cls)) {
        return res.status(403).type('application/json').json({ error: 'Turma não autorizada para este estudante.' });
    }

    const dataObj = {};
    const releasedKeys = releasedApostilaKeysForClass(cls, req.studentEmail, getReleasedItemsForClass);
    await Promise.all(releasedKeys.map(async (key) => {
        const content = await readApostila(key, { ownHosts: [req.get('host')] });
        if (content !== null) dataObj[key] = content;
    }));
    dataObj.courseStructure = [];
    dataObj.courses = [{
        id: course.id,
        name: course.name || '',
        description: course.description || '',
        structure: classStructure(cls),
    }];
    dataObj.branding = db.memory.branding || {};
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(`const courseData = ${JSON.stringify(dataObj, null, 2)};`);
}

// Serve apostilas em Markdown (editor de conteúdo do instrutor e leitura do aluno).
// Exige sessão. A chave digitada nunca vira caminho: o aluno só recebe apostila que
// esteja liberada para uma turma em que está matriculado; o instrutor recebe o
// arquivo existente de mesmo nome. Avaliações e gabaritos nunca saem por esta rota,
// em nenhuma grafia (o Windows não diferencia maiúsculas de minúsculas).
router.get('/:key.md', async (req, res, next) => {
    const { key } = req.params;
    if (!SAFE_CONTENT_KEY.test(key)) {
        return next();
    }
    return validateAnySession(req, res, async () => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        if (isRestrictedContentKey(key)) {
            return res.status(403).type('text/plain').send('Avaliação não disponível por esta rota.');
        }

        if (req.requester.role === 'student') {
            const wanted = key.toLowerCase();
            const canonicalKey = (db.memory.classes || [])
                .filter(cls => studentBelongsToClass(req.studentAccount, cls))
                .flatMap(cls => releasedApostilaKeysForClass(cls, req.studentEmail, getReleasedItemsForClass))
                .find(item => item.toLowerCase() === wanted);
            if (!canonicalKey) {
                return res.status(403).type('text/plain').send('Material não liberado para a sua turma.');
            }
            const content = await readApostila(canonicalKey, { ownHosts: [req.get('host')] });
            if (content === null) return res.status(404).type('text/plain').send('');
            return res.type('text/markdown').send(content);
        }

        const filePath = await findContentFile(key);
        if (!filePath || isRestrictedContentKey(path.basename(filePath, '.md'))) {
            return res.status(404).type('text/plain').send('');
        }
        try {
            // Links antigos com a sessão de outro instrutor gravada saem limpos (UXA-X2).
            const content = stripStoredAccessTokens(await fs.promises.readFile(filePath, 'utf8'), { ownHosts: [req.get('host')] });
            res.type('text/markdown').send(content);
        } catch (err) {
            console.error('Erro ao ler apostila:', err && err.message, 'filePath:', filePath);
            return res.status(404).type('text/plain').send('');
        }
    });
});

const { extractBranding, resolveEffectiveBranding, validateBrandingPatch } = require('../utils/branding.js');

function rejectInvalidBranding(res, body) {
    const validationError = validateBrandingPatch(body);
    if (!validationError) return false;
    res.status(400).json({ error: validationError.message, code: validationError.code, field: validationError.field });
    return true;
}

router.get('/api/branding', (req, res) => {
    const courseId = (req.query.courseId || '').trim();
    const requestedSchoolId = (req.query.schoolId || '').trim();
    if (courseId && requestedSchoolId) {
        return res.status(400).json({ error: 'Informe courseId ou schoolId, não ambos.' });
    }
    const g = db.memory.branding || {};
    if (req.query.raw === '1') {
        return res.json({ ...g, displayName: g.displayName || g.name || g.institutionName || '', primaryColor: g.primaryColor || g.color || '' });
    }
    const global = { ...g, displayName: g.displayName || g.name || g.institutionName, primaryColor: g.primaryColor || g.color, logoLightUrl: g.logoLightUrl || g.logoUrl };
    const course = courseId ? (db.memory.courses || []).find(c => c.id === courseId) : null;
    const schoolId = (course && course.schoolId) || requestedSchoolId || null;
    const school = schoolId
        ? (db.memory.schools || []).find(s => s.id === schoolId)
        : null;
    if (requestedSchoolId && !school) {
        return res.status(404).json({ error: 'Escola não encontrada.' });
    }
    const effective = resolveEffectiveBranding({ global, school, course });
    // Aliases de compatibilidade com a tela de Identidade atual.
    effective.name = effective.displayName;
    effective.color = effective.primaryColor;
    res.json(effective);
});

router.post('/api/branding', (req, res) => {
    validateAdminPermission(req, res, 'branding.manage', () => {
        if (rejectInvalidBranding(res, req.body)) return;
        db.memory.branding = { ...db.memory.branding, ...extractBranding(req.body) };
        db.save();
        res.json({ success: true, branding: db.memory.branding });
    });
});

function isCourseDeleted(course) {
    return course && (course.deleted === true || course.status === 'deleted' || course.status === 'inactive' || !!course.deletedAt);
}

// Lista completa de cursos (estrutura, chaves de unidades e avaliações, excluídos)
// só para o instrutor; o professor recebe só os cursos do escopo dele (SEG-12). Sem
// sessão de instrutor, devolve apenas id e nome dos cursos ativos com turma aberta para
// cadastro. Instrutor é só quem manda x-admin-session: o 'Authorization: email:senha'
// não vale mais (SEG-03) e cai na lista pública.
router.get('/api/courses', (req, res) => {
    const hasAdminCredentials = !!req.get('x-admin-session');
    if (!hasAdminCredentials) {
        const openCourseIds = new Set((db.memory.classes || []).filter(cls => cls.registrationEnabled).map(cls => cls.courseId));
        return res.json((db.memory.courses || [])
            .filter(course => !isCourseDeleted(course) && openCourseIds.has(course.id))
            .map(course => ({ id: course.id, name: course.name || '' })));
    }
    validateAdmin(req, res, (config, matchedAdmin) => {
        const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
        const allowed = isProfessorAccount(matchedAdmin) ? adminAllowedCourseIds(matchedAdmin) : null;
        const courses = (db.memory.courses || []).filter(course => course && (!allowed || allowed.has(String(course.id))));
        res.json(includeDeleted ? courses : courses.filter(c => !isCourseDeleted(c)));
    });
});

// Criar, alterar e excluir curso mudaram para /api/admin/courses (SEG-12), que passa
// pela guarda do painel (escopo do professor, troca obrigatória de senha) e grava só os
// campos permitidos. Uma aba aberta com o app de antes da atualização ainda chama estas
// rotas: recebe 410 com o pedido de recarregar a página, e nada é gravado.
const COURSE_ROUTE_MOVED = 'O IClass foi atualizado. Recarregue a página (F5) para continuar.';
function courseRouteMoved(req, res) {
    res.status(410).json({ success: false, error: COURSE_ROUTE_MOVED });
}
router.post('/api/courses', courseRouteMoved);
router.put('/api/courses/:id', courseRouteMoved);
router.delete('/api/courses/:id', courseRouteMoved);
module.exports = router;
