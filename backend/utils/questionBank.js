// Banco de questões no modelo único da questão (fase 3, P3-S9a: AVA-15; decisões D3 e
// D21 do desenho P3).
//
// Antes o banco guardava só "uma correta" (enunciado, alternativas e a letra certa) com
// uma validação própria, e a avaliação aceitava o que o banco recusava. Agora:
// - o item passa pelo mesmo normalizeQuestion da avaliação (context 'banco'): os seis
//   tipos, pontos, explicação, rubrica e os metadados (dificuldade, habilidades e
//   etiquetas);
// - o enunciado continua no campo questionText (o nome de sempre do banco: a 281029f e
//   as telas de hoje leem por ele); os outros campos têm o nome da questão da avaliação;
// - cada item ganha author (quem criou), revision (1 na criação, +1 a cada alteração que
//   muda alguma coisa; o item antigo vale 0 e o primeiro salvamento dá 1), updatedAt,
//   updatedBy e archived ("Arquivar" tira da lista padrão sem apagar);
// - a estatística (usos e % de acerto) é calculada na hora, nunca gravada: uma questão
//   vinda do banco leva bankKey na avaliação e no snapshot da aplicação (a troca de
//   questão no Monitor leva sourceBankKey), e as entregas são contadas por essa chave.
//
// Nada é reescrito no boot: o item antigo (type 'multiple_choice' ou sem type, sem
// metadados, às vezes com o enunciado em text) é lido com padrão e só muda quando alguém
// salva.
const { QUESTION_TYPES } = require('./examScoring.js');
const { DIFFICULTIES, TYPE_LABELS, normalizeQuestion } = require('./questionModel.js');
const { compareText, matchesSearch, normalizeSearch } = require('./textSearch.js');

// Campos da questão guardados no item (os do modelo, com o enunciado em questionText;
// text é o nome de item antigo gravado pela API).
const QUESTION_FIELDS = Object.freeze([
    'type', 'points', 'questionText', 'text', 'alternatives', 'correctAnswer', 'correctAnswers', 'partialCredit',
    'numeric', 'acceptedAnswers', 'review', 'expectedAnswer', 'rubric', 'explanation', 'difficulty', 'skills', 'tags', 'bankKey',
]);
// Campos que o pedido pode mandar para a questão (os do questionInputSchema).
const INPUT_FIELDS = Object.freeze([
    'type', 'points', 'alternatives', 'correctAnswer', 'correctAnswers', 'partialCredit', 'numeric', 'acceptedAnswers',
    'review', 'expectedAnswer', 'rubric', 'explanation', 'difficulty', 'skills', 'tags',
]);
const DEFAULT_CATEGORY = 'Geral';

function clone(value) {
    return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function textOf(value) {
    return typeof value === 'string' ? value : '';
}

function bankQuestionText(item) {
    if (typeof item?.questionText === 'string') return item.questionText;
    return typeof item?.text === 'string' ? item.text : '';
}

// O item como questão do modelo (com o enunciado em text): para o editor, para a troca de
// questão no Monitor e para salvar de novo. Tipo desconhecido ou ausente é uma correta (D1).
function bankItemQuestion(item) {
    const question = {};
    if (!item || typeof item !== 'object') return question;
    QUESTION_FIELDS.forEach(field => {
        if (field === 'questionText' || field === 'text' || field === 'bankKey') return;
        if (item[field] !== undefined && item[field] !== null) question[field] = clone(item[field]);
    });
    if (typeof question.type !== 'string' || !QUESTION_TYPES.includes(question.type)) delete question.type;
    question.text = bankQuestionText(item);
    return question;
}

function hasMarkedAlternative(alternatives) {
    return Array.isArray(alternatives) && alternatives.some(alternative => alternative && typeof alternative === 'object' && alternative.isCorrect === true);
}

function withoutMarks(alternatives) {
    return Array.isArray(alternatives)
        ? alternatives.map(alternative => (alternative && typeof alternative === 'object' ? { ...alternative, isCorrect: false } : alternative))
        : alternatives;
}

// Questão do pedido por cima da questão de antes (no update): campo ausente fica como
// estava; campo enviado vazio ('' ou []) limpa. A resposta certa vem de um lugar só: com
// as alternativas marcadas e sem letra, a letra de antes não vale; com a letra e sem
// alternativas, a marca das alternativas de antes não vale.
function mergeQuestionInput(input, previous) {
    const source = input && typeof input === 'object' ? input : {};
    const raw = previous ? bankItemQuestion(previous) : {};
    INPUT_FIELDS.forEach(field => {
        if (source[field] !== undefined) raw[field] = source[field];
    });
    if (source.text !== undefined) raw.text = source.text;
    else if (source.questionText !== undefined) raw.text = source.questionText;
    if (previous) {
        const sentAnswer = source.correctAnswer !== undefined || source.correctAnswers !== undefined;
        if (source.alternatives !== undefined && !sentAnswer && hasMarkedAlternative(source.alternatives)) {
            delete raw.correctAnswer;
            delete raw.correctAnswers;
        }
        if (source.alternatives === undefined && sentAnswer) raw.alternatives = withoutMarks(raw.alternatives);
    }
    return raw;
}

// Pedido (e o item de antes, no update) -> campos da questão para gravar no item. Lança o
// erro 400 do modelo com a mensagem sem "Questão N:" ("Informe o enunciado.").
function normalizeBankQuestion(input, { previous = null } = {}) {
    const question = normalizeQuestion(mergeQuestionInput(input, previous), { context: 'banco' });
    delete question.bankKey;
    const { text, ...rest } = question;
    return { ...rest, questionText: text };
}

// Troca os campos da questão do item pelos normalizados (os outros campos, inclusive os
// de item antigo que o banco não conhece, ficam como estavam).
function applyBankQuestion(item, normalized) {
    QUESTION_FIELDS.forEach(field => { delete item[field]; });
    Object.assign(item, normalized);
    return item;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            if (value[key] !== undefined) out[key] = canonical(value[key]);
            return out;
        }, {});
    }
    return value;
}

// Nomes dos campos que mudaram entre duas versões do item (questão, categoria e
// componente curricular), para saber se a revisão sobe e para a auditoria.
const COMPARED_FIELDS = Object.freeze([...QUESTION_FIELDS.filter(field => field !== 'text' && field !== 'bankKey'), 'category', 'curriculumKey']);
function changedBankFields(before, after) {
    const beforeQuestion = { ...before, questionText: bankQuestionText(before) };
    return COMPARED_FIELDS.filter(field => JSON.stringify(canonical(beforeQuestion[field])) !== JSON.stringify(canonical(after[field])));
}

function itemCategory(item) {
    const category = textOf(item?.category).trim();
    return category || DEFAULT_CATEGORY;
}

function itemType(item) {
    return typeof item?.type === 'string' && QUESTION_TYPES.includes(item.type) ? item.type : 'multiple_choice';
}

function itemDifficulty(item) {
    return DIFFICULTIES.includes(item?.difficulty) ? item.difficulty : '';
}

function textList(value) {
    return (Array.isArray(value) ? value : []).filter(entry => typeof entry === 'string' && entry.trim());
}

function isArchivedItem(item) {
    return item?.archived === true;
}

// ---------------------------------------------------------------- estatística (D21)

function isConsideredSubmission(submission) {
    if (!submission || typeof submission !== 'object') return false;
    if (submission.resultStatus === 'archived' || submission.archived === true || submission.resultStatus === 'invalidated') return false;
    // Tentativa anulada por integridade (A9): as respostas dela não contam (zero e
    // desconsiderar); desfeita, volta a contar.
    const integrity = submission.integrity;
    if (integrity && typeof integrity === 'object' && integrity.decisao && !integrity.desfeitaEm) return false;
    return true;
}

function snapshotQuestionKey(question) {
    if (!question || typeof question !== 'object') return '';
    const key = textOf(question.bankKey).trim() || textOf(question.sourceBankKey).trim();
    return key;
}

function snapshotQuestions(snapshots) {
    return (Array.isArray(snapshots) ? snapshots : [])
        .flatMap(snapshot => (snapshot && Array.isArray(snapshot.questions) ? snapshot.questions : []));
}

function questionNumberOf(question, index) {
    return Number(question?.originalNumber || question?.number || index + 1);
}

// Número da questão -> chave do banco, a partir das questões de um snapshot.
function keysByNumber(questions) {
    const map = new Map();
    (Array.isArray(questions) ? questions : []).forEach((question, index) => {
        const key = snapshotQuestionKey(question);
        if (key) map.set(questionNumberOf(question, index), key);
    });
    return map;
}

// Entrega lançada pelo cartão-resposta (POST /api/admin/submissions/create): não tem
// examSnapshot nem applicationId, e o número de cada resposta é o da questão na
// avaliação (originalNumber). A chave do banco vem:
// 1. da prova impressa registrada no histórico da turma (examHistory[examKey], type
//    'impressa'): a mais nova cujas versões têm todas as questões respondidas (a do
//    activeHistoryId primeiro, como a revisão da entrega faz). versionSnapshots é o que a
//    avaliação tinha na impressão, com o bankKey que o servidor copiou (não o da tela);
// 2. senão (cartão lançado pela avaliação, sem escolher a versão impressa), das questões
//    da avaliação, que são as que o lançamento usou para corrigir. Se a turma não tem
//    prova impressa registrada nessa prova, ela não tem outro registro de uso: as
//    entregas da turma contam uma aplicação para cada questão do banco respondida
//    (extraUses).
// Devolve { byNumber, extraUses }.
function printedKeysResolver(memory) {
    const classes = Array.isArray(memory?.classes) ? memory.classes : [];
    const evaluations = memory?.evaluations && typeof memory.evaluations === 'object' ? memory.evaluations : {};
    const evaluationKeys = new Map();
    const keysOfEvaluation = examKey => {
        if (!evaluationKeys.has(examKey)) {
            const evaluation = Object.prototype.hasOwnProperty.call(evaluations, examKey) ? evaluations[examKey] : null;
            evaluationKeys.set(examKey, keysByNumber(evaluation && Array.isArray(evaluation.questions) ? evaluation.questions : []));
        }
        return evaluationKeys.get(examKey);
    };
    const countedGroups = new Map();
    const none = { byNumber: new Map(), extraUses: [] };
    return (submission, studentClass, courseId, answers) => {
        // Só o lançamento pelo cartão (ou impresso antigo com respostas): a entrega online
        // antiga sem aplicação nem snapshot não é da prova impressa e fica fora, como antes.
        if (submission.entryMode !== 'card' && submission.type !== 'impressa') return none;
        const examKey = textOf(submission.examKey).trim();
        if (!examKey) return none;
        const cls = classes.find(item => item && typeof item === 'object' && item.name === studentClass && (!courseId || !item.courseId || String(item.courseId) === String(courseId)));
        const history = cls && cls.examHistory && typeof cls.examHistory === 'object' && Array.isArray(cls.examHistory[examKey])
            ? cls.examHistory[examKey].filter(item => item && typeof item === 'object' && item.type === 'impressa')
            : [];
        const numbers = answers.map(answer => Number(answer?.questionNumber)).filter(Number.isFinite);
        const activeId = textOf(submission.activeHistoryId);
        const ordered = activeId
            ? [...history.filter(item => item.id === activeId), ...history.filter(item => item.id !== activeId).reverse()]
            : [...history].reverse();
        for (const historyEntry of ordered) {
            const versions = Array.isArray(historyEntry.versionSnapshots) ? historyEntry.versionSnapshots : [];
            const matched = versions.some(version => {
                const inVersion = new Set((Array.isArray(version?.questions) ? version.questions : []).map(questionNumberOf));
                return numbers.every(number => inVersion.has(number));
            });
            if (matched) return { byNumber: keysByNumber(snapshotQuestions(versions)), extraUses: [] };
        }
        const byNumber = keysOfEvaluation(examKey);
        if (history.length) return { byNumber, extraUses: [] };
        const group = `${studentClass}\u0000${courseId}\u0000${examKey}`;
        if (!countedGroups.has(group)) countedGroups.set(group, new Set());
        const counted = countedGroups.get(group);
        const extraUses = [...new Set(numbers.map(number => byNumber.get(number)).filter(key => key && !counted.has(key)))];
        extraUses.forEach(key => counted.add(key));
        return { byNumber, extraUses };
    };
}

function emptyStats() {
    return { usos: 0, respostas: 0, pendentes: 0, acertoPct: null };
}

// Estatística de cada questão do banco, por chave: usos (aplicações online que não foram
// canceladas, provas impressas registradas com a questão e, sem registro, a prova impressa
// lançada pelo cartão-resposta na turma), respostas contadas (as do cartão-resposta
// também, por printedKeysResolver), respostas
// aguardando o professor e % de acerto (pontos obtidos sobre os possíveis em cada
// resposta corrigida; entrega antiga sem pontos conta 100% ou 0% pelo acerto). Só entram
// entregas consideradas (não arquivadas, não anuladas) e só turmas que canAccessClass
// deixa ver (o professor vê a estatística das turmas dele).
function questionBankStats(memory, { canAccessClass = null } = {}) {
    const allowed = (studentClass, courseId) => (typeof canAccessClass === 'function' ? canAccessClass(studentClass, courseId) : true);
    const totals = new Map();
    const entry = key => {
        if (!totals.has(key)) totals.set(key, { usos: 0, respostas: 0, pendentes: 0, soma: 0 });
        return totals.get(key);
    };
    const applications = new Map();
    (Array.isArray(memory?.examApplications) ? memory.examApplications : []).forEach(application => {
        if (!application || typeof application !== 'object' || !application.id) return;
        applications.set(application.id, application);
        if (application.status === 'cancelled' || application.status === 'draft') return;
        if (!allowed(application.studentClass, application.courseId)) return;
        new Set(snapshotQuestions(application.versionSnapshots).map(snapshotQuestionKey).filter(Boolean)).forEach(key => { entry(key).usos += 1; });
    });
    // Prova impressa: não vira aplicação; o registro dela no histórico da turma é o uso.
    (Array.isArray(memory?.classes) ? memory.classes : []).forEach(cls => {
        if (!cls || typeof cls !== 'object' || !cls.examHistory || typeof cls.examHistory !== 'object') return;
        if (!allowed(cls.name, cls.courseId)) return;
        Object.values(cls.examHistory).forEach(list => {
            (Array.isArray(list) ? list : []).forEach(historyEntry => {
                if (!historyEntry || historyEntry.type !== 'impressa') return;
                const snapshots = Array.isArray(historyEntry.versionSnapshots) && historyEntry.versionSnapshots.length
                    ? historyEntry.versionSnapshots
                    : historyEntry.printSnapshot;
                new Set(snapshotQuestions(snapshots).map(snapshotQuestionKey).filter(Boolean)).forEach(key => { entry(key).usos += 1; });
            });
        });
    });
    const applicationKeys = new Map();
    const keysOfApplication = id => {
        if (!applicationKeys.has(id)) applicationKeys.set(id, keysByNumber(snapshotQuestions(applications.get(id)?.versionSnapshots)));
        return applicationKeys.get(id);
    };
    const printed = printedKeysResolver(memory);
    (Array.isArray(memory?.submissions) ? memory.submissions : []).forEach(submission => {
        if (!isConsideredSubmission(submission)) return;
        const answers = Array.isArray(submission.gradedAnswers) ? submission.gradedAnswers : [];
        if (!answers.length) return;
        const studentClass = submission.student?.studentClass || submission.studentClass || '';
        const courseId = submission.student?.courseId || submission.courseId || '';
        if (!allowed(studentClass, courseId)) return;
        let byNumber = keysByNumber(submission.examSnapshot?.questions);
        if (!byNumber.size && submission.applicationId && applications.has(submission.applicationId)) byNumber = keysOfApplication(submission.applicationId);
        // Lançada pelo cartão-resposta (prova impressa): sem snapshot e sem aplicação.
        if (!byNumber.size && !submission.applicationId) {
            const resolved = printed(submission, studentClass, courseId, answers);
            byNumber = resolved.byNumber;
            resolved.extraUses.forEach(key => { entry(key).usos += 1; });
        }
        if (!byNumber.size) return;
        answers.forEach(answer => {
            if (!answer || typeof answer !== 'object') return;
            const key = byNumber.get(Number(answer.questionNumber));
            if (!key || answer.annulled === true) return;
            const stats = entry(key);
            if (answer.pending === true) {
                stats.pendentes += 1;
                return;
            }
            const possible = Number(answer.pointsPossible);
            const earned = Number(answer.pointsEarned);
            const fraction = Number.isFinite(possible) && possible > 0 && Number.isFinite(earned)
                ? Math.max(0, Math.min(1, earned / possible))
                : (answer.isCorrect === true ? 1 : 0);
            stats.respostas += 1;
            stats.soma += fraction;
        });
    });
    const result = new Map();
    totals.forEach((value, key) => {
        result.set(key, {
            usos: value.usos,
            respostas: value.respostas,
            pendentes: value.pendentes,
            acertoPct: value.respostas ? Math.round((value.soma / value.respostas) * 100) : null,
        });
    });
    return result;
}

// ---------------------------------------------------------------- lista e filtros

// Item no formato da tela: category, curriculumKey, type e questionText sempre texto (um
// item antigo gravado pela API com um objeto ali derrubava Provas e Monitor), revision e
// archived com padrão, e a estatística. Só a resposta é normalizada; o banco não é
// regravado.
function bankItemForScreen(item, stats = null) {
    return {
        ...item,
        category: itemCategory(item),
        curriculumKey: textOf(item.curriculumKey),
        type: itemType(item),
        questionText: bankQuestionText(item),
        revision: Number.isInteger(item.revision) && item.revision > 0 ? item.revision : 0,
        archived: isArchivedItem(item),
        stats: stats || emptyStats(),
    };
}

const FILTER_FIELDS = Object.freeze({
    categoria: 'categoria',
    tipo: 'tipo',
    dificuldade: 'dificuldade',
    tag: 'etiqueta',
    q: 'busca',
    arquivadas: 'arquivadas',
});
// Categoria do item: a tela manda o tema da prova (ou o nome da unidade). O teto é o
// mesmo do campo Tema do editor (500, com contador): o schema nunca recusa o que a tela
// deixa digitar (decisões §12, sobra do H9b).
const QUESTION_CATEGORY_MAX_CHARS = 500;
const FILTER_MAX_LENGTH = 80;
// Teto de cada filtro: o da categoria é o mesmo da categoria do item, porque a tela filtra
// pela categoria inteira que o GET devolve em "categorias" (uma categoria de 90 caracteres
// vinda do tema da prova tem de poder ser filtrada). A etiqueta tem 40 no modelo e a busca
// 80 na tela.
const FILTER_MAX_LENGTHS = Object.freeze({ categoria: QUESTION_CATEGORY_MAX_CHARS });

// Filtros do GET (?categoria=&tipo=&dificuldade=&tag=&q=&arquivadas=0|1): cada um texto
// de até 80 caracteres (a categoria até 500); tipo e dificuldade só os valores do modelo
// ('sem' = sem dificuldade). Devolve { filters } ou { error, field }.
function parseBankFilters(query = {}) {
    const filters = {};
    for (const [field, label] of Object.entries(FILTER_FIELDS)) {
        const value = query[field];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string') return { error: `O campo "${label}" está em formato inválido.`, field };
        const text = value.trim();
        const max = FILTER_MAX_LENGTHS[field] || FILTER_MAX_LENGTH;
        if (text.length > max) return { error: `O campo "${label}" aceita no máximo ${max} caracteres.`, field };
        if (text) filters[field] = text;
    }
    if (filters.tipo && !QUESTION_TYPES.includes(filters.tipo)) return { error: 'O campo "tipo" tem um valor não permitido.', field: 'tipo' };
    if (filters.dificuldade && filters.dificuldade !== 'sem' && !DIFFICULTIES.includes(filters.dificuldade)) {
        return { error: 'O campo "dificuldade" tem um valor não permitido.', field: 'dificuldade' };
    }
    if (filters.arquivadas && !['0', '1'].includes(filters.arquivadas)) return { error: 'O campo "arquivadas" tem um valor não permitido.', field: 'arquivadas' };
    return { filters };
}

function alternativeTexts(item) {
    return (Array.isArray(item?.alternatives) ? item.alternatives : [])
        .map(alternative => (typeof alternative === 'string' ? alternative : textOf(alternative?.text)));
}

function matchesBankFilters(item, filters = {}) {
    if (filters.arquivadas !== '1' && isArchivedItem(item)) return false;
    if (filters.categoria && normalizeSearch(itemCategory(item)) !== normalizeSearch(filters.categoria)) return false;
    if (filters.tipo && itemType(item) !== filters.tipo) return false;
    if (filters.dificuldade) {
        const difficulty = itemDifficulty(item);
        if (filters.dificuldade === 'sem' ? difficulty !== '' : difficulty !== filters.dificuldade) return false;
    }
    if (filters.tag) {
        const wanted = normalizeSearch(filters.tag);
        if (!textList(item?.tags).some(tag => normalizeSearch(tag) === wanted)) return false;
    }
    if (filters.q && !matchesSearch([bankQuestionText(item), itemCategory(item), ...textList(item?.tags), ...textList(item?.skills), ...alternativeTexts(item)], filters.q)) return false;
    return true;
}

// Categorias e etiquetas existentes (para os filtros da tela), em ordem alfabética do
// português e sem repetir por acento ou maiúscula.
function bankFacets(items) {
    const distinct = values => {
        const seen = new Map();
        values.forEach(value => {
            const key = normalizeSearch(value);
            if (key && !seen.has(key)) seen.set(key, value.trim());
        });
        return [...seen.values()].sort(compareText);
    };
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    return {
        categorias: distinct(list.map(itemCategory)),
        etiquetas: distinct(list.flatMap(item => textList(item.tags))),
    };
}

function bankTypeLabel(item) {
    return TYPE_LABELS[itemType(item)] || TYPE_LABELS.multiple_choice;
}

module.exports = {
    DEFAULT_CATEGORY,
    QUESTION_CATEGORY_MAX_CHARS,
    applyBankQuestion,
    bankFacets,
    bankItemForScreen,
    bankItemQuestion,
    bankQuestionText,
    bankTypeLabel,
    changedBankFields,
    isArchivedItem,
    itemCategory,
    itemType,
    matchesBankFilters,
    normalizeBankQuestion,
    parseBankFilters,
    questionBankStats,
};
