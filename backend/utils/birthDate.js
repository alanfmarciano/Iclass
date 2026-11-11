// Data de nascimento do aluno (H8a-2; SEG-09, decisão P4 do Alan).
//
// Formato gravado: 'AAAA-MM-DD' (o que o <input type="date"> manda), de 1900-01-01 até
// hoje no fuso das configurações (settings.timezone). A idade é contada em anos
// completos; menor é quem tem menos de 18 anos. Campo opcional no cadastro pelo
// professor e na edição; obrigatório no autocadastro; o portão do primeiro acesso
// (StudentPrivacyGate) pede a quem não tem. Cadastro antigo sem o campo continua valendo.

const BIRTH_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_BIRTH_DATE = '1900-01-01';
const ADULT_AGE = 18;

// Hoje no fuso das configurações ('AAAA-MM-DD'). Carregado aqui: utils/settings.js lê o
// banco, e este módulo também é usado em testes de unidade.
function todayIso() {
    try {
        return require('./settings.js').today();
    } catch (error) {
        return new Date().toISOString().slice(0, 10);
    }
}

function parseIsoDate(value) {
    const match = BIRTH_DATE_RE.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return { year, month, day };
}

// Confere a data informada. Devolve { ok: true, value } ou { ok: false, error, field }.
// Vazio é aceito quando não é obrigatório (value: '').
function checkBirthDate(value, { required = false, today = todayIso() } = {}) {
    const text = typeof value === 'string' ? value.trim() : (value === undefined || value === null ? '' : String(value).trim());
    if (!text) {
        return required
            ? { ok: false, error: 'Informe a data de nascimento.', field: 'birthDate' }
            : { ok: true, value: '' };
    }
    if (!parseIsoDate(text)) return { ok: false, error: 'Data de nascimento inválida. Informe dia, mês e ano.', field: 'birthDate' };
    if (text < MIN_BIRTH_DATE) return { ok: false, error: 'Data de nascimento inválida. Confira o ano.', field: 'birthDate' };
    if (text > today) return { ok: false, error: 'A data de nascimento não pode ser depois de hoje.', field: 'birthDate' };
    return { ok: true, value: text };
}

// A data gravada vale? (cadastro antigo pode ter qualquer coisa ou nada)
function hasValidBirthDate(student, { today = todayIso() } = {}) {
    if (!student || typeof student.birthDate !== 'string') return false;
    return checkBirthDate(student.birthDate, { required: true, today }).ok;
}

// Idade em anos completos na data de hoje, ou null sem data válida.
function ageOn(birthDate, today = todayIso()) {
    const birth = parseIsoDate(birthDate);
    const now = parseIsoDate(today);
    if (!birth || !now) return null;
    let age = now.year - birth.year;
    if (now.month < birth.month || (now.month === birth.month && now.day < birth.day)) age -= 1;
    return age;
}

// Menor de 18 anos (só quando a data é conhecida).
function isMinorBirthDate(birthDate, today = todayIso()) {
    const age = ageOn(birthDate, today);
    return age !== null && age < ADULT_AGE;
}

module.exports = {
    MIN_BIRTH_DATE,
    ADULT_AGE,
    todayIso,
    checkBirthDate,
    hasValidBirthDate,
    ageOn,
    isMinorBirthDate,
};
