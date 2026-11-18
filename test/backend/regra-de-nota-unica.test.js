// Guarda da regra de nota única (ENG-02, contrato C1 do P2): a faixa da nota e a
// média mínima só saem de backend/utils/gradebook.js (servidor) e da cópia em
// web/src/lib/grades.js (telas), e as duas dão sempre a mesma resposta. Nenhuma tela
// ou rota compara nota com 6, 7, 9, 40 ou 60 escritos no código, o gabarito sai só de
// examGrading.correctAnswerFor e Resultados não recalcula a regra das tentativas.
// (A média do portal do aluno, consolidatedAverage, sai na tela Minhas notas do P2-S4.)
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

// Comparação de algo com cara de nota (nota, média, score, grade, gradeOf(...), g) com
// um literal de faixa. Não pega "seconds < 60" nem "minutes < 60".
const COMPARACAO_FIXA = /(?:\b(?:g|x|grade|score|nota|media|média|average|avg|averageScore|mediaGeral)\b|gradeOf\([^()]*\)|\.(?:grade|score|media|average)\b|Number\([^()]*(?:average|score|media|grade)[^()]*\))\s*(?:>=|<=|<|>)\s*(?:6|7|9|40|60|85)(?![\d.])/;

function linhasComFaixaFixa(files) {
    const achados = [];
    files.forEach(file => {
        fs.readFileSync(file, 'utf8').split('\n').forEach((linha, index) => {
            if (/^\s*(\/\/|\*)/.test(linha)) return;
            if (COMPARACAO_FIXA.test(linha)) achados.push(`${rel(file)}:${index + 1}: ${linha.trim()}`);
        });
    });
    return achados;
}

test('[UC-TENTATIVA-003] gradeBand do servidor e da tela dão a mesma faixa em toda nota e mínima', () => {
    const minimas = [undefined, null, 'abc', -1, 11, 0, 4, 5, 5.5, 6, 6.05, 7, 8.5, 9.5, 10];
    for (const mediaMinima of minimas) {
        const criterio = mediaMinima === undefined ? undefined : { mediaMinima };
        for (let centesimos = -5; centesimos <= 1005; centesimos += 1) {
            const nota = centesimos / 100;
            assert.equal(web.gradeBand(nota, criterio), gradebook.gradeBand(nota, criterio), `nota ${nota}, mínima ${mediaMinima}`);
            assert.equal(web.isPassingGrade(nota, criterio), gradebook.isPassingGrade(nota, criterio), `aprovação ${nota}, mínima ${mediaMinima}`);
        }
        for (const estranha of [null, undefined, '', '  ', true, NaN, '7', 'sete']) {
            assert.equal(web.gradeBand(estranha, criterio), gradebook.gradeBand(estranha, criterio), `nota ${JSON.stringify(estranha)}`);
        }
        assert.equal(web.fmtMinimumGrade(criterio), gradebook.formatMinimumGrade(criterio));
        assert.deepEqual(web.normalizeCriterio(criterio), gradebook.normalizeGradeCriterion(criterio));
    }
    assert.deepEqual(web.GRADE_BANDS, gradebook.GRADE_BANDS);
    assert.deepEqual({ ...web.CRITERIO_PADRAO }, { ...gradebook.DEFAULT_GRADE_CRITERION });
    assert.deepEqual(gradebook.gradeCriterionFor({}, { courseId: 'qualquer' }), { ...gradebook.DEFAULT_GRADE_CRITERION });
});

test('[UC-TENTATIVA-003] nenhuma tela compara nota com 6, 7, 9, 40, 60 ou 85 escritos no código', () => {
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
    ];
    for (const linha of antigas) assert.ok(COMPARACAO_FIXA.test(linha), linha);
    for (const linha of ['if (seconds < 60) return', 'if (minutes < 60) {', 'if (total < 60) return', 'x < 50 ? 0 : x < 70 ? 1 : 2']) {
        assert.equal(COMPARACAO_FIXA.test(linha), false, linha);
    }
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
