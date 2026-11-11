// Fase 2, H5d (SEG-17, ENG-07): dependências de produção sem vulnerabilidade alta ou
// crítica conhecida e verificação automática (`npm run test:audit`, Dependabot). Antes, o
// npm audit acusava adm-zip 0.5.18 (restauração de backup), multer 2.2.0 (envios),
// proxy-addr, tar, undici e qs no servidor, e dompurify 3.4.12 e react-router-dom 6.30.4
// na interface; não havia test:audit nem .github/dependabot.yml.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { auditAll, parseAuditOutput, failingCount, npmCommand, SKIPPED_MESSAGE } = require('../audit-deps.js');

const ROOT = path.resolve(__dirname, '..', '..');

function readJson(file) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// Compara "a.b.c" (sem pré-lançamento): devolve <0, 0 ou >0.
function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

function auditReport(counts, vulnerabilities = {}) {
    return JSON.stringify({
        auditReportVersion: 2,
        vulnerabilities,
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } },
    });
}

test('[UC-SEC-003] versões instaladas no package-lock com as correções', () => {
    // Piso de cada pacote: a primeira versão sem alerta alto ou crítico (ou, no web, a
    // primeira com a correção de XSS/redirecionamento da linha 6 do react-router).
    const floors = {
        'package-lock.json': {
            'adm-zip': '0.6.1',
            multer: '2.5.0',
            'proxy-addr': '2.0.8',
            tar: '7.5.22',
            undici: '6.29.1',
            'brace-expansion': '2.1.7',
        },
        'web/package-lock.json': {
            dompurify: '3.4.17',
            'react-router-dom': '6.30.6',
        },
    };
    for (const [lockFile, packages] of Object.entries(floors)) {
        const lock = readJson(lockFile);
        for (const [name, floor] of Object.entries(packages)) {
            const entry = lock.packages[`node_modules/${name}`];
            assert.ok(entry, `${lockFile}: ${name} instalado`);
            assert.ok(compareVersions(entry.version, floor) >= 0, `${lockFile}: ${name} ${entry.version} precisa ser >= ${floor}`);
        }
    }
    // As faixas declaradas também não deixam voltar para a versão vulnerável.
    const rootPkg = readJson('package.json');
    assert.equal(rootPkg.dependencies['adm-zip'], '^0.6.1');
    assert.equal(rootPkg.dependencies.multer, '^2.5.0');
    const webPkg = readJson('web/package.json');
    assert.equal(webPkg.dependencies.dompurify, '^3.4.17');
    assert.equal(webPkg.dependencies['react-router-dom'], '^6.30.6');
});

test('[UC-SEC-003] npm run test:audit existe e entra no npm run check', () => {
    const rootPkg = readJson('package.json');
    assert.equal(rootPkg.scripts['test:audit'], 'node test/audit-deps.js');
    assert.equal(rootPkg.scripts.check, 'npm run test:full');
    const runner = fs.readFileSync(path.join(ROOT, 'test', 'run-module.js'), 'utf8');
    const full = runner.slice(runner.indexOf('full: ['), runner.indexOf('],', runner.indexOf('full: [')));
    assert.match(full, /npmScript\('test:audit'/, 'test:audit no módulo full (npm run check)');
});

test('[UC-SEC-003] Dependabot semanal para o servidor e a interface', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'dependabot.yml'), 'utf8');
    assert.match(yml, /^version: 2$/m);
    const blocks = yml.split(/\n\s*- package-ecosystem:/).slice(1);
    assert.equal(blocks.length, 2);
    const dirs = blocks.map(block => {
        assert.match(block, /^\s*"npm"/);
        assert.match(block, /interval: "weekly"/);
        assert.match(block, /open-pull-requests-limit: 5/);
        return block.match(/directory: "([^"]+)"/)[1];
    });
    assert.deepEqual(dirs.sort(), ['/', '/web']);
});

test('[UC-SEC-003] alta ou crítica reprova; moderada e baixa só aparecem', () => {
    const logs = [];
    const outputs = [
        { status: 1, stdout: auditReport({ moderate: 2 }, { archiver: { severity: 'moderate', isDirect: true, range: '7.0.0 - 7.0.1' } }) },
        { status: 1, stdout: auditReport({ high: 1, critical: 1 }, {
            dompurify: { severity: 'critical', isDirect: true, range: '<=3.4.16' },
            'react-router': { severity: 'high', isDirect: false, range: '6.0.0 - 7.17.0' },
        }) },
    ];
    const code = auditAll({ run: () => outputs.shift(), log: line => logs.push(line) });
    assert.equal(code, 1);
    const text = logs.join('\n');
    assert.match(text, /Dependências de produção do servidor: 2 moderadas\./);
    assert.match(text, /- archiver \(moderada, direta\)/);
    assert.match(text, /✗ dompurify \(crítica, direta\)/);
    assert.match(text, /Auditoria reprovada: 2 vulnerabilidades altas ou críticas/);

    const okLogs = [];
    const ok = auditAll({ run: () => ({ status: 1, stdout: auditReport({ moderate: 1, low: 3 }) }), log: line => okLogs.push(line) });
    assert.equal(ok, 0);
    assert.match(okLogs.join('\n'), /Auditoria aprovada/);
    assert.equal(failingCount({ high: 2, critical: 1, moderate: 9 }), 3);
});

test('[UC-SEC-003] sem rede ou com o registro fora: avisa, não reprova e não tenta a outra pasta', () => {
    // Saída real do npm 10 sem rede (ENOTFOUND) com --json.
    const offline = {
        status: 1,
        stdout: JSON.stringify({ message: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org', error: { code: 'ENOTFOUND', summary: 'request to https://registry.npmjs.org/ failed' } }),
        stderr: 'npm error code ENOTFOUND',
    };
    for (const output of [
        offline,
        { status: 1, stdout: '', stderr: 'npm error code EAI_AGAIN\nnpm error syscall getaddrinfo' },
        { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync npm ETIMEDOUT'), { code: 'ETIMEDOUT' }) },
        { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' }) },
        { status: 1, stdout: '<html>502 Bad Gateway</html>', stderr: '' },
    ]) {
        assert.equal(parseAuditOutput(output).skipped, true, JSON.stringify(output).slice(0, 80));
        const logs = [];
        let calls = 0;
        const code = auditAll({ run: () => { calls += 1; return output; }, log: line => logs.push(line) });
        assert.equal(code, 0);
        assert.equal(calls, 1, 'sem registro na raiz, não espera de novo no web/');
        assert.equal(logs[0], SKIPPED_MESSAGE);
        assert.equal(SKIPPED_MESSAGE, 'Não foi possível consultar o registro npm; auditoria pulada.');
    }
});

test('[UC-SEC-003] npm chamado pelo próprio Node quando o script roda por npm run (Windows sem shell)', () => {
    const cli = path.join(ROOT, 'test', 'audit-deps.js'); // qualquer .js que exista
    const viaNode = npmCommand(['audit'], { npm_execpath: cli });
    assert.equal(viaNode.command, process.execPath);
    assert.deepEqual(viaNode.args, [cli, 'audit']);
    assert.equal(viaNode.shell, false);
    const plain = npmCommand(['audit'], {});
    assert.deepEqual(plain.args, ['audit']);
    assert.equal(plain.command, process.platform === 'win32' ? 'npm.cmd' : 'npm');
});
