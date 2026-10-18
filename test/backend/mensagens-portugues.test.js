const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

// Textos que o usuário vê (mensagens de erro e de sucesso do servidor e telas do aluno)
// ficam em português com acentos. Sobra G5-acentos: mensagens como 'Aplicacao de prova
// nao encontrada.' e 'Texto da questÃ£o Ã© obrigatÃ³rio.' chegavam ao aluno e ao professor.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-mensagens-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const root = path.resolve(__dirname, '..', '..');
// Palavras que nunca se escrevem sem acento em português (não são formas verbais válidas).
const UNACCENTED = /(^|[^\wÀ-ÿ])(nao|Nao|sao|questao|Questao|questoes|aplicacao|Aplicacao|duvida|Duvida|duvidas|sessao|Sessao|permissao|operacao|obrigatorio|obrigatoria|obrigatorios|obrigatorias|historico|Titulo|titulo|Ja|maximo|minimo|Modulo|topico|topicos|concluido|concluida|concluidos|Conclusao|Faca|voce|Voce|disponivel|possivel|codigo|usuario|matricula|Matricula)(?=[^\wÀ-ÿ]|$)/;
// Texto UTF-8 lido como Latin-1 ("questÃ£o", "Ã©").
const MOJIBAKE = /Ã[\u0080-¿]|Ã[£¡©³§ªµº‰]/;

function walk(directory, pattern) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(fullPath, pattern);
        return pattern.test(entry.name) ? [fullPath] : [];
    });
}

function userFacingStrings(line) {
    const found = [];
    line.replace(/(['"`])((?:\\.|(?!\1)[^\n])*)\1/g, (_, quote, text) => { found.push(text.replace(/\$\{[^}]*\}/g, '0')); return ''; });
    // Só frases (com espaço); chaves técnicas como 'nao' ou `duvida:${id}` ficam de fora.
    return found.filter(text => /\s/.test(text.trim()));
}

function scan(files, { jsxText = false } = {}) {
    const problems = [];
    for (const file of files) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            if (/console\.(log|error|warn|info)\(/.test(line)) return;
            const code = line.replace(/\s\/\/\s.*$/, '');
            const texts = userFacingStrings(code);
            if (jsxText) code.replace(/>([^<>{}=]+)</g, (_, text) => { texts.push(text); return ''; });
            texts.forEach(text => {
                if (UNACCENTED.test(text) || MOJIBAKE.test(text)) problems.push(`${path.relative(root, file)}:${index + 1}: ${text.trim().slice(0, 120)}`);
            });
        });
    }
    return problems;
}

test('mensagens do servidor ficam em português com acentos e sem codificação quebrada', () => {
    const files = [
        ...walk(path.join(root, 'backend', 'routes'), /\.js$/),
        ...walk(path.join(root, 'backend', 'utils'), /\.js$/),
        path.join(root, 'backend', 'middlewares.js'),
        path.join(root, 'backend', 'server.js'),
    ];
    assert.deepEqual(scan(files), []);
});

test('telas do aluno ficam em português com acentos', () => {
    const files = walk(path.join(root, 'web', 'src', 'features', 'student'), /\.jsx?$/)
        .filter(file => !/\.test\.jsx?$/.test(file));
    assert.deepEqual(scan(files, { jsxText: true }), []);
});

let app;
const studentToken = 'student-token-mensagens';
const studentEmail = 'aluno@mensagens.local';
const studentClass = 'Turma Mensagens';
const courseId = 'curso-mensagens';

test.before(async () => {
    await db.init();
    app = createApp();
    db.memory.students = [{ name: 'Aluno Mensagens', email: studentEmail, status: 'Ativo', classes: [{ name: studentClass, courseId, status: 'Ativo' }], studentClass }];
    db.memory.sessions = { [studentEmail]: { token: studentToken, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{ id: courseId, structure: [] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
    db.memory.examApplications = [];
    db.memory.comments = [];
});

test.after(async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('aluno recebe as mensagens de erro da contestação e do fórum com acentos', async () => {
    const report = await request(app)
        .post('/api/student/report-question')
        .set('x-session-token', studentToken)
        .send({ applicationId: 'app_inexistente', attemptId: 'x', questionNumber: 1, reason: 'outro' })
        .expect(404);
    assert.equal(report.body.error, 'Aplicação de prova não encontrada.');
});
