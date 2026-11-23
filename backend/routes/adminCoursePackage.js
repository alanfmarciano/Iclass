// Pacote de curso pelo painel (fase 3, P4-S14: CRIT-06; D25 a D27 do desenho P4). A
// lógica fica em utils/coursePackage.js; aqui ficam as rotas, o envio do arquivo, o
// escopo e a auditoria.
//
// GET  /api/admin/courses/:id/package      baixa o .iclass-curso.zip do curso
// POST /api/admin/course-packages/preview  confere o pacote enviado e mostra o que entra
// POST /api/admin/course-packages/import   importa (tudo ou nada), com o sha256 da prévia
//
// Regras:
// - Permissão course.manage no guarda (adminPermissions.js) e de novo aqui; o curso do
//   caminho passa pelo escopo da conta (adminCanAccessCourse). A coordenação, só de
//   consulta, recebe 403 read_only_account no guarda ao enviar.
// - O pacote leva as provas com os gabaritos (D26): a tela avisa antes de baixar e a
//   exportação fica na auditoria (course_package_exported).
// - O envio (multipart, campo "arquivo", só .zip, até 200 MB) vai para uma pasta de
//   DATA_DIR só dele e é apagado no fim, com ou sem sucesso: nada do arquivo fica guardado.
// - Importar pede o sha256 que a prévia devolveu (arquivo diferente: 409 import_changed),
//   o código novo (as regras do "Duplicar": letras sem acento, números, '-' e '_') e o
//   nome; a escola de destino, para quem não é administrador, precisa ser uma das
//   atribuídas à conta (como no "Duplicar"); a prévia devolve essas escolas
//   (escolasPermitidas) para a tela oferecer só elas. A gravação é uma só, com a
//   auditoria (course_package_imported) junto; se ela falhar, o curso e a entrada da
//   auditoria saem da memória e os arquivos novos são apagados.
// - Turma modelo com o nome de uma turma em que há aluno com a matrícula antiga só pelo
//   nome não é criada (os alunos entrariam nela): a prévia avisa e a resposta diz quais.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../database.js');
const runtimePaths = require('../runtimePaths.js');
const {
    validateAdmin,
    adminAssignedSchoolIds,
    adminCanAccessCourse,
    guarded,
    sendInternalError,
    sendRouteError,
    studentBelongsToClass,
} = require('../middlewares.js');
const { accountScopeKind, outOfScopeMessage } = require('../utils/adminRoles.js');
const { canAccessAdminPermission } = require('../utils/adminPermissions.js');
const { recordAudit } = require('../utils/audit.js');
const { body, oneOf, str } = require('../utils/inputSchema.js');
const {
    CoursePackageError,
    PACKAGE_LIMITS,
    exportCoursePackage,
    importCoursePackage,
    previewCoursePackage,
} = require('../utils/coursePackage.js');
const { courseIdError, parseCourseName, schoolExists } = require('./adminCourses.js');

const INBOX_DIR = path.join(runtimePaths.DATA_DIR, '.pacotes-curso', 'envios');
const INBOX_STALE_MS = 60 * 60 * 1000;
const PACKAGE_MISSING_MESSAGE = 'Envie o arquivo do pacote de curso (.iclass-curso.zip).';

const IMPORT_SCHEMA = body({
    sha256: str({ required: true, pattern: /^[a-f0-9]{64}$/i, label: 'conferência do arquivo' }),
    newId: str({ required: true, max: 64, label: 'código do curso' }),
    newName: str({ required: true, max: 120, label: 'nome do curso' }),
    schoolId: str({ nullable: true, max: 100, label: 'escola' }),
    incluirTurmasModelo: oneOf(['sim', 'nao', 'true', 'false', '1', '0'], { nullable: true, label: 'turmas modelo' }),
});

function actorEmail(account) {
    return (account && (account.email || account.name)) || 'Administrador';
}

function sendPackageError(error, req, res) {
    if (error instanceof CoursePackageError) {
        return res.status(error.status || 400).json(error.toResponse());
    }
    return sendRouteError(error, req, res);
}

function discard(file) {
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch (error) { /* segue */ }
}

// Envio que caiu no meio e ficou na pasta (queda do servidor): sai depois de 1 hora.
function cleanInbox(now = Date.now()) {
    let names = [];
    try { names = fs.readdirSync(INBOX_DIR); } catch (error) { return; }
    names.forEach(name => {
        const full = path.join(INBOX_DIR, name);
        try { if (now - fs.statSync(full).mtimeMs > INBOX_STALE_MS) fs.rmSync(full, { force: true }); } catch (error) { /* segue */ }
    });
}

function createAdminCoursePackageRouter({ uploadErrorMessage, isUploadRequestError } = {}) {
    const router = express.Router();

    function packageUpload() {
        const storage = multer.diskStorage({
            destination: (req, file, cb) => {
                fs.promises.mkdir(INBOX_DIR, { recursive: true }).then(() => cb(null, INBOX_DIR), cb);
            },
            filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.zip`),
        });
        return multer({
            storage,
            limits: { fileSize: PACKAGE_LIMITS.maxBytes, files: 1, fields: 10 },
            fileFilter: (req, file, cb) => {
                if (path.extname(String(file.originalname || '')).toLowerCase() !== '.zip') {
                    return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
                }
                cb(null, true);
            },
        }).single('arquivo');
    }

    // Recebe o pacote e devolve o arquivo gravado, ou null quando já respondeu.
    function receivePackage(req, res) {
        cleanInbox();
        return new Promise(resolve => {
            packageUpload()(req, res, guarded(req, res, async error => {
                if (error) {
                    if (req.file) discard(req.file.path);
                    if (error.code === 'LIMIT_FILE_SIZE') {
                        res.status(413).json({ success: false, error: 'O pacote passa do limite de 200 MB.', code: 'package_too_large' });
                    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
                        res.status(400).json({ success: false, error: 'Envie o arquivo .iclass-curso.zip baixado em "Exportar curso".', code: 'not_course_package' });
                    } else if (isUploadRequestError && isUploadRequestError(error)) {
                        res.status(400).json({ success: false, error: uploadErrorMessage ? uploadErrorMessage(error) : 'Erro no envio do pacote.' });
                    } else {
                        sendInternalError(error, req, res, 'Falha ao gravar no disco o pacote enviado.');
                    }
                    return resolve(null);
                }
                if (!req.file) {
                    res.status(400).json({ success: false, error: PACKAGE_MISSING_MESSAGE, code: 'package_missing' });
                    return resolve(null);
                }
                resolve({ path: req.file.path, originalName: String(req.file.originalname || '').slice(0, 200), size: req.file.size || 0 });
            }));
        });
    }

    // Escolas para onde a conta pode importar (a mesma regra do "Duplicar"): todas para
    // quem tem escopo total; senão só as atribuídas à conta.
    function importSchools(account) {
        const schools = (db.memory.schools || []).filter(Boolean);
        if (accountScopeKind(account) === 'tudo') return schools.map(school => String(school.id));
        const assigned = new Set(adminAssignedSchoolIds(account).map(String));
        return schools.map(school => String(school.id)).filter(id => assigned.has(id));
    }

    function refuseWithoutPermission(res, account) {
        if (canAccessAdminPermission(account, 'course.manage')) return false;
        res.status(403).json({ success: false, error: 'Sua conta não possui permissão para esta operação.' });
        return true;
    }

    router.get('/api/admin/courses/:id/package', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (refuseWithoutPermission(res, matchedAdmin)) return;
            const courseId = String(req.params.id || '');
            const course = (db.memory.courses || []).find(item => item && item.id === courseId);
            if (!course) return res.status(404).json({ success: false, error: 'Curso não encontrado.' });
            if (!adminCanAccessCourse(matchedAdmin, course.id)) {
                return res.status(403).json({ success: false, error: outOfScopeMessage(matchedAdmin, 'O curso solicitado') });
            }
            let built;
            try {
                built = await exportCoursePackage(db.memory, course.id);
            } catch (error) {
                return sendPackageError(error, req, res);
            }
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_package_exported',
                category: 'academic',
                courseId: course.id,
                details: {
                    arquivos: built.arquivos,
                    bytes: built.bytes,
                    contagens: built.contagens,
                    ...(built.foraDoPacote.length ? { foraDoPacote: built.foraDoPacote.slice(0, 50) } : {}),
                },
            });
            await db.save({ only: ['auditLogs'] });
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${built.fileName}"`);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-IClass-Fora-Do-Pacote', String(built.foraDoPacote.length));
            res.send(built.buffer);
        });
    });

    router.post('/api/admin/course-packages/preview', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (refuseWithoutPermission(res, matchedAdmin)) return;
            const upload = await receivePackage(req, res);
            if (!upload) return;
            try {
                const preview = await previewCoursePackage({ path: upload.path }, { memory: db.memory, studentBelongsToClass });
                res.json({ success: true, arquivo: upload.originalName, ...preview, escolasPermitidas: importSchools(matchedAdmin) });
            } catch (error) {
                sendPackageError(error, req, res);
            } finally {
                discard(upload.path);
            }
        });
    });

    router.post('/api/admin/course-packages/import', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (refuseWithoutPermission(res, matchedAdmin)) return;
            const upload = await receivePackage(req, res);
            if (!upload) return;
            try {
                if (!IMPORT_SCHEMA.check(req, res)) return;
                const fields = req.body;
                const newId = fields.newId.trim().toUpperCase();
                const idError = courseIdError(newId);
                if (idError) return res.status(400).json({ success: false, error: idError, field: 'newId' });
                const parsedName = parseCourseName(fields.newName);
                if (parsedName.error) return res.status(400).json({ success: false, error: parsedName.error, field: 'newName' });
                if ((db.memory.courses || []).some(course => course && String(course.id).toLowerCase() === newId.toLowerCase())) {
                    return res.status(400).json({ success: false, error: 'Já existe um curso com esse código.', field: 'newId', code: 'course_exists' });
                }
                const fullScope = accountScopeKind(matchedAdmin) === 'tudo';
                const assignedSchools = fullScope ? [] : adminAssignedSchoolIds(matchedAdmin).map(String);
                const requestedSchool = typeof fields.schoolId === 'string' ? fields.schoolId.trim() : '';
                const schoolId = requestedSchool
                    || (fullScope ? String(((db.memory.schools || []).find(Boolean) || {}).id || 'escola_default') : (assignedSchools[0] || ''));
                if (!fullScope && !assignedSchools.includes(schoolId)) {
                    return res.status(403).json({ success: false, error: 'Você só pode importar curso para uma escola atribuída à sua conta.', field: 'schoolId' });
                }
                if (requestedSchool && !schoolExists(requestedSchool)) {
                    return res.status(400).json({ success: false, error: 'Escola não encontrada.', field: 'schoolId' });
                }
                let result;
                try {
                    result = await importCoursePackage({ path: upload.path }, {
                        memory: db.memory,
                        newId,
                        newName: parsedName.value,
                        schoolId,
                        incluirTurmasModelo: ['sim', 'true', '1'].includes(fields.incluirTurmasModelo),
                        actorEmail: actorEmail(matchedAdmin),
                        expectedSha256: fields.sha256,
                        studentBelongsToClass,
                    });
                } catch (error) {
                    return sendPackageError(error, req, res);
                }
                const entry = recordAudit(db.memory, {
                    req,
                    actor: matchedAdmin,
                    action: 'course_package_imported',
                    category: 'academic',
                    courseId: result.course.id,
                    details: {
                        origemNome: result.origem.nome,
                        origemCodigo: result.origem.codigo,
                        versaoFormato: result.origem.versaoFormato,
                        versaoApp: result.origem.versaoApp,
                        arquivo: upload.originalName,
                        sha256: result.sha256,
                        schoolId,
                        contagens: result.contagens,
                        turmasModelo: result.classes.map(cls => cls.name),
                        renomeadas: result.renomeadas.length,
                        ...(result.renomeadas.length ? { exemplosRenomeadas: result.renomeadas.slice(0, 20) } : {}),
                        arquivosRenomeados: result.arquivosRenomeados.length,
                        ...(result.turmasPuladas.length ? { turmasPuladas: result.turmasPuladas } : {}),
                    },
                });
                try {
                    // Uma gravação só: o curso e a auditoria entram juntos ou nenhum entra.
                    await db.save({ only: ['courses', 'classes', 'evaluations', 'library', 'questionBank', 'auditLogs'] });
                } catch (error) {
                    // Nada fica pela metade: o curso e a entrada da auditoria (que nunca foi
                    // gravada) saem da memória e os arquivos novos saem do disco; a tela
                    // recebe o 503 de "tente de novo".
                    result.undo();
                    const audits = Array.isArray(db.memory.auditLogs) ? db.memory.auditLogs : [];
                    const at = audits.indexOf(entry);
                    if (at >= 0) audits.splice(at, 1);
                    return sendInternalError(error, req, res, 'Falha ao gravar o curso importado.');
                }
                res.json({
                    success: true,
                    course: result.course,
                    classes: result.classes.map(cls => ({ name: cls.name, courseId: cls.courseId, period: cls.period })),
                    contagens: result.contagens,
                    renomeadas: result.renomeadas.length,
                    arquivosRenomeados: result.arquivosRenomeados.length,
                    arquivosReaproveitados: result.arquivosReaproveitados,
                    turmasPuladas: result.turmasPuladas,
                    avisos: result.avisos,
                });
            } finally {
                discard(upload.path);
            }
        });
    });

    return router;
}

module.exports = { createAdminCoursePackageRouter };
