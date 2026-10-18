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
// Fora da lista entram as terminações -cao/-coes/-soes (sempre -ção/-ções/-sões).
const WORDS = [
    'nao', 'sao', 'questao', 'questoes', 'aplicacao', 'aplicacoes', 'duvida', 'duvidas', 'sessao', 'permissao', 'operacao',
    'obrigatorio', 'obrigatoria', 'obrigatorios', 'obrigatorias', 'historico', 'titulo', 'titulos', 'ja', 'ha', 'maximo', 'minimo',
    'modulo', 'modulos', 'topico', 'topicos', 'concluido', 'concluida', 'concluidos', 'concluidas', 'conclusao', 'faca', 'voce', 'voces',
    'disponivel', 'disponiveis', 'indisponivel', 'possivel', 'impossivel', 'codigo', 'usuario', 'usuarios', 'matricula', 'matriculas',
    'materia', 'materias', 'anotacao', 'anotacoes', 'informacao', 'informacoes', 'mes', 'meses', 'proximo', 'proxima', 'proximos', 'proximas',
    'paragrafo', 'paragrafos', 'conteudo', 'conteudos', 'avaliacao', 'avaliacoes', 'medio', 'ultimo', 'ultima', 'ultimos', 'ultimas',
    'periodo', 'horario', 'horarios', 'calendario', 'presenca', 'presencas', 'frequencia', 'pagina', 'paginas', 'numero', 'valido', 'valida',
    'invalido', 'invalida', 'atencao', 'descricao', 'exercicio', 'exercicios', 'tambem', 'apos', 'sera', 'serao', 'ninguem', 'alguem', 'porem',
    'unico', 'unica', 'publico', 'publica', 'edicao', 'selecao', 'opcao', 'opcoes', 'acao', 'acoes', 'secao', 'secoes', 'versao', 'versoes',
    'correcao', 'nivel', 'padrao', 'rapido', 'rapida', 'rapidos', 'rapidas', 'cartao', 'reutilizaveis', 'inicio',
];
const UNACCENTED = new RegExp(`(^|[^\\w.@\\-À-ÿ])(${WORDS.map(word => `${word}|${word[0].toUpperCase()}${word.slice(1)}`).join('|')}|[A-Za-z]+(?:cao|coes|soes))(?=[^\\wÀ-ÿ]|$)`);
// "Termina as 10:00" (crase antes de hora).
const HOUR_WITHOUT_CRASE = /\b(termina|começa|inicia|encerra|abre|fecha)\s+as\s*(\d|$)/i;
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

// singleWords: nas telas, uma palavra só com inicial maiúscula ('Concluida') é rótulo
// visível; chaves técnicas ('nao', 'observacao') são minúsculas e ficam de fora.
function userFacingStrings(line, { singleWords = false } = {}) {
    const found = [];
    line.replace(/(['"`])((?:\\.|(?!\1)[^\n])*)\1/g, (_, quote, text) => { found.push(text.replace(/\$\{[^}]*\}/g, '0')); return ''; });
    // Só frases (com espaço); chaves técnicas como 'nao' ou `duvida:${id}` ficam de fora.
    return found.filter(text => /\s/.test(text.trim()) || (singleWords && /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(text.trim())));
}

function scan(files, { jsxText = false } = {}) {
    const problems = [];
    for (const file of files) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            const trimmed = line.trim();
            if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
            if (/console\.(log|error|warn|info)\(/.test(line)) return;
            const code = line.replace(/\s\/\/\s.*$/, '');
            const texts = userFacingStrings(code, { singleWords: jsxText });
            // Texto do JSX entre tags e expressões: <p>Termina as {hora}</p>, {n} materia{s}.
            if (jsxText) code.replace(/[>}]([^<>{}=]+)[<{]/g, (_, text) => { texts.push(text); return ''; });
            texts.forEach(text => {
                if (UNACCENTED.test(text) || HOUR_WITHOUT_CRASE.test(text) || MOJIBAKE.test(text)) problems.push(`${path.relative(root, file)}:${index + 1}: ${text.trim().slice(0, 120)}`);
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

// Revisão do ajuste 1: 'Concluida', 'Anotacao salva', 'Termina as', 'Mes anterior' e
// 'materia(s)' passavam (palavra solta, texto entre chaves, palavras fora da lista).
// Vale para todas as telas (aluno, instrutor e componentes comuns).
test('telas ficam em português com acentos', () => {
    const files = walk(path.join(root, 'web', 'src'), /\.jsx?$/)
        .filter(file => !/\.test\.jsx?$/.test(file));
    assert.deepEqual(scan(files, { jsxText: true }), []);
});

test('a varredura de acentos pega os casos que escapavam', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-acentos-'));
    const file = path.join(tmp, 'Tela.jsx');
    fs.writeFileSync(file, [
        "<Badge>{feito ? 'Concluida' : 'Em estudo'}</Badge>",
        "toast.success('Anotacao salva')",
        '<p><Clock size={15} /> Termina as {detail.endTime}</p>',
        '<Button aria-label="Mes anterior" />',
        "<div>Mostrando <b>{n}</b> em <b>{m}</b> materia{m !== 1 ? 's' : ''}</div>",
        "<Badge>{usados} ja usadas</Badge>",
        "<p>Sem informacoes adicionais.</p>",
        // Ficam de fora: chave técnica minúscula, propriedade, CSS e frase correta.
        "const radius = 'padrao'; const x = o.media; const css = '@media print'; const y = 'encerra as provas em andamento'",
    ].join('\n'));
    const problems = scan([file], { jsxText: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(problems.length, 7, problems.join('\n'));
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
