// Escrita de curso pelo painel do instrutor (SEG-12): criar, alterar e excluir em
// /api/admin/courses. Antes ficavam em /api/courses (common.js), fora da guarda de
// /api/admin: o professor com course.manage alterava e excluía curso de outra
// coordenação, e o PUT copiava o corpo inteiro para o curso (schoolId, structure ou
// qualquer outro campo). Agora:
// - passam pelo adminRbacGuard (troca obrigatória de senha, course.manage e escopo do
//   professor; o id do caminho é conferido em validateProfessorRequestScope);
// - só os campos permitidos são gravados: nome, descrição, escola (que o professor não
//   muda), identidade visual e restaurar um curso excluído. A estrutura continua só pela
//   rota /api/admin/courses/:id/structure;
// - cada mudança fica na trilha de auditoria (course_created, course_updated,
//   course_deleted; o curso duplicado é course_cloned, na rota /clone de admin.js).
// As rotas antigas de escrita em /api/courses respondem 410 (common.js). Os campos que a
// atribuição em massa já gravou num curso ficam onde estão: só deixam de ser graváveis.
const express = require('express');
const db = require('../database.js');
const {
    validateAdminPermission,
    isProfessorAccount,
    adminAssignedSchoolIds,
    adminCanAccessCourse,
} = require('../middlewares.js');
const { recordAudit } = require('../utils/audit.js');
const { extractBranding, validateBrandingPatch } = require('../utils/branding.js');
const { isCourseDeleted } = require('../utils/contentAccess.js');
const { isInheritedKey } = require('../utils/ownEntry.js');

// O código do curso entra em nomes de arquivo do conteúdo duplicado
// (<chave>_<código>.md) e em chaves de mapa: só letras sem acento, números, '-' e '_'.
const COURSE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COURSE_NAME_MAX = 120;
const COURSE_DESCRIPTION_MAX = 2000;

// Erro de campo no formato das validações de entrada: 400 { success, error, field }.
function sendFieldError(res, error, field, status = 400) {
    return res.status(status).json({ success: false, error, field });
}

function courseIdError(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    if (!COURSE_ID_PATTERN.test(id) || isInheritedKey(id)) {
        return 'O código do curso aceita só letras sem acento, números, "-" e "_", com até 64 caracteres.';
    }
    return null;
}

function parseCourseName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > COURSE_NAME_MAX) return { error: `O nome do curso precisa ter de 1 a ${COURSE_NAME_MAX} caracteres.` };
    return { value: name };
}

function parseCourseDescription(value) {
    if (value === null) return { value: '' };
    if (typeof value !== 'string') return { error: 'A descrição do curso precisa ser um texto.' };
    const description = value.trim();
    if (description.length > COURSE_DESCRIPTION_MAX) return { error: 'A descrição do curso pode ter até 2.000 caracteres.' };
    return { value: description };
}

function parseSchoolId(value) {
    if (value === undefined || value === null) return { value: '' };
    if (typeof value !== 'string') return { error: 'Escola inválida.' };
    return { value: value.trim() };
}

function schoolExists(schoolId) {
    return (db.memory.schools || []).some(school => school && String(school.id) === schoolId);
}

// Identidade visual do curso: objeto validado como hoje (validateBrandingPatch) e gravado
// em merge (extractBranding). Devolve true quando já respondeu o erro.
function rejectInvalidCourseBranding(res, branding) {
    if (!branding || typeof branding !== 'object' || Array.isArray(branding)) {
        sendFieldError(res, 'Identidade visual do curso inválida.', 'branding');
        return true;
    }
    const validationError = validateBrandingPatch(branding);
    if (!validationError) return false;
    res.status(400).json({ success: false, error: validationError.message, code: validationError.code, field: validationError.field });
    return true;
}

// O que a auditoria guarda do curso: só os campos que estas rotas gravam. A estrutura e a
// identidade visual ficam de fora (a logo pode ser uma imagem inteira); da identidade
// visual entram só os nomes do que mudou (details.brandingKeys).
function courseAuditView(course) {
    return {
        id: course.id,
        name: course.name || '',
        description: course.description || '',
        schoolId: course.schoolId || '',
        status: course.status || 'active',
        deleted: course.deleted === true,
        deletedAt: course.deletedAt || null,
    };
}

function changedBrandingKeys(previous, next) {
    const before = previous && typeof previous === 'object' ? previous : {};
    const after = next && typeof next === 'object' ? next : {};
    return Object.keys({ ...before, ...after })
        .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function findCourseIndex(courseId) {
    return (db.memory.courses || []).findIndex(course => course && course.id === courseId);
}

function createAdminCoursesRouter() {
    const router = express.Router();

    router.post('/api/admin/courses', (req, res) => {
        validateAdminPermission(req, res, 'course.manage', (config, matchedAdmin) => {
            const body = req.body || {};
            const idError = courseIdError(body.id);
            if (idError) return sendFieldError(res, idError, 'id');
            const id = body.id.trim();
            const name = parseCourseName(body.name);
            if (name.error) return sendFieldError(res, name.error, 'name');
            const description = body.description === undefined ? { value: '' } : parseCourseDescription(body.description);
            if (description.error) return sendFieldError(res, description.error, 'description');
            const school = parseSchoolId(body.schoolId);
            if (school.error) return sendFieldError(res, school.error, 'schoolId');
            // O professor só cria curso numa escola atribuída a ele: fora dela, o curso
            // nasceria fora do escopo da própria conta.
            if (isProfessorAccount(matchedAdmin) && !adminAssignedSchoolIds(matchedAdmin).includes(school.value)) {
                return sendFieldError(res, 'Você só pode criar curso numa escola atribuída à sua conta.', 'schoolId', 403);
            }
            if (school.value && !schoolExists(school.value)) return sendFieldError(res, 'Escola não encontrada.', 'schoolId');
            if (body.branding !== undefined && rejectInvalidCourseBranding(res, body.branding)) return;
            if (!Array.isArray(db.memory.courses)) db.memory.courses = [];
            if (findCourseIndex(id) !== -1) return sendFieldError(res, 'Já existe um curso com esse código.', 'id');

            // A estrutura começa sempre vazia: módulos e unidades vêm pelo editor.
            const course = {
                id,
                name: name.value,
                description: description.value,
                schoolId: school.value,
                structure: [],
                status: 'active',
                deleted: false,
                deletedAt: null,
            };
            if (body.branding !== undefined) course.branding = extractBranding(body.branding);
            db.memory.courses.push(course);
            const brandingKeys = changedBrandingKeys({}, course.branding);
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_created',
                category: 'academic',
                courseId: id,
                after: courseAuditView(course),
                details: brandingKeys.length ? { brandingKeys } : undefined,
            });
            db.save();
            res.json({ success: true, course });
        });
    });

    router.put('/api/admin/courses/:id', (req, res) => {
        validateAdminPermission(req, res, 'course.manage', (config, matchedAdmin) => {
            const courseId = req.params.id;
            const index = findCourseIndex(courseId);
            if (index === -1) return res.status(404).json({ error: 'Curso não encontrado.' });
            if (!adminCanAccessCourse(matchedAdmin, courseId)) {
                return res.status(403).json({ error: 'O curso solicitado não pertence às turmas atribuídas a esta conta.' });
            }
            const course = db.memory.courses[index];
            const body = req.body || {};
            const patch = {};
            if (body.name !== undefined) {
                const name = parseCourseName(body.name);
                if (name.error) return sendFieldError(res, name.error, 'name');
                patch.name = name.value;
            }
            if (body.description !== undefined) {
                const description = parseCourseDescription(body.description);
                if (description.error) return sendFieldError(res, description.error, 'description');
                patch.description = description.value;
            }
            if (body.schoolId !== undefined) {
                const school = parseSchoolId(body.schoolId);
                if (school.error) return sendFieldError(res, school.error, 'schoolId');
                // A mesma escola (a tela manda a atual junto com o nome) não é mudança.
                if (school.value !== String(course.schoolId || '')) {
                    if (isProfessorAccount(matchedAdmin)) {
                        return sendFieldError(res, 'Só o administrador pode mudar a escola do curso.', 'schoolId', 403);
                    }
                    if (!school.value) return sendFieldError(res, 'Escolha a escola do curso.', 'schoolId');
                    if (!schoolExists(school.value)) return sendFieldError(res, 'Escola não encontrada.', 'schoolId');
                    patch.schoolId = school.value;
                }
            }
            if (body.branding !== undefined && rejectInvalidCourseBranding(res, body.branding)) return;
            // Restaurar um curso excluído ("Restaurar" em Cursos e turmas).
            if (isCourseDeleted(course) && (body.deleted === false || body.status === 'active')) {
                patch.status = 'active';
                patch.deleted = false;
                patch.deletedAt = null;
            }
            // O resto do corpo (structure, id, clonedFrom ou qualquer outro campo) é ignorado.

            const before = courseAuditView(course);
            const previousBranding = { ...(course.branding || {}) };
            const updated = { ...course, ...patch, id: course.id };
            if (body.branding !== undefined) updated.branding = { ...previousBranding, ...extractBranding(body.branding) };
            const after = courseAuditView(updated);
            const brandingKeys = changedBrandingKeys(previousBranding, updated.branding);
            const changed = JSON.stringify(before) !== JSON.stringify(after) || brandingKeys.length > 0;
            if (!changed) return res.json({ success: true, course });
            db.memory.courses[index] = updated;
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_updated',
                category: 'academic',
                courseId: course.id,
                before,
                after,
                details: brandingKeys.length ? { brandingKeys } : undefined,
            });
            db.save();
            res.json({ success: true, course: updated });
        });
    });

    // Excluir curso: marca como excluído e preserva tudo para "Restaurar"; apagar de vez
    // é o arquivamento (/api/admin/courses/:id/purge, só administrador).
    router.delete('/api/admin/courses/:id', (req, res) => {
        validateAdminPermission(req, res, 'course.manage', (config, matchedAdmin) => {
            const courseId = req.params.id;
            const index = findCourseIndex(courseId);
            if (index === -1) return res.status(404).json({ error: 'Curso não encontrado.' });
            if (!adminCanAccessCourse(matchedAdmin, courseId)) {
                return res.status(403).json({ error: 'O curso solicitado não pertence às turmas atribuídas a esta conta.' });
            }
            const course = db.memory.courses[index];
            // Já excluído: nada muda (nem a data da exclusão) e nada vai para a trilha.
            if (isCourseDeleted(course)) return res.json({ success: true, course });
            const before = courseAuditView(course);
            const updated = {
                ...course,
                status: 'deleted',
                deleted: true,
                deletedAt: new Date().toISOString(),
            };
            db.memory.courses[index] = updated;
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_deleted',
                category: 'academic',
                courseId: course.id,
                before,
                after: courseAuditView(updated),
            });
            db.save();
            res.json({ success: true, course: updated });
        });
    });

    return router;
}

module.exports = {
    createAdminCoursesRouter,
    courseIdError,
    parseCourseName,
    schoolExists,
    COURSE_ID_PATTERN,
};
