// Autorrecuperação depois de uma atualização do IClass (revisão da integração da fase 1):
// o servidor manda a versão do build que serve (sourceHash de web/dist/build-meta.json)
// no cabeçalho X-IClass-Build de toda resposta da API que o aluno já consulta (sync,
// status, ping), inclusive as de erro. O navegador com o bundle de antes da atualização
// compara com a versão dele e recarrega sozinho (web/src/lib/buildVersion.js). Cada teste
// falha no comportamento antigo (sem o cabeçalho).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-build-version-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const runtimePaths = require('../../backend/runtimePaths.js');
const { BUILD_ID_HEADER, currentBuildId, resetBuildIdCache } = require('../../backend/utils/buildIntegrity.js');
const { createApp } = require('../../backend/server.js');

let app;
const originalDistDir = runtimePaths.WEB_DIST_DIR;
const distDir = path.join(tempRoot, 'dist');
const studentClass = 'Turma Versão';
const courseId = 'curso-versao';
const student = { email: 'ana@versao.local', token: 'token-ana-versao' };
const BUILD_A = 'a'.repeat(64);
const BUILD_B = 'b'.repeat(64);

function writeBuildMeta(sourceHash, mtime) {
    fs.mkdirSync(distDir, { recursive: true });
    const metaPath = path.join(distDir, 'build-meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ sourceHash, builtAt: new Date().toISOString() }) + '\n');
    // mtime explícito: duas gravações no mesmo milissegundo não podem parecer o mesmo arquivo.
    if (mtime) fs.utimesSync(metaPath, mtime, mtime);
    resetBuildIdCache();
}

test.before(async () => {
    runtimePaths.WEB_DIST_DIR = distDir;
    writeBuildMeta(BUILD_A);
    await db.init();
    app = createApp();
    db.memory.students = [{ name: 'Ana', email: student.email, status: 'Ativo', classes: [{ name: studentClass, courseId }] }];
    db.memory.sessions = { [student.email]: { token: student.token, lastSeen: Date.now(), ip: '127.0.0.1' } };
    db.memory.courses = [{ id: courseId, structure: [] }];
    db.memory.classes = [{ name: studentClass, courseId, releasedItems: {}, onlineExamConfigs: {}, examHistory: {} }];
});

test.after(async () => {
    runtimePaths.WEB_DIST_DIR = originalDistDir;
    resetBuildIdCache();
    await new Promise(resolve => setTimeout(resolve, 300));
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

function asStudent(url) {
    return request(app).get(url).set('x-session-token', student.token);
}

test('[UC-MANUT-001] respostas que o aluno já consulta (sync, status, ping) levam a versão do build servido', async () => {
    const query = `email=${encodeURIComponent(student.email)}&studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}`;
    const sync = await asStudent(`/api/student/sync?${query}`).expect(200);
    assert.equal(sync.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_A);
    const status = await asStudent(`/api/status?${query}`).expect(200);
    assert.equal(status.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_A);
    const ping = await asStudent(`/api/ping?email=${encodeURIComponent(student.email)}`).expect(200);
    assert.equal(ping.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_A);
});

test('[UC-MANUT-001] sessão recusada (401) e rota inexistente também levam a versão: o bundle antigo recarrega mesmo sem conseguir usar a API', async () => {
    const denied = await request(app).get(`/api/student/sync?email=${encodeURIComponent(student.email)}`).expect(401);
    assert.equal(denied.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_A);
    const missing = await request(app).get('/api/rota-que-nao-existe');
    assert.equal(missing.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_A);
});

test('[UC-MANUT-001] build refeito com o servidor ligado: o cabeçalho passa a anunciar a versão nova', async () => {
    writeBuildMeta(BUILD_B, new Date(Date.now() + 5000));
    const query = `email=${encodeURIComponent(student.email)}&studentClass=${encodeURIComponent(studentClass)}&courseId=${courseId}`;
    const sync = await asStudent(`/api/student/sync?${query}`).expect(200);
    assert.equal(sync.headers[BUILD_ID_HEADER.toLowerCase()], BUILD_B);
});

test('[UC-MANUT-001] build-meta.json ausente ou inválido não inventa versão (sem cabeçalho, nada recarrega)', async () => {
    fs.writeFileSync(path.join(distDir, 'build-meta.json'), '{"sourceHash":"<script>"}');
    fs.utimesSync(path.join(distDir, 'build-meta.json'), new Date(Date.now() + 10000), new Date(Date.now() + 10000));
    resetBuildIdCache();
    assert.equal(currentBuildId(), null);
    const status = await asStudent('/api/status').expect(200);
    assert.equal(status.headers[BUILD_ID_HEADER.toLowerCase()], undefined);
    fs.rmSync(path.join(distDir, 'build-meta.json'));
    resetBuildIdCache();
    assert.equal(currentBuildId(), null);
    writeBuildMeta(BUILD_A, new Date(Date.now() + 15000));
    assert.equal(currentBuildId(), BUILD_A);
});
