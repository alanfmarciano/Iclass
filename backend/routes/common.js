const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { SERVER_INSTANCE_ID } = require('../utils/sessionConfig.js');
const settingsUtil = require('../utils/settings.js');
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
    localIpAddresses,
    validateAdmin,
    validateAdminPermission,
    validateAnySession,
    studentBelongsToClass,
    findClassByNameAndCourse,
    getReleasedItemsForClass
} = require('../middlewares.js');

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
        const content = await readApostila(key);
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
            const content = await readApostila(canonicalKey);
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

// Retorna os IPs da rede local
router.get('/api/admin/network-info', (req, res) => {
    res.json(localIpAddresses);
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
// só para o instrutor. Sem sessão de instrutor, devolve apenas id e nome dos cursos
// ativos com turma aberta para cadastro.
router.get('/api/courses', (req, res) => {
    const hasAdminCredentials = !!(req.get('x-admin-session') || req.headers.authorization);
    if (!hasAdminCredentials) {
        const openCourseIds = new Set((db.memory.classes || []).filter(cls => cls.registrationEnabled).map(cls => cls.courseId));
        return res.json((db.memory.courses || [])
            .filter(course => !isCourseDeleted(course) && openCourseIds.has(course.id))
            .map(course => ({ id: course.id, name: course.name || '' })));
    }
    validateAdmin(req, res, () => {
        const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
        const courses = db.memory.courses || [];
        res.json(includeDeleted ? courses : courses.filter(c => !isCourseDeleted(c)));
    });
});

router.post('/api/courses', (req, res) => {
    validateAdminPermission(req, res, 'course.manage', () => {
        const newCourse = { ...req.body };
        if (!newCourse.id || !newCourse.name) {
            return res.status(400).json({ error: 'ID e Nome são obrigatórios.' });
        }
        if (newCourse.branding !== undefined) {
            if (rejectInvalidBranding(res, newCourse.branding)) return;
            newCourse.branding = extractBranding(newCourse.branding);
        }
        if (!db.memory.courses) db.memory.courses = [];
        const existing = db.memory.courses.find(c => c.id === newCourse.id);
        if (existing) {
            return res.status(400).json({ error: 'Já existe um curso com esse ID.' });
        }
        if (!newCourse.structure) newCourse.structure = [];
        newCourse.status = newCourse.status || 'active';
        newCourse.deleted = false;
        newCourse.deletedAt = null;
        db.memory.courses.push(newCourse);
        db.save();
        res.json({ success: true, course: newCourse });
    });
});
router.put('/api/courses/:id', (req, res) => {
    validateAdminPermission(req, res, 'course.manage', () => {
        const courseId = req.params.id;
        if (!db.memory.courses) db.memory.courses = [];
        const idx = db.memory.courses.findIndex(c => c.id === courseId);
        if (idx === -1) {
            return res.status(404).json({ error: 'Curso não encontrado.' });
        }
        const patch = { ...req.body };
        if (patch.branding !== undefined) {
            if (rejectInvalidBranding(res, patch.branding)) return;
            patch.branding = { ...(db.memory.courses[idx].branding || {}), ...extractBranding(patch.branding) };
        }
        db.memory.courses[idx] = { ...db.memory.courses[idx], ...patch, id: courseId };
        db.save();
        res.json({ success: true, course: db.memory.courses[idx] });
    });
});

router.delete('/api/courses/:id', (req, res) => {
    validateAdminPermission(req, res, 'course.manage', () => {
        const courseId = req.params.id;
        if (!db.memory.courses) db.memory.courses = [];
        const idx = db.memory.courses.findIndex(c => c.id === courseId);
        if (idx === -1) {
            return res.status(404).json({ error: 'Curso nÃ£o encontrado.' });
        }
        db.memory.courses[idx] = {
            ...db.memory.courses[idx],
            status: 'deleted',
            deleted: true,
            deletedAt: new Date().toISOString()
        };
        db.save();
        res.json({ success: true, course: db.memory.courses[idx] });
    });
});
module.exports = router;
