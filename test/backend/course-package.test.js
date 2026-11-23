// Pacote de curso: exportar e importar entre instalações (fase 3, P4-S14: CRIT-06;
// decisões D25 a D27 do desenho P4; contrato coursePackage do plano).
// [UC-PACOTE-001] ida e volta numa instalação vazia (outra memória e outras pastas): a
//   mesma estrutura, os mesmos .md (sha256), as mesmas avaliações com os gabaritos, as
//   imagens e os arquivos citados, a biblioteca do curso, as questões do banco ligadas às
//   avaliações e as turmas modelo; pela rota, o ZIP baixado e a auditoria.
// [UC-PACOTE-002] importar na mesma instalação: código novo, chaves renomeadas pela regra
//   do "Duplicar", imagem com o mesmo nome e outro conteúdo renomeada com a referência
//   reescrita, o mesmo arquivo reaproveitado, o curso original intacto; sha256 da prévia,
//   escopo do professor, coordenação só de consulta, falha da gravação desfaz tudo.
// [UC-PACOTE-003] segurança do ZIP: '../', caminho absoluto, link simbólico, arquivo fora
//   de conteudo/ e midia/, sha256 errado, formato mais novo, bomba de descompressão e
//   backup do IClass são recusados com 400 e nada é gravado.
// [UC-PACOTE-004] o pacote não leva alunos, notas, presença nem e-mail.
// O "Duplicar curso" usa o mesmo remapCourseKeys (as suítes do clone continuam passando).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const AdmZip = require('adm-zip');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-course-package-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const coursePackage = require('../../backend/utils/coursePackage.js');
const gradingRules = require('../../backend/utils/gradingRules.js');
const { normalizeEvaluationQuestions } = require('../../backend/utils/questionModel.js');
const { createApp } = require('../../backend/server.js');

let app;
const adminToken = 'admin-token-course-package';
const professorToken = 'professor-token-course-package';
const coordToken = 'coord-token-course-package';
const COURSE = 'REDES';
const OTHER = 'OUTRO';
const CLASS = '1RED';
const PROF = 'prof@pacote.local';
const STUDENT = 'ana.aluna@pacote.local';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-de-teste-123')]);
const PNG_OUTRA = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('outra-imagem-456')]);
const PDF = Buffer.from('%PDF-1.4\n% arquivo de teste\n');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
const SVG_DIFERENTE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>');

const asAdmin = req => req.set('x-admin-session', adminToken);
const asProfessor = req => req.set('x-admin-session', professorToken);
const asCoord = req => req.set('x-admin-session', coordToken);
const audits = action => (db.memory.auditLogs || []).filter(entry => entry.action === action);
const sha = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function binaryParser(res, callback) {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
}

const APOSTILA_1 = '# Topologias\n\n![Estrela](imagens/redes/topologia.svg)\n\nVeja a foto: ![foto](/uploads/foto-rede.png)\n';
const APOSTILA_2 = '# Endereçamento\n\nSem imagens aqui.\n';
const AVALIACAO_MD = '# Avaliação de redes\n\n1. Qual topologia?\n';

function structure() {
    return [
        { id: 'MOD1', name: 'Fundamentos', units: [
            { id: '1', name: 'Topologias', apostilaKey: 'Apostila_REDES_1', avaliacaoKey: 'Avaliacao_REDES_1', files: [{ id: 'f_1', name: 'roteiro.pdf', path: '/uploads/roteiro-unidade.pdf', type: 'pdf', timestamp: '2026-11-01T10:00:00.000Z' }] },
            { id: '2', name: 'Endereçamento', apostilaKey: 'Apostila_REDES_2', files: [] },
        ] },
        { id: 'MOD2', name: 'Prática', units: [
            { id: '1', name: 'Prova prática', avaliacaoKey: 'Avaliacao_REDES_2', files: [] },
        ] },
    ];
}

function evaluations() {
    return {
        Avaliacao_REDES_1: {
            key: 'Avaliacao_REDES_1', title: 'Avaliação de redes', theme: 'Topologias', rubric: '', revision: 2, createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z',
            questions: [
                { number: 1, originalNumber: 1, type: 'multiple_choice', points: 1, text: 'Qual topologia tem um nó central? ![q](/uploads/questao-img.png)', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'Estrela', isCorrect: true }, { letter: 'B', text: 'Anel', isCorrect: false }], bankKey: 'qb_redes_1' },
                { number: 2, originalNumber: 2, type: 'short_answer', points: 1, text: 'Comando que mostra o IP no Linux?', acceptedAnswers: ['ip a'], review: 'auto' },
            ],
        },
        Avaliacao_REDES_2: { key: 'Avaliacao_REDES_2', title: 'Prova prática', theme: '', rubric: '', questions: [] },
        Avaliacao_OUTRO_1: { key: 'Avaliacao_OUTRO_1', title: 'De outro curso', questions: [] },
    };
}

function writeFiles(contentDir, uploadsDir) {
    fs.mkdirSync(path.join(contentDir, 'imagens', 'redes'), { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(contentDir, 'Apostila_REDES_1.md'), APOSTILA_1);
    fs.writeFileSync(path.join(contentDir, 'Apostila_REDES_2.md'), APOSTILA_2);
    fs.writeFileSync(path.join(contentDir, 'Avaliacao_REDES_1.md'), AVALIACAO_MD);
    fs.writeFileSync(path.join(contentDir, 'imagens', 'redes', 'topologia.svg'), SVG);
    fs.writeFileSync(path.join(uploadsDir, 'foto-rede.png'), PNG);
    fs.writeFileSync(path.join(uploadsDir, 'questao-img.png'), PNG_OUTRA);
    fs.writeFileSync(path.join(uploadsDir, 'roteiro-unidade.pdf'), PDF);
    fs.writeFileSync(path.join(uploadsDir, 'apostila-extra.pdf'), PDF);
    fs.writeFileSync(path.join(uploadsDir, 'da-turma.pdf'), PDF);
}

function seedMemory(memory) {
    memory.admins = [
        { email: 'admin@pacote.local', name: 'Admin', role: 'admin', password: db.hashPassword('senha-administrativa') },
        { email: PROF, name: 'Professora', role: 'professor', password: db.hashPassword('senha-administrativa'), assignedSchoolIds: ['escola_a'], additionalPermissions: ['course.manage'] },
        { email: 'coord@pacote.local', name: 'Coord', role: 'coordenacao', password: db.hashPassword('senha-administrativa'), assignedSchoolIds: ['escola_a'] },
    ];
    memory.adminSessions = {
        [adminToken]: { email: 'admin@pacote.local', createdAt: Date.now(), lastSeen: Date.now() },
        [professorToken]: { email: PROF, createdAt: Date.now(), lastSeen: Date.now() },
        [coordToken]: { email: 'coord@pacote.local', createdAt: Date.now(), lastSeen: Date.now() },
    };
    memory.schools = [{ id: 'escola_a', name: 'Escola A' }, { id: 'escola_b', name: 'Escola B' }];
    memory.courses = [
        {
            id: COURSE, name: 'Redes de Computadores', description: 'Curso de redes.', schoolId: 'escola_a', status: 'active', deleted: false, deletedAt: null,
            structure: structure(),
            disciplinas: [{ id: 'RED', nome: 'Redes', cor: '#336699' }],
            gradeTemplates: [{ id: 'g1', nome: 'Manhã', rhythm: { start: '07:30', duration: 50, count: 2, defaultGap: 10, gaps: [10] }, days: { 1: true }, grid: { 1: ['RED', 'RED'] }, subjectIds: ['RED'] }],
            branding: { primaryColor: '#123456', logoLightUrl: '/uploads/foto-rede.png' },
        },
        { id: OTHER, name: 'Outro', schoolId: 'escola_b', structure: [{ id: 'X', name: 'X', units: [{ id: '1', avaliacaoKey: 'Avaliacao_OUTRO_1' }] }] },
    ];
    memory.classes = [
        { name: CLASS, courseId: COURSE, period: 'Noite', registrationEnabled: true, releasedItems: { Apostila_REDES_1: true }, attendanceConfig: { toleranciaMin: 5, limiarRiscoPct: 80, grade: { 1: [{ ordem: 1, inicio: '19:00', disciplinaId: 'RED' }] } }, onlineExamConfigs: {}, examHistory: {} },
    ];
    memory.evaluations = evaluations();
    memory.questionBank = [
        { key: 'qb_redes_1', category: 'Redes', type: 'multiple_choice', questionText: 'Qual topologia tem um nó central?', correctAnswer: 'A', alternatives: [{ letter: 'A', text: 'Estrela', isCorrect: true }, { letter: 'B', text: 'Anel' }], sourceExamKey: 'Avaliacao_REDES_1', author: PROF, updatedBy: PROF, revision: 1 },
        { key: 'qb_outro', category: 'Outro', questionText: 'De outro curso', sourceExamKey: 'Avaliacao_OUTRO_1', author: PROF },
        { key: 'qb_comum', category: 'Geral', questionText: 'Do acervo comum', author: PROF },
    ];
    memory.library = [
        { id: 'lib_1', kind: 'file', courseId: COURSE, studentClass: '', moduleId: 'MOD1', name: 'Apostila extra', originalName: 'extra.pdf', filename: 'apostila-extra.pdf', url: '/uploads/apostila-extra.pdf', type: 'pdf', ext: '.pdf', size: PDF.length, description: 'Leitura', tags: ['redes'], author: PROF, createdAt: 1, updatedAt: 1 },
        { id: 'lib_2', kind: 'link', courseId: COURSE, studentClass: '', moduleId: 'MOD2', name: 'RFC 791', url: 'https://www.rfc-editor.org/rfc/rfc791', type: 'link', size: 0, description: '', tags: [], author: PROF, createdAt: 1, updatedAt: 1 },
        { id: 'lib_3', kind: 'file', courseId: COURSE, studentClass: CLASS, name: 'Só da turma', filename: 'da-turma.pdf', url: '/uploads/da-turma.pdf', author: PROF },
    ];
    memory.students = [{ name: 'Ana Aluna', email: STUDENT, status: 'Ativo', classes: [{ name: CLASS, courseId: COURSE }] }];
    memory.submissions = [{ id: 'sub_1', studentEmail: STUDENT, examKey: 'Avaliacao_REDES_1', studentClass: CLASS, courseId: COURSE, score: 80 }];
    memory.attendance = [{ id: 'att_1', studentEmail: STUDENT, studentClass: CLASS, courseId: COURSE, date: '2026-11-10', status: 'presente' }];
    memory.examApplications = [];
    memory.auditLogs = [];
}

function freshInstall() {
    fs.rmSync(runtimePaths.CONTENT_DIR, { recursive: true, force: true });
    fs.rmSync(runtimePaths.UPLOADS_DIR, { recursive: true, force: true });
    writeFiles(runtimePaths.CONTENT_DIR, runtimePaths.UPLOADS_DIR);
    seedMemory(db.memory);
}

test.before(async () => {
    await db.init();
    app = createApp();
    freshInstall();
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function emptyMemory() {
    return { courses: [], classes: [], evaluations: {}, library: [], questionBank: [], submissions: [], examApplications: [], schools: [] };
}

function otherInstallDirs(name) {
    const base = path.join(tempRoot, name);
    const dirs = { contentDir: path.join(base, 'content'), uploadsDir: path.join(base, 'uploads') };
    fs.mkdirSync(dirs.contentDir, { recursive: true });
    fs.mkdirSync(dirs.uploadsDir, { recursive: true });
    return dirs;
}

function listTree(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? listTree(full).map(rel => `${entry.name}/${rel}`) : [entry.name];
    }).sort();
}

async function exportBuffer() {
    const res = await asAdmin(request(app).get(`/api/admin/courses/${COURSE}/package`)).buffer(true).parse(binaryParser);
    assert.equal(res.status, 200, String(res.body));
    return res;
}

async function postPackage(url, buffer, fields = {}, as = asAdmin, fileName = 'curso.iclass-curso.zip') {
    let req = as(request(app).post(url));
    Object.entries(fields).forEach(([key, value]) => { req = req.field(key, value); });
    return req.attach('arquivo', buffer, fileName);
}

test('[UC-PACOTE-001] exportar e importar numa instalação vazia dá o mesmo curso, os mesmos arquivos e as mesmas avaliações', async () => {
    freshInstall();
    const built = await coursePackage.exportCoursePackage(db.memory, COURSE, { contentDir: runtimePaths.CONTENT_DIR, uploadsDir: runtimePaths.UPLOADS_DIR });
    assert.match(built.fileName, /^curso_REDES_\d{4}-\d{2}-\d{2}\.iclass-curso\.zip$/);
    const zip = new AdmZip(built.buffer);
    const names = zip.getEntries().map(entry => entry.entryName).sort();
    assert.deepEqual(names, [
        'conteudo/Apostila_REDES_1.md', 'conteudo/Apostila_REDES_2.md', 'conteudo/Avaliacao_REDES_1.md', 'manifest.json',
        'midia/imagens/redes/topologia.svg',
        'midia/uploads/apostila-extra.pdf', 'midia/uploads/foto-rede.png', 'midia/uploads/questao-img.png', 'midia/uploads/roteiro-unidade.pdf',
    ], 'o arquivo só da turma (biblioteca da turma) fica de fora');
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal(manifest.formato, 'iclass-curso');
    assert.equal(manifest.versao, 1);
    assert.deepEqual(Object.keys(manifest.curso).sort(), ['branding', 'codigo', 'description', 'disciplinas', 'gradeTemplates', 'name', 'structure'].sort(),
        'só os campos de COURSE_PACKAGE_FIELDS (e o código de origem)');
    assert.deepEqual(Object.keys(manifest.avaliacoes).sort(), ['Avaliacao_REDES_1', 'Avaliacao_REDES_2']);
    assert.equal(manifest.questoes.length, 1, 'só a questão do banco que veio de avaliação do curso');
    assert.equal(manifest.questoes[0].key, undefined);
    assert.equal(manifest.avaliacoes.Avaliacao_REDES_1.questions[0].bankKey, manifest.questoes[0].ref);
    manifest.arquivos.forEach(item => assert.equal(item.sha256, sha(zip.readFile(item.caminho)), item.caminho));

    // Outra instalação: memória vazia e pastas vazias.
    const memory = emptyMemory();
    const dirs = otherInstallDirs('instalacao-b');
    const preview = await coursePackage.previewCoursePackage(built.buffer, { memory, ...dirs });
    assert.equal(preview.conflitos.cursoExiste, false);
    assert.equal(preview.conflitos.chavesRenomeadas, 0);
    assert.equal(preview.sugestao.newId, 'REDES');
    assert.equal(preview.contagens.modulos, 2);
    assert.equal(preview.contagens.apostilas, 2);
    assert.equal(preview.contagens.avaliacoes, 2);
    assert.equal(preview.contagens.imagens, 1);
    assert.equal(preview.contagens.arquivos, 4);
    assert.deepEqual(preview.turmasModelo, [CLASS]);
    assert.deepEqual(memory.courses, [], 'a prévia não grava');
    assert.deepEqual(listTree(dirs.contentDir), []);

    const result = await coursePackage.importCoursePackage(built.buffer, {
        memory, ...dirs, newId: 'REDES', newName: 'Redes de Computadores', schoolId: 'escola_x', incluirTurmasModelo: true, actorEmail: 'admin@b.local', expectedSha256: preview.sha256,
    });
    const source = db.memory.courses.find(course => course.id === COURSE);
    const imported = memory.courses[0];
    assert.equal(imported.id, 'REDES');
    assert.equal(imported.schoolId, 'escola_x');
    assert.deepEqual(imported.structure, source.structure, 'a mesma estrutura, com as mesmas chaves');
    assert.deepEqual(imported.disciplinas, source.disciplinas);
    // O pacote passa as grades pelo mesmo saneamento da tela de disciplinas (dias e grade completos).
    assert.deepEqual(imported.gradeTemplates, require('../../backend/utils/attendance.js').sanitizeGradeTemplates(source.gradeTemplates));
    assert.deepEqual(imported.branding, source.branding);
    assert.equal(imported.description, source.description);
    assert.equal(imported.importedFrom.codigo, COURSE);
    ['Apostila_REDES_1.md', 'Apostila_REDES_2.md', 'Avaliacao_REDES_1.md'].forEach(name => {
        assert.equal(sha(fs.readFileSync(path.join(dirs.contentDir, name))), sha(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, name))), name);
    });
    assert.equal(sha(fs.readFileSync(path.join(dirs.contentDir, 'imagens', 'redes', 'topologia.svg'))), sha(SVG));
    ['foto-rede.png', 'questao-img.png', 'roteiro-unidade.pdf', 'apostila-extra.pdf'].forEach(name => {
        assert.equal(sha(fs.readFileSync(path.join(dirs.uploadsDir, name))), sha(fs.readFileSync(path.join(runtimePaths.UPLOADS_DIR, name))), name);
    });
    assert.equal(fs.existsSync(path.join(dirs.uploadsDir, 'da-turma.pdf')), false);
    // As mesmas avaliações, com o gabarito; a questão que veio do banco aponta para a
    // questão importada.
    const bankItem = memory.questionBank[0];
    assert.equal(memory.questionBank.length, 1);
    assert.equal(bankItem.sourceExamKey, 'Avaliacao_REDES_1');
    assert.equal(bankItem.questionText, 'Qual topologia tem um nó central?');
    assert.equal(bankItem.author, 'admin@b.local', 'autor é quem importou, não o e-mail da origem');
    assert.notEqual(bankItem.key, 'qb_redes_1');
    // As questões entram pelo modelo único da questão, como no PUT do editor
    // (normalizeEvaluationQuestions): o mesmo gabarito, com os campos que o editor grava.
    const expectedEval = JSON.parse(JSON.stringify(db.memory.evaluations.Avaliacao_REDES_1));
    expectedEval.questions = normalizeEvaluationQuestions(expectedEval.questions);
    delete expectedEval.key;
    expectedEval.questions[0].bankKey = bankItem.key;
    const { key: importedKey, ...importedEval } = memory.evaluations.Avaliacao_REDES_1;
    assert.equal(importedKey, 'Avaliacao_REDES_1');
    assert.deepEqual(importedEval, expectedEval);
    assert.deepEqual(memory.evaluations.Avaliacao_REDES_1.questions.map(question => [question.type, question.correctAnswer, question.acceptedAnswers]),
        [['multiple_choice', 'A', undefined], ['short_answer', '', ['ip a']]]);
    assert.deepEqual(memory.evaluations.Avaliacao_REDES_2, db.memory.evaluations.Avaliacao_REDES_2);
    assert.equal(memory.evaluations.Avaliacao_OUTRO_1, undefined);
    // Biblioteca do curso (sem a da turma), com id e autor desta instalação.
    assert.deepEqual(memory.library.map(entry => [entry.kind, entry.name, entry.filename || entry.url, entry.courseId, entry.studentClass]), [
        ['file', 'Apostila extra', 'apostila-extra.pdf', 'REDES', ''],
        ['link', 'RFC 791', 'https://www.rfc-editor.org/rfc/rfc791', 'REDES', ''],
    ]);
    assert.ok(memory.library.every(entry => entry.author === 'admin@b.local' && /^lib_/.test(entry.id)));
    // Turma modelo: nome, período e grade, sem alunos e sem nada de prova.
    assert.equal(memory.classes.length, 1);
    assert.equal(memory.classes[0].name, CLASS);
    assert.equal(memory.classes[0].period, 'Noite');
    assert.equal(memory.classes[0].courseId, 'REDES');
    assert.deepEqual(memory.classes[0].onlineExamConfigs, {}, 'como o "Duplicar": o boot seguinte não regrava a turma');
    assert.deepEqual(memory.classes[0].attendanceConfig, { toleranciaMin: 5, limiarRiscoPct: 80, grade: { 1: [{ ordem: 1, inicio: '19:00', disciplinaId: 'RED' }] } });
    assert.deepEqual(memory.classes[0].releasedItems, { Apostila_REDES_1: true, Apostila_REDES_2: true, Avaliacao_REDES_1: false, Gabarito_Avaliacao_REDES_1: false, Avaliacao_REDES_2: false, Gabarito_Avaliacao_REDES_2: false });
    assert.equal(result.contagens.turmasModelo, 1);
    assert.deepEqual(result.renomeadas, []);
    // Sem pasta temporária sobrando.
    assert.deepEqual(listTree(dirs.contentDir).filter(name => name.startsWith('.pacote-')), []);
    assert.deepEqual(fs.readdirSync(dirs.uploadsDir).filter(name => name.startsWith('.pacote-')), []);

    // Sem "turmas modelo", nenhuma turma.
    const memory2 = emptyMemory();
    const dirs2 = otherInstallDirs('instalacao-c');
    const without = await coursePackage.importCoursePackage(built.buffer, { memory: memory2, ...dirs2, newId: 'REDES', newName: 'Redes' });
    assert.deepEqual(without.classes, []);
    assert.deepEqual(memory2.classes, []);
});

test('[UC-PACOTE-001] pela rota: o ZIP baixado tem o nome do curso e a exportação fica na auditoria', async () => {
    freshInstall();
    const res = await exportBuffer();
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /attachment; filename="curso_REDES_\d{4}-\d{2}-\d{2}\.iclass-curso\.zip"/);
    assert.equal(res.headers['x-iclass-fora-do-pacote'], '0');
    const manifest = JSON.parse(new AdmZip(res.body).readAsText('manifest.json'));
    assert.equal(manifest.curso.codigo, COURSE);
    const logged = audits('course_package_exported');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].courseId, COURSE);
    assert.equal(logged[0].category, 'academic');
    assert.equal(logged[0].details.arquivos, 8);
    assert.equal(logged[0].details.bytes, res.body.length);
    // Arquivo citado que não existe: o pacote sai sem ele e diz quantos ficaram de fora.
    fs.rmSync(path.join(runtimePaths.UPLOADS_DIR, 'roteiro-unidade.pdf'));
    const missing = await exportBuffer();
    assert.equal(missing.headers['x-iclass-fora-do-pacote'], '1');
    assert.deepEqual(JSON.parse(new AdmZip(missing.body).readAsText('manifest.json')).foraDoPacote, [{ arquivo: 'uploads/roteiro-unidade.pdf', motivo: 'não encontrado nesta instalação' }]);
    // Curso que não existe: 404; fora do escopo do professor: 403.
    assert.equal((await asAdmin(request(app).get('/api/admin/courses/NAO_EXISTE/package'))).status, 404);
    assert.equal((await asProfessor(request(app).get(`/api/admin/courses/${OTHER}/package`))).status, 403);
    assert.equal((await asProfessor(request(app).get(`/api/admin/courses/${COURSE}/package`)).buffer(true).parse(binaryParser)).status, 200);
    // A coordenação não tem course.manage.
    assert.equal((await asCoord(request(app).get(`/api/admin/courses/${COURSE}/package`))).status, 403);
});

test('[UC-PACOTE-002] importar na mesma instalação: código novo, chaves renomeadas, imagens e referências reescritas, original intacto', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    const before = JSON.stringify({ course: db.memory.courses.find(course => course.id === COURSE), evaluations: db.memory.evaluations, classes: db.memory.classes });
    const contentBefore = listTree(runtimePaths.CONTENT_DIR).map(name => [name, sha(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, name)))]);
    // Nesta instalação a imagem mudou depois da exportação (mesmo nome, outro conteúdo).
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'), SVG_DIFERENTE);

    const preview = await postPackage('/api/admin/course-packages/preview', buffer);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.conflitos.cursoExiste, true);
    assert.equal(preview.body.sugestao.newId, 'REDES2', 'o código sugerido ganha um número');
    assert.equal(preview.body.conflitos.chavesRenomeadas, 4);
    assert.equal(preview.body.conflitos.arquivosRenomeados, 1, 'só a imagem com outro conteúdo');
    assert.equal(preview.body.conflitos.arquivosReaproveitados, 4, 'os arquivos de /uploads iguais são reaproveitados');
    assert.equal(preview.body.sha256, sha(buffer));
    assert.equal(db.memory.courses.length, 2, 'a prévia não grava');

    // Arquivo diferente do da prévia: 409.
    const other = await postPackage('/api/admin/course-packages/import', buffer, { sha256: 'a'.repeat(64), newId: 'REDES2', newName: 'Redes (cópia)' });
    assert.equal(other.status, 409);
    assert.equal(other.body.code, 'import_changed');
    // Código já usado: 400 com o campo.
    const taken = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'redes', newName: 'Redes' });
    assert.equal(taken.status, 400);
    assert.equal(taken.body.field, 'newId');

    const done = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'redes2', newName: 'Redes (importado)', schoolId: 'escola_b', incluirTurmasModelo: 'sim' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.course.id, 'REDES2');
    assert.equal(done.body.renomeadas, 4);
    const imported = db.memory.courses.find(course => course.id === 'REDES2');
    assert.equal(imported.name, 'Redes (importado)');
    assert.equal(imported.schoolId, 'escola_b');
    const units = imported.structure.flatMap(module => module.units);
    assert.deepEqual(units.map(unit => [unit.apostilaKey, unit.avaliacaoKey]), [
        ['Apostila_REDES_1_REDES2', 'Avaliacao_REDES_1_REDES2'],
        ['Apostila_REDES_2_REDES2', undefined],
        [undefined, 'Avaliacao_REDES_2_REDES2'],
    ]);
    assert.equal(units[0].files[0].path, '/uploads/roteiro-unidade.pdf', 'arquivo igual: mesmo nome');
    assert.equal(db.memory.evaluations.Avaliacao_REDES_1_REDES2.key, 'Avaliacao_REDES_1_REDES2');
    assert.equal(db.memory.evaluations.Avaliacao_REDES_1_REDES2.questions[0].correctAnswer, 'A', 'o gabarito vem junto');
    const apostila = fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1_REDES2.md'), 'utf8');
    assert.match(apostila, /!\[Estrela\]\(imagens\/redes\/topologia-REDES2\.svg\)/, 'a referência aponta para a imagem renomeada');
    assert.match(apostila, /\/uploads\/foto-rede\.png/);
    assert.equal(sha(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia-REDES2.svg'))), sha(SVG));
    assert.equal(sha(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'))), sha(SVG_DIFERENTE), 'a imagem daqui não muda');
    const bank = db.memory.questionBank.filter(item => item.sourceExamKey === 'Avaliacao_REDES_1_REDES2');
    assert.equal(bank.length, 1);
    assert.equal(db.memory.evaluations.Avaliacao_REDES_1_REDES2.questions[0].bankKey, bank[0].key);
    assert.equal(db.memory.classes.filter(cls => cls.courseId === 'REDES2').length, 1);
    // O curso original e os arquivos dele não mudaram.
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'), SVG);
    assert.equal(JSON.stringify({ course: db.memory.courses.find(course => course.id === COURSE), evaluations: Object.fromEntries(Object.entries(db.memory.evaluations).filter(([key]) => !key.endsWith('_REDES2'))), classes: db.memory.classes.filter(cls => cls.courseId !== 'REDES2') }), before);
    contentBefore.forEach(([name, hash]) => assert.equal(sha(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, name))), hash, name));
    // Auditoria na mesma gravação.
    const logged = audits('course_package_imported');
    assert.equal(logged.length, 1);
    assert.equal(logged[0].courseId, 'REDES2');
    assert.equal(logged[0].details.origemCodigo, COURSE);
    assert.equal(logged[0].details.renomeadas, 4);
    assert.equal(logged[0].details.sha256, preview.body.sha256);
    assert.deepEqual(logged[0].details.turmasModelo, [CLASS]);
    // A pasta de envios fica vazia.
    assert.deepEqual(fs.readdirSync(path.join(runtimePaths.DATA_DIR, '.pacotes-curso', 'envios')), []);

    // De novo: a segunda importação ganha outro sufixo e não pisa na primeira.
    const again = await postPackage('/api/admin/course-packages/preview', buffer);
    assert.equal(again.body.sugestao.newId, 'REDES3');
    const third = await postPackage('/api/admin/course-packages/import', buffer, { sha256: again.body.sha256, newId: 'REDES3', newName: 'Redes 3' });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    assert.ok(db.memory.evaluations.Avaliacao_REDES_1_REDES3);
    assert.equal(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1_REDES2.md'), 'utf8'), apostila);
});

test('[UC-PACOTE-002] escopo: professor só importa para escola dele, coordenação só consulta, sem course.manage não entra', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    const preview = await postPackage('/api/admin/course-packages/preview', buffer, {}, asProfessor);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const outside = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'PROF1', newName: 'Do professor', schoolId: 'escola_b' }, asProfessor);
    assert.equal(outside.status, 403);
    assert.equal(outside.body.field, 'schoolId');
    const inside = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'PROF1', newName: 'Do professor' }, asProfessor);
    assert.equal(inside.status, 200, JSON.stringify(inside.body));
    assert.equal(db.memory.courses.find(course => course.id === 'PROF1').schoolId, 'escola_a', 'sem escola: a primeira atribuída');
    const coord = await postPackage('/api/admin/course-packages/preview', buffer, {}, asCoord);
    assert.equal(coord.status, 403);
    assert.equal(coord.body.code, 'read_only_account');
    db.memory.admins.find(account => account.email === PROF).additionalPermissions = [];
    const noPermission = await postPackage('/api/admin/course-packages/preview', buffer, {}, asProfessor);
    assert.equal(noPermission.status, 403);
});

test('[UC-PACOTE-002] falha da gravação: o curso sai da memória, os arquivos novos saem do disco e a resposta é 503', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    const preview = await postPackage('/api/admin/course-packages/preview', buffer);
    const filesBefore = { content: listTree(runtimePaths.CONTENT_DIR), uploads: listTree(runtimePaths.UPLOADS_DIR) };
    const memoryBefore = JSON.stringify([db.memory.courses, db.memory.classes, db.memory.evaluations, db.memory.library, db.memory.questionBank]);
    const auditBefore = db.memory.auditLogs.length;
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'), SVG_DIFERENTE); // força uma imagem nova
    const originalSave = db.save;
    let failedOnly = null;
    db.save = function failingSave(options) {
        if (options && Array.isArray(options.only) && options.only.includes('courses')) {
            failedOnly = options.only;
            const error = new Error('Não foi possível gravar os dados agora.');
            error.code = 'ICLASS_DB_WRITE';
            return Promise.reject(error);
        }
        return originalSave.call(this, options);
    };
    let res;
    try {
        res = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'FALHA', newName: 'Falha', incluirTurmasModelo: 'sim' });
    } finally {
        db.save = originalSave;
    }
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.retryable, true);
    assert.equal(JSON.stringify([db.memory.courses, db.memory.classes, db.memory.evaluations, db.memory.library, db.memory.questionBank]), memoryBefore);
    assert.equal(db.memory.auditLogs.length, auditBefore, 'a entrada da auditoria que não foi gravada sai da memória');
    assert.ok(failedOnly.includes('auditLogs'), 'a auditoria vai na mesma gravação do curso (contrato auditoria do plano)');
    assert.deepEqual(listTree(runtimePaths.CONTENT_DIR), filesBefore.content, 'nenhum .md nem imagem novo ficou');
    assert.deepEqual(listTree(runtimePaths.UPLOADS_DIR), filesBefore.uploads);
});

// ------------------------------------------------------------------ segurança do ZIP

function buildPackage(mutate) {
    const zip = new AdmZip();
    const files = { 'conteudo/Apostila_X_1.md': Buffer.from('# X\n') };
    const manifest = {
        formato: 'iclass-curso', versao: 1, versaoApp: '3.0.0', exportadoEm: Date.now(),
        curso: { codigo: 'MALICIOSO', name: 'Curso X', structure: [{ id: 'M', name: 'M', units: [{ id: '1', name: 'U', apostilaKey: 'Apostila_X_1' }] }] },
        avaliacoes: {}, biblioteca: [], questoes: [], turmasModelo: [],
        arquivos: [],
    };
    const extra = mutate ? mutate({ zip, files, manifest }) || {} : {};
    Object.entries(files).forEach(([name, buffer]) => {
        zip.addFile(name, buffer);
        if (!extra.unlisted || !extra.unlisted.includes(name)) {
            manifest.arquivos.push({ caminho: name, tipo: name.startsWith('conteudo/') ? 'conteudo' : name.startsWith('midia/uploads/') ? 'upload' : 'imagem', ...(name.startsWith('conteudo/') ? { chave: path.basename(name, '.md') } : {}), bytes: buffer.length, sha256: sha(buffer) });
        }
    });
    if (extra.afterList) extra.afterList(manifest);
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    let buffer = zip.toBuffer();
    if (extra.patch) buffer = extra.patch(buffer);
    return buffer;
}

// Troca o tamanho descompactado declarado de uma entrada (diretório central e cabeçalho
// local), como faz quem monta uma bomba de descompressão com tamanho falso.
function patchDeclaredSize(buffer, name, size) {
    const out = Buffer.from(buffer);
    for (let index = 0; index + 46 < out.length; index += 1) {
        if (out.readUInt32LE(index) !== 0x02014b50) continue;
        const nameLength = out.readUInt16LE(index + 28);
        if (out.toString('utf8', index + 46, index + 46 + nameLength) !== name) continue;
        out.writeUInt32LE(size, index + 24);
        const local = out.readUInt32LE(index + 42);
        out.writeUInt32LE(size, local + 22);
    }
    return out;
}

test('[UC-PACOTE-003] ZIP inseguro ou alterado é recusado com 400 e nada é gravado', async () => {
    freshInstall();
    const before = { courses: JSON.stringify(db.memory.courses), content: listTree(runtimePaths.CONTENT_DIR), uploads: listTree(runtimePaths.UPLOADS_DIR) };
    const symlinkZip = () => buildPackage(({ zip }) => {
        // O adm-zip só aceita permissões no addFile; o tipo "link simbólico" (S_IFLNK) vai direto no atributo.
        zip.addFile('conteudo/link.md', Buffer.from('/etc/passwd')).attr = (0o120777 << 16) >>> 0;
        return { afterList: manifest => manifest.arquivos.push({ caminho: 'conteudo/link.md', tipo: 'conteudo', chave: 'link', bytes: 11, sha256: sha(Buffer.from('/etc/passwd')) }) };
    });
    const bomb = () => {
        const huge = Buffer.alloc(4 * 1024 * 1024, 0x41);
        return buildPackage(({ files }) => {
            files['midia/uploads/bomba.txt'] = huge;
            return {
                afterList: manifest => { const item = manifest.arquivos.find(entry => entry.caminho === 'midia/uploads/bomba.txt'); item.bytes = 100; item.sha256 = sha(huge.subarray(0, 100)); },
                patch: buffer => patchDeclaredSize(buffer, 'midia/uploads/bomba.txt', 100),
            };
        });
    };
    const giant = () => buildPackage(({ files }) => {
        files['midia/uploads/grande.txt'] = Buffer.from('texto');
        return {
            afterList: manifest => { manifest.arquivos.find(entry => entry.caminho === 'midia/uploads/grande.txt').bytes = 600 * 1024 * 1024; },
            patch: buffer => patchDeclaredSize(buffer, 'midia/uploads/grande.txt', 600 * 1024 * 1024),
        };
    });
    const backupLike = Buffer.from(JSON.stringify({ type: 'iclass-backup-data', data: { admins: [{ email: 'x@y', password: 'scrypt$c2FsdHNhbHQ=$aGFzaGhhc2g=' }] } }));
    const cases = [
        ['../ no caminho', () => buildPackage(({ zip }) => { zip.addFile('conteudo/../../fora.md', Buffer.from('x')); }), /caminho|fora das pastas do pacote/],
        ['caminho absoluto', () => buildPackage(({ zip }) => { zip.addFile('/etc/cron.d/x', Buffer.from('x')); }), /caminho|fora das pastas do pacote/],
        ['link simbólico', symlinkZip, /link simbólico/],
        ['arquivo fora de conteudo/ e midia/', () => buildPackage(({ files }) => { files['backend/server.js'] = Buffer.from('process.exit()'); }), /fora das pastas do pacote de curso/],
        ['arquivo no ZIP fora do manifesto', () => buildPackage(({ files }) => { files['midia/uploads/solto.pdf'] = PDF; return { unlisted: ['midia/uploads/solto.pdf'] }; }), /não está no manifesto/],
        ['sha256 errado', () => buildPackage(({ files }) => ({ afterList: manifest => { manifest.arquivos[0].sha256 = 'b'.repeat(64); } })), /não confere/],
        ['versão mais nova do formato', () => buildPackage(({ manifest }) => { manifest.versao = 2; manifest.versaoApp = '4.0.0'; }), /versão mais nova do IClass/],
        ['não é pacote de curso', () => buildPackage(({ manifest }) => { manifest.formato = 'iclass-backup'; }), /não é um pacote de curso/],
        ['bomba com tamanho falso', bomb, /não confere/],
        ['arquivo grande demais declarado', giant, /grande demais/],
        ['executável disfarçado', () => buildPackage(({ files }) => { files['midia/uploads/virus.exe'] = Buffer.from('MZ'); }), /tipo de arquivo não aceito/],
        ['imagem que não é imagem', () => buildPackage(({ files }) => { files['midia/uploads/foto.png'] = Buffer.from('não sou png'); }), /não é do tipo/],
        ['backup do IClass dentro do pacote', () => buildPackage(({ files }) => { files['midia/uploads/dados.json'] = backupLike; }), /backup do IClass/],
        ['chave insegura na estrutura', () => buildPackage(({ manifest }) => { manifest.curso.structure[0].units[0].apostilaKey = '../../x'; }), /chave de conteúdo inválida/],
        ['ZIP ilegível', () => Buffer.from('PK\x03\x04 não é zip de verdade'), /não pôde ser lido/],
    ];
    for (const [label, make, pattern] of cases) {
        const buffer = make();
        const preview = await postPackage('/api/admin/course-packages/preview', buffer);
        const imported = await postPackage('/api/admin/course-packages/import', buffer, { sha256: sha(buffer), newId: 'MAL1', newName: 'Malicioso' });
        // O backup disfarçado só aparece na importação (a prévia não grava o arquivo).
        if (label !== 'backup do IClass dentro do pacote') {
            assert.equal(preview.status, 400, `${label}: ${JSON.stringify(preview.body)}`);
            assert.match(preview.body.error, pattern, label);
        }
        assert.equal(imported.status, 400, `${label}: ${JSON.stringify(imported.body)}`);
        assert.match(imported.body.error, pattern, label);
        assert.equal(JSON.stringify(db.memory.courses), before.courses, label);
        assert.deepEqual(listTree(runtimePaths.CONTENT_DIR), before.content, label);
        assert.deepEqual(listTree(runtimePaths.UPLOADS_DIR), before.uploads, label);
    }
    // Não é .zip: recusado no envio.
    const notZip = await postPackage('/api/admin/course-packages/preview', Buffer.from('x'), {}, asAdmin, 'curso.txt');
    assert.equal(notZip.status, 400);
    const noFile = await asAdmin(request(app).post('/api/admin/course-packages/preview')).field('x', '1');
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.code, 'package_missing');
    assert.deepEqual(fs.readdirSync(path.join(runtimePaths.DATA_DIR, '.pacotes-curso', 'envios')), []);
});

test('[UC-PACOTE-004] o pacote não tem alunos, notas, presença nem e-mail', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    const zip = new AdmZip(buffer);
    const text = zip.readAsText('manifest.json');
    const manifest = JSON.parse(text);
    assert.deepEqual(Object.keys(manifest).sort(), ['arquivos', 'avaliacoes', 'biblioteca', 'contagens', 'curso', 'exportadoEm', 'foraDoPacote', 'formato', 'questoes', 'turmasModelo', 'versao', 'versaoApp']);
    assert.doesNotMatch(text, /@/, 'nenhum e-mail (autor, aluno, quem exportou)');
    // attendanceConfig (horários da turma modelo) pode; registros de presença, não.
    assert.doesNotMatch(text, /Ana Aluna|"students"|"submissions"|"attendance"|"att_1"|studentEmail|"grades"|"notas"/);
    manifest.turmasModelo.forEach(cls => assert.deepEqual(Object.keys(cls).sort(), ['attendanceConfig', 'name', 'period']));
    zip.getEntries().forEach(entry => assert.doesNotMatch(zip.readAsText(entry), new RegExp(STUDENT.replace('.', '\\.'))));
});

test('remapCourseKeys: o "Duplicar curso" e o pacote usam o mesmo remapeamento', () => {
    const course = { id: 'A', structure: structure() };
    const cls = {
        name: 'T1', courseId: 'A',
        contentOverrides: { materials: { Apostila_REDES_1: { key: 'Apostila_REDES_1__turma_x' } }, evaluations: {}, unitNames: { Avaliacao_REDES_1: 'Prova da turma' }, extraUnits: [{ moduleId: 'MOD1', unit: { id: '9', apostilaKey: 'Apostila_EXTRA' } }], structure: null },
        releasedItems: { Apostila_REDES_1: true, Gabarito_Avaliacao_REDES_1: true, Outro: false },
        releaseSchedule: { Gabarito_Avaliacao_REDES_1: { at: 5, adiadoEm: 9 } },
    };
    const snapshot = JSON.stringify({ course, cls });
    const result = coursePackage.remapCourseKeys({ course, classes: [cls], newCourseId: 'B', mapKey: key => `${key}_B` });
    assert.equal(JSON.stringify({ course, cls }), snapshot, 'os originais não mudam');
    assert.deepEqual(result.course.structure[0].units[0].apostilaKey, 'Apostila_REDES_1_B');
    const [copy] = result.classes;
    assert.equal(copy.courseId, 'B');
    assert.deepEqual(copy.contentOverrides.materials, { Apostila_REDES_1_B: { key: 'Apostila_REDES_1__turma_x_B' } });
    assert.deepEqual(copy.contentOverrides.unitNames, { Avaliacao_REDES_1_B: 'Prova da turma' });
    assert.equal(copy.contentOverrides.extraUnits[0].unit.apostilaKey, 'Apostila_EXTRA_B');
    assert.deepEqual(copy.releasedItems, { Apostila_REDES_1_B: true, Gabarito_Avaliacao_REDES_1_B: true, Outro: false });
    assert.deepEqual(copy.releaseSchedule, { Gabarito_Avaliacao_REDES_1_B: { at: 5 } });
    // A variante da turma também é copiada (como no clone antigo), na ordem em que aparece.
    assert.deepEqual([...result.materialKeys.keys()], ['Apostila_REDES_1', 'Apostila_REDES_2', 'Apostila_REDES_1__turma_x', 'Apostila_EXTRA']);
    assert.equal(result.mapItemKey('Gabarito_Avaliacao_REDES_2'), 'Gabarito_Avaliacao_REDES_2_B');
    assert.deepEqual(coursePackage.COURSE_PACKAGE_FIELDS, ['name', 'description', 'structure', 'disciplinas', 'gradeTemplates', 'branding', 'avaliacao', 'permitirImpressao']);
});

test('remapCourseKeys: "Duplicar curso" copia arquivos, avaliações e turmas como antes da extração', async () => {
    freshInstall();
    const res = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/clone`)).send({ newId: 'COPIA', newName: 'Cópia' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const copy = db.memory.courses.find(course => course.id === 'COPIA');
    assert.deepEqual(copy.structure.flatMap(module => module.units).map(unit => unit.apostilaKey || unit.avaliacaoKey), ['Apostila_REDES_1_COPIA', 'Apostila_REDES_2_COPIA', 'Avaliacao_REDES_2_COPIA']);
    assert.equal(copy.clonedFrom, COURSE);
    assert.deepEqual(copy.disciplinas, db.memory.courses.find(course => course.id === COURSE).disciplinas);
    assert.ok(fs.existsSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1_COPIA.md')));
    assert.ok(fs.existsSync(path.join(runtimePaths.CONTENT_DIR, 'Avaliacao_REDES_1_COPIA.md')));
    assert.equal(db.memory.evaluations.Avaliacao_REDES_1_COPIA.key, 'Avaliacao_REDES_1_COPIA');
    const clonedClass = db.memory.classes.find(cls => cls.courseId === 'COPIA');
    assert.deepEqual(clonedClass.releasedItems, { Apostila_REDES_1_COPIA: true });
    assert.deepEqual(clonedClass.onlineExamConfigs, {});
    assert.equal(clonedClass.activeExamKey, null);
    assert.equal(audits('course_cloned').length, 1);
});

// ------------------------------------------------------------------ rodada de ajuste 1

function evaluationPackage({ questions, bank = [], codigo = 'MALQ' } = {}) {
    return buildPackage(({ manifest }) => {
        manifest.curso.codigo = codigo;
        manifest.curso.structure[0].units.push({ id: '2', name: 'Prova', avaliacaoKey: 'Avaliacao_X_1' });
        manifest.avaliacoes = { Avaliacao_X_1: { key: 'Avaliacao_X_1', title: 'Prova X', questions } };
        manifest.questoes = bank;
    });
}

test('[UC-PACOTE-003] avaliação e questão do banco passam pelo modelo único da questão: fora do modelo, 400 com o lugar da questão', async () => {
    freshInstall();
    const before = { courses: JSON.stringify(db.memory.courses), evaluations: JSON.stringify(db.memory.evaluations), bank: JSON.stringify(db.memory.questionBank), content: listTree(runtimePaths.CONTENT_DIR) };
    const cases = [
        ['tipo desconhecido, enunciado que não é texto, pontos em texto', evaluationPackage({ questions: [{ text: { a: 1 }, alternatives: 'abc', type: 'tipo_inexistente', points: 'muitos' }] }), /avaliação Avaliacao_X_1: Questão 1: /],
        ['questão sem enunciado', evaluationPackage({ questions: [{ type: 'essay', text: '' }] }), /avaliação Avaliacao_X_1: Questão 1: informe o enunciado/],
        ['item do banco com tipo desconhecido', evaluationPackage({ questions: [], bank: [{ ref: 'q1', questionText: 12345, type: 'xyz', archived: 'talvez', stats: { usos: 999 } }] }), /questão 1 do banco: /],
        ['item do banco com categoria que não é texto', evaluationPackage({ questions: [], bank: [{ ref: 'q1', questionText: 'Ok?', alternatives: [{ letter: 'A', text: 'Sim', isCorrect: true }, { letter: 'B', text: 'Não' }], category: { x: 1 } }] }), /categoria da questão 1 do banco precisa ser texto/],
    ];
    for (const [label, buffer, pattern] of cases) {
        const preview = await postPackage('/api/admin/course-packages/preview', buffer);
        assert.equal(preview.status, 400, `${label}: ${JSON.stringify(preview.body)}`);
        assert.equal(preview.body.code, 'invalid_package', label);
        assert.match(preview.body.error, pattern, label);
        const imported = await postPackage('/api/admin/course-packages/import', buffer, { sha256: sha(buffer), newId: 'MALQ', newName: 'Malicioso' });
        assert.equal(imported.status, 400, `${label}: ${JSON.stringify(imported.body)}`);
        assert.match(imported.body.error, pattern, label);
        assert.equal(JSON.stringify(db.memory.courses), before.courses, label);
        assert.equal(JSON.stringify(db.memory.evaluations), before.evaluations, label);
        assert.equal(JSON.stringify(db.memory.questionBank), before.bank, label);
        assert.deepEqual(listTree(runtimePaths.CONTENT_DIR), before.content, label);
    }

    // A questão antiga (sem type nem points, com weight, como as do banco do Alan) continua
    // aceita, como no PUT do editor: vira "uma correta" com o mesmo gabarito. O item do
    // banco entra só com os campos do banco: sem estatística, arquivada só com true e
    // revisão nova.
    const legacy = { originalNumber: 1, text: 'Qual é o gargalo?', weight: 1, alternatives: [{ letter: 'A', text: 'Disco', isCorrect: false }, { letter: 'B', text: 'Memória', isCorrect: true }], correctAnswer: 'B', bankKey: 'q1' };
    const bankItem = { ref: 'q1', category: 'FUTEC', curriculumKey: '', questionText: 'Qual é o gargalo?', alternatives: legacy.alternatives, correctAnswer: 'B', sourceExamKey: 'Avaliacao_X_1', archived: 'talvez', stats: { usos: 999 }, revision: 7, createdAt: '2026-10-19T13:24:20.450Z' };
    const good = evaluationPackage({ questions: [legacy], bank: [bankItem], codigo: 'LEGADO' });
    const preview = await postPackage('/api/admin/course-packages/preview', good);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const done = await postPackage('/api/admin/course-packages/import', good, { sha256: preview.body.sha256, newId: 'LEGADO', newName: 'Legado' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const evaluation = db.memory.evaluations.Avaliacao_X_1;
    assert.deepEqual(evaluation.questions, normalizeEvaluationQuestions([legacy]).map(question => ({ ...question, bankKey: evaluation.questions[0].bankKey })));
    assert.equal(evaluation.questions[0].type, 'multiple_choice');
    assert.equal(evaluation.questions[0].correctAnswer, 'B');
    assert.equal(evaluation.questions[0].weight, undefined);
    const item = db.memory.questionBank.find(entry => entry.key === evaluation.questions[0].bankKey);
    assert.ok(item, 'a questão da avaliação aponta para o item importado');
    assert.equal(item.archived, false);
    assert.equal(item.stats, undefined);
    assert.equal(item.revision, 1);
    assert.equal(item.questionText, 'Qual é o gargalo?');
    assert.equal(item.category, 'FUTEC');
    assert.equal(item.sourceExamKey, 'Avaliacao_X_1');
    assert.equal(item.ref, undefined);
});

test('[UC-PACOTE-003] chave de conteúdo com nome que todo objeto herda (toString, hasOwnProperty) é recusada', async () => {
    freshInstall();
    for (const key of ['toString', 'hasOwnProperty', 'valueOf']) {
        const buffer = buildPackage(({ manifest }) => { manifest.curso.structure[0].units.push({ id: '2', name: 'U2', apostilaKey: key }); });
        const preview = await postPackage('/api/admin/course-packages/preview', buffer);
        assert.equal(preview.status, 400, `${key}: ${JSON.stringify(preview.body)}`);
        assert.match(preview.body.error, /chave de conteúdo inválida/, key);
    }
    // Avaliação com essa chave nem é lida (sai na limpeza do manifesto, como '__proto__').
    const avaliacao = buildPackage(({ manifest }) => { manifest.avaliacoes = JSON.parse('{"toString":{"title":"x","questions":[]},"__proto__":{"title":"y"}}'); });
    const res = await postPackage('/api/admin/course-packages/preview', avaliacao);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.contagens.avaliacoes, 0);
    const done = await postPackage('/api/admin/course-packages/import', avaliacao, { sha256: res.body.sha256, newId: 'HERDA', newName: 'Herda' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(Object.prototype.hasOwnProperty.call(db.memory.evaluations, 'toString'), false);
    assert.equal({}.title, undefined);
    assert.equal(fs.existsSync(path.join(runtimePaths.CONTENT_DIR, 'toString.md')), false);
});

test('[UC-PACOTE-004] e-mail em campo aninhado que ninguém listou não vai para o pacote', async () => {
    freshInstall();
    db.memory.questionBank[0].history = [{ by: 'prof.historico@escola.local', em: '2026-11-01', mudou: ['texto'] }];
    db.memory.questionBank[0].revisions = [{ editor: 'editora@escola.local', n: 2 }];
    db.memory.questionBank[0].campoNovo = { quemMexeu: 'outra.pessoa@escola.local', vistoPor: ['um@escola.local', 'dois@escola.local'] };
    db.memory.evaluations.Avaliacao_REDES_1.questions[1].meta = { revisor: 'revisor@escola.local' };
    const { body: buffer } = await exportBuffer();
    const text = new AdmZip(buffer).readAsText('manifest.json');
    assert.doesNotMatch(text, /@/, 'nenhum e-mail, em nenhum nível');
    const manifest = JSON.parse(text);
    assert.deepEqual(manifest.questoes[0].history, [{ em: '2026-11-01', mudou: ['texto'] }], 'o resto do campo fica');
    assert.deepEqual(manifest.questoes[0].campoNovo, { vistoPor: [] });
});

test('[UC-PACOTE-001] apostila da estrutura sem o .md fica de fora, entra em foraDoPacote e a prévia avisa', async () => {
    freshInstall();
    fs.rmSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_2.md'));
    const res = await exportBuffer();
    assert.equal(res.headers['x-iclass-fora-do-pacote'], '1');
    const manifest = JSON.parse(new AdmZip(res.body).readAsText('manifest.json'));
    assert.deepEqual(manifest.foraDoPacote, [{ arquivo: 'conteudo/Apostila_REDES_2.md', motivo: 'apostila sem o arquivo nesta instalação' }]);
    // A avaliação feita no editor (sem .md) não é "arquivo que falta".
    assert.equal(manifest.foraDoPacote.some(item => item.arquivo.includes('Avaliacao_REDES_2')), false);
    const preview = await coursePackage.previewCoursePackage(res.body, { memory: emptyMemory(), ...otherInstallDirs('instalacao-fora') });
    assert.ok(preview.avisos.some(aviso => /1 arquivo citado no curso não estava na instalação de origem.*conteudo\/Apostila_REDES_2\.md/.test(aviso)), JSON.stringify(preview.avisos));
});

test('[UC-PACOTE-002] turma modelo em que alunos antigos (turma gravada só pelo nome) entrariam não é criada, e a prévia avisa', async () => {
    freshInstall();
    const { studentBelongsToClass } = require('../../backend/middlewares.js');
    // Como no banco do Alan: turma gravada só como texto, e o campo antigo studentClass.
    db.memory.students.push(
        { name: 'Raul', email: 'raul@pacote.local', status: 'Ativo', classes: [CLASS], studentClass: CLASS },
        { name: 'Mateus', email: 'mateus@pacote.local', status: 'Ativo', studentClass: CLASS },
        { name: 'Bia', email: 'bia@pacote.local', status: 'Ativo', classes: [{ name: CLASS }] },
    );
    const { body: buffer } = await exportBuffer();
    const preview = await postPackage('/api/admin/course-packages/preview', buffer);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.turmasModelo, [CLASS]);
    assert.deepEqual(preview.body.turmasModeloComAlunos, [{ nome: CLASS, alunos: 3 }], 'Ana, matriculada com o curso, não conta');
    assert.ok(preview.body.avisos.some(aviso => aviso.includes(`A turma modelo ${CLASS} não será criada: 3 alunos daqui têm a turma ${CLASS} gravada só pelo nome`)), JSON.stringify(preview.body.avisos));

    const done = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'REDES_NOVO', newName: 'Redes novo', incluirTurmasModelo: 'sim' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.classes, []);
    assert.deepEqual(done.body.turmasPuladas, [{ nome: CLASS, alunos: 3 }]);
    assert.ok(done.body.avisos.some(aviso => aviso.includes('não será criada')));
    assert.equal(db.memory.classes.some(cls => cls.courseId === 'REDES_NOVO'), false);
    assert.deepEqual(audits('course_package_imported').at(-1).details.turmasPuladas, [{ nome: CLASS, alunos: 3 }]);
    // Nenhuma turma do curso novo tem aluno.
    const novas = db.memory.classes.filter(cls => cls.courseId === 'REDES_NOVO');
    assert.equal(db.memory.students.filter(student => novas.some(cls => studentBelongsToClass(student, cls))).length, 0);

    // Sem aluno antigo com esse nome, a turma é criada vazia.
    db.memory.students = db.memory.students.filter(student => student.email === STUDENT);
    const again = await postPackage('/api/admin/course-packages/preview', buffer);
    assert.deepEqual(again.body.turmasModeloComAlunos, []);
    const created = await postPackage('/api/admin/course-packages/import', buffer, { sha256: again.body.sha256, newId: 'REDES_OUTRO', newName: 'Redes outro', incluirTurmasModelo: 'sim' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const cls = db.memory.classes.find(item => item.courseId === 'REDES_OUTRO');
    assert.equal(cls.name, CLASS);
    assert.equal(db.memory.students.filter(student => studentBelongsToClass(student, cls)).length, 0, 'vazia');
});

test('[UC-PACOTE-002] código sugerido: separador quando o código termina em número; a prévia diz para quais escolas a conta importa', async () => {
    const buffer = buildPackage(({ manifest }) => { manifest.curso.codigo = 'curso_legacy_01'; });
    const memory = { ...emptyMemory(), courses: [{ id: 'CURSO_LEGACY_01' }, { id: 'CURSO_LEGACY_01_2' }] };
    const preview = await coursePackage.previewCoursePackage(buffer, { memory, ...otherInstallDirs('instalacao-sugestao') });
    assert.equal(preview.conflitos.cursoExiste, true);
    assert.equal(preview.sugestao.newId, 'CURSO_LEGACY_01_3');
    const letters = buildPackage(({ manifest }) => { manifest.curso.codigo = 'FUTEC'; });
    const futec = await coursePackage.previewCoursePackage(letters, { memory: { ...emptyMemory(), courses: [{ id: 'FUTEC' }] }, ...otherInstallDirs('instalacao-sugestao-2') });
    assert.equal(futec.sugestao.newId, 'FUTEC2', 'o exemplo do desenho continua');

    freshInstall();
    const asAdminPreview = await postPackage('/api/admin/course-packages/preview', buffer);
    assert.deepEqual(asAdminPreview.body.escolasPermitidas, ['escola_a', 'escola_b']);
    const asProfPreview = await postPackage('/api/admin/course-packages/preview', buffer, {}, asProfessor);
    assert.equal(asProfPreview.status, 200, JSON.stringify(asProfPreview.body));
    assert.deepEqual(asProfPreview.body.escolasPermitidas, ['escola_a'], 'só a escola atribuída, como a importação exige');
});

test('[UC-PACOTE-002] importar grava o curso e a auditoria numa gravação só', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    const preview = await postPackage('/api/admin/course-packages/preview', buffer);
    const originalSave = db.save;
    const calls = [];
    db.save = function spySave(options) {
        calls.push(options && Array.isArray(options.only) ? [...options.only] : 'tudo');
        return originalSave.call(this, options);
    };
    let res;
    try {
        res = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'UMA_VEZ', newName: 'Uma vez' });
    } finally {
        db.save = originalSave;
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const withCourse = calls.filter(only => only === 'tudo' || only.includes('courses'));
    assert.equal(withCourse.length, 1, JSON.stringify(calls));
    assert.ok(withCourse[0] === 'tudo' || withCourse[0].includes('auditLogs'), JSON.stringify(calls));
    assert.equal(calls.filter(only => only !== 'tudo' && only.length === 1 && only[0] === 'auditLogs').length, 0, 'sem gravação só da auditoria depois');
});

// Ajuste 2 do A14: a regra "texto que é só um e-mail sai" não vale para o conteúdo da
// questão. Questão de curso de TI cuja alternativa ou resposta aceita é um e-mail vai e
// volta como está; o histórico com e-mail de quem mexeu continua saindo.
test('[UC-PACOTE-001] questão com e-mail na alternativa, no gabarito e na resposta aceita vai e volta igual', async () => {
    freshInstall();
    const questions = [
        { type: 'multiple_choice', points: 1, text: 'Qual destes é um e-mail válido?', correctAnswer: 'A', alternatives: [
            { letter: 'A', text: 'joao@empresa.com.br' }, { letter: 'B', text: 'joao@@empresa' }, { letter: 'C', text: 'joao.empresa.com' },
        ] },
        { type: 'short_answer', points: 1, text: 'Para que endereço vai o pedido de suporte?', acceptedAnswers: ['suporte@escola.edu.br'], review: 'auto', explanation: 'suporte@escola.edu.br' },
        { type: 'essay', points: 2, text: 'Escreva o e-mail de contato.', expectedAnswer: 'contato@escola.edu.br' },
    ];
    db.memory.evaluations.Avaliacao_REDES_2 = { key: 'Avaliacao_REDES_2', title: 'Prova prática', theme: '', rubric: '', questions: normalizeEvaluationQuestions(questions).map((question, index) => (index === 0 ? { ...question, meta: { revisor: 'revisor@escola.local' } } : question)) };
    db.memory.questionBank.push({ key: 'qb_email', category: 'Redes', type: 'short_answer', questionText: 'E-mail do suporte?', acceptedAnswers: ['suporte@escola.edu.br'], review: 'auto', sourceExamKey: 'Avaliacao_REDES_2', author: PROF, updatedBy: PROF, history: [{ by: PROF, em: '2026-11-01' }] });

    const res = await exportBuffer();
    const manifest = JSON.parse(new AdmZip(res.body).readAsText('manifest.json'));
    const exported = manifest.avaliacoes.Avaliacao_REDES_2.questions;
    assert.equal(exported[0].alternatives[0].text, 'joao@empresa.com.br');
    assert.deepEqual(exported[1].acceptedAnswers, ['suporte@escola.edu.br']);
    assert.equal(exported[1].explanation, 'suporte@escola.edu.br');
    assert.equal(exported[2].expectedAnswer, 'contato@escola.edu.br');
    assert.deepEqual(exported[0].meta, {}, 'campo fora do conteúdo da questão segue a regra geral: o e-mail sai');
    const bankItem = manifest.questoes.find(item => item.questionText === 'E-mail do suporte?');
    assert.deepEqual(bankItem.acceptedAnswers, ['suporte@escola.edu.br']);
    assert.equal(bankItem.author, undefined);
    assert.deepEqual(bankItem.history, [{ em: '2026-11-01' }]);
    const text = JSON.stringify(manifest);
    [PROF, 'revisor@escola.local', STUDENT].forEach(email => assert.equal(text.includes(email), false, email));

    const preview = await postPackage('/api/admin/course-packages/preview', res.body);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const done = await postPackage('/api/admin/course-packages/import', res.body, { sha256: preview.body.sha256, newId: 'REDES_EMAIL', newName: 'Redes e-mail' });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const imported = db.memory.evaluations.Avaliacao_REDES_2_REDES_EMAIL.questions;
    const original = db.memory.evaluations.Avaliacao_REDES_2.questions;
    assert.deepEqual(imported.map(({ meta, ...question }) => question), original.map(({ meta, ...question }) => question), 'as questões voltam iguais');
    const importedBank = db.memory.questionBank.find(item => item.sourceExamKey === 'Avaliacao_REDES_2_REDES_EMAIL');
    assert.deepEqual(importedBank.acceptedAnswers, ['suporte@escola.edu.br']);
    assert.equal(importedBank.author, 'admin@pacote.local');
});

test('[UC-PACOTE-001] avaliação da estrutura que não existe na origem entra em foraDoPacote e a prévia avisa', async () => {
    freshInstall();
    delete db.memory.evaluations.Avaliacao_REDES_2; // sem .md e sem questões nesta instalação
    const res = await exportBuffer();
    assert.equal(res.headers['x-iclass-fora-do-pacote'], '1');
    const manifest = JSON.parse(new AdmZip(res.body).readAsText('manifest.json'));
    assert.deepEqual(manifest.foraDoPacote, [{ arquivo: 'conteudo/Avaliacao_REDES_2.md', chave: 'Avaliacao_REDES_2', tipo: 'avaliacao', motivo: 'avaliação sem as questões nesta instalação' }]);
    const preview = await coursePackage.previewCoursePackage(res.body, { memory: emptyMemory(), ...otherInstallDirs('instalacao-sem-avaliacao') });
    assert.ok(preview.avisos.some(aviso => aviso === 'A avaliação Avaliacao_REDES_2 está na estrutura do curso, mas não existia na instalação de origem e não veio no pacote: a unidade chega sem as questões.'), JSON.stringify(preview.avisos));
    assert.equal(preview.avisos.some(aviso => /arquivo citado no curso/.test(aviso)), false, 'não é contada como arquivo');
    // A avaliação que existe (feita no editor, sem .md) continua não sendo "falta".
    freshInstall();
    const ok = await exportBuffer();
    assert.equal(ok.headers['x-iclass-fora-do-pacote'], '0');
});

test('[UC-PACOTE-003] arquivo de mídia que o curso não cita não é gravado; a prévia e a importação avisam', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const buffer = buildPackage(({ files, manifest }) => {
        files['conteudo/Apostila_X_1.md'] = Buffer.from('# X\n\n![usada](imagens/x/usada.svg) e [pdf](/uploads/usado.pdf)\n');
        files['midia/imagens/x/usada.svg'] = SVG;
        files['midia/imagens/x/evil.svg'] = svg;
        files['midia/uploads/usado.pdf'] = PDF;
        files['midia/uploads/solto.pdf'] = PDF;
        files['midia/uploads/da-biblioteca.pdf'] = PDF;
        manifest.biblioteca = [{ kind: 'file', name: 'Leitura', filename: 'da-biblioteca.pdf', description: '' }];
    });
    const memory = emptyMemory();
    const dirs = otherInstallDirs('instalacao-nao-citados');
    const preview = await coursePackage.previewCoursePackage(buffer, { memory, ...dirs });
    assert.equal(preview.conflitos.arquivosNaoCitados, 2);
    assert.equal(preview.contagens.imagens, 1);
    assert.equal(preview.contagens.arquivos, 2);
    assert.ok(preview.avisos.some(aviso => aviso.startsWith('2 arquivos do pacote não são citados') && aviso.includes('midia/imagens/x/evil.svg') && aviso.includes('midia/uploads/solto.pdf')), JSON.stringify(preview.avisos));
    const result = await coursePackage.importCoursePackage(buffer, { memory, ...dirs, newId: 'X', newName: 'Curso X', expectedSha256: preview.sha256 });
    assert.deepEqual(result.arquivosNaoCitados.sort(), ['midia/imagens/x/evil.svg', 'midia/uploads/solto.pdf']);
    assert.ok(result.avisos.some(aviso => aviso.startsWith('2 arquivos do pacote não são citados')));
    assert.deepEqual(listTree(dirs.contentDir), ['Apostila_X_1.md', 'imagens/x/usada.svg']);
    assert.deepEqual(listTree(dirs.uploadsDir), ['da-biblioteca.pdf', 'usado.pdf']);
    assert.equal(result.contagens.imagens, 1);
});

test('[UC-PACOTE-003] pasta temporária da importação: o backup não a leva e o boot a apaga', async () => {
    const backupArchive = require('../../backend/utils/backupArchive.js');
    const dirs = otherInstallDirs('instalacao-staging');
    const stale = path.join(dirs.contentDir, '.pacote-0123456789abcdef');
    const staleUploads = path.join(dirs.uploadsDir, '.pacote-0123456789abcdef');
    [stale, staleUploads].forEach(dir => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '0'), AVALIACAO_MD); });
    fs.writeFileSync(path.join(dirs.contentDir, 'Apostila_A.md'), APOSTILA_2);
    fs.mkdirSync(path.join(dirs.contentDir, '.pacote-outra-coisa'));
    fs.writeFileSync(path.join(dirs.contentDir, '.pacote-outra-coisa', 'fica.md'), APOSTILA_2);
    assert.ok(backupArchive.TRANSIENT_DIR_NAME.test('.pacote-0123456789abcdef'));
    assert.equal(String(backupArchive.TRANSIENT_DIR_NAME), String(coursePackage.STAGING_DIR_NAME), 'o mesmo padrão nos dois módulos');
    const listed = (await backupArchive.listFolderFiles(dirs.contentDir)).map(file => file.rel).sort();
    assert.deepEqual(listed, ['.pacote-outra-coisa/fica.md', 'Apostila_A.md'], 'a pasta de trabalho fica fora do backup');
    // Na importação, só a de mais de 1 hora sai; no boot (idade 0), todas.
    assert.equal(coursePackage.cleanStaleStaging(dirs), 0);
    assert.ok(fs.existsSync(stale));
    assert.equal(coursePackage.cleanStaleStaging(dirs, Date.now(), 0), 2);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(staleUploads), false);
    assert.ok(fs.existsSync(path.join(dirs.contentDir, '.pacote-outra-coisa', 'fica.md')), 'só o nome exato da pasta de trabalho');
    assert.ok(fs.existsSync(path.join(dirs.contentDir, 'Apostila_A.md')));
    // O boot chama a limpeza (server.js, passo 5c).
    const serverSource = fs.readFileSync(path.join(__dirname, '../../backend/server.js'), 'utf8');
    assert.match(serverSource, /coursePackage\.js'\)\.cleanStaleStaging\(undefined, Date\.now\(\), 0\)/);
});

test('[UC-PACOTE-002] prévia: imagensRenomeadas conta só as imagens de content/imagens renomeadas', async () => {
    freshInstall();
    const { body: buffer } = await exportBuffer();
    fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'), SVG_DIFERENTE);
    fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'foto-rede.png'), PNG_OUTRA);
    try {
        const preview = await postPackage('/api/admin/course-packages/preview', buffer);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        assert.equal(preview.body.conflitos.arquivosRenomeados, 2);
        assert.equal(preview.body.conflitos.imagensRenomeadas, 1);
        assert.equal(preview.body.conflitos.arquivosNaoCitados, 0);
    } finally {
        fs.writeFileSync(path.join(runtimePaths.CONTENT_DIR, 'imagens', 'redes', 'topologia.svg'), SVG);
        fs.writeFileSync(path.join(runtimePaths.UPLOADS_DIR, 'foto-rede.png'), PNG);
    }
});

test('[UC-PACOTE-002] curso excluído guardado em Cursos excluídos: o código e as chaves dele contam como usados, e restaurar depois não pisa no importado (J2, pendência do A14)', async () => {
    freshInstall();
    fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
    const { body: buffer } = await exportBuffer();
    const archived = await asAdmin(request(app).post(`/api/admin/courses/${COURSE}/purge`)).send({});
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    assert.equal(db.memory.courses.some(course => course.id === COURSE), false);
    assert.equal(fs.existsSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1.md')), false, 'a apostila foi para o pacote');
    try {
        const preview = await postPackage('/api/admin/course-packages/preview', buffer);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        assert.equal(preview.body.sugestao.newId, 'REDES2', 'o código do curso excluído não é sugerido');
        assert.equal(preview.body.conflitos.chavesRenomeadas, 4, 'as chaves do curso excluído contam como usadas');
        // O código do curso excluído (sem diferença de maiúsculas) é recusado.
        const taken = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'redes', newName: 'Redes' });
        assert.equal(taken.status, 400, JSON.stringify(taken.body));
        assert.equal(taken.body.field, 'newId');
        assert.match(taken.body.error, /curso excluído/);
        const done = await postPackage('/api/admin/course-packages/import', buffer, { sha256: preview.body.sha256, newId: 'REDES2', newName: 'Redes (importado)' });
        assert.equal(done.status, 200, JSON.stringify(done.body));
        const apostila = path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1_REDES2.md');
        const imported = fs.readFileSync(apostila, 'utf8');
        fs.writeFileSync(apostila, `${imported}\nEditado no curso importado.\n`);
        // Restaurar o curso excluído traz as apostilas dele com os nomes de antes, sem
        // sobrescrever as do importado.
        const restored = await asAdmin(request(app).post('/api/admin/archived-courses/restore')).send({ folder: archived.body.folder });
        assert.equal(restored.status, 200, JSON.stringify(restored.body));
        assert.equal(fs.readFileSync(apostila, 'utf8'), `${imported}\nEditado no curso importado.\n`);
        assert.equal(fs.readFileSync(path.join(runtimePaths.CONTENT_DIR, 'Apostila_REDES_1.md'), 'utf8'), APOSTILA_1);
        assert.deepEqual(db.memory.courses.map(course => course.id).sort(), [COURSE, OTHER, 'REDES2'].sort());
        // Unidade: sem pasta de cursos excluídos, nada muda.
        assert.deepEqual(coursePackage.archivedCourseReservations(path.join(tempRoot, 'nada')), { keys: new Set(), ids: new Set() });
    } finally {
        fs.rmSync(runtimePaths.ARCHIVE_DIR, { recursive: true, force: true });
    }
});

test('[UC-PACOTE-001] critérios de avaliação do curso (avaliacao, B6) e "Permitir imprimir a apostila" (permitirImpressao, C17) vão e voltam no pacote (J2)', async () => {
    freshInstall();
    const course = db.memory.courses.find(item => item.id === COURSE);
    course.avaliacao = {
        versao: 1, ativo: true, mediaMinima: 7, frequenciaMinima: 80,
        etapas: [{ ordem: 1, nome: '1º bimestre', peso: 1 }, { ordem: 2, nome: '2º bimestre', peso: 2 }],
        recuperacao: { etapa: 'substitui_se_maior', final: 'media' },
        mencoes: [{ sigla: 'MB', nome: 'Muito bom', min: 9 }, { sigla: 'I', nome: 'Insuficiente', min: 0 }],
        unidadeSituacao: 'disciplina', atualizadoEm: 1700000000000, atualizadoPor: 'admin@pacote.local',
    };
    course.permitirImpressao = false;
    const built = await coursePackage.exportCoursePackage(db.memory, COURSE, { contentDir: runtimePaths.CONTENT_DIR, uploadsDir: runtimePaths.UPLOADS_DIR });
    const manifest = JSON.parse(new AdmZip(built.buffer).readAsText('manifest.json'));
    assert.equal(manifest.curso.permitirImpressao, false);
    assert.equal(manifest.curso.avaliacao.atualizadoPor, undefined, 'sem o e-mail de quem mudou');
    assert.equal(manifest.curso.avaliacao.atualizadoEm, undefined);
    assert.equal(JSON.stringify(manifest).includes('admin@pacote.local'), false);

    const memory = emptyMemory();
    const dirs = otherInstallDirs('instalacao-criterios');
    const preview = await coursePackage.previewCoursePackage(built.buffer, { memory, ...dirs });
    const done = await coursePackage.importCoursePackage(built.buffer, { memory, ...dirs, newId: preview.sugestao.newId, newName: 'Redes', actorEmail: 'outra@escola.local', expectedSha256: preview.sha256, now: 1800000000000 });
    const imported = done.course;
    assert.equal(imported.permitirImpressao, false);
    const { atualizadoEm, atualizadoPor, ...criterios } = imported.avaliacao;
    assert.deepEqual([atualizadoEm, atualizadoPor], [1800000000000, 'outra@escola.local'], 'quem importou, nesta instalação');
    const { atualizadoEm: a, atualizadoPor: b, ...original } = gradingRules.normalizeCriteria(course.avaliacao);
    assert.deepEqual(criterios, original, 'os mesmos critérios');
    assert.deepEqual(gradingRules.criterioForScreen(imported.avaliacao), gradingRules.criterioForScreen(course.avaliacao));

    // Critérios desligados viajam desligados (a regra antiga continua no importado), e o
    // curso sem o campo de impressão continua sem (padrão: pode imprimir).
    course.avaliacao = { ...course.avaliacao, ativo: false };
    delete course.permitirImpressao;
    const off = await coursePackage.exportCoursePackage(db.memory, COURSE, { contentDir: runtimePaths.CONTENT_DIR, uploadsDir: runtimePaths.UPLOADS_DIR });
    const offManifest = JSON.parse(new AdmZip(off.buffer).readAsText('manifest.json'));
    assert.equal(offManifest.curso.avaliacao.ativo, false);
    assert.equal(offManifest.curso.permitirImpressao, undefined);
    const memory2 = emptyMemory();
    const dirs2 = otherInstallDirs('instalacao-criterios-2');
    const preview2 = await coursePackage.previewCoursePackage(off.buffer, { memory: memory2, ...dirs2 });
    const done2 = await coursePackage.importCoursePackage(off.buffer, { memory: memory2, ...dirs2, newId: preview2.sugestao.newId, newName: 'Redes', expectedSha256: preview2.sha256 });
    assert.equal(done2.course.avaliacao.ativo, false);
    assert.equal(gradingRules.normalizeCriteria(done2.course.avaliacao), null);
    assert.equal(done2.course.permitirImpressao, undefined);
    delete course.avaliacao;
});
