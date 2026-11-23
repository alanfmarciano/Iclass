// Sorteio de questões por aluno (fase 3, P3-S11: AVA-16; decisão D24 do desenho do P3).
//
// Até aqui toda a turma recebia as mesmas questões: as versões (A a D) só mudavam a ordem
// e a letra das alternativas. Com o sorteio por aluno, a aplicação guarda
//   application.sorteio = { modo: 'por_aluno', grupos: [{ filtro, quantidade, numeros }], total }
// (ausente = 'versoes', o de sempre). As questões da montagem salva (o snapshot da
// preparação) são o "pool": na preparação cada questão entra no PRIMEIRO grupo cujo
// filtro ela atende (os grupos não repartem a mesma questão) e o grupo guarda os números
// que tem (numeros), para o sorteio não depender de a avaliação mudar depois. No começo
// da tentativa o servidor sorteia, com uma semente de crypto guardada na tentativa
// (state.drawSeed), a quantidade de cada grupo e embaralha a ordem (se a aplicação
// embaralha questões); state.assignedQuestionNumbers fica com os números sorteados e a
// questão ganha o examNumber pela posição (examGrading.questionsForAttempt). A mesma
// semente dá sempre o mesmo sorteio (recarregar a página, trocar a versão no Monitor).
//
// Filtro de um grupo: origem ('avaliacao': escrita na própria prova; 'banco': veio do
// banco de questões, com bankKey), categoria (a do item do banco), dificuldade ('facil' |
// 'media' | 'dificil') e etiqueta; campo vazio não filtra. As questões do banco entram no
// pool como entram na prova: pelo editor ("Banco de questões > Adicionar").
const crypto = require('crypto');
const { DIFFICULTIES } = require('./questionModel.js');
const { itemCategory } = require('./questionBank.js');
const { normalizeSearch } = require('./textSearch.js');

const DRAW_MODES = Object.freeze(['versoes', 'por_aluno']);
const DRAW_ORIGINS = Object.freeze(['avaliacao', 'banco']);
const MAX_DRAW_GROUPS = 10;
const MAX_DRAW_PER_GROUP = 500;
const DRAW_CATEGORY_MAX = 80;
const DRAW_TAG_MAX = 40;
const DIFFICULTY_LABELS = Object.freeze({ facil: 'fáceis', media: 'médias', dificil: 'difíceis' });

function questionNumberOf(question, index = 0) {
    return Number(question?.originalNumber || question?.number || index + 1);
}

function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// Gerador de números com semente (sfc32 sobre o sha256 da semente): a mesma semente dá
// sempre o mesmo sorteio, em qualquer máquina.
function seededRandom(seed) {
    const digest = crypto.createHash('sha256').update(`iclass-sorteio:${String(seed)}`).digest();
    let a = digest.readUInt32LE(0);
    let b = digest.readUInt32LE(4);
    let c = digest.readUInt32LE(8);
    let d = digest.readUInt32LE(12);
    return () => {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        const t = (a + b) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0;
        const result = (t + d) | 0;
        c = (c + result) | 0;
        return (result >>> 0) / 4294967296;
    };
}

// Aleatório de crypto (o padrão do servidor; os testes passam o seu).
function cryptoRandom() {
    return crypto.randomInt(0, 0x100000000) / 0x100000000;
}

function shuffle(list, random = cryptoRandom) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function newDrawSeed() {
    return crypto.randomBytes(8).toString('hex');
}

function isPerStudentDraw(application) {
    return !!(application && application.sorteio && application.sorteio.modo === 'por_aluno'
        && Array.isArray(application.sorteio.grupos) && application.sorteio.grupos.length > 0);
}

// Metadados de uma questão do pool para o filtro: os da avaliação (é lá que o professor
// marca dificuldade e etiquetas) e, sem ela, os do snapshot. A categoria é a do item do
// banco de onde a questão veio.
function questionDrawMeta(question, evaluationQuestion, memory) {
    const source = evaluationQuestion && typeof evaluationQuestion === 'object' ? evaluationQuestion : (question || {});
    const bankKey = textOf(source.bankKey) || textOf(question?.bankKey);
    const bankItem = bankKey ? (Array.isArray(memory?.questionBank) ? memory.questionBank : []).find(item => item && item.key === bankKey) : null;
    const difficulty = DIFFICULTIES.includes(source.difficulty) ? source.difficulty : '';
    const tags = (Array.isArray(source.tags) ? source.tags : []).map(textOf).filter(Boolean);
    return {
        origem: bankKey ? 'banco' : 'avaliacao',
        categoria: bankItem ? itemCategory(bankItem) : '',
        dificuldade: difficulty,
        tags,
    };
}

// O pool de uma montagem: as questões da primeira versão guardada (todas as versões têm as
// mesmas), sem as que entraram no lugar de outra durante uma aplicação.
function drawPool(snapshots, evaluation, memory) {
    const first = (Array.isArray(snapshots) ? snapshots : []).find(snapshot => snapshot && Array.isArray(snapshot.questions)) || null;
    const evaluationQuestions = Array.isArray(evaluation?.questions) ? evaluation.questions : [];
    const byNumber = new Map(evaluationQuestions.map((question, index) => [questionNumberOf(question, index), question]));
    const seen = new Set();
    const pool = [];
    (first ? first.questions : []).forEach((question, index) => {
        if (!question || typeof question !== 'object' || question.isAdditional === true) return;
        const number = questionNumberOf(question, index);
        if (!Number.isFinite(number) || seen.has(number)) return;
        seen.add(number);
        pool.push({ number, ...questionDrawMeta(question, byNumber.get(number), memory) });
    });
    return pool;
}

function cleanFilter(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const filter = {};
    const origem = textOf(source.origem);
    if (origem) filter.origem = origem;
    const categoria = textOf(source.categoria);
    if (categoria) filter.categoria = categoria;
    const dificuldade = textOf(source.dificuldade);
    if (dificuldade) filter.dificuldade = dificuldade;
    const tag = textOf(source.tag);
    if (tag) filter.tag = tag;
    return filter;
}

function matchesDrawFilter(meta, filter = {}) {
    if (filter.origem && meta.origem !== filter.origem) return false;
    if (filter.dificuldade && meta.dificuldade !== filter.dificuldade) return false;
    if (filter.categoria && normalizeSearch(meta.categoria) !== normalizeSearch(filter.categoria)) return false;
    if (filter.tag) {
        const wanted = normalizeSearch(filter.tag);
        if (!meta.tags.some(tag => normalizeSearch(tag) === wanted)) return false;
    }
    return true;
}

// Cada questão do pool vai para o primeiro grupo que a aceita. Devolve os números de cada
// grupo, na ordem do pool.
function partitionPool(pool, filters) {
    const groups = filters.map(() => []);
    pool.forEach(meta => {
        const index = filters.findIndex(filter => matchesDrawFilter(meta, filter));
        if (index >= 0) groups[index].push(meta.number);
    });
    return groups;
}

// O grupo em palavras, para as mensagens e a tela ('questões fáceis da categoria Redes').
function describeDrawFilter(filter = {}) {
    const parts = [];
    parts.push(filter.dificuldade ? `questões ${DIFFICULTY_LABELS[filter.dificuldade] || filter.dificuldade}` : 'questões');
    if (filter.origem === 'banco') parts.push('vindas do banco');
    if (filter.origem === 'avaliacao') parts.push('escritas na prova');
    if (filter.categoria) parts.push(`da categoria ${filter.categoria}`);
    if (filter.tag) parts.push(`com a etiqueta ${filter.tag}`);
    return parts.join(' ');
}

function fail(error, field) {
    return { ok: false, error, field };
}

// "Como montar" da preparação (applicationOptions.sorteio). Sem o campo, ou com modo
// 'versoes', é o de sempre (value null). Por aluno: confere os grupos contra o pool da
// montagem e devolve o sorteio a gravar na aplicação. field: relativo a 'sorteio'.
function parseDrawInput(raw, { pool = [] } = {}) {
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) return fail('O campo "como montar" está em formato inválido.', 'sorteio');
    const modo = textOf(raw.modo) || 'versoes';
    if (!DRAW_MODES.includes(modo)) return fail('Escolha como montar a prova: versões ou sorteio por aluno.', 'sorteio.modo');
    if (modo === 'versoes') return { ok: true, value: null };
    const grupos = Array.isArray(raw.grupos) ? raw.grupos : [];
    if (!grupos.length) return fail('No sorteio por aluno, diga quantas questões sortear (pelo menos um grupo).', 'sorteio.grupos');
    if (grupos.length > MAX_DRAW_GROUPS) return fail(`O sorteio aceita no máximo ${MAX_DRAW_GROUPS} grupos.`, 'sorteio.grupos');
    if (!pool.length) return fail('A montagem salva não tem questões para sortear.', 'sorteio');
    const filters = [];
    const quantities = [];
    for (let index = 0; index < grupos.length; index++) {
        const group = grupos[index] && typeof grupos[index] === 'object' && !Array.isArray(grupos[index]) ? grupos[index] : null;
        const field = `sorteio.grupos[${index}]`;
        if (!group) return fail(`Grupo ${index + 1} do sorteio em formato inválido.`, field);
        const filter = cleanFilter(group.filtro);
        if (filter.origem && !DRAW_ORIGINS.includes(filter.origem)) return fail(`Grupo ${index + 1}: a origem deve ser "escritas na prova" ou "vindas do banco".`, `${field}.filtro.origem`);
        if (filter.dificuldade && !DIFFICULTIES.includes(filter.dificuldade)) return fail(`Grupo ${index + 1}: a dificuldade deve ser fácil, média ou difícil.`, `${field}.filtro.dificuldade`);
        if (filter.categoria && filter.categoria.length > DRAW_CATEGORY_MAX) return fail(`Grupo ${index + 1}: a categoria aceita no máximo ${DRAW_CATEGORY_MAX} caracteres.`, `${field}.filtro.categoria`);
        if (filter.tag && filter.tag.length > DRAW_TAG_MAX) return fail(`Grupo ${index + 1}: a etiqueta aceita no máximo ${DRAW_TAG_MAX} caracteres.`, `${field}.filtro.tag`);
        const quantity = Number(group.quantidade);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_DRAW_PER_GROUP) {
            return fail(`Grupo ${index + 1}: informe quantas questões sortear (um número inteiro a partir de 1).`, `${field}.quantidade`);
        }
        filters.push(filter);
        quantities.push(quantity);
    }
    const numbers = partitionPool(pool, filters);
    for (let index = 0; index < filters.length; index++) {
        const available = numbers[index].length;
        if (quantities[index] > available) {
            const what = describeDrawFilter(filters[index]);
            // A frase dos dois grupos só quando um grupo de cima levou questões que este
            // filtro também aceita (não quando o filtro não combina com nada).
            const matching = pool.filter(meta => matchesDrawFilter(meta, filters[index])).length;
            const others = matching > available ? ' (a questão que serve para dois grupos fica no primeiro)' : '';
            const error = available === 0
                ? `Grupo ${index + 1}: nenhuma questão da montagem combina com o filtro (${what})${others}.`
                : `Grupo ${index + 1}: pediu ${quantities[index]} ${what}, mas a montagem só tem ${available}${others}.`;
            return fail(error, `sorteio.grupos[${index}].quantidade`);
        }
    }
    const total = quantities.reduce((sum, value) => sum + value, 0);
    return {
        ok: true,
        value: {
            modo: 'por_aluno',
            grupos: filters.map((filtro, index) => ({ filtro, quantidade: quantities[index], numeros: numbers[index] })),
            total,
        },
    };
}

// Os números sorteados para uma tentativa, pela semente: a quantidade de cada grupo, sem
// repetir questão, e a ordem embaralhada (ou a do pool, quando a aplicação não embaralha
// as questões). Não muda nada; devolve { numbers, drawGroups }.
function drawNumbers(sorteio, seed, { shuffleOrder = true } = {}) {
    const grupos = Array.isArray(sorteio?.grupos) ? sorteio.grupos : [];
    const random = seededRandom(seed);
    const used = new Set();
    const order = new Map();
    const picked = grupos.map(group => {
        const candidates = (Array.isArray(group?.numeros) ? group.numeros : [])
            .map(Number)
            .filter(number => Number.isFinite(number) && !used.has(number));
        candidates.forEach(number => { if (!order.has(number)) order.set(number, order.size); });
        const chosen = shuffle(candidates, random).slice(0, Math.max(0, Number(group?.quantidade) || 0));
        chosen.forEach(number => used.add(number));
        return chosen;
    });
    const flat = picked.flat();
    const numbers = shuffleOrder ? shuffle(flat, random) : [...flat].sort((a, b) => order.get(a) - order.get(b));
    return { numbers, drawGroups: picked.map(list => list.length) };
}

// Questões que entraram no lugar de uma sorteada (troca de questão no Monitor): o aluno que
// tirou a questão trocada recebe a nova no fim, como na prova por versões.
function withReplacements(numbers, snapshot) {
    const result = [...numbers];
    const questions = Array.isArray(snapshot?.questions) ? snapshot.questions : [];
    questions.forEach((question, index) => {
        if (!question || question.isAdditional !== true) return;
        const replaced = Number(question.replacedQuestionNumber);
        const number = questionNumberOf(question, index);
        if (result.includes(replaced) && !result.includes(number)) result.push(number);
    });
    return result;
}

// Sorteia (ou refaz pela semente) as questões da tentativa de uma aplicação com sorteio por
// aluno. Muda o estado no lugar: drawSeed (nova, quando não tem), drawGroups e
// assignedQuestionNumbers. Devolve true quando mudou alguma coisa.
function ensureAttemptDraw(state, application, snapshot) {
    if (!state || !isPerStudentDraw(application)) return false;
    if (Array.isArray(state.assignedQuestionNumbers) && state.drawSeed) return false;
    if (!state.drawSeed) state.drawSeed = newDrawSeed();
    const drawn = drawNumbers(application.sorteio, state.drawSeed, { shuffleOrder: application.shuffleQuestions !== false });
    state.drawGroups = drawn.drawGroups;
    state.assignedQuestionNumbers = withReplacements(drawn.numbers, snapshot);
    return true;
}

// Resumo do sorteio para a tela (sem os números de cada grupo).
function drawSummary(application) {
    if (!isPerStudentDraw(application)) return { modo: 'versoes' };
    return {
        modo: 'por_aluno',
        total: Number(application.sorteio.total) || application.sorteio.grupos.reduce((sum, group) => sum + (Number(group.quantidade) || 0), 0),
        grupos: application.sorteio.grupos.map(group => ({
            filtro: { ...(group.filtro || {}) },
            quantidade: Number(group.quantidade) || 0,
            disponiveis: Array.isArray(group.numeros) ? group.numeros.length : 0,
            descricao: describeDrawFilter(group.filtro || {}),
        })),
    };
}

module.exports = {
    DRAW_MODES,
    DRAW_ORIGINS,
    MAX_DRAW_GROUPS,
    MAX_DRAW_PER_GROUP,
    describeDrawFilter,
    drawNumbers,
    drawPool,
    drawSummary,
    ensureAttemptDraw,
    isPerStudentDraw,
    matchesDrawFilter,
    newDrawSeed,
    parseDrawInput,
    partitionPool,
    questionDrawMeta,
    seededRandom,
    shuffle,
    withReplacements,
};
