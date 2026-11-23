// Telas de atividade do aluno (fase 3, C9 / P1-g; FUN-01, D5, D6 e D12 do P1). A tela
// confere o envio antes de mandar (tipo, executável, tamanho, quantidade, total, link e
// envio vazio) com as frases de web/src/features/student/atividades/atividadeRules.js. Este
// teste carrega esse arquivo no Node e manda os mesmos casos de verdade a POST
// /api/student/assignments/:id/submit: a frase que a tela mostra antes do upload é a mesma
// que o servidor daria depois dele. Também confere que o corpo que a tela monta (campo
// 'files', 'text', 'link') e os caminhos que ela chama são os que o servidor lê. Antes do
// C9 não havia a tela nem esse módulo: este teste falha no código antigo ao importá-lo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-assignments-screen-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const assignments = require('../../backend/utils/assignments.js');
const assignmentFiles = require('../../backend/utils/assignmentFiles.js');
const { createStudentSession } = require('../../backend/utils/authSessions.js');
const { createApp } = require('../../backend/server.js');

const ROOT = path.join(__dirname, '..', '..');
const WEB_SRC = path.join(ROOT, 'web', 'src');
const COURSE = 'curso-tela';
const CLASS = '1DES';
const ANA = 'ana@tela.local';
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(512, 0x20), Buffer.from('\n%%EOF\n')]);
let app;
let rules;
let token;

function task(fields = {}) {
    const now = Date.now();
    return assignments.newAssignmentRecord({
        courseId: COURSE,
        studentClass: CLASS,
        title: 'Relatório',
        response: { files: true, text: true, link: true },
        files: { maxFiles: 2, maxSizeMb: 1, types: ['pdf', 'image'], extraExtensions: ['.pkt'] },
        dueAt: now + 3 * DAY,
        latePolicy: { mode: 'aceitar', penaltyPerDayPct: 10, penaltyMaxPct: 50 },
        status: 'publicada',
        ...fields,
    }, { actor: 'prof@tela.local', now: now - 1000 });
}

function seed() {
    db.memory.config = { ...(db.memory.config || {}), settings: {
        timezone: 'America/Sao_Paulo',
        entregas: { maxMbPorArquivo: 20, maxMbPorEnvio: 2, discoLivreMinimoMb: 0 },
    } };
    db.memory.courses = [{ id: COURSE, name: 'Curso', structure: [] }];
    db.memory.classes = [{ name: CLASS, courseId: COURSE, period: 'Manhã' }];
    db.memory.students = [{ id: 'alu_00000000000000a1', name: 'Ana', email: ANA, status: 'Ativo', password: db.hashPassword('123'), classes: [{ name: CLASS, courseId: COURSE }] }];
    db.memory.assignments = [];
    db.memory.assignmentSubmissions = [];
    db.memory.auditLogs = [];
    db.memory.sessions = {};
    token = createStudentSession(db.memory, ANA);
    fs.rmSync(runtimePaths.ASSIGNMENT_FILES_DIR, { recursive: true, force: true });
}

const Q = `courseId=${COURSE}&studentClass=${CLASS}`;

async function detailOf(id) {
    const res = await request(app).get(`/api/student/assignments/${id}?${Q}`).set('x-session-token', token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
}

function submit(id, { files = [], text, link } = {}) {
    let req = request(app).post(`/api/student/assignments/${id}/submit`).set('x-session-token', token);
    files.forEach(([name, buffer]) => { req = req.attach('files', buffer, name); });
    if (text !== undefined) req = req.field('text', text);
    if (link !== undefined) req = req.field('link', link);
    if (!files.length && text === undefined && link === undefined) req = req.field('nada', '');
    return req;
}

function source(file) {
    return fs.readFileSync(path.join(WEB_SRC, file), 'utf8');
}

test.before(async () => {
    rules = await import(pathToFileURL(path.join(WEB_SRC, 'features', 'student', 'atividades', 'atividadeRules.js')).href);
    await db.init();
    app = createApp();
});
test.beforeEach(() => { seed(); });
test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('a lista de executáveis da tela é a do servidor (assignmentFiles.BLOCKED_EXECUTABLES)', () => {
    assert.deepEqual([...rules.BLOCKED_EXECUTABLES], [...assignmentFiles.BLOCKED_EXECUTABLES]);
});

test('nome e extensão: a frase da tela = a de assignmentFiles.classifyFileName, com as extensões do detalhe', async () => {
    const row = task();
    db.memory.assignments = [row];
    const { aceita } = await detailOf(row.id);
    const serverRules = assignments.submissionRules(assignments.normalizeAssignment(row), { maxMbPorArquivo: 20 });
    assert.deepEqual(aceita.extensoes, serverRules.extensions);
    const names = [
        'relatorio.pdf', 'Relatório final.PDF', 'foto.jpg', 'tela.png', 'circuito.pkt', 'virus.exe', 'atalho.LNK', 'script.ps1',
        'planilha.xlsx', 'codigo.py', 'IMG_2031', '.oculto', 'nome com espaço no fim .pdf', 'a<b>c.pdf', 'pasta/sub/arquivo.pdf',
        'arquivo.', `${'x'.repeat(130)}.pdf`, 'imagem.HEIC', 'arquivo.tar.gz', 'sem\u0007controle.pdf',
    ];
    for (const name of names) {
        const server = assignmentFiles.classifyFileName(name, serverRules);
        const client = rules.fileProblem({ name, size: 10 }, aceita);
        assert.equal(client, server.ok ? '' : server.message, `nome ${JSON.stringify(name)}`);
    }
    assert.equal(rules.fileProblem({ name: '', size: 10 }, aceita), assignmentFiles.classifyFileName('', serverRules).message);
});

test('recusas de verdade do envio têm a mesma frase da tela: tipo, executável, tamanho, quantidade, total, link e vazio', async () => {
    const row = task();
    db.memory.assignments = [row];
    const { aceita } = await detailOf(row.id);
    const cases = [
        { label: 'tipo fora da tarefa', files: [['planilha.xlsx', PDF]], client: () => rules.fileProblem({ name: 'planilha.xlsx', size: PDF.length }, aceita) },
        { label: 'executável', files: [['virus.exe', PDF]], client: () => rules.fileProblem({ name: 'virus.exe', size: PDF.length }, aceita) },
        { label: 'sem extensão', files: [['IMG_2031', PDF]], client: () => rules.fileProblem({ name: 'IMG_2031', size: PDF.length }, aceita) },
        { label: 'grande', files: [['grande.pdf', Buffer.concat([PDF, Buffer.alloc(MB)])]], client: () => rules.fileProblem({ name: 'grande.pdf', size: PDF.length + MB }, aceita) },
        { label: 'arquivos demais', files: [['a.pdf', PDF], ['b.pdf', PDF], ['c.pdf', PDF]], client: () => rules.selectionProblem([{}, {}, {}], aceita) },
        { label: 'link sem http', files: [], link: 'github.com/ana', client: () => rules.linkProblem('github.com/ana') },
        { label: 'link javascript', files: [], link: 'javascript:alert(1)', client: () => rules.linkProblem('javascript:alert(1)') },
        { label: 'vazio', files: [], client: () => rules.emptySubmissionText(aceita.resposta) },
    ];
    for (const item of cases) {
        const res = await submit(row.id, { files: item.files, link: item.link });
        assert.ok(res.status >= 400 && res.status < 500, `${item.label}: ${res.status} ${JSON.stringify(res.body)}`);
        const expected = item.client();
        assert.ok(expected, `${item.label}: a tela não recusou`);
        assert.equal(res.body.error, expected, item.label);
    }
    // Total do envio: dois arquivos de 0,6 MB com 1 MB por envio (o limite de Sistema): a
    // tela recusa antes, com a frase do servidor.
    const part = Buffer.concat([PDF, Buffer.alloc(Math.floor(0.6 * MB), 0x20)]);
    db.memory.config.settings.entregas = { maxMbPorArquivo: 1, maxMbPorEnvio: 1, discoLivreMinimoMb: 0 };
    const tight = await detailOf(row.id);
    assert.equal(tight.aceita.maxTotalMb, 1);
    const total = await submit(row.id, { files: [['a.pdf', part], ['b.pdf', part]] });
    assert.equal(total.status, 413, JSON.stringify(total.body));
    assert.equal(total.body.error, rules.selectionProblem([{ size: part.length }, { size: part.length }], tight.aceita));
    // Nada ficou gravado.
    assert.equal((db.memory.assignmentSubmissions || []).length, 0);
});

test('tarefa só com arquivo ou só com link: a frase do envio vazio acompanha a resposta aceita', async () => {
    const onlyFiles = task({ response: { files: true, text: false, link: false } });
    const onlyLink = task({ response: { files: false, text: false, link: true } });
    db.memory.assignments = [onlyFiles, onlyLink];
    for (const row of [onlyFiles, onlyLink]) {
        const { aceita } = await detailOf(row.id);
        const res = await submit(row.id);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error, rules.emptySubmissionText(aceita.resposta));
    }
});

test('o corpo que a tela monta é o que o servidor lê: arquivos em "files", texto e link; e os caminhos da tela existem', async () => {
    const detailScreen = source('features/student/AtividadeDetalhePage.jsx');
    const text = source('features/student/atividades/atividadeText.js');
    assert.ok(text.includes("form.append('files', file, file.name)"), 'a tela manda cada arquivo no campo files');
    assert.ok(text.includes("form.append('text', text)"), 'a tela manda o texto em text');
    assert.ok(text.includes("form.append('link', String(link).trim())"), 'a tela manda o link em link');
    assert.ok(detailScreen.includes('`/api/student/assignments/${encodeURIComponent(id)}/submit`'));
    assert.ok(detailScreen.includes('`/api/student/assignments/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`'));
    assert.ok(detailScreen.includes('`/api/student/assignments/${encodeURIComponent(id)}?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`'));
    assert.ok(source('features/student/AtividadesPage.jsx').includes('`/api/student/assignments?courseId=${encodeURIComponent(courseId)}&studentClass=${encodeURIComponent(studentClass)}`'));

    const row = task();
    db.memory.assignments = [row];
    const res = await submit(row.id, { files: [['Relatório final.pdf', PDF]], text: 'Segue o relatório.', link: 'https://github.com/ana/projeto' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const version = res.body.version;
    assert.equal(version.n, 1);
    assert.deepEqual(version.files.map(file => file.name), ['Relatório final.pdf']);
    assert.equal(version.text, 'Segue o relatório.');
    assert.equal(version.link, 'https://github.com/ana/projeto');
    // O comprovante que a tela mostra (código da versão e de cada arquivo) vem pronto.
    assert.match(version.comprovante, /^[0-9A-F]{8}$/);
    assert.match(version.files[0].comprovante, /^[0-9A-F]{8}$/);
    // O detalhe traz a versão com os mesmos campos que a tela lê (versões, bytes, código).
    const after = await detailOf(row.id);
    const listed = after.minhaEntrega.versoes[0];
    assert.equal(listed.comprovante, version.comprovante);
    assert.equal(listed.bytes, PDF.length);
    assert.equal(after.situacao, 'enviada');
    // Download que a tela pede (filePath): anexo do próprio arquivo.
    const download = await request(app).get(`/api/student/assignments/${row.id}/files/${listed.files[0].id}`).set('x-session-token', token);
    assert.equal(download.status, 200);
    assert.match(download.headers['content-disposition'], /^attachment;/);
});
