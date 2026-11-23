const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, sendInternalError } = require('../middlewares.js');
const { isFullAdmin } = require('../utils/adminRoles.js');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside, assertSafeId } = require('../utils/safePath.js');
const { revokeStudentSession } = require('../utils/authSessions.js');
const { recordAudit } = require('../utils/audit.js');
const { assignStudentId, studentIdsByEmail } = require('../utils/studentIdentity.js');
const { relinkRecordsByEmail } = require('../utils/studentDataHandlers.js');
// Tarefas e entregas do curso (fase 3, C10 / P1-h, D14): os registros vão no pacote e os
// arquivos para data/entregas/_cursos_arquivados/<pasta> (fora do ZIP de backup).
const assignmentLifecycle = require('../utils/assignmentLifecycle.js');

const ARCHIVE_DIR = runtimePaths.ARCHIVE_DIR;

function archiveDirectory(folder) {
    const safeFolder = assertSafeId(folder);
    const directory = resolveInside(ARCHIVE_DIR, safeFolder);
    const manifest = path.join(directory, 'manifesto.json');
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory() || !fs.existsSync(manifest)) return null;
    return directory;
}

function courseContentKeys(course) {
    const keys = new Set();
    (course.structure || []).forEach(module => (module.units || module.items || []).forEach(unit => {
        if (unit.apostilaKey) keys.add(unit.apostilaKey);
        if (unit.avaliacaoKey) keys.add(unit.avaliacaoKey);
    }));
    return [...keys];
}

function contentFilePath(key) {
    return path.join(runtimePaths.CONTENT_DIR, `${key}.md`);
}

function pickByEmails(collection, emailSet) {
    const selected = {};
    Object.keys(collection || {}).forEach(key => {
        if (emailSet.has(String(key).toLowerCase())) selected[key] = collection[key];
    });
    return selected;
}

function createAdminArchiveRouter({ studentClassNames }) {
    if (typeof studentClassNames !== 'function') throw new Error('Dependência studentClassNames inválida para adminArchive.');
    const router = express.Router();

    router.post('/api/admin/courses/:id/purge', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!isFullAdmin(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores podem excluir definitivamente.' });
            const courseId = req.params.id;
            const course = (db.memory.courses || []).find(item => item.id === courseId);
            if (!course) return res.status(404).json({ error: 'Curso não encontrado.' });

            const classes = db.memory.classes || [];
            const courseClasses = classes.filter(item => item.courseId === courseId);
            const classNames = new Set(courseClasses.map(item => item.name));
            const submissions = (db.memory.submissions || []).filter(item => item.courseId === courseId || classNames.has(item.studentClass));
            const relatedStudents = (db.memory.students || []).filter(student => studentClassNames(student).some(name => classNames.has(name)));
            const orphanStudents = relatedStudents.filter(student => {
                const names = studentClassNames(student);
                return names.length > 0 && names.every(name => classNames.has(name));
            });
            const orphanEmails = new Set(orphanStudents.map(student => String(student.email || '').toLowerCase()));

            const contentFiles = {};
            courseContentKeys(course).forEach(key => {
                const file = contentFilePath(key);
                if (fs.existsSync(file)) {
                    try { contentFiles[`${key}.md`] = fs.readFileSync(file, 'utf8'); } catch (error) {}
                }
            });

            // Tarefas e entregas (C10): todas as do curso, de qualquer aluno, como as provas.
            const courseTasks = assignmentLifecycle.courseAssignmentRecords(db.memory, courseId);
            const taskIds = courseTasks.assignments.map(item => item.id);
            const taskFiles = courseTasks.assignmentSubmissions.reduce((sum, sub) => sum + (sub.versions || []).reduce((n, version) => n + ((version && version.files) || []).length, 0), 0);

            const bundle = {
                archivedAt: new Date().toISOString(),
                archivedBy: matchedAdmin.email || 'admin',
                course,
                classes: courseClasses,
                submissions,
                students: orphanStudents,
                progress: pickByEmails(db.memory.progress, orphanEmails),
                notes: pickByEmails(db.memory.notes, orphanEmails),
                annotations: pickByEmails(db.memory.annotations, orphanEmails),
                assignments: courseTasks.assignments,
                assignmentSubmissions: courseTasks.assignmentSubmissions,
            };

            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const folderName = `${courseId}__${stamp}`;
            const directory = path.join(ARCHIVE_DIR, folderName);
            try {
                fs.mkdirSync(path.join(directory, 'conteudo'), { recursive: true });
                fs.writeFileSync(path.join(directory, 'curso.json'), JSON.stringify(bundle, null, 2));
                Object.entries(contentFiles).forEach(([filename, text]) => fs.writeFileSync(path.join(directory, 'conteudo', filename), text));
                fs.writeFileSync(path.join(directory, 'manifesto.json'), JSON.stringify({
                    folder: folderName,
                    courseId,
                    name: course.name,
                    schoolId: course.schoolId || null,
                    archivedAt: bundle.archivedAt,
                    archivedBy: bundle.archivedBy,
                    counts: {
                        turmas: courseClasses.length,
                        alunos: orphanStudents.length,
                        submissoes: submissions.length,
                        arquivos: Object.keys(contentFiles).length,
                        tarefas: courseTasks.assignments.length,
                        entregas: courseTasks.assignmentSubmissions.length,
                        arquivosEntregas: taskFiles,
                    },
                    // Onde ficam os arquivos das entregas (relativo a data/entregas).
                    entregas: taskFiles ? `${assignmentLifecycle.COURSE_ARCHIVE_SEGMENT}/${folderName}` : null,
                }, null, 2));
            } catch (error) {
                // O detalhe (caminho, código do sistema) fica no crash.log; a tela recebe a
                // mensagem padrão com o código do erro (ENG-04).
                return sendInternalError(error, req, res);
            }

            db.memory.courses = (db.memory.courses || []).filter(item => item.id !== courseId);
            db.memory.classes = classes.filter(item => item.courseId !== courseId);
            db.memory.submissions = (db.memory.submissions || []).filter(item => !(item.courseId === courseId || classNames.has(item.studentClass)));
            db.memory.students = (db.memory.students || []).filter(student => !orphanEmails.has(String(student.email || '').toLowerCase()));
            const archivedTasks = new Set(courseTasks.assignments);
            const archivedSubs = new Set(courseTasks.assignmentSubmissions);
            db.memory.assignments = (db.memory.assignments || []).filter(item => !archivedTasks.has(item));
            db.memory.assignmentSubmissions = (db.memory.assignmentSubmissions || []).filter(item => !archivedSubs.has(item));
            // Os alunos que saíram com o curso perdem a sessão (também na tabela
            // auth_sessions, H3a-2): ela não volta num reinício nem quando o curso arquivado
            // for restaurado com eles.
            orphanEmails.forEach(email => revokeStudentSession(db.memory, email));
            db.memory.students.forEach(student => {
                if (Array.isArray(student.classes)) student.classes = student.classes.filter(item => !classNames.has(typeof item === 'string' ? item : (item && item.name)));
                if (student.studentClass && classNames.has(student.studentClass)) {
                    const first = student.classes && student.classes[0];
                    student.studentClass = first ? (typeof first === 'string' ? first : first.name) : '';
                }
            });
            ['progress', 'notes', 'annotations'].forEach(collection => {
                if (db.memory[collection]) Object.keys(db.memory[collection]).forEach(key => {
                    if (orphanEmails.has(String(key).toLowerCase())) delete db.memory[collection][key];
                });
            });
            courseContentKeys(course).forEach(key => {
                const file = contentFilePath(key);
                if (fs.existsSync(file)) {
                    try { fs.unlinkSync(file); } catch (error) {}
                }
            });
            // O que saiu do sistema e para onde foi (SEG-07): a cópia inteira está na pasta.
            const counts = { turmas: courseClasses.length, alunos: orphanStudents.length, submissoes: submissions.length, arquivos: Object.keys(contentFiles).length, tarefas: courseTasks.assignments.length, entregas: courseTasks.assignmentSubmissions.length };
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_archived',
                category: 'academic',
                courseId,
                details: { folder: folderName, name: course.name || '', schoolId: course.schoolId || null, classes: courseClasses.map(item => item.name), counts },
            });

            await db.save();
            // Os arquivos das entregas só mudam de lugar com o curso já fora do banco (nenhum
            // envio novo chega a uma tarefa que saiu). O que não mudar de lugar fica em
            // data/entregas e volta igual na restauração do curso.
            await assignmentLifecycle.archiveCourseAssignmentFiles(taskIds, folderName);
            res.json({ success: true, folder: folderName, counts: { turmas: courseClasses.length, alunos: orphanStudents.length, submissoes: submissions.length, tarefas: courseTasks.assignments.length, entregas: courseTasks.assignmentSubmissions.length } });
        });
    });

    router.get('/api/admin/archived-courses', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (!isFullAdmin(matchedAdmin) || !fs.existsSync(ARCHIVE_DIR)) return res.json([]);
            const items = [];
            fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).forEach(entry => {
                const manifest = path.join(ARCHIVE_DIR, entry.name, 'manifesto.json');
                if (fs.existsSync(manifest)) {
                    try { items.push(JSON.parse(fs.readFileSync(manifest, 'utf8'))); } catch (error) {}
                }
            });
            items.sort((left, right) => String(right.archivedAt || '').localeCompare(String(left.archivedAt || '')));
            res.json(items);
        });
    });

    router.post('/api/admin/archived-courses/restore', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!isFullAdmin(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores.' });
            let directory;
            try { directory = archiveDirectory(String(req.body.folder || '')); } catch (error) { return res.status(400).json({ error: 'Pasta inválida.' }); }
            if (!directory) return res.status(404).json({ error: 'Arquivo não encontrado.' });
            const courseFile = path.join(directory, 'curso.json');
            if (!fs.existsSync(courseFile)) return res.status(404).json({ error: 'Arquivo não encontrado.' });

            let bundle;
            try { bundle = JSON.parse(fs.readFileSync(courseFile, 'utf8')); } catch (error) { return sendInternalError(error, req, res, 'Arquivo corrompido.'); }
            const course = bundle.course;
            if (!course || !course.id) return res.status(400).json({ error: 'Curso inválido no arquivo.' });
            if ((db.memory.courses || []).some(item => item.id === course.id)) return res.status(400).json({ error: 'Já existe um curso ativo com este ID.' });

            const contentDirectory = path.join(directory, 'conteudo');
            if (fs.existsSync(contentDirectory)) {
                fs.readdirSync(contentDirectory).forEach(filename => {
                    try { fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, filename), fs.readFileSync(path.join(contentDirectory, filename), 'utf8')); } catch (error) {}
                });
            }
            course.deleted = false;
            course.status = 'active';
            course.deletedAt = null;
            db.memory.courses = [...(db.memory.courses || []), course];
            const existingClassKeys = new Set((db.memory.classes || []).map(item => `${item.name}::${item.courseId}`));
            (bundle.classes || []).forEach(item => {
                if (!existingClassKeys.has(`${item.name}::${item.courseId}`)) db.memory.classes.push(item);
            });
            const existingSubmissionIds = new Set((db.memory.submissions || []).map(item => item.id));
            (bundle.submissions || []).forEach(item => {
                if (!existingSubmissionIds.has(item.id)) db.memory.submissions.push(item);
            });
            const existingEmails = new Set((db.memory.students || []).map(item => String(item.email || '').toLowerCase()));
            (bundle.students || []).forEach(item => {
                if (existingEmails.has(String(item.email || '').toLowerCase())) return;
                // Id estável (C1 / P4-S3): o do arquivo, se ninguém mais o usa; senão um novo.
                assignStudentId(db.memory, item);
                db.memory.students.push(item);
            });
            ['progress', 'notes', 'annotations'].forEach(collection => {
                if (bundle[collection]) {
                    db.memory[collection] = db.memory[collection] || {};
                    Object.assign(db.memory[collection], bundle[collection]);
                }
            });
            // Tarefas e entregas (C10; pacote de antes do C10 não tem: nada muda). Registro
            // com o mesmo id de um que já existe fica de fora, como as provas; a entrega
            // volta ligada ao id de hoje do aluno (relink pelo e-mail).
            const existingTaskIds = new Set((db.memory.assignments || []).map(item => item && item.id));
            const restoredTasks = (Array.isArray(bundle.assignments) ? bundle.assignments : []).filter(item => item && item.id && !existingTaskIds.has(item.id));
            const existingDeliveryIds = new Set((db.memory.assignmentSubmissions || []).map(item => item && item.id));
            // Anonimizar ou apagar um aluno que já passou e cujo pacote ainda espera a
            // regravação (ela vem depois da gravação do banco): a entrega volta como ficaria.
            const bundleDeliveries = assignmentLifecycle.pendingBundleChangesApplied(path.basename(directory), Array.isArray(bundle.assignmentSubmissions) ? bundle.assignmentSubmissions : []);
            const restoredDeliveries = bundleDeliveries.filter(item => item && item.id && !existingDeliveryIds.has(item.id));
            if (restoredTasks.length) db.memory.assignments = [...(db.memory.assignments || []), ...restoredTasks];
            if (restoredDeliveries.length) {
                relinkRecordsByEmail(db.memory, restoredDeliveries, studentIdsByEmail(db.memory));
                // Aluno que trocou de e-mail com o curso fora: a entrega vai para o e-mail de hoje.
                assignmentLifecycle.followCurrentStudentEmails(db.memory, restoredDeliveries);
                db.memory.assignmentSubmissions = [...(db.memory.assignmentSubmissions || []), ...restoredDeliveries];
            }
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_archive_restored',
                category: 'academic',
                courseId: course.id,
                details: {
                    folder: path.basename(directory),
                    name: course.name || '',
                    counts: {
                        turmas: (bundle.classes || []).length,
                        alunos: (bundle.students || []).length,
                        submissoes: (bundle.submissions || []).length,
                        tarefas: restoredTasks.length,
                        entregas: restoredDeliveries.length,
                    },
                },
            });
            await db.save();
            // Os arquivos das entregas voltam para data/entregas (sem sobrescrever). O que não
            // voltar vai para a lixeira de arquivos antes de o pacote sair (não fica perdido).
            await assignmentLifecycle.restoreCourseAssignmentFiles(path.basename(directory), { deletedBy: matchedAdmin.email || 'admin' });
            try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) {}
            res.json({ success: true, course });
        });
    });

    router.post('/api/admin/archived-courses/delete', (req, res) => {
        validateAdmin(req, res, async (config, matchedAdmin) => {
            if (!isFullAdmin(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores.' });
            let directory;
            try { directory = archiveDirectory(String(req.body.folder || '')); } catch (error) { return res.status(400).json({ error: 'Pasta inválida.' }); }
            if (!directory) return res.status(404).json({ error: 'Arquivo não encontrado.' });
            // O manifesto diz o que foi apagado (curso e contagens), para a auditoria.
            let manifest = {};
            try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifesto.json'), 'utf8')) || {}; } catch (error) { manifest = {}; }
            // As entregas do pacote (C10): os arquivos vão para a lixeira com lápide.
            let bundleDeliveries = [];
            try {
                const bundle = JSON.parse(fs.readFileSync(path.join(directory, 'curso.json'), 'utf8')) || {};
                bundleDeliveries = Array.isArray(bundle.assignmentSubmissions) ? bundle.assignmentSubmissions : [];
            } catch (error) { bundleDeliveries = []; }
            try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) { return sendInternalError(error, req, res); }
            const deliveryFiles = assignmentLifecycle.trashArchivedCourseAssignmentFiles(db.memory, path.basename(directory), bundleDeliveries, { deletedBy: matchedAdmin.email || 'admin' });
            recordAudit(db.memory, {
                req,
                actor: matchedAdmin,
                action: 'course_archive_deleted',
                category: 'academic',
                courseId: manifest.courseId ? String(manifest.courseId) : undefined,
                details: {
                    folder: path.basename(directory),
                    name: String(manifest.name || ''),
                    archivedAt: manifest.archivedAt || null,
                    counts: manifest.counts && typeof manifest.counts === 'object' ? manifest.counts : null,
                    arquivosEntregasNaLixeira: deliveryFiles.arquivos,
                },
            });
            await db.save();
            res.json({ success: true });
        });
    });

    return router;
}

module.exports = { createAdminArchiveRouter };
