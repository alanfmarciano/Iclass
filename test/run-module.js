const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NODE = process.execPath;
const NPM_CLI = process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)
  ? process.env.npm_execpath
  : null;

const backend = (...files) => ({
  name: 'Testes do servidor',
  command: NODE,
  args: ['--test', ...files.map(file => path.join('test', 'backend', file))],
});

const web = (...files) => ({
  name: 'Testes da interface',
  command: NPM,
  args: files.length
    ? ['--prefix', 'web', 'run', 'test', '--', ...files]
    : ['run', 'test:web'],
});

const e2e = (...files) => ({
  name: 'Casos de uso no navegador',
  e2e: true,
  files,
});

const npmScript = (name, label) => ({ name: label, command: NPM, args: ['run', name] });

const SUITES = {
  quick: [
    npmScript('test:docs', 'Rastreabilidade da documentacao'),
    npmScript('test:backend', 'Todos os testes do servidor'),
    npmScript('test:web', 'Todos os testes da interface'),
  ],
  provas: [
    backend('exam-applications.test.js', 'exam-attempts.test.js'),
    web(
      'src/features/student/StudentExamAvailability.test.jsx',
      'src/features/admin/FinishApplicationModal.test.jsx',
      'src/features/admin/monitorTimer.test.js',
    ),
    e2e('test/e2e/exam-flow.spec.js'),
  ],
  admins: [
    backend('admin-rbac-catalog.test.js', 'database-persistence.test.js'),
    e2e('test/e2e/admin-access.spec.js'),
  ],
  alunos: [
    backend('student-sessions.test.js', 'student-analytics.test.js'),
    web('src/lib/sessionActivity.test.js'),
    e2e('test/e2e/student-login.spec.js'),
  ],
  cursos: [
    backend('branding-interface-preset.test.js', 'database-persistence.test.js'),
    web('src/features/admin/AdminCourseGate.test.jsx'),
    e2e('test/e2e/course-management.spec.js'),
  ],
  presenca: [
    backend('attendance-utils.test.js', 'student-analytics.test.js'),
    web('src/features/admin/TurmaPresencaConfig.test.jsx'),
    e2e('test/e2e/attendance-flow.spec.js'),
  ],
  layout: [
    backend('branding-interface-preset.test.js'),
    web('src/features/admin/AdminCourseGate.test.jsx', 'src/components/ui/Modal.test.jsx'),
    e2e('test/e2e/visual-layout.spec.js'),
  ],
  security: [
    backend(
      'upload-security.test.js',
      'safe-path.test.js',
      'launcher-safety.test.js',
      'admin-rbac-catalog.test.js',
    ),
  ],
  full: [
    npmScript('test:docs', 'Rastreabilidade da documentacao'),
    npmScript('test:backend', 'Todos os testes do servidor'),
    npmScript('test:web', 'Todos os testes da interface'),
    npmScript('build', 'Compilacao da interface'),
    e2e(),
  ],
};

const ALIASES = {
  admin: 'admins',
  administradores: 'admins',
  aluno: 'alunos',
  prova: 'provas',
  visual: 'layout',
  attendance: 'presenca',
  frequencia: 'presenca',
  chamada: 'presenca',
  seguranca: 'security',
  completo: 'full',
  rapido: 'quick',
};

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function writeReport(summary) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, 'resumo.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  const rows = summary.steps.map(step => {
    const color = step.status === 'aprovado' ? '#15803d' : step.status === 'bloqueado' ? '#a16207' : '#b91c1c';
    return `<tr><td>${escapeHtml(step.name)}</td><td style="color:${color};font-weight:700">${escapeHtml(step.status)}</td><td>${escapeHtml(step.durationSeconds)}s</td><td>${escapeHtml(step.detail || '')}</td></tr>`;
  }).join('');
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatorio de testes IClass V3</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:1000px;margin:40px auto;padding:0 20px;color:#172033}h1{margin-bottom:6px}p{color:#526078}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{text-align:left;border-bottom:1px solid #dce2ea;padding:12px 10px}th{background:#f4f7fa}.ok{color:#15803d}.fail{color:#b91c1c}.blocked{color:#a16207}</style></head>
<body><h1>Relatorio de testes IClass V3</h1><p>Modulo: <strong>${escapeHtml(summary.module)}</strong> | Inicio: ${escapeHtml(summary.startedAt)} | Resultado: <strong class="${summary.status === 'aprovado' ? 'ok' : summary.status === 'bloqueado' ? 'blocked' : 'fail'}">${escapeHtml(summary.status)}</strong></p>
<table><thead><tr><th>Etapa</th><th>Resultado</th><th>Duracao</th><th>Detalhe</th></tr></thead><tbody>${rows}</tbody></table>
<p>Os testes usam dados temporarios. Traces, capturas e diferencas visuais ficam nesta mesma pasta.</p></body></html>`;
  fs.writeFileSync(path.join(RESULTS_DIR, 'ultimo-relatorio.html'), html, 'utf8');
}

function playwrightCli() {
  return require.resolve('@playwright/test/cli', { paths: [ROOT] });
}

function browserAvailable() {
  try {
    const { chromium } = require(require.resolve('@playwright/test', { paths: [ROOT] }));
    return fs.existsSync(chromium.executablePath());
  } catch (_error) {
    return false;
  }
}

function runProcess(command, args) {
  const executable = command === NPM && NPM_CLI ? NODE : command;
  const executableArgs = command === NPM && NPM_CLI ? [NPM_CLI, ...args] : args;
  return spawnSync(executable, executableArgs, {
    cwd: ROOT,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR || '1' },
    stdio: 'inherit',
    shell: false,
  });
}

function runSetup() {
  const steps = [
    ['Dependencias do servidor', NPM, ['install']],
    ['Dependencias da interface', NPM, ['--prefix', 'web', 'install']],
    ['Navegador automatizado Chromium', NODE, [playwrightCli(), 'install', 'chromium']],
  ];
  for (const [label, command, args] of steps) {
    console.log(`\n=== ${label} ===`);
    const result = runProcess(command, args);
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log('\nAmbiente de testes preparado com sucesso.');
}

function runSuite(moduleName) {
  const steps = SUITES[moduleName];
  const summary = { module: moduleName, startedAt: new Date().toISOString(), status: 'aprovado', steps: [] };

  for (const step of steps) {
    console.log(`\n============================================================`);
    console.log(` ICLASS V3 - ${step.name}`);
    console.log(`============================================================\n`);
    const started = Date.now();

    if (step.e2e && !browserAvailable()) {
      const detail = 'Chromium nao instalado. Execute npm run test:setup ou use a opcao P da Central de Testes.';
      console.error(detail);
      summary.steps.push({ name: step.name, status: 'bloqueado', durationSeconds: 0, detail });
      summary.status = 'bloqueado';
      break;
    }

    let result;
    if (step.e2e) {
      const output = path.join('test-results', moduleName, 'playwright');
      result = runProcess(NODE, [playwrightCli(), 'test', ...step.files, `--output=${output}`, '--reporter=line']);
    } else {
      result = runProcess(step.command, step.args);
    }

    const durationSeconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === 0) {
      summary.steps.push({ name: step.name, status: 'aprovado', durationSeconds, detail: '' });
    } else {
      const processError = result.error ? `: ${result.error.message}` : '';
      summary.steps.push({ name: step.name, status: 'reprovado', durationSeconds, detail: `Codigo de saida ${result.status ?? 1}${processError}` });
      summary.status = 'reprovado';
      break;
    }
  }

  writeReport(summary);
  console.log(`\nResultado: ${summary.status.toUpperCase()}`);
  console.log(`Relatorio: ${path.join(RESULTS_DIR, 'ultimo-relatorio.html')}`);
  process.exit(summary.status === 'aprovado' ? 0 : summary.status === 'bloqueado' ? 2 : 1);
}

function main() {
  const requested = String(process.argv[2] || '').trim().toLowerCase();
  const moduleName = ALIASES[requested] || requested;

  if (moduleName === 'setup') return runSetup();
  if (moduleName === 'report') {
    const report = path.join(RESULTS_DIR, 'ultimo-relatorio.html');
    console.log(fs.existsSync(report) ? report : 'Nenhum relatorio foi gerado ainda.');
    return;
  }
  if (!SUITES[moduleName]) {
    console.error(`Modulo invalido: ${requested || '(vazio)'}`);
    console.error(`Use um destes modulos: ${Object.keys(SUITES).join(', ')}`);
    process.exit(64);
  }
  runSuite(moduleName);
}

main();
