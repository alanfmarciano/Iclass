const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../database.js');
const { validateAdmin, isProfessorAccount } = require('../middlewares.js');
const runtimePaths = require('../runtimePaths.js');
const { resolveInside, assertSafeId } = require('../utils/safePath.js');

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
            if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores podem excluir definitivamente.' });
            const courseId = req.params.id;
            const course = (db.memory.courses || []).find(item => item.id === courseId);
            if (!course) return res.status(404).json({ error: 'Curso nao encontrado.' });

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
                    },
                }, null, 2));
            } catch (error) {
                return res.status(500).json({ error: `Falha ao gravar o arquivo: ${error.message}` });
            }

            db.memory.courses = (db.memory.courses || []).filter(item => item.id !== courseId);
            db.memory.classes = classes.filter(item => item.courseId !== courseId);
            db.memory.submissions = (db.memory.submissions || []).filter(item => !(item.courseId === courseId || classNames.has(item.studentClass)));
            db.memory.students = (db.memory.students || []).filter(student => !orphanEmails.has(String(student.email || '').toLowerCase()));
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

            await db.save();
            res.json({ success: true, folder: folderName, counts: { turmas: courseClasses.length, alunos: orphanStudents.length, submissoes: submissions.length } });
        });
    });

    router.get('/api/admin/archived-courses', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (isProfessorAccount(matchedAdmin) || !fs.existsSync(ARCHIVE_DIR)) return res.json([]);
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
            if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores.' });
            let directory;
            try { directory = archiveDirectory(String(req.body.folder || '')); } catch (error) { return res.status(400).json({ error: 'Pasta invalida.' }); }
            if (!directory) return res.status(404).json({ error: 'Arquivo nao encontrado.' });
            const courseFile = path.join(directory, 'curso.json');
            if (!fs.existsSync(courseFile)) return res.status(404).json({ error: 'Arquivo nao encontrado.' });

            let bundle;
            try { bundle = JSON.parse(fs.readFileSync(courseFile, 'utf8')); } catch (error) { return res.status(500).json({ error: 'Arquivo corrompido.' }); }
            const course = bundle.course;
            if (!course || !course.id) return res.status(400).json({ error: 'Curso invalido no arquivo.' });
            if ((db.memory.courses || []).some(item => item.id === course.id)) return res.status(400).json({ error: 'Ja existe um curso ativo com este ID.' });

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
                if (!existingEmails.has(String(item.email || '').toLowerCase())) db.memory.students.push(item);
            });
            ['progress', 'notes', 'annotations'].forEach(collection => {
                if (bundle[collection]) {
                    db.memory[collection] = db.memory[collection] || {};
                    Object.assign(db.memory[collection], bundle[collection]);
                }
            });
            await db.save();
            try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) {}
            res.json({ success: true, course });
        });
    });

    router.post('/api/admin/archived-courses/delete', (req, res) => {
        validateAdmin(req, res, (config, matchedAdmin) => {
            if (isProfessorAccount(matchedAdmin)) return res.status(403).json({ error: 'Apenas administradores.' });
            let directory;
            try { directory = archiveDirectory(String(req.body.folder || '')); } catch (error) { return res.status(400).json({ error: 'Pasta invalida.' }); }
            if (!directory) return res.status(404).json({ error: 'Arquivo nao encontrado.' });
            try { fs.rmSync(directory, { recursive: true, force: true }); } catch (error) { return res.status(500).json({ error: error.message }); }
            res.json({ success: true });
        });
    });

    return router;
}

module.exports = { createAdminArchiveRouter };
