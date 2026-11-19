// Guarda da regra de nota única (ENG-02, contrato C1 do P2): a faixa da nota e a
// média mínima só saem de backend/utils/gradebook.js (servidor) e da cópia em
// web/src/lib/grades.js (telas), e as duas dão sempre a mesma resposta. Nenhuma tela
// ou rota compara nota com 6, 7, 9 ou 40 a 90 escritos no código (nem como faixa em dado
// ou rótulo de gráfico, que saem de gradeBandRanges), o gabarito sai só de
// examGrading.correctAnswerFor e Resultados não recalcula a regra das tentativas.
// Pendências com dono, listadas aqui para não crescerem: a média do portal do aluno
// (consolidatedAverage e a "matéria" por prefixo em student/ProvasPage.jsx) e o
// critério fixo (CRITERIO_PADRAO) nas telas que ainda leem listas sem critério saem
// no P2-S4 (B9), quando o servidor manda o critério e o resumo do aluno.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const gradebook = require('../../backend/utils/gradebook.js');

const ROOT = path.join(__dirname, '..', '..');
let web;

test.before(async () => {
    web = await import(pathToFileURL(path.join(ROOT, 'web', 'src', 'lib', 'grades.js')).href);
});

function walk(dir, filter) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full, filter);
        return filter(full) ? [full] : [];
    });
}

const rel = file => path.relative(ROOT, file).split(path.sep).join('/');

// Literal com cara de limite de faixa: 4 a 10 na escala da tela (também "6.0" e "5.95")
// e 40, 50, ..., 90 e 85 na escala do banco.
const LITERAL_DE_FAIXA = '(?:[4-9]|10|[4-9]0|85)(?:\\.\\d+)?(?![\\d.])';
// Comparação de algo com cara de nota (nota, média, score, grade, gradeOf(...),
// toGrade(...), g, x) com um literal de faixa. Não pega "seconds < 60" nem "minutes < 60".
const COMPARACAO_FIXA = new RegExp(`(?:\\b(?:g|x|grade|score|nota|media|média|average|avg|averageScore|mediaGeral)\\b|gradeOf\\([^()]*\\)|toGrade\\([^()]*\\)|\\.(?:grade|score|media|average)\\b|Number\\([^()]*(?:average|score|media|grade)[^()]*\\))\\s*(?:>=|<=|<|>)\\s*${LITERAL_DE_FAIXA}`);
// Faixa escrita como dado (o gráfico "Distribuição" do aluno tinha { lo: 6, hi: 7 }):
// lo/hi com literal de faixa, ou min e max com literal de faixa no mesmo objeto. Não pega
// limites de campo como { max: 40 } nem { min: 1, max: 90 }.
const FAIXA_COMO_DADO = new RegExp(`\\b(?:lo|hi)\\s*:\\s*${LITERAL_DE_FAIXA}|\\{[^{}]*\\bmin\\s*:\\s*${LITERAL_DE_FAIXA}[^{}]*\\bmax\\s*:\\s*${LITERAL_DE_FAIXA}`);
// Rótulo de faixa escrito à mão ('0–5,9', '7-8,9'): sai de gradeBandRanges.
const ROTULO_DE_FAIXA = /['"`]\d{1,2}(?:,\d)?\s*[–-]\s*\d{1,2},9['"`]/;
const DETECTORES = [COMPARACAO_FIXA, FAIXA_COMO_DADO, ROTULO_DE_FAIXA];
const temFaixaFixa = linha => DETECTORES.some(detector => detector.test(linha));

function linhasComFaixaFixa(files) {
    const achados = [];
    files.forEach(file => {
        fs.readFileSync(file, 'utf8').split('\n').forEach((linha, index) => {
            if (/^\s*(\/\/|\*)/.test(linha)) return;
            if (temFaixaFixa(linha)) achados.push(`${rel(file)}:${index + 1}: ${linha.trim()}`);
        });
    });
    return achados;
}

test('[UC-TENTATIVA-003] gradeBand do servidor e da tela dão a mesma faixa em toda nota e mínima', () => {
    const minimas = [undefined, null, 'abc', '', '  ', '5,5', ' 7 ', -1, 11, 0, 4, 5, 5.5, 6, 6.05, 7, 8.5, 9.5, 10];
    for (const mediaMinima of minimas) {
        const criterio = mediaMinima === undefined ? undefined : { mediaMinima };
        for (let centesimos = -5; centesimos <= 1005; centesimos += 1) {
            const nota = centesimos / 100;
            assert.equal(web.gradeBand(nota, criterio), gradebook.gradeBand(nota, criterio), `nota ${nota}, mínima ${mediaMinima}`);
            assert.equal(web.isPassingGrade(nota, criterio), gradebook.isPassingGrade(nota, criterio), `aprovação ${nota}, mínima ${mediaMinima}`);
        }
        for (const estranha of [null, undefined, '', '  ', '\t', true, NaN, '7', ' 7 ', '5,5', '5.5', '5,', ',5', '1e1', 'sete']) {
            assert.equal(web.gradeBand(estranha, criterio), gradebook.gradeBand(estranha, criterio), `nota ${JSON.stringify(estranha)}`);
        }
        assert.equal(web.fmtMinimumGrade(criterio), gradebook.formatMinimumGrade(criterio));
        assert.deepEqual(web.normalizeCriterio(criterio), gradebook.normalizeGradeCriterion(criterio));
    }
    assert.deepEqual(web.GRADE_BANDS, gradebook.GRADE_BANDS);
    assert.deepEqual({ ...web.CRITERIO_PADRAO }, { ...gradebook.DEFAULT_GRADE_CRITERION });
    assert.deepEqual(gradebook.gradeCriterionFor({}, { courseId: 'qualquer' }), { ...gradebook.DEFAULT_GRADE_CRITERION });
});

test('[UC-TENTATIVA-003] faixas dos gráficos (gradeBandRanges e countByBand) batem com gradeBand do servidor', () => {
    for (const mediaMinima of [undefined, 0, 1.5, 4, 5, 5.5, 6, 6.05, 7, 8, 9, 9.5, 10]) {
        const criterio = mediaMinima === undefined ? undefined : { mediaMinima };
        const ranges = web.gradeBandRanges(criterio);
        // Cobrem de 0 a 10 sem buraco nem sobreposição, na ordem da mais baixa à mais alta.
        assert.equal(ranges[0].min, 0);
        assert.equal(ranges[ranges.length - 1].max, 10);
        for (let i = 1; i < ranges.length; i += 1) assert.equal(Math.round((ranges[i].min - ranges[i - 1].max) * 10), 1, `mínima ${mediaMinima}`);
        for (let decimos = 0; decimos <= 100; decimos += 1) {
            const nota = decimos / 10;
            const faixa = ranges.find(r => nota >= r.min - 1e-9 && nota <= r.max + 1e-9);
            assert.equal(faixa.band, gradebook.gradeBand(nota, criterio), `nota ${nota}, mínima ${mediaMinima}`);
        }
    }
    assert.deepEqual(web.gradeBandRanges().map(r => r.label), ['0–3,9', '4–5,9', '6–6,9', '7–8,9', '9–10']);
    // Conta pela nota como aparece: 5,96 (mostrada 6,0) é 'suficiente', 4,96 é 'abaixo'.
    const contagem = web.countByBand([5.96, 4.96, 3.94, 8.96, 10, null, '', 11]);
    assert.deepEqual(contagem, { excelente: 2, bom: 0, suficiente: 1, abaixo: 1, muito_abaixo: 1 });
});

test('[UC-TENTATIVA-003] nota só com espaços não tem faixa; mínima "5,5" com vírgula vale 5,5', () => {
    for (const lado of [gradebook, null]) {
        const gradeBand = lado ? lado.gradeBand : web.gradeBand;
        const normalize = lado ? lado.normalizeGradeCriterion : web.normalizeCriterio;
        // Antes Number('  ') = 0 dava "muito_abaixo" para nota vazia.
        assert.equal(gradeBand('  '), null);
        assert.equal(gradeBand(' '), null);
        assert.equal(gradeBand('\t'), null);
        assert.equal(gradeBand(' 7 '), 'bom');
        assert.equal(gradeBand('5,5'), 'abaixo');
        assert.equal(gradeBand('5,5', { mediaMinima: '5,5' }), 'suficiente');
        assert.equal(normalize({ mediaMinima: '5,5' }).mediaMinima, 5.5);
        assert.equal(normalize({ mediaMinima: '  ' }).mediaMinima, 6);
        assert.equal(normalize({ mediaMinima: '5,5,5' }).mediaMinima, 6);
    }
});

test('[UC-TENTATIVA-003] nenhuma tela compara nota com faixa escrita no código (6, 7, 9, 40 a 90, 85; também como dado ou rótulo)', () => {
    const files = walk(path.join(ROOT, 'web', 'src'), file => /\.(jsx?|mjs)$/.test(file)
        && !/\.test\.(jsx?|mjs)$/.test(file)
        && rel(file) !== 'web/src/lib/grades.js');
    assert.ok(files.length > 50);
    assert.deepEqual(linhasComFaixaFixa(files), []);
});

test('[UC-TENTATIVA-003] nenhuma rota ou utilitário do servidor compara nota com faixa fixa', () => {
    const files = walk(path.join(ROOT, 'backend'), file => file.endsWith('.js')
        && rel(file) !== 'backend/utils/gradebook.js');
    assert.ok(files.length > 20);
    assert.deepEqual(linhasComFaixaFixa(files), []);
});

test('[UC-TENTATIVA-003] o detector pega as faixas fixas que existiam antes', () => {
    const antigas = [
        "return g >= 9 ? 'rb-g9' : g >= 7 ? 'rb-g7' : g >= 6 ? 'rb-g6' : 'rb-g0'",
        "const approved = scores.filter((score) => score >= 60).length",
        "const approved = scores.filter((x) => x >= 60).length",
        "const tone = score >= 60 ? 'success' : score >= 40 ? 'warning' : 'danger'",
        "const avgTone = Number(module.average) >= 60 ? 'success' : 'danger'",
        "<Badge tone={gradeOf(s.score) >= 6 ? 'success' : 'warning'}>",
        "<td class=\"num grade${exam.grade != null && exam.grade < 6 ? ' low' : ''}\">",
        "else if (o.media < 6) reasons.push('x')",
        "if (media != null && media < 6) reasons.push('media');",
        "if (score < 60) gradeBuckets.baixo++;",
        // Os dois gráficos de distribuição (Resultados e Provas do aluno) do B2 ajuste 1.
        "scores.forEach((x) => { const i = x < 50 ? 0 : x < 70 ? 1 : x < 90 ? 2 : 3; buckets[i]++ })",
        "{ k: '9–10', lo: 9, hi: 10.01, cls: 'bg-success' },",
        "{ k: '6–6,9', lo: 6, hi: 7, cls: 'bg-warning' },",
        "{ k: '0–5,9', lo: 0, hi: 6, cls: 'bg-danger' },",
        "const faixas = [{ min: 6, max: 6.9 }]",
        "if (media >= 6.0) return 'ok'",
        "const ok = gradeOf(s.score) >= 5.95",
        "<span>{toGrade(s.score) < 6 ? 'baixa' : ''}</span>",
        "const rotulos = ['0-4', '5–5,9']",
    ];
    for (const linha of antigas) assert.ok(temFaixaFixa(linha), linha);
    const comuns = [
        'if (seconds < 60) return', 'if (minutes < 60) {', 'if (total < 60) return', 'if (value < 60) return',
        "role: str({ max: 40, nullable: true, label: 'papel' }),",
        'const limits = config.data?.limites?.guardarExterno || { min: 1, max: 90 }',
        'const CLIENT_ERROR_RATE_LIMIT = { max: 10, windowMs: 60000 };',
        'while (n >= 1024 && i < 3) { n /= 1024; i++ }',
        "const label = `${n} nota(s) de ${bucket.label}`",
    ];
    for (const linha of comuns) assert.equal(temFaixaFixa(linha), false, linha);
});

test('[UC-TENTATIVA-003] gabarito só por correctAnswerFor e Resultados sem recálculo da regra das tentativas', () => {
    const backendFiles = walk(path.join(ROOT, 'backend'), file => file.endsWith('.js'));
    const copias = backendFiles.filter(file => /function\s+getCorrectAnswer\b|getCorrectAnswer\s*=/.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(copias.map(rel), []);

    const resultados = fs.readFileSync(path.join(ROOT, 'web', 'src', 'features', 'admin', 'ResultadosPage.jsx'), 'utf8');
    assert.doesNotMatch(resultados, /resultForAttempts/);
    // A nota do grupo é a consolidatedScore do servidor, sem regra maior/última/média local.
    assert.doesNotMatch(resultados, /Math\.max\(\.\.\.considered/);
    assert.doesNotMatch(resultados, /selectedForResult\s*\|\|/);
});

test('[UC-TENTATIVA-003] pendências do B9 não crescem: critério fixo e média no navegador só onde já estavam', () => {
    const telas = walk(path.join(ROOT, 'web', 'src'), file => /\.(jsx?|mjs)$/.test(file)
        && !/\.test\.(jsx?|mjs)$/.test(file)
        && rel(file) !== 'web/src/lib/grades.js');
    const usam = nome => telas.filter(file => new RegExp(`\\b${nome}\\b`).test(fs.readFileSync(file, 'utf8'))).map(rel).sort();
    // Tela nova recebe o critério do servidor (gradebook, boletim e ficha já mandam
    // "criterio"); CRITERIO_PADRAO fica só nas telas que leem listas sem critério.
    // A ficha (AlunoDetailPage) já usa o criterio de GET /api/admin/student/dashboard.
    assert.deepEqual(usam('CRITERIO_PADRAO'), [
        'web/src/features/admin/AlunosPage.jsx',
        'web/src/features/admin/ResultadosPage.jsx',
        'web/src/features/student/ProvasPage.jsx',
    ]);
    // D3 do P2: o navegador não recalcula média. A única exceção é a do portal do aluno,
    // que passa a ler /api/student/grades-summary no B9.
    assert.deepEqual(usam('consolidatedAverage'), ['web/src/features/student/ProvasPage.jsx']);
    const boletim = fs.readFileSync(path.join(ROOT, 'web', 'src', 'features', 'admin', 'boletimPrint.js'), 'utf8');
    assert.match(boletim, /report\.criterio/, 'o boletim usa o critério que vem com o boletim');
    const ficha = fs.readFileSync(path.join(ROOT, 'web', 'src', 'features', 'admin', 'AlunoDetailPage.jsx'), 'utf8');
    assert.match(ficha, /dash\?\.criterio/, 'a ficha usa o critério que vem com a ficha');
});
