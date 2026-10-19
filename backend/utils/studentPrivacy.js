// SEG-04: o texto de acessibilidade do aluno (accessibility.observacao) pode trazer laudo
// ou diagnóstico e só o administrador o vê. O professor recebe o necessário para a
// acomodação (tempo extra e recursos) e a indicação de que existe uma observação restrita.
//
// O cadastro do aluno também viaja copiado dentro das entregas (sub.student), das cópias
// da lixeira de notas e dos registros de auditoria; por isso a máscara não fica rota a
// rota: toda resposta JSON de uma rota de instrutor passa por redactSensitiveStudentPayload
// quando a conta é de professor (installProfessorResponseRedaction em validateAdmin).
const { isProfessorAccount } = require('./adminPermissions.js');

const MAX_DEPTH = 64;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function hasRestrictedAccessibilityNote(value) {
    return isPlainObject(value)
        && isPlainObject(value.accessibility)
        && Object.prototype.hasOwnProperty.call(value.accessibility, 'observacao')
        && value.accessibility.observacao !== '';
}

// Uma ficha de aluno (cadastro ou cópia dentro de uma entrega) sem o texto restrito.
// Idempotente: aplicada duas vezes, continua dizendo que há observação restrita.
function maskStudentRecord(student) {
    if (!isPlainObject(student) || !isPlainObject(student.accessibility)) return student;
    const { observacao, ...accommodation } = student.accessibility;
    return {
        ...student,
        accessibility: { ...accommodation, observacao: '' },
        accessibilityNoteRestricted: !!String(observacao || '').trim() || student.accessibilityNoteRestricted === true,
    };
}

function redactSensitiveStudentData(student, account) {
    if (!isProfessorAccount(account)) return student;
    return maskStudentRecord(student);
}

// Percorre a resposta e mascara toda ficha de aluno que tenha o texto de acessibilidade.
// Só copia o caminho que mudou; o restante é o mesmo objeto (nada do banco em memória
// é alterado).
function redactSensitiveStudentPayload(value, depth = 0) {
    if (depth > MAX_DEPTH || !value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        let changed = null;
        for (let i = 0; i < value.length; i += 1) {
            const next = redactSensitiveStudentPayload(value[i], depth + 1);
            if (next !== value[i]) {
                if (!changed) changed = value.slice();
                changed[i] = next;
            }
        }
        return changed || value;
    }
    if (!isPlainObject(value)) return value;
    let current = hasRestrictedAccessibilityNote(value) ? maskStudentRecord(value) : value;
    let changed = current !== value ? current : null;
    for (const key of Object.keys(current)) {
        const child = current[key];
        if (!child || typeof child !== 'object') continue;
        const next = redactSensitiveStudentPayload(child, depth + 1);
        if (next !== child) {
            if (!changed) changed = { ...current };
            changed[key] = next;
        }
    }
    return changed || value;
}

function installProfessorResponseRedaction(res, account) {
    if (!res || !isProfessorAccount(account) || res.__studentPrivacyRedaction) return;
    res.__studentPrivacyRedaction = true;
    const originalJson = res.json.bind(res);
    res.json = body => originalJson(redactSensitiveStudentPayload(body));
}

module.exports = {
    redactSensitiveStudentData,
    redactSensitiveStudentPayload,
    installProfessorResponseRedaction,
};
