// Auditoria das dependências de produção (H5d, SEG-17, ENG-07): `npm run test:audit`.
// Roda `npm audit --omit=dev --audit-level=high --json` na raiz (servidor) e em web/
// (interface) e falha (saída 1) só com vulnerabilidade alta ou crítica. As moderadas e
// baixas aparecem na lista, mas não reprovam: algumas só fecham com versão maior de um
// pacote (archiver 8, react-router 7), que muda a API e fica para uma atualização própria.
// Sem internet ou com o registro npm fora do ar, avisa e sai com 0: nada no IClass pode
// depender de rede, e a máquina da escola muitas vezes está offline.
// Também entra nos módulos "full" e "security" da Central de Testes (test/run-module.js).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
    { label: 'do servidor', cwd: ROOT },
    { label: 'da interface (web)', cwd: path.join(ROOT, 'web') },
];
const FAILING_SEVERITIES = ['critical', 'high'];
const SEVERITY_LABELS = { critical: 'crítica', high: 'alta', moderate: 'moderada', low: 'baixa', info: 'informativa' };
const AUDIT_TIMEOUT_MS = 120000;
const SKIPPED_MESSAGE = 'Não foi possível consultar o registro npm; auditoria pulada.';

// npm por meio do próprio Node quando o script roda por `npm run` (npm_execpath aponta o
// npm-cli.js): no Windows, o Node 20 recusa abrir npm.cmd sem shell.
function npmCommand(args, env = process.env) {
    const cli = env.npm_execpath;
    if (cli && /\.c?js$/i.test(cli) && fs.existsSync(cli)) return { command: process.execPath, args: [cli, ...args], shell: false };
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args, shell: process.platform === 'win32' };
}

function runNpmAudit(cwd) {
    const { command, args, shell } = npmCommand(['audit', '--omit=dev', '--audit-level=high', '--json']);
    const result = spawnSync(command, args, {
        cwd, shell, encoding: 'utf8', timeout: AUDIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error || null };
}

// Lê a saída do npm audit. Devolve { skipped: true, reason } quando a consulta não
// aconteceu (sem rede, registro fora, npm ausente, resposta que não é o relatório) ou
// { counts, findings } com a contagem por gravidade e cada pacote vulnerável.
function parseAuditOutput({ status, stdout, stderr, error }) {
    if (error) return { skipped: true, reason: error.code === 'ETIMEDOUT' ? 'tempo esgotado' : (error.code || error.message) };
    let report;
    try { report = JSON.parse(String(stdout || '').trim() || 'null'); } catch (_) { report = null; }
    if (!report || typeof report !== 'object') {
        return { skipped: true, reason: String(stderr || '').trim().split('\n')[0] || `npm audit saiu com ${status}` };
    }
    if (report.error) {
        const err = report.error;
        const reason = [err.code, err.summary || report.message].filter(Boolean).join(': ');
        return { skipped: true, reason: reason || 'erro do registro' };
    }
    const meta = report.metadata && report.metadata.vulnerabilities;
    if (!meta || typeof meta !== 'object') return { skipped: true, reason: 'relatório sem contagem de vulnerabilidades' };
    const counts = {};
    for (const key of Object.keys(SEVERITY_LABELS)) counts[key] = Number(meta[key]) || 0;
    const findings = Object.entries(report.vulnerabilities || {}).map(([name, info]) => ({
        name,
        severity: String(info && info.severity || ''),
        range: String(info && info.range || ''),
        direct: !!(info && info.isDirect),
    }));
    return { skipped: false, counts, findings };
}

function failingCount(counts) {
    return FAILING_SEVERITIES.reduce((sum, key) => sum + (Number(counts && counts[key]) || 0), 0);
}

function describeCounts(counts) {
    const parts = Object.keys(SEVERITY_LABELS)
        .filter(key => counts[key] > 0)
        .map(key => `${counts[key]} ${SEVERITY_LABELS[key]}${counts[key] > 1 ? 's' : ''}`);
    return parts.length ? parts.join(', ') : 'nenhuma vulnerabilidade';
}

// run(cwd) → saída do npm (injetável nos testes); log(texto) para cada linha.
function auditAll({ run = runNpmAudit, log = console.log, targets = TARGETS } = {}) {
    let failures = 0;
    let skipped = false;
    for (const target of targets) {
        const parsed = parseAuditOutput(run(target.cwd));
        if (parsed.skipped) {
            // Sem registro para uma pasta, sem registro para a outra: não espera de novo.
            log(SKIPPED_MESSAGE);
            log(`  (dependências ${target.label}: ${parsed.reason})`);
            skipped = true;
            break;
        }
        const bad = failingCount(parsed.counts);
        failures += bad;
        log(`Dependências de produção ${target.label}: ${describeCounts(parsed.counts)}.`);
        for (const item of parsed.findings) {
            const mark = FAILING_SEVERITIES.includes(item.severity) ? '  ✗' : '  -';
            log(`${mark} ${item.name} (${SEVERITY_LABELS[item.severity] || item.severity}${item.direct ? ', direta' : ''})${item.range ? ` ${item.range}` : ''}`);
        }
    }
    if (failures > 0) {
        log(`Auditoria reprovada: ${failures} vulnerabilidade${failures > 1 ? 's' : ''} alta${failures > 1 ? 's' : ''} ou crítica${failures > 1 ? 's' : ''}. Atualize o pacote (npm audit fix) e rode os testes.`);
        return 1;
    }
    if (!skipped) log('Auditoria aprovada: nenhuma vulnerabilidade alta ou crítica nas dependências de produção.');
    return 0;
}

if (require.main === module) process.exit(auditAll());

module.exports = { auditAll, parseAuditOutput, failingCount, npmCommand, SKIPPED_MESSAGE };
