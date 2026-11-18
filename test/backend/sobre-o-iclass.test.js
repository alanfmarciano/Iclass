// Versão visível, Novidades e Sobre o IClass (fase 3, A1 / P6-S2: ENG-10, OPS-02, OPS-21).
// - GET /api/admin/system/about: o cartão "Sobre o IClass" da tela Sistema (versão do
//   package.json, build, versão dos dados, última atualização, identidade da instalação;
//   pastas só para o administrador pleno).
// - Migração '2026-11-p6-instalacao': settings.install { id, criadaEm } quando faltam,
//   idempotente; a identidade fica a desta instalação ao restaurar um backup (de antes da
//   migração ou de outro computador) e o POST genérico de configurações não a apaga.
// - buildIntegrity: a versão do package.json e o CHANGELOG.md (as Novidades no bundle)
//   entram no hash do build.
// - package.json com engines.npm e packageManager; as duas versões iguais.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-sobre-test-'));
process.env.ICLASS_DATA_DIR = tempRoot;
process.env.ICLASS_CONTENT_DIR = path.join(tempRoot, 'content');
process.env.ICLASS_ARCHIVE_DIR = path.join(tempRoot, 'archives');
process.env.TEST_MODE = '1';

const db = require('../../backend/database.js');
const { createApp } = require('../../backend/server.js');
const { createAdminSession } = require('../../backend/utils/authSessions.js');
const backupUtil = require('../../backend/utils/backup.js');
const schemaMigrations = require('../../backend/utils/schemaMigrations.js');
const { MIGRATIONS } = require('../../backend/migrations/index.js');
const { systemAbout } = require('../../backend/routes/adminSystem.js');

const repoRoot = path.resolve(__dirname, '..', '..');
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const INSTALL_MIGRATION = MIGRATIONS.find(row => row.id === '2026-11-p6-instalacao');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ADMIN = 'adm@sobre.local';
const PROF = 'prof@sobre.local';
const PROF_SISTEMA = 'prof-sistema@sobre.local';
let app;
let tokens;

function seedAccounts() {
    db.memory.admins = [
        { email: ADMIN, name: 'Admin', role: 'admin', password: db.hashPassword('senha-adm') },
        { email: PROF, name: 'Prof', role: 'professor', password: db.hashPassword('senha-prof'), assignedClasses: [] },
        { email: PROF_SISTEMA, name: 'Prof Sistema', role: 'professor', password: db.hashPassword('senha-prof'), assignedClasses: [], additionalPermissions: ['page.system'] },
    ];
    db.memory.adminSessions = {};
    tokens = {
        admin: createAdminSession(db.memory, ADMIN),
        prof: createAdminSession(db.memory, PROF),
        profSistema: createAdminSession(db.memory, PROF_SISTEMA),
    };
}

const about = token => request(app).get('/api/admin/system/about').set('x-admin-session', token);

test.before(async () => {
    await db.init();
    app = createApp();
});
test.beforeEach(() => seedAccounts());
test.after(async () => {
    await db.flush();
    await db.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('[UC-VERSAO-006] o boot dá a esta instalação um código (UUID) e a data, pela migração 2026-11-p6-instalacao, na ordem do registro', () => {
    assert.ok(INSTALL_MIGRATION, 'a linha 2026-11-p6-instalacao está no registro');
    assert.deepEqual(MIGRATIONS.slice(0, 2).map(row => row.id), ['2026-11-p6-base', '2026-11-p6-instalacao']);
    assert.equal(INSTALL_MIGRATION.tipo, 'memoria');
    const install = db.memory.config.settings.install;
    assert.match(install.id, UUID);
    assert.ok(Number.isFinite(install.criadaEm) && install.criadaEm > 0);
    assert.deepEqual(Object.keys(install).sort(), ['criadaEm', 'id'], 'só o código e a data (licença e licenciadoPara são do A21b)');
    const applied = schemaMigrations.normalizeSchemaMeta(db.memory.schemaMeta).aplicadas.map(entry => entry.id);
    assert.ok(applied.includes('2026-11-p6-instalacao'), applied.join(', '));
});

test('[UC-VERSAO-006] a migração 2026-11-p6-instalacao só preenche o que falta e roda de novo sem mudar nada', () => {
    const ctx = { origem: 'boot', now: 1763424000000, versaoApp: '3.0.0', previousStudentIds: new Map() };
    // Banco da 281029f: sem a seção.
    const empty = { config: { settings: { timezone: 'America/Sao_Paulo' } } };
    assert.equal(INSTALL_MIGRATION.run(empty, ctx), true);
    assert.match(empty.config.settings.install.id, UUID);
    assert.equal(empty.config.settings.install.criadaEm, ctx.now);
    assert.equal(empty.config.settings.timezone, 'America/Sao_Paulo', 'o resto das configurações fica');
    const snapshot = structuredClone(empty);
    assert.equal(INSTALL_MIGRATION.run(empty, { ...ctx, now: ctx.now + 5000 }), false, 'idempotente');
    assert.deepEqual(empty, snapshot);
    // Seção com parte dos campos (licença gravada antes do código, valor estranho): só o que falta.
    const partial = { config: { settings: { install: { id: '', criadaEm: 'ontem', licenciadoPara: 'Escola Técnica' } } } };
    assert.equal(INSTALL_MIGRATION.run(partial, ctx), true);
    assert.match(partial.config.settings.install.id, UUID);
    assert.equal(partial.config.settings.install.criadaEm, ctx.now);
    assert.equal(partial.config.settings.install.licenciadoPara, 'Escola Técnica');
    const kept = { config: { settings: { install: { id: 'codigo-antigo', criadaEm: 5 } } } };
    assert.equal(INSTALL_MIGRATION.run(kept, ctx), false);
    assert.deepEqual(kept.config.settings.install, { id: 'codigo-antigo', criadaEm: 5 });
    // Memória sem config (caso extremo): cria só o necessário.
    const bare = {};
    assert.equal(INSTALL_MIGRATION.run(bare, ctx), true);
    assert.match(bare.config.settings.install.id, UUID);
    // Dois bancos diferentes não ganham o mesmo código.
    const other = { config: { settings: {} } };
    INSTALL_MIGRATION.run(other, ctx);
    assert.notEqual(other.config.settings.install.id, empty.config.settings.install.id);
});

test('[UC-VERSAO-006] restaurar um backup de antes da migração ou de outro computador mantém a identidade desta instalação', async () => {
    const current = structuredClone(db.memory.config.settings.install);
    // Backup de outro computador: outra identidade e a lista de migrações completa.
    const fromOther = structuredClone(backupUtil.buildDataSnapshot());
    fromOther.data.config.settings.install = { id: '11111111-2222-4333-8444-555555555555', criadaEm: 1, licenciadoPara: 'Outra escola' };
    await backupUtil.restoreDataSnapshot(fromOther);
    assert.deepEqual(db.memory.config.settings.install, current, 'a identidade fica a desta instalação');

    // Backup da 281029f: sem schemaMeta e sem a seção. A migração roda sobre o restaurado
    // (naRestauracao) e o gancho 'protectedConfig' põe a identidade de agora de volta.
    seedAccounts();
    const legacy = structuredClone(backupUtil.buildDataSnapshot());
    delete legacy.data.schemaMeta;
    delete legacy.data.config.settings.install;
    await backupUtil.restoreDataSnapshot(legacy);
    assert.deepEqual(db.memory.config.settings.install, current);
    const applied = schemaMigrations.normalizeSchemaMeta(db.memory.schemaMeta).aplicadas;
    const entry = applied.find(item => item.id === '2026-11-p6-instalacao');
    assert.ok(entry && entry.naRestauracao === true, JSON.stringify(applied));
    // O que foi para o banco é a identidade de agora.
    await db.flush();
    const stored = await db.readStoredData();
    assert.deepEqual(stored.memory.config.settings.install, current);
});

test('[UC-VERSAO-006] o POST genérico de configurações não apaga a identidade da instalação', async () => {
    const current = structuredClone(db.memory.config.settings.install);
    await request(app).post('/api/admin/settings').set('x-admin-session', tokens.admin).send({ timezone: 'America/Manaus', install: { id: 'troca' } }).expect(200);
    assert.deepEqual(db.memory.config.settings.install, current);
});

test('[UC-VERSAO-003] GET /api/admin/system/about: versão do package.json, build, versão dos dados, última atualização e identidade', async () => {
    const res = await about(tokens.admin).expect(200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.body;
    assert.equal(body.success, true);
    assert.equal(body.versao, rootPackage.version);
    assert.equal(body.node, process.version);
    assert.ok(['pacote', 'desenvolvimento'].includes(body.modo));
    assert.equal(body.modo, 'desenvolvimento', 'pasta do git (web/src presente, sem release-manifest.json)');
    assert.equal(typeof body.plataforma, 'string');
    assert.deepEqual(Object.keys(body.build).sort(), ['geradoEm', 'id', 'node']);
    // Versão dos dados: todas as do registro aplicadas, a última com o nome do registro.
    assert.equal(body.esquema.aplicadas, MIGRATIONS.length);
    assert.equal(body.esquema.pendentes, 0);
    assert.equal(body.esquema.desconhecidas, 0);
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    assert.equal(body.esquema.ultima.id, last.id);
    assert.equal(body.esquema.ultima.nome, last.nome);
    // Instalação nova (pasta vazia): a última atualização é a da instalação.
    assert.equal(body.ultimaAtualizacao.instalacaoNova, true);
    assert.equal(body.ultimaAtualizacao.para, rootPackage.version);
    assert.deepEqual(body.instalacao, {
        id: db.memory.config.settings.install.id,
        criadaEm: db.memory.config.settings.install.criadaEm,
        licenciadoPara: null,
        licencaAceita: false,
    });
    // Pastas só para o administrador pleno.
    assert.equal(body.pastas.dados, path.resolve(tempRoot));
    assert.equal(body.pastas.conteudo, path.resolve(tempRoot, 'content'));
    assert.equal(body.pastas.cursosArquivados, path.resolve(tempRoot, 'archives'));
    assert.equal(body.pastas.programa, repoRoot);
});

test('[UC-VERSAO-003] Sobre o IClass: professor sem page.system recebe 403; com page.system, sem as pastas do computador; sem sessão, 401', async () => {
    await about(tokens.prof).expect(403);
    const res = await about(tokens.profSistema).expect(200);
    assert.equal(res.body.versao, rootPackage.version);
    assert.equal(Object.hasOwn(res.body, 'pastas'), false);
    assert.equal(JSON.stringify(res.body).includes(tempRoot), false, 'nenhum caminho do computador para quem não é administrador');
    await request(app).get('/api/admin/system/about').expect(401);
});

test('[UC-VERSAO-003] Sobre o IClass lê banco de antes (sem schemaMeta e sem a identidade) e uma atualização com backup sem quebrar', () => {
    const admin = { email: ADMIN, role: 'admin' };
    const old = systemAbout(admin, { config: { settings: {} } });
    assert.deepEqual(old.esquema, { aplicadas: 0, ultima: null, pendentes: MIGRATIONS.length, desconhecidas: 0 });
    assert.equal(old.ultimaAtualizacao, null);
    assert.deepEqual(old.instalacao, { id: null, criadaEm: null, licenciadoPara: null, licencaAceita: false });
    const updated = systemAbout(admin, {
        config: { settings: { install: { id: 'abc', criadaEm: 10, licenciadoPara: '  Escola Técnica  ', licenca: { versao: '1', aceitaEm: 20, aceitaPor: ADMIN } } } },
        schemaMeta: {
            aplicadas: [{ id: '2026-11-p6-base', em: 100 }, { id: '2099-01-futuro-teste', em: 200 }],
            atualizacoes: [{ de: '3.0.0', para: '3.1.0', em: 300, migracoes: ['2026-11-p6-base'], backup: 'pre-atualizacao_dados_x.zip', semBackup: false }],
        },
    });
    assert.deepEqual(updated.esquema.ultima, { id: '2099-01-futuro-teste', nome: null, em: 200 });
    assert.equal(updated.esquema.desconhecidas, 1);
    assert.deepEqual(updated.ultimaAtualizacao, { de: '3.0.0', para: '3.1.0', em: 300, backup: 'pre-atualizacao_dados_x.zip', semBackup: false, instalacaoNova: false, migracoes: 1 });
    assert.deepEqual(updated.instalacao, { id: 'abc', criadaEm: 10, licenciadoPara: 'Escola Técnica', licencaAceita: true });
});

test('[UC-VERSAO-004] a versão do package.json e o CHANGELOG.md entram no hash do build', () => {
    const buildIntegrity = require('../../backend/utils/buildIntegrity.js');
    const runtimePaths = require('../../backend/runtimePaths.js');
    assert.ok(buildIntegrity.ROOT_BUILD_FILES.includes('CHANGELOG.md'));
    const projectRoot = path.join(tempRoot, 'projeto-versao');
    const write = (relative, content) => {
        const target = path.join(projectRoot, ...relative.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        return target;
    };
    write('web/src/main.jsx', 'export default 1;\n');
    write('web/package.json', '{"version":"3.0.0"}\n');
    write('package.json', JSON.stringify({ name: 'iclass-v3', version: '3.0.0', scripts: { start: 'node backend/server.js' } }));
    const changelog = write('CHANGELOG.md', '# Novidades do IClass\n\n## Não publicado\n');
    const originalRoot = runtimePaths.PROJECT_ROOT;
    runtimePaths.PROJECT_ROOT = projectRoot;
    try {
        assert.equal(buildIntegrity.appVersion(), '3.0.0');
        const base = buildIntegrity.computeSourceHash();
        // Só a versão muda o hash; o resto do package.json da raiz (scripts) não.
        write('package.json', JSON.stringify({ name: 'iclass-v3', version: '3.0.0', scripts: { start: 'node outro.js' } }));
        assert.equal(buildIntegrity.computeSourceHash(), base, 'scripts do servidor não mudam o build');
        write('package.json', JSON.stringify({ name: 'iclass-v3', version: '3.1.0', scripts: { start: 'node outro.js' } }));
        assert.equal(buildIntegrity.appVersion(), '3.1.0');
        const bumped = buildIntegrity.computeSourceHash();
        assert.notEqual(bumped, base, 'trocar a versão pede build novo (a barra lateral mostraria a versão de antes)');
        fs.appendFileSync(changelog, '\n- Agora dá para ver as Novidades.\n');
        assert.notEqual(buildIntegrity.computeSourceHash(), bumped, 'mudar as Novidades pede build novo');
        // package.json da raiz ilegível: versão vazia, sem quebrar o boot.
        write('package.json', '{');
        assert.equal(buildIntegrity.appVersion(), '');
    } finally {
        runtimePaths.PROJECT_ROOT = originalRoot;
    }
});

test('[UC-VERSAO-005] package.json com engines.npm e packageManager, a mesma versão no web/package.json e o CHANGELOG começando por "Não publicado"', () => {
    const webPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'web', 'package.json'), 'utf8'));
    for (const [name, pkg] of [['package.json', rootPackage], ['web/package.json', webPackage]]) {
        assert.equal(pkg.engines.node, '>=20.19.0', `${name}: o código continua no Node 20.19`);
        assert.equal(pkg.engines.npm, '>=10', `${name}: engines.npm`);
        assert.match(pkg.packageManager, /^npm@10\.9\.\d+$/, `${name}: packageManager fixo no npm 10.9`);
    }
    assert.match(rootPackage.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'SemVer');
    assert.equal(webPackage.version, rootPackage.version);
    // O package-lock.json acompanha os engines da raiz (npm ci não reescreve o lock).
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    assert.deepEqual(lock.packages[''].engines, rootPackage.engines);
    assert.equal(lock.packages[''].version, rootPackage.version);
    const headings = [...fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8').matchAll(/^##\s+(.+?)\s*$/gm)].map(match => match[1]);
    assert.equal(headings[0], 'Não publicado');
    assert.equal(headings.find(text => /^\d+\.\d+\.\d+/.test(text)).split(' ')[0], rootPackage.version);
});
