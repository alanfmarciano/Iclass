// Busca e ordem de texto no servidor (fase 3, CRIT-07): a mesma regra da tela
// (web/src/lib/textSearch.js). Substitui as cópias que normalizavam texto em
// utils/students.js (situação do aluno) e routes/adminAudit.js (filtros da Auditoria).
//
// - normalizeSearch(valor): texto sem acento, em minúsculas e com os espaços juntados;
//   null e undefined viram ''.
// - matchesSearch(valores, termo): todas as palavras do termo, cada uma em qualquer um
//   dos valores; termo vazio casa com tudo.
// - compareText(a, b): ordem alfabética do português (Intl.Collator 'pt-BR', sem
//   diferenciar acento nem maiúscula, números em ordem natural). O Node 20 do Windows
//   traz o ICU completo, então a ordem é a mesma da tela.
// - compareOrdinal(a, b): ordem pelo código dos caracteres (chaves, datas ISO).
//
// O teste test/backend/text-search.test.js confere que os dois lados dão o mesmo
// resultado no mesmo quadro de casos.

const DIACRITICS = /[̀-ͯ]/g;
const SPACES = /\s+/g;

function plainText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'bigint') return String(value);
    if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(' ');
    return '';
}

function normalizeSearch(value) {
    return plainText(value).normalize('NFD').replace(DIACRITICS, '').toLowerCase().replace(SPACES, ' ').trim();
}

function searchTerms(term) {
    const text = normalizeSearch(term);
    return text ? [...new Set(text.split(' '))] : [];
}

function matchesSearch(values, term) {
    const words = searchTerms(term);
    if (!words.length) return true;
    const list = Array.isArray(values) ? values : [values];
    const haystack = list.map(normalizeSearch).filter(Boolean);
    if (!haystack.length) return false;
    return words.every(word => haystack.some(text => text.includes(word)));
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

function compareText(a, b) {
    return collator.compare(plainText(a), plainText(b));
}

function compareOrdinal(a, b) {
    const left = plainText(a);
    const right = plainText(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

module.exports = {
    normalizeSearch,
    searchTerms,
    matchesSearch,
    compareText,
    compareOrdinal,
};
