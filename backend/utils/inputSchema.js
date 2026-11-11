// Validação do corpo dos pedidos por schema (fase 2, H9b: ENG-03), sem pacote novo.
// Cada rota declara o tipo e o tamanho dos campos que lê; o pedido com um campo de tipo
// errado ou grande demais recebe 400 { success:false, error, field } (field é o nome do
// campo enviado; dentro de um objeto, com ponto: 'guardian.name'; numa lista, com o
// índice: 'events[3]'). Antes cada rota conferia do seu jeito: um número no lugar de um
// texto derrubava a rota com 500 ('email.trim is not a function') e o aluno gravava
// textos enormes que pesavam a sala inteira.
//
// Regras (desenho do H9):
// - O schema confere tipo e tamanho. A presença do campo continua com a rota, com as
//   mensagens de sempre (os testes da fase 1 conferem esses textos); `required: true`
//   só onde a rota não tinha mensagem própria.
// - Campo não declarado fica como veio. Campo ausente (undefined) passa; null só passa
//   com `nullable: true`.
// - Texto é aparado (trim) por padrão, e o texto aparado volta para req.body; senha e
//   anotação usam `trim: false`. O tamanho é o .length do texto (como o maxLength do
//   navegador), contado depois de aparar.
// - Número que a tela manda como texto usa `coerce: true` (o número volta para req.body).
//
// Uso:
//   const { body, str, int } = require('../utils/inputSchema.js');
//   router.post('/rota', validateStudentSession, body({ moduleKey: str({ max: 200, label: 'unidade' }) }), handler);
//   // Dentro do callback de validateAdmin (a sessão é conferida antes): if (!SCHEMA.check(req, res)) return;
const { isInheritedKey } = require('./ownEntry.js');

const BODY_FORMAT_ERROR = 'Dados enviados em formato inválido.';

// Milhar em pt-BR (50.000), igual em qualquer instalação do Node (sem depender do ICU).
function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    const [whole, fraction] = String(Math.abs(number)).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${number < 0 ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
}

const MESSAGES = {
    invalid: label => `O campo "${label}" está em formato inválido.`,
    required: label => `O campo "${label}" é obrigatório.`,
    maxChars: (label, max) => `O campo "${label}" aceita no máximo ${formatCount(max)} caracteres.`,
    maxItems: (label, max) => `O campo "${label}" aceita no máximo ${formatCount(max)} itens.`,
    notAllowed: label => `O campo "${label}" tem um valor não permitido.`,
    range: (label, min, max) => `O campo "${label}" deve estar entre ${formatCount(min)} e ${formatCount(max)}.`,
    pattern: label => `O campo "${label}" tem caracteres não permitidos.`,
};

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function fail(field, error) {
    return { ok: false, field, error };
}

function pass(value) {
    return { ok: true, value };
}

// Cada construtor devolve um validador { kind, options, run(value, field, label) }.
// run devolve { ok: true, value } (o valor normalizado) ou { ok: false, field, error }.
// undefined e null são tratados aqui, igual para todos os tipos. Opção comum a todos:
// `typeMessage`, a mensagem do tipo errado quando a rota já tinha uma (login).
function validator(kind, options, check) {
    const opts = options || {};
    return {
        kind,
        options: opts,
        run(value, field, fallbackLabel) {
            const label = opts.label || fallbackLabel || field;
            if (value === undefined) return opts.required ? fail(field, MESSAGES.required(label)) : pass(undefined);
            if (value === null) {
                if (opts.nullable) return pass(null);
                return fail(field, opts.required ? MESSAGES.required(label) : (opts.typeMessage || MESSAGES.invalid(label)));
            }
            const result = check(value, field, label, opts);
            // typeMessage: a mensagem que a rota já dava para o tipo errado (login).
            if (!result.ok && opts.typeMessage && result.field === field && result.error === MESSAGES.invalid(label)) {
                return fail(field, opts.typeMessage);
            }
            return result;
        },
    };
}

// Texto: { max, min, trim = true, pattern, nullable, required, label }.
function str(options = {}) {
    return validator('str', options, (value, field, label, opts) => {
        if (typeof value !== 'string') return fail(field, MESSAGES.invalid(label));
        const text = opts.trim === false ? value : value.trim();
        if (!text) return opts.required || (opts.min && opts.min > 0) ? fail(field, MESSAGES.required(label)) : pass(text);
        if (opts.max !== undefined && text.length > opts.max) return fail(field, MESSAGES.maxChars(label, opts.max));
        if (opts.min !== undefined && text.length < opts.min) return fail(field, MESSAGES.invalid(label));
        if (opts.pattern) {
            opts.pattern.lastIndex = 0;
            if (!opts.pattern.test(text)) return fail(field, MESSAGES.pattern(label));
        }
        return pass(text);
    });
}

function numberCheck(integer) {
    return (value, field, label, opts) => {
        let number = value;
        if (opts.coerce && typeof value === 'string') {
            const text = value.trim();
            const shape = integer ? /^-?\d{1,15}$/ : /^-?(?:\d{1,15}(?:\.\d+)?|\.\d+)$/;
            if (!shape.test(text)) return fail(field, MESSAGES.invalid(label));
            number = Number(text);
        }
        if (typeof number !== 'number' || !Number.isFinite(number)) return fail(field, MESSAGES.invalid(label));
        if (integer && !Number.isSafeInteger(number)) return fail(field, MESSAGES.invalid(label));
        const min = opts.min === undefined ? -Infinity : opts.min;
        const max = opts.max === undefined ? Infinity : opts.max;
        if (number < min || number > max) {
            return fail(field, MESSAGES.range(label, opts.min === undefined ? Number.MIN_SAFE_INTEGER : opts.min, opts.max === undefined ? Number.MAX_SAFE_INTEGER : opts.max));
        }
        return pass(number);
    };
}

// Inteiro: { min, max, coerce, nullable, required, label }.
function int(options = {}) {
    return validator('int', options, numberCheck(true));
}

// Número (com casas decimais): { min, max, coerce, nullable, required, label }.
function num(options = {}) {
    return validator('num', options, numberCheck(false));
}

// Verdadeiro ou falso (true/false de JSON, nunca o texto 'true').
function bool(options = {}) {
    return validator('bool', options, (value, field, label) => (
        typeof value === 'boolean' ? pass(value) : fail(field, MESSAGES.invalid(label))
    ));
}

// Um dos valores da lista. Texto é aparado antes; o texto vazio conta como ausente.
function oneOf(values, options = {}) {
    const allowed = Array.isArray(values) ? values : [];
    const onlyText = allowed.every(item => typeof item === 'string');
    return validator('oneOf', options, (value, field, label, opts) => {
        const candidate = typeof value === 'string' ? value.trim() : value;
        if (candidate === '' && opts.required) return fail(field, MESSAGES.required(label));
        if (candidate === '' && !allowed.includes('')) return pass(candidate);
        if (onlyText && typeof candidate !== 'string') return fail(field, MESSAGES.invalid(label));
        return allowed.includes(candidate) ? pass(candidate) : fail(field, MESSAGES.notAllowed(label));
    });
}

// Lista: list(item, { max, label, nullable, required }). Cada item passa pelo validador
// `item` (null e undefined dentro da lista seguem as regras dele).
function list(item, options = {}) {
    return validator('list', options, (value, field, label, opts) => {
        if (!Array.isArray(value)) return fail(field, MESSAGES.invalid(label));
        if (opts.max !== undefined && value.length > opts.max) return fail(field, MESSAGES.maxItems(label, opts.max));
        if (!item) return pass(value);
        const out = new Array(value.length);
        for (let index = 0; index < value.length; index++) {
            const result = item.run(value[index], `${field}[${index}]`, label);
            if (!result.ok) return result;
            out[index] = result.value;
        }
        return pass(out);
    });
}

// Valida os campos declarados de um objeto e grava de volta neles o valor normalizado
// (texto aparado, número convertido). Campo não declarado fica como veio.
function checkFields(target, fields, prefix) {
    for (const [name, rule] of Object.entries(fields || {})) {
        if (!rule || typeof rule.run !== 'function') continue;
        const has = Object.prototype.hasOwnProperty.call(target, name);
        const raw = has ? target[name] : undefined;
        const result = rule.run(raw, prefix ? `${prefix}.${name}` : name, name);
        if (!result.ok) return result;
        if (has && result.value !== raw) target[name] = result.value;
    }
    return null;
}

// Objeto simples (não lista) com os campos declarados: shape(fields, { label, nullable, required }).
// shape({}) aceita qualquer objeto simples.
function shape(fields, options = {}) {
    return validator('shape', options, (value, field, label) => {
        if (!isPlainObject(value)) return fail(field, MESSAGES.invalid(label));
        const problem = checkFields(value, fields, field);
        return problem || pass(value);
    });
}

// Nome de uma chave do mapa no `field` da resposta: 'completedUnits.a' dentro de um
// campo, ou só a chave quando o mapa é o próprio corpo (preferências). Chave longa demais
// para ecoar (mais de 200 caracteres) fica com o nome do mapa, ou com o começo dela.
const MAX_ECHOED_KEY = 200;
function keyFieldName(field, key) {
    if (key.length > MAX_ECHOED_KEY) return field || key.slice(0, MAX_ECHOED_KEY);
    return field ? `${field}.${key}` : key;
}

// Mapa de chave para valor: dict(value, { maxKeys, keyPattern, keyMax, label, nullable, required }).
// Chave herdada de Object.prototype ('__proto__', 'constructor') nunca passa. A recusa
// aponta no `field` a chave enviada: a que tem caracteres não permitidos, ou a primeira
// além do limite de chaves.
function dict(value, options = {}) {
    return validator('dict', options, (raw, field, label, opts) => {
        if (!isPlainObject(raw)) return fail(field, MESSAGES.invalid(label));
        const keys = Object.keys(raw);
        if (opts.maxKeys !== undefined && keys.length > opts.maxKeys) {
            return fail(keyFieldName(field, keys[opts.maxKeys]), MESSAGES.maxItems(label, opts.maxKeys));
        }
        for (const key of keys) {
            const keyField = keyFieldName(field, key);
            if (isInheritedKey(key)) return fail(keyField, MESSAGES.pattern(label));
            if (opts.keyMax !== undefined && key.length > opts.keyMax) return fail(keyField, MESSAGES.pattern(label));
            if (opts.keyPattern) {
                opts.keyPattern.lastIndex = 0;
                if (!opts.keyPattern.test(key)) return fail(keyField, MESSAGES.pattern(label));
            }
            if (!value) continue;
            const result = value.run(raw[key], keyField, label);
            if (!result.ok) return result;
            if (result.value !== raw[key]) raw[key] = result.value;
        }
        return pass(raw);
    });
}

// O primeiro dos validadores que aceitar o valor (por exemplo, texto ou número). Se
// nenhum aceitar, a mensagem é a do primeiro que reconhece o tipo, ou "formato inválido".
function either(validators, options = {}) {
    const choices = Array.isArray(validators) ? validators : [];
    return validator('either', options, (value, field, label) => {
        let firstProblem = null;
        for (const choice of choices) {
            const result = choice.run(value, field, label);
            if (result.ok) return result;
            if (!firstProblem && result.error !== MESSAGES.invalid(choice.options.label || label)) firstProblem = result;
        }
        return firstProblem || fail(field, MESSAGES.invalid(label));
    });
}

// Middleware do corpo: body({ campo: str(...), ... }). Exige corpo de objeto simples (uma
// lista ou um texto solto recebe 400 'Dados enviados em formato inválido.'). O próprio
// middleware tem .check(req, res): devolve true com o corpo certo; senão já respondeu o
// 400 e devolve false (para usar dentro do callback de validateAdmin).
function body(fields) {
    const check = (req, res) => {
        if (!isPlainObject(req.body)) {
            res.status(400).json({ success: false, error: BODY_FORMAT_ERROR });
            return false;
        }
        const problem = checkFields(req.body, fields, '');
        if (problem) {
            res.status(400).json({ success: false, error: problem.error, field: problem.field });
            return false;
        }
        return true;
    };
    const middleware = (req, res, next) => (check(req, res) ? next() : undefined);
    middleware.check = check;
    middleware.fields = fields;
    return middleware;
}

// Chave de unidade, tópico ou caderno (apostilaKey, 'geral'): letras (com acento),
// números, espaço, _ . : e -, até 200 caracteres.
const KEY_PATTERN = /^[\p{L}\p{N} _.:-]{1,200}$/u;

module.exports = {
    BODY_FORMAT_ERROR,
    KEY_PATTERN,
    MESSAGES,
    body,
    bool,
    dict,
    either,
    formatCount,
    int,
    isPlainObject,
    list,
    num,
    oneOf,
    shape,
    str,
};
