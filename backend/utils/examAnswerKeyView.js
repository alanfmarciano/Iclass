// Gabarito fora do que vai para quem não prepara nem corrige prova (B1, papel "sem
// notas" do Professor auxiliar; shared_contracts.rbac.papeis do plano).
//
// Duas medidas, de propósito diferentes:
// - turma e configuração da prova (GET /classes, POST /config, controle da prova): as
//   versões montadas (versionSnapshots, printSnapshot, questions) só para quem prepara
//   prova (page.exams). As outras contas que leem a turma (Professor auxiliar no
//   Monitor, Secretaria e Coordenação no Dashboard e em Turmas) recebem a configuração
//   sem elas; nenhuma tela delas as usa (a prova do aluno lê pela rota do aluno);
// - a questão contestada no Monitor (GET /question-reports): o gabarito vai para quem
//   corrige a questão (page.results) ou prepara a prova (page.exams). O Professor
//   auxiliar vê o enunciado e as alternativas, sem a marca da correta.
const { canAccessAdminPermission } = require('./adminPermissions.js');

// Campos da configuração (e das entradas do histórico) que levam as questões montadas
// com o gabarito. printSnapshot e questions vêm de configurações antigas.
const ANSWER_KEY_CONFIG_FIELDS = Object.freeze(['versionSnapshots', 'printSnapshot', 'questions', 'answerKey']);

function canReadExamVersions(account) {
    return canAccessAdminPermission(account, 'page.exams');
}

function canReadQuestionAnswerKey(account) {
    return canAccessAdminPermission(account, 'page.exams') || canAccessAdminPermission(account, 'page.results');
}

function withoutFields(value, fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy = { ...value };
    fields.forEach(field => { delete copy[field]; });
    return copy;
}

function onlineExamConfigWithoutAnswerKeys(config) {
    return withoutFields(config, ANSWER_KEY_CONFIG_FIELDS);
}

function onlineExamConfigsWithoutAnswerKeys(configs) {
    if (!configs || typeof configs !== 'object' || Array.isArray(configs)) return configs;
    return Object.fromEntries(Object.entries(configs)
        .map(([examKey, config]) => [examKey, onlineExamConfigWithoutAnswerKeys(config)]));
}

// Turma sem o gabarito: configurações da prova online, histórico de montagens (cada
// entrada guarda as versões impressas) e avaliações personalizadas da turma (as
// questões, com a alternativa correta).
function classWithoutAnswerKeys(cls) {
    if (!cls || typeof cls !== 'object') return cls;
    const copy = { ...cls };
    if (cls.onlineExamConfigs && typeof cls.onlineExamConfigs === 'object') {
        copy.onlineExamConfigs = onlineExamConfigsWithoutAnswerKeys(cls.onlineExamConfigs);
    }
    if (cls.examHistory && typeof cls.examHistory === 'object' && !Array.isArray(cls.examHistory)) {
        copy.examHistory = Object.fromEntries(Object.entries(cls.examHistory).map(([examKey, entries]) => [
            examKey,
            Array.isArray(entries) ? entries.map(entry => withoutFields(entry, ANSWER_KEY_CONFIG_FIELDS)) : entries,
        ]));
    }
    const overrides = cls.contentOverrides;
    if (overrides && typeof overrides === 'object' && overrides.evaluations && typeof overrides.evaluations === 'object') {
        copy.contentOverrides = {
            ...overrides,
            evaluations: Object.fromEntries(Object.entries(overrides.evaluations)
                .map(([key, evaluation]) => [key, withoutFields(evaluation, ['questions', 'answerKey'])])),
        };
    }
    return copy;
}

// Questão sem o gabarito (lista branca: campo novo no snapshot não vaza por acidente).
function questionWithoutAnswerKey(question) {
    if (!question || typeof question !== 'object') return question;
    const view = {};
    ['originalNumber', 'examNumber', 'text', 'questionText', 'isAdditional', 'replacedQuestionNumber', 'version']
        .forEach(field => { if (question[field] !== undefined) view[field] = question[field]; });
    view.alternatives = (Array.isArray(question.alternatives) ? question.alternatives : []).map((alternative, index) => {
        const item = {
            letter: String((alternative && alternative.letter) || String.fromCharCode(65 + index)).toUpperCase(),
            text: String((alternative && alternative.text) ?? ''),
        };
        if (alternative && alternative.displayLetter) item.displayLetter = alternative.displayLetter;
        return item;
    });
    return view;
}

module.exports = {
    ANSWER_KEY_CONFIG_FIELDS,
    canReadExamVersions,
    canReadQuestionAnswerKey,
    classWithoutAnswerKeys,
    onlineExamConfigWithoutAnswerKeys,
    onlineExamConfigsWithoutAnswerKeys,
    questionWithoutAnswerKey,
};
