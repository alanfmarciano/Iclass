// Versões da prova montadas e conferidas no servidor (fase 3, P3-S11: AVA-16; decisão D23
// do desenho do P3).
//
// Antes o navegador do professor montava as versões online (web/src/features/admin/
// examTools.js buildExamVersions) e o servidor guardava o que chegasse, com a letra certa
// e o gabarito impresso calculados no navegador; a tela deixava pedir 5 versões e o
// servidor cortava em 4 sem avisar. Agora:
// - buildOnlineVersions (porta do buildExamVersions) monta as versões online a partir da
//   avaliação gravada e dos números das questões escolhidas na montagem, com o aleatório de
//   crypto; no máximo 4 versões (A a D), e a 5ª é recusada com mensagem;
// - a prova impressa continua montada no navegador (ela é impressa na hora, sem esperar o
//   servidor), e conferVersionSnapshots confere cada questão dela com a avaliação: o
//   texto, as alternativas (letra e texto), o tipo e o gabarito declarados têm de ser os da
//   prova, e o gabarito impresso de cada versão tem de bater com as letras da versão. O que
//   o pedido não trouxe (o snapshot mínimo de um cliente antigo) é preenchido pela
//   avaliação: quem decide a resposta certa é sempre o servidor;
// - a configuração salva que nasceu de uma dessas duas passa a ter gabaritoConferidoEm. A
//   de antes desta versão é conferida na hora de preparar (preparationAnswerKeyProblem):
//   gabarito diferente do da avaliação de hoje não vira aplicação sem aviso.
const crypto = require('crypto');
const { freezeSnapshotGrading, questionNumber } = require('./examGrading.js');
const { isChoiceType, questionType } = require('./examScoring.js');
const { answerKeyOf, applyAnswerKeyToSnapshots, describeAnswerKey, sameAnswerKey } = require('./examAnswerKeyCorrection.js');
const { shuffle } = require('./examDraw.js');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
// Versões online: as letras que o Monitor, a troca de versão e a correção conhecem.
const ONLINE_VERSION_LABELS = Object.freeze(['A', 'B', 'C', 'D']);
const ONLINE_VERSIONS_MAX = ONLINE_VERSION_LABELS.length;
// Prova impressa: até 10 versões (a tela vai até 10, com um código por versão).
const PRINT_VERSIONS_MAX = 10;
const ONLINE_VERSIONS_ERROR = `No máximo ${ONLINE_VERSIONS_MAX} versões online (A a D).`;
const ONLINE_VERSION_COUNT_ERROR = `Informe quantas versões online (de 1 a ${ONLINE_VERSIONS_MAX}).`;
// Campos de correção que vão com a questão da versão (a prévia e a impressão mostram o tipo
// e os pontos); freezeSnapshotGrading regrava todos a partir da avaliação.
const VERSION_QUESTION_FIELDS = Object.freeze(['type', 'points', 'partialCredit', 'numeric', 'acceptedAnswers', 'review', 'expectedAnswer', 'rubric']);

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cryptoRandom() {
    return crypto.randomInt(0, 0x100000000) / 0x100000000;
}

// Código da versão (4 letras e números), como o da tela.
function generateExamCode(random = cryptoRandom) {
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
    return code;
}

// O que String() devolve para um objeto: era o texto da alternativa vazia na tela de antes.
const OBJECT_TEXT = String({});

// Enunciado e alternativas da questão como a tela os lê (examTools.normalizeQuestion): o
// texto em text ou questionText e as alternativas em lista ou no objeto antigo { A: '...' }.
function questionTextOf(question, index) {
    return question?.text || question?.questionText || `Questão ${index + 1}`;
}

function alternativesOf(question) {
    const raw = Array.isArray(question?.alternatives)
        ? question.alternatives
        : Object.entries(question?.alternatives || {}).map(([letter, text]) => ({ letter, text }));
    return raw.map((alternative, index) => {
        const isObject = alternative && typeof alternative === 'object';
        return {
            letter: String((isObject && alternative.letter) || LETTERS[index] || '').toUpperCase(),
            text: isObject ? (alternative.text || alternative.label || '') : String(alternative ?? ''),
        };
    });
}

function evaluationIndex(evaluation) {
    const questions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    const map = new Map();
    questions.forEach((question, index) => {
        if (!question || typeof question !== 'object') return;
        const number = questionNumber(question, index);
        if (!map.has(number)) map.set(number, { question, index });
    });
    return map;
}

// Letras da versão (as de exibição) da resposta certa: 'B' ou, em várias corretas, 'AC'.
// Questão sem alternativas não entra no gabarito impresso.
function printedAnswer(question, key) {
    const type = questionType(question);
    if (!isChoiceType(type)) return '';
    const correct = new Set(type === 'multiple_answer' ? (key.correctAnswers || []) : [key.correctAnswer]);
    return (Array.isArray(question.alternatives) ? question.alternatives : [])
        .map((alternative, position) => {
            const letter = String(alternative?.letter || LETTERS[position] || '').toUpperCase();
            return correct.has(letter) ? String(alternative?.displayLetter || LETTERS[position] || '').toUpperCase() : '';
        })
        .filter(Boolean)
        .join('');
}

function positionOf(question, index) {
    const examNumber = Number(question?.examNumber);
    return Number.isInteger(examNumber) && examNumber > 0 ? examNumber : index + 1;
}

function versionQuestion(source, sourceIndex, alternatives, examNumber) {
    const fields = {};
    VERSION_QUESTION_FIELDS.forEach(field => {
        if (source[field] !== undefined && source[field] !== null) fields[field] = clone(source[field]);
    });
    const key = answerKeyOf(source);
    const correct = new Set(key.type === 'multiple_answer' ? key.correctAnswers : (key.correctAnswer ? [key.correctAnswer] : []));
    const text = questionTextOf(source, sourceIndex);
    return {
        ...fields,
        originalNumber: questionNumber(source, sourceIndex),
        examNumber,
        text,
        questionText: source.questionText || text,
        correctAnswer: key.type === 'multiple_answer' ? '' : (key.correctAnswer || ''),
        ...(key.type === 'multiple_answer' ? { correctAnswers: [...key.correctAnswers] } : {}),
        alternatives: alternatives.map((alternative, position) => ({
            letter: alternative.letter,
            displayLetter: LETTERS[position],
            text: alternative.text,
            isCorrect: correct.has(alternative.letter),
        })),
    };
}

function fail(error, field, extra = {}) {
    return { ok: false, error, field, ...extra };
}

// Monta as versões online pela avaliação (porta do buildExamVersions da tela).
// options: questionNumbers (as questões da montagem, na ordem da avaliação), versionCount
// (1 a 4), shuffleQuestions (cada versão com a sua ordem), shuffleAnswers (alternativas
// embaralhadas por versão; verdadeiro ou falso nunca), random (testes).
function buildOnlineVersions(evaluation, options = {}) {
    const index = evaluationIndex(evaluation);
    if (!index.size) return fail('A prova não tem questões para montar.', 'questionNumbers');
    const requested = Number(options.versionCount ?? 1);
    if (!Number.isInteger(requested) || requested < 1) return fail(ONLINE_VERSION_COUNT_ERROR, 'versionCount');
    if (requested > ONLINE_VERSIONS_MAX) return fail(ONLINE_VERSIONS_ERROR, 'versionCount', { code: 'too_many_versions' });
    const numbers = (Array.isArray(options.questionNumbers) ? options.questionNumbers : []).map(Number);
    if (!numbers.length) return fail('Nenhuma questão selecionada.', 'questionNumbers');
    const seen = new Set();
    for (const number of numbers) {
        if (!Number.isInteger(number) || !index.has(number)) return fail(`A questão ${Number.isFinite(number) ? number : '?'} não existe nesta prova.`, 'questionNumbers');
        if (seen.has(number)) return fail(`A questão ${number} foi escolhida duas vezes.`, 'questionNumbers');
        seen.add(number);
    }
    const random = typeof options.random === 'function' ? options.random : cryptoRandom;
    // A montagem vai na ordem da avaliação; cada versão embaralha a sua.
    const base = [...numbers].sort((a, b) => index.get(a).index - index.get(b).index).map(number => index.get(number));
    const versions = ONLINE_VERSION_LABELS.slice(0, requested).map(version => {
        const ordered = options.shuffleQuestions === true ? shuffle(base, random) : [...base];
        const questions = ordered.map(({ question, index: sourceIndex }, position) => {
            const alternatives = alternativesOf(question);
            const keepOrder = questionType(question) === 'true_false' || !isChoiceType(questionType(question));
            const arranged = options.shuffleAnswers === true && !keepOrder ? shuffle(alternatives, random) : alternatives;
            return versionQuestion(question, sourceIndex, isChoiceType(questionType(question)) ? arranged : [], position + 1);
        });
        const answerKey = {};
        questions.forEach((question, position) => {
            const letters = printedAnswer(question, answerKeyOf(question));
            if (letters) answerKey[position + 1] = letters;
        });
        return { version, examCode: generateExamCode(random), count: questions.length, answerKey, questions };
    });
    return { ok: true, versions };
}

function declaresAnswerKey(question) {
    const type = questionType(question);
    if (isChoiceType(type)) {
        if (typeof question.correctAnswer === 'string' && question.correctAnswer.trim()) return true;
        if (Array.isArray(question.correctAnswers) && question.correctAnswers.length) return true;
        return (Array.isArray(question.alternatives) ? question.alternatives : []).some(alternative => alternative && alternative.isCorrect === true);
    }
    if (type === 'numeric') return !!(question.numeric && typeof question.numeric === 'object' && question.numeric.value !== undefined && question.numeric.value !== null);
    if (type === 'short_answer') return Array.isArray(question.acceptedAnswers) && question.acceptedAnswers.length > 0;
    return false;
}

function mismatch(problems) {
    const first = problems[0];
    const extra = problems.length > 1 ? ` (e mais ${problems.length - 1} ${problems.length === 2 ? 'diferença' : 'diferenças'})` : '';
    return {
        ok: false,
        code: 'snapshot_mismatch',
        error: `A prova montada não confere com a prova gravada: ${first.motivo}${extra}. Recarregue a página e monte de novo.`,
        problems,
    };
}

// Confere as versões montadas pelo navegador com a avaliação (D23) e devolve uma cópia com
// a resposta certa e o gabarito impresso calculados no servidor. maxVersions: 4 (online)
// ou 10 (impressa).
function conferVersionSnapshots(snapshots, evaluation, { maxVersions = PRINT_VERSIONS_MAX } = {}) {
    const list = Array.isArray(snapshots) ? snapshots : [];
    if (list.length > maxVersions) {
        return maxVersions === ONLINE_VERSIONS_MAX
            ? fail(ONLINE_VERSIONS_ERROR, 'printSnapshot', { code: 'too_many_versions' })
            : fail(`No máximo ${maxVersions} versões impressas.`, 'printSnapshot', { code: 'too_many_versions' });
    }
    const index = evaluationIndex(evaluation);
    if (!index.size) return fail('A prova não foi encontrada para conferir o gabarito. Abra a prova de novo e monte outra vez.', 'printSnapshot', { code: 'snapshot_mismatch' });
    const copies = clone(list);
    const problems = [];
    copies.forEach((snapshot, versionIndex) => {
        const label = (snapshot && snapshot.version) || LETTERS[versionIndex];
        if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.questions) || !snapshot.questions.length) {
            problems.push({ version: label, motivo: `a versão ${label} não tem questões` });
            return;
        }
        const seen = new Set();
        snapshot.questions.forEach((question, position) => {
            if (!question || typeof question !== 'object') {
                problems.push({ version: label, position: position + 1, motivo: `a questão ${position + 1} da versão ${label} está em formato inválido` });
                return;
            }
            const number = questionNumber(question, position);
            const where = `questão ${number} (versão ${label})`;
            if (seen.has(number)) {
                problems.push({ version: label, questionNumber: number, motivo: `a ${where} aparece duas vezes` });
                return;
            }
            seen.add(number);
            const origin = index.get(number);
            if (!origin) {
                problems.push({ version: label, questionNumber: number, motivo: `a questão ${number} não existe na prova` });
                return;
            }
            const source = origin.question;
            const type = questionType(source);
            if (typeof question.type === 'string' && question.type.trim() && questionType(question) !== type) {
                problems.push({ version: label, questionNumber: number, motivo: `o tipo da ${where} não é o da prova` });
                return;
            }
            const declaredText = question.text || question.questionText;
            if (declaredText && declaredText !== questionTextOf(source, origin.index)) {
                problems.push({ version: label, questionNumber: number, motivo: `o enunciado da ${where} não é o da prova` });
                return;
            }
            const sourceAlternatives = alternativesOf(source);
            if (isChoiceType(type) && Array.isArray(question.alternatives) && question.alternatives.length) {
                const byLetter = new Map(sourceAlternatives.map(alternative => [alternative.letter, alternative.text]));
                const letters = new Set();
                for (let position2 = 0; position2 < question.alternatives.length; position2++) {
                    const alternative = question.alternatives[position2];
                    const letter = String((alternative && typeof alternative === 'object' && alternative.letter) || LETTERS[position2] || '').toUpperCase();
                    const text = alternative && typeof alternative === 'object' ? (alternative.text || alternative.label || '') : String(alternative ?? '');
                    // Alternativa vazia na prova: a tela de antes mandava '[object Object]' no
                    // lugar do texto (examTools.normalizeQuestion). Vale como vazia, e o texto
                    // guardado passa a ser o da prova.
                    const blankInSource = byLetter.has(letter) && !byLetter.get(letter);
                    const garbled = blankInSource && text === OBJECT_TEXT;
                    if (!byLetter.has(letter) || letters.has(letter) || (text && !garbled && text !== byLetter.get(letter))) {
                        problems.push({ version: label, questionNumber: number, motivo: `as alternativas da ${where} não são as da prova` });
                        return;
                    }
                    if (garbled && alternative && typeof alternative === 'object') {
                        alternative.text = byLetter.get(letter);
                        if (alternative.label === OBJECT_TEXT) delete alternative.label;
                    }
                    const display = alternative && typeof alternative === 'object' ? alternative.displayLetter : null;
                    if (display && String(display).toUpperCase() !== LETTERS[position2]) {
                        problems.push({ version: label, questionNumber: number, motivo: `as letras das alternativas da ${where} estão fora da ordem` });
                        return;
                    }
                    letters.add(letter);
                }
                if (letters.size !== byLetter.size) {
                    problems.push({ version: label, questionNumber: number, motivo: `as alternativas da ${where} não são as da prova` });
                    return;
                }
            }
            const key = answerKeyOf(source);
            if (declaresAnswerKey(question) && !sameAnswerKey(answerKeyOf({ ...question, type }), key)) {
                const right = describeAnswerKey(key, source);
                problems.push({ version: label, questionNumber: number, motivo: `a resposta certa da ${where} não é a da prova${right ? ` (na prova: ${right})` : ''}` });
                return;
            }
            // Snapshot mínimo (sem alternativas): elas vêm da avaliação, na ordem dela.
            if (isChoiceType(type) && !(Array.isArray(question.alternatives) && question.alternatives.length)) {
                question.alternatives = sourceAlternatives.map(alternative => ({ ...alternative }));
            }
            if (!question.text && !question.questionText) question.text = questionTextOf(source, origin.index);
        });
        if (problems.length) return;
        // O gabarito impresso declarado precisa bater com as letras da versão.
        const declaredKey = snapshot.answerKey && typeof snapshot.answerKey === 'object' && !Array.isArray(snapshot.answerKey) ? snapshot.answerKey : null;
        const expectedKey = {};
        snapshot.questions.forEach((question, position) => {
            const origin = index.get(questionNumber(question, position));
            const letters = printedAnswer({ ...question, type: questionType(origin.question) }, answerKeyOf(origin.question));
            if (letters) expectedKey[positionOf(question, position)] = letters;
        });
        if (declaredKey) {
            const positions = new Set([...Object.keys(declaredKey), ...Object.keys(expectedKey)].map(String));
            for (const position of positions) {
                const declared = String(declaredKey[position] ?? '').toUpperCase();
                const expected = String(expectedKey[position] ?? '');
                if (declared && declared !== expected) {
                    problems.push({ version: label, position: Number(position), motivo: `o gabarito impresso da versão ${label} na questão ${position} não confere com a prova${expected ? ` (deveria ser ${expected})` : ''}` });
                    return;
                }
            }
        }
        snapshot.answerKey = expectedKey;
    });
    if (problems.length) return mismatch(problems);
    // A resposta certa de cada questão (e as marcas das alternativas) passa a ser a da
    // avaliação, calculada aqui; tipo, pontos e o resto do gabarito, pelo freeze.
    copies.forEach(snapshot => {
        snapshot.questions = snapshot.questions.map((question, position) => {
            const number = questionNumber(question, position);
            const source = index.get(number).question;
            const draft = { questions: [{ ...question }] };
            applyAnswerKeyToSnapshots([draft], number, answerKeyOf(source));
            const checked = draft.questions[0];
            // A chave do banco vem da avaliação, nunca do navegador (como no freeze).
            delete checked.sourceBankKey;
            delete checked.bankKey;
            if (typeof source.bankKey === 'string' && source.bankKey) checked.bankKey = source.bankKey;
            return checked;
        });
        if (!snapshot.count) snapshot.count = snapshot.questions.length;
    });
    return { ok: true, snapshots: copies };
}

// As versões que a aplicação guarda: as primeiras 4 com a letra da versão e o tipo, os
// pontos e o gabarito congelados como estão na avaliação agora.
function frozenVersionSnapshots(snapshots, evaluation) {
    return freezeSnapshotGrading(
        clone(snapshots).slice(0, ONLINE_VERSIONS_MAX).map((snapshot, index) => ({ version: ONLINE_VERSION_LABELS[index], ...snapshot })),
        evaluation
    );
}

// Configuração salva antes desta versão (sem gabaritoConferidoEm): o gabarito de cada
// questão guardada é conferido com o da avaliação de hoje na hora de preparar. A questão
// cujo gabarito foi corrigido depois da prova (Corrigir gabarito, A8) vale como foi
// corrigida. Devolve null ou { error, code, questionNumber }.
function preparationAnswerKeyProblem(entry, evaluation) {
    if (!entry || typeof entry !== 'object' || entry.gabaritoConferidoEm) return null;
    const index = evaluationIndex(evaluation);
    if (!index.size) return null;
    const corrected = new Set((Array.isArray(entry.gabaritoCorrigido) ? entry.gabaritoCorrigido : []).map(Number));
    const snapshots = Array.isArray(entry.versionSnapshots) && entry.versionSnapshots.length
        ? entry.versionSnapshots
        : (Array.isArray(entry.printSnapshot) ? entry.printSnapshot : []);
    for (const snapshot of snapshots.slice(0, ONLINE_VERSIONS_MAX)) {
        const questions = Array.isArray(snapshot?.questions) ? snapshot.questions : [];
        for (let position = 0; position < questions.length; position++) {
            const question = questions[position];
            if (!question || typeof question !== 'object' || question.isAdditional === true) continue;
            const number = questionNumber(question, position);
            if (corrected.has(number)) continue;
            const origin = index.get(number);
            if (!origin) {
                return {
                    code: 'snapshot_mismatch',
                    questionNumber: number,
                    error: `A configuração salva tem a questão ${number}, que não existe mais na prova. Monte a prova de novo antes de aplicar.`,
                };
            }
            const key = answerKeyOf(origin.question);
            // Snapshot antigo sem tipo é de "uma correta": só confere a letra quando a questão
            // da avaliação é do mesmo tipo (a conta da nota já usa o tipo da avaliação).
            const stored = answerKeyOf({ ...question, type: question.type || key.type });
            if (!sameAnswerKey(stored, key)) {
                const right = describeAnswerKey(key, origin.question);
                return {
                    code: 'snapshot_mismatch',
                    questionNumber: number,
                    error: `A resposta certa da questão ${number} na configuração salva não é a da prova${right ? ` (na prova: ${right})` : ''}. Monte a prova de novo para aplicar com o gabarito de hoje.`,
                };
            }
        }
    }
    return null;
}

module.exports = {
    ONLINE_VERSION_COUNT_ERROR,
    ONLINE_VERSION_LABELS,
    ONLINE_VERSIONS_ERROR,
    ONLINE_VERSIONS_MAX,
    PRINT_VERSIONS_MAX,
    buildOnlineVersions,
    conferVersionSnapshots,
    frozenVersionSnapshots,
    generateExamCode,
    preparationAnswerKeyProblem,
};
