// Hora da escola (fundação C0b da fase 3; K7 e K21 do plano).
//
// Toda conta de "dia" e de "prazo" no fuso da escola (settings.timezone) sai daqui:
// tarefas (opensAt, dueAt, closeAt e prorrogações), agenda de prova e de material, dias
// não letivos e diário. Ninguém cria outra conta de fuso.
//
// - deadlineFromLocal(data, hora, fuso): o que o professor digitou ('2026-11-20' e
//   '23:59', no relógio da escola) vira instante em ms, o formato dos registros. Hora
//   que não existe por causa do horário de verão (o relógio pula de 00:00 para 01:00)
//   vale o mesmo tanto depois do pulo (00:30 vira 01:30); hora que acontece duas vezes
//   (o relógio volta) vale a primeira. É a regra 'compatible' do Temporal, a mesma das
//   agendas de calendário. Entrada inválida (data que não existe, hora fora de 00:00 a
//   23:59, fuso que o Intl não conhece) devolve null: quem chama recusa com 400.
// - schoolDateOf(ms, fuso): a data civil 'AAAA-MM-DD' daquele instante no fuso da
//   escola; com o instante de agora é o mesmo que settings.todayInTz (teste).
// - localParts(ms, fuso): data, hora 'HH:MM', ano, mês, dia, hora, minuto, segundo e dia
//   da semana (0 = domingo) no fuso da escola.
//
// Sem fuso informado vale o das configurações (settings.getSettings().timezone, que já
// troca nome desconhecido pelo padrão America/Sao_Paulo). Funções puras quanto ao
// relógio: o instante vem sempre de quem chama (teste injeta a hora).
const settingsUtil = require('./settings.js');

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Formatadores guardados por fuso (o Intl é caro de criar; poucos fusos por vez).
const formatters = new Map();
function partsFormatter(timeZone) {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            weekday: 'short',
        });
        if (formatters.size >= 64) formatters.clear();
        formatters.set(timeZone, formatter);
    }
    return formatter;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Fuso da escola: o informado, se o Intl o conhece; senão o das configurações.
function schoolTimezone(timezone) {
    if (typeof timezone === 'string' && settingsUtil.isValidTimeZone(timezone.trim())) return timezone.trim();
    return settingsUtil.getSettings().timezone;
}

function toMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) {
        const text = value.trim();
        return /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    }
    return NaN;
}

const pad2 = value => String(value).padStart(2, '0');

// Partes do instante no fuso. null para instante inválido.
function localParts(ms, timezone) {
    const time = toMs(ms);
    if (!Number.isFinite(time)) return null;
    const zone = schoolTimezone(timezone);
    const raw = {};
    partsFormatter(zone).formatToParts(new Date(time)).forEach(part => { raw[part.type] = part.value; });
    const year = Number(raw.year);
    const month = Number(raw.month);
    const day = Number(raw.day);
    const hour = Number(raw.hour) % 24;
    const minute = Number(raw.minute);
    const second = Number(raw.second);
    return {
        date: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
        time: `${pad2(hour)}:${pad2(minute)}`,
        year,
        month,
        day,
        hour,
        minute,
        second,
        weekday: WEEKDAYS[raw.weekday] ?? new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
        timezone: zone,
    };
}

// Data civil 'AAAA-MM-DD' do instante no fuso da escola. null para instante inválido.
function schoolDateOf(ms, timezone) {
    const parts = localParts(ms, timezone);
    return parts ? parts.date : null;
}

// Diferença do fuso naquele instante: hora local - UTC, em ms (São Paulo: -3 h).
function offsetAt(ms, timezone) {
    const parts = localParts(ms, timezone);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return asUtc - (Math.floor(ms / 1000) * 1000);
}

function parseLocalDate(date) {
    const match = DATE_PATTERN.exec(String(date || '').trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { year, month, day };
}

function parseLocalTime(time) {
    const match = TIME_PATTERN.exec(String(time || '').trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] === undefined ? 0 : Number(match[3]);
    if (hour > 23 || minute > 59 || second > 59) return null;
    return { hour, minute, second };
}

function isValidLocalDate(date) {
    return parseLocalDate(date) !== null;
}

function isValidLocalTime(time) {
    return parseLocalTime(time) !== null;
}

// Data + hora digitadas no relógio da escola -> instante em ms (ver o começo do arquivo).
function deadlineFromLocal(date, time, timezone) {
    const day = parseLocalDate(date);
    const clock = parseLocalTime(time);
    if (!day || !clock) return null;
    if (timezone !== undefined && timezone !== null && timezone !== '' && !settingsUtil.isValidTimeZone(String(timezone).trim())) return null;
    const zone = schoolTimezone(timezone);
    // A hora digitada como se fosse UTC; o instante certo é ela menos a diferença do fuso.
    const wall = Date.UTC(day.year, day.month - 1, day.day, clock.hour, clock.minute, clock.second);
    // As diferenças possíveis em volta (no máximo uma troca de horário por dia).
    const offsets = [...new Set([wall - DAY_MS, wall, wall + DAY_MS].map(at => offsetAt(at, zone)))];
    const matches = offsets
        .map(offset => wall - offset)
        .filter(candidate => offsetAt(candidate, zone) === wall - candidate);
    if (matches.length) return Math.min(...matches);
    // A hora caiu no pulo do horário de verão: vale com a diferença de antes do pulo,
    // que é a menor (o relógio adiantou), e cai o mesmo tanto depois do pulo.
    return wall - Math.min(...offsets);
}

module.exports = {
    deadlineFromLocal,
    schoolDateOf,
    localParts,
    schoolTimezone,
    isValidLocalDate,
    isValidLocalTime,
};
