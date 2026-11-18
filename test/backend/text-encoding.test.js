// Textos com codificação quebrada ("não" gravado como UTF-8 relido em Latin-1): nenhum arquivo do sistema
// pode ter UTF-8 relido como Latin-1/Windows-1252, e as mensagens corrigidas chegam
// certas ao professor. Os padrões ficam escritos com escapes para este arquivo não
// conter o próprio texto quebrado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-encoding-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');

const repoRoot = path.resolve(__dirname, '..', '..');
// "Ã" ou "Â" seguidos de um caractere da faixa 0x80–0xBF (ou dos especiais do
// Windows-1252), e "\u00E2\u20AC" (aspas e travessões quebrados).
const CP1252_SPECIALS = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const MOJIBAKE = new RegExp(`[\\u00C3\\u00C2][\\u0080-\\u00BF${CP1252_SPECIALS}]|\\u00E2\\u20AC`);
const SCANNED_DIRS = ['backend', path.join('web', 'src'), 'content', 'test', 'resources'];
const TEXT_FILE = /\.(?:js|jsx|cjs|mjs|json|md|html|css|txt|csv|bat)$/i;

function walk(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (['node_modules', 'dist', '.git'].includes(entry.name)) return [];
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return walk(fullPath);
        return TEXT_FILE.test(entry.name) ? [fullPath] : [];
    });
}

test('nenhum arquivo do sistema tem texto com codificação quebrada', () => {
    const files = [...SCANNED_DIRS.flatMap(dir => walk(path.join(repoRoot, dir))), path.join(repoRoot, 'ligarIclassV3.bat')]
        .filter(file => fs.existsSync(file));
    assert.ok(files.length > 50, 'a varredura encontrou os arquivos do sistema');
    const broken = [];
    for (const file of files) {
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
            if (MOJIBAKE.test(line)) broken.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    assert.deepEqual(broken, []);
    // O detector reconhece o texto quebrado de verdade.
    assert.equal(MOJIBAKE.test(Buffer.from('são obrigatórios', 'utf8').toString('latin1')), true);
    assert.equal(MOJIBAKE.test('são obrigatórios'), false);
});

test('liberar o foco sem aluno ou prova responde com a mensagem em português correto', async () => {
    await db.init();
    const app = createApp();
    db.memory.admins = [{ email: 'admin@encoding.local', name: 'Admin', role: 'admin', password: db.hashPassword('x') }];
    db.memory.adminSessions = { 'admin-token-encoding': { email: 'admin@encoding.local', createdAt: Date.now(), lastSeen: Date.now() } };
    const response = await request(app)
        .post('/api/admin/unlock-student-focus')
        .set('x-admin-session', 'admin-token-encoding')
        .send({ studentClass: 'Turma' })
        .expect(400);
    assert.equal(response.body.error, 'E-mail do aluno e prova são obrigatórios.');
    const question = await request(app)
        .post('/api/admin/question-bank/create')
        .set('x-admin-session', 'admin-token-encoding')
        .send({})
        .expect(400);
    assert.equal(question.body.error, 'Texto da questão é obrigatório.');
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});
