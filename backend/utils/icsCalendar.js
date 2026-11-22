// Agenda em .ics (iCalendar, RFC 5545; fase 3, B3 / P2-S5, FUN-15), sem pacote: o
// professor e o aluno baixam o calendário da turma e importam no Google Agenda, no
// Outlook ou no celular, sem precisar de internet na escola.
//
// buildIcs({ nome, eventos, timezone, now }) devolve o texto do arquivo:
// - linhas terminadas em CRLF e dobradas em 75 octetos (a continuação começa com um
//   espaço), sem partir uma letra acentuada no meio;
// - texto com '\', ';', ',' e quebra de linha escapados (\\, \;, \, e \n);
// - evento de dia inteiro (sem hora, como o dia não letivo): DTSTART;VALUE=DATE e
//   DTEND;VALUE=DATE no dia seguinte ao último (o fim é exclusivo na RFC);
// - evento com hora: DTSTART e DTEND em UTC ('Z'), a partir da data e da hora no relógio
//   da escola (schoolTime.deadlineFromLocal no fuso das configurações); sem hora de fim
//   (ou com ela antes do início), dura 1 hora;
// - UID estável (o id do evento + '@iclass'): importar de novo atualiza em vez de
//   duplicar.
// Cada evento: { uid, titulo, descricao?, data 'AAAA-MM-DD', dataFim?, inicio?, fim?,
// categoria? }.
const schoolTime = require('./schoolTime.js');

const CRLF = '\r\n';
const MAX_OCTETS = 75;
const HOUR_MS = 60 * 60 * 1000;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Texto do iCalendar: sem caractere de controle, com os quatro escapes da RFC.
function escapeText(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

// Dobra a linha em pedaços de até 75 octetos (UTF-8), sem partir um caractere.
function foldLine(line) {
    const chars = Array.from(String(line));
    const parts = [];
    let current = '';
    let size = 0;
    let limit = MAX_OCTETS;
    chars.forEach(char => {
        const bytes = Buffer.byteLength(char, 'utf8');
        if (size + bytes > limit) {
            parts.push(current);
            current = '';
            size = 0;
            limit = MAX_OCTETS - 1; // a continuação começa com um espaço
        }
        current += char;
        size += bytes;
    });
    parts.push(current);
    return parts.join(`${CRLF} `);
}

function dateValue(date) {
    return String(date).replace(/-/g, '');
}

function nextDay(date) {
    const match = YMD_RE.exec(String(date || ''));
    const value = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
    return value.toISOString().slice(0, 10);
}

function utcValue(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function eventLines(event, { timezone, stamp }) {
    const data = String(event.data || '');
    if (!YMD_RE.test(data)) return [];
    const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}@iclass`, `DTSTAMP:${stamp}`];
    const inicio = HHMM_RE.test(String(event.inicio || '')) ? event.inicio : '';
    const start = inicio ? schoolTime.deadlineFromLocal(data, inicio, timezone) : null;
    if (start !== null && start !== undefined) {
        const fimHora = HHMM_RE.test(String(event.fim || '')) ? event.fim : '';
        let end = fimHora ? schoolTime.deadlineFromLocal(data, fimHora, timezone) : null;
        if (end === null || end === undefined || end <= start) end = start + HOUR_MS;
        lines.push(`DTSTART:${utcValue(start)}`, `DTEND:${utcValue(end)}`);
    } else {
        const last = YMD_RE.test(String(event.dataFim || '')) && event.dataFim > data ? event.dataFim : data;
        lines.push(`DTSTART;VALUE=DATE:${dateValue(data)}`, `DTEND;VALUE=DATE:${dateValue(nextDay(last))}`);
        // Dia inteiro sem aula não ocupa a agenda de quem importa.
        lines.push('TRANSP:TRANSPARENT');
    }
    lines.push(`SUMMARY:${escapeText(event.titulo || 'Evento')}`);
    if (event.descricao) lines.push(`DESCRIPTION:${escapeText(event.descricao)}`);
    if (event.categoria) lines.push(`CATEGORIES:${escapeText(event.categoria)}`);
    lines.push('END:VEVENT');
    return lines;
}

function buildIcs({ nome = 'IClass', eventos = [], timezone, now = Date.now() } = {}) {
    const zone = schoolTime.schoolTimezone(timezone);
    const stamp = utcValue(now);
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//IClass//Agenda da turma//PT-BR',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        `X-WR-CALNAME:${escapeText(nome)}`,
        `X-WR-TIMEZONE:${escapeText(zone)}`,
    ];
    (Array.isArray(eventos) ? eventos : []).forEach(event => {
        if (event && typeof event === 'object') lines.push(...eventLines(event, { timezone: zone, stamp }));
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join(CRLF) + CRLF;
}

// Nome de arquivo seguro: 'agenda-<curso>-<turma>.ics' sem acento nem espaço.
function icsFileName(...parts) {
    const slug = parts
        .map(part => String(part || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
        .filter(Boolean)
        .join('-')
        .slice(0, 80);
    return `agenda${slug ? `-${slug}` : ''}.ics`;
}

// Eventos do calendário (no formato de calendar-events ou do painel) para o buildIcs.
function calendarEventToIcs(item) {
    if (!item || typeof item !== 'object') return null;
    return {
        uid: item.id,
        titulo: item.title,
        descricao: item.description || item.message || '',
        data: item.eventDate,
        dataFim: item.endDate || '',
        inicio: item.startTime || '',
        fim: item.endTime || '',
        categoria: item.eventType === 'nao_letivo' ? 'Sem aula' : '',
    };
}

module.exports = { buildIcs, escapeText, foldLine, icsFileName, calendarEventToIcs };
