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
    sanitizeEvaluationForStudent,
    localIpAddresses,
    validateAdminPermission,
    validateAnySession
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
// Exige sessão (aluno ou instrutor): o arquivo carrega os enunciados das avaliações
// do curso e ficava aberto a qualquer um na rede.
router.get(['/data.js', '/api/data.js'], validateAnySession, async (req, res) => {
    res.set('Content-Type', 'application/javascript');
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

// Serve apostilas e avaliacoes Markdown usadas pelo editor de conteudo.
router.get('/:key.md', async (req, res, next) => {
    const { key } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
        return next();
    }

    if (key.startsWith('Avaliacao_')) {
        return res.status(403).type('text/plain').send('Avaliação não disponível por esta rota.');
    }

    const filePath = path.join(CONTENT_DIR, `${key}.md`);
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        res.type('text/markdown').send(content);
    } catch (err) {
        console.error("DEBUG ERROR LOADING MD:", err, "filePath:", filePath);
        return res.status(404).type('text/plain').send('');
    }
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

router.get('/api/courses', (req, res) => {
    const includeDeleted = req.query.includeDeleted === '1' || req.query.includeDeleted === 'true';
    const courses = db.memory.courses || [];
    res.json(includeDeleted ? courses : courses.filter(c => !isCourseDeleted(c)));
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
            return res.status(404).json({ error: 'Curso não encontrado.' });
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
