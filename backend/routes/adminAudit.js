// Tela Auditoria e exportação da trilha em CSV (H7a-2; SEG-07, FUN-04).
//
// GET /api/admin/audit: a trilha inteira (auditLogs), lida por normalizeAuditEntry (os
// quatro formatos antigos e o canônico), do mais novo para o mais antigo, com filtros e
// paginação no servidor. GET /api/admin/audit/export: os mesmos filtros, em CSV no padrão
// do Excel pt-BR (BOM UTF-8, ';', fórmula neutralizada), com registro audit_exported.
//
// Só o administrador (permissão audit.view, decisão P5 da fase 2): a trilha mostra IP,
// ações de conta e o que os outros professores fizeram. O professor continua vendo o
// histórico de cada nota em Resultados.
//
// Só lê a trilha: nenhuma entrada gravada muda aqui.
const express = require('express');
const db = require('../database.js');
const { validateAdminPermission } = require('../middlewares.js');
const {
    AUDIT_CATEGORIES,
    CATEGORY_LABELS,
    auditEntryWithoutSecrets,
    auditTimestamp,
    normalizeAuditEntry,
    recordAudit,
} = require('../utils/audit.js');
const { buildCsv, examTitle } = require('../utils/gradebook.js');
const settingsUtil = require('../utils/settings.js');

const AUDIT_PAGE_DEFAULT = 100;
const AUDIT_PAGE_MAX = 500;
const AUDIT_EXPORT_MAX = 50000;
const AUDIT_EXPORT_TOO_LARGE = 'Filtre por período: a exportação tem mais de 50.000 eventos.';
// Teto de cada lista de opções dos filtros (quem fez, provas, aplicações).
const FACET_MAX = 500;
// Texto de uma célula de Antes/Depois no CSV (o Excel aceita até 32.767 por célula).
const CSV_VALUE_MAX = 2000;

// Filtros de texto aceitos na query (todos opcionais).
const TEXT_FILTERS = ['actor', 'student', 'category', 'action', 'courseId', 'studentClass', 'examKey', 'applicationId', 'q'];

// Texto para comparar sem diferenciar maiúscula nem acento.
function fold(value) {
    return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ------------------------------------------------------------ datas
// 'AAAA-MM-DD' de verdade (mês e dia que existem), ou null.
function parseDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    return { year, month, day };
}

// Diferença (ms) entre a hora local do fuso e o UTC num instante.
const zoneFormatters = new Map();
function zoneFormatter(timeZone) {
    if (!zoneFormatters.has(timeZone)) {
        let formatter = null;
        try {
            formatter = new Intl.DateTimeFormat('en-US', {
                timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            });
        } catch (error) { formatter = null; }
        zoneFormatters.set(timeZone, formatter);
    }
    return zoneFormatters.get(timeZone);
}

// Fuso das datas da auditoria: o das configurações. getSettings já troca o nome que o
// Intl não conhece pelo padrão (America/Sao_Paulo); a conferência aqui é a segunda
// linha de defesa, porque uma data formatada com fuso inválido derrubava a tela inteira
// (as opções dos filtros saem junto com a primeira página).
function auditTimeZone() {
    const timeZone = settingsUtil.getSettings().timezone;
    return zoneFormatter(timeZone) ? timeZone : settingsUtil.DEFAULTS.timezone;
}

function zoneOffsetMs(instant, timeZone) {
    const formatter = zoneFormatter(timeZone);
    if (!formatter) return 0;
    const parts = {};
    formatter.formatToParts(new Date(instant)).forEach(part => { parts[part.type] = part.value; });
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(instant / 1000) * 1000;
}

// Instante (ms) da meia-noite de um dia no fuso das configurações. Duas passadas para
// acertar o dia em que o fuso muda de horário.
function zonedDayStart({ year, month, day }, timeZone) {
    const guess = Date.UTC(year, month - 1, day);
    let instant = guess - zoneOffsetMs(guess, timeZone);
    instant = guess - zoneOffsetMs(instant, timeZone);
    return instant;
}

function nextDay({ year, month, day }) {
    const date = new Date(Date.UTC(year, month - 1, day + 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// ------------------------------------------------------------ filtros
function badFilter(error, field) {
    return { ok: false, body: { success: false, error, field } };
}

// Lê a query: período (from e to, AAAA-MM-DD no fuso das configurações, os dois dias
// inclusive), filtros de texto e a página. Data inválida responde 400.
function parseAuditQuery(query = {}, { timeZone } = {}) {
    const filters = {};
    TEXT_FILTERS.forEach(name => {
        const value = String(query[name] ?? '').trim().slice(0, 200);
        if (value) filters[name] = value;
    });
    let fromMs = null;
    let toMs = null;
    const fromText = String(query.from ?? '').trim();
    const toText = String(query.to ?? '').trim();
    if (fromText) {
        const day = parseDay(fromText);
        if (!day) return badFilter('Data inicial inválida: use o formato AAAA-MM-DD.', 'from');
        fromMs = zonedDayStart(day, timeZone);
        filters.from = fromText;
    }
    if (toText) {
        const day = parseDay(toText);
        if (!day) return badFilter('Data final inválida: use o formato AAAA-MM-DD.', 'to');
        toMs = zonedDayStart(nextDay(day), timeZone);
        filters.to = toText;
    }
    if (fromMs !== null && toMs !== null && fromMs >= toMs) return badFilter('A data inicial é depois da data final.', 'from');
    if (filters.category && !AUDIT_CATEGORIES.includes(filters.category)) return badFilter('Categoria de auditoria desconhecida.', 'category');
    const offset = Math.max(0, Number.parseInt(query.offset, 10) || 0);
    const requestedLimit = Number.parseInt(query.limit, 10);
    const limit = Math.min(AUDIT_PAGE_MAX, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : AUDIT_PAGE_DEFAULT));
    return { ok: true, filters, fromMs, toMs, offset, limit };
}

// ------------------------------------------------------------ nomes
// Nomes de quem aparece na trilha, resolvidos na leitura: alunos (nome social antes) e
// contas de acesso. A entrada guarda só o e-mail.
function buildNameIndex(memory) {
    const names = new Map();
    (memory.admins || []).forEach(account => {
        const email = String((account && account.email) || '').trim().toLowerCase();
        if (email && account.name) names.set(email, String(account.name));
    });
    (memory.students || []).forEach(student => {
        const email = String((student && student.email) || '').trim().toLowerCase();
        const name = String((student && ((student.nomeSocial && String(student.nomeSocial).trim()) || student.name)) || '').trim();
        if (email && name && !names.has(email)) names.set(email, name);
    });
    return names;
}

function personName(names, email) {
    const key = String(email || '').trim().toLowerCase();
    return key ? names.get(key) || '' : '';
}

// Filtro de pessoa: com '@' é o e-mail exato; sem, um pedaço do e-mail ou do nome.
function matchesPerson(filter, email, name) {
    if (!filter) return true;
    const wanted = fold(filter);
    if (wanted.includes('@')) return fold(email) === wanted;
    return fold(email).includes(wanted) || fold(name).includes(wanted);
}

function valueText(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
}

function sameClass(left, right) {
    return fold(left) === fold(right);
}

// A entrada (normalizada) passa nos filtros?
function entryMatches(item, filters, names) {
    if (filters.category && item.category !== filters.category) return false;
    if (filters.action && item.action !== filters.action) return false;
    if (filters.courseId && String(item.courseId || '') !== filters.courseId) return false;
    if (filters.studentClass && !sameClass(item.studentClass, filters.studentClass)) return false;
    if (filters.examKey && String(item.examKey || '') !== filters.examKey) return false;
    if (filters.applicationId && String(item.applicationId || '') !== filters.applicationId) return false;
    if (filters.actor && !matchesPerson(filters.actor, item.actor, personName(names, item.actor))) return false;
    if (filters.student && !matchesPerson(filters.student, item.studentEmail, personName(names, item.studentEmail))) return false;
    if (filters.q) {
        const wanted = fold(filters.q);
        const haystack = [
            item.label, item.field, valueText(item.oldValue), valueText(item.newValue), item.reason,
            item.actor, personName(names, item.actor), item.studentEmail, personName(names, item.studentEmail), item.targetEmail,
        ].map(fold).join('\n');
        if (!haystack.includes(wanted)) return false;
    }
    return true;
}

function rawTimestamp(raw) {
    return auditTimestamp(raw.timestamp !== undefined && raw.timestamp !== null && raw.timestamp !== '' ? raw.timestamp : raw.at);
}

// Entradas que passam nos filtros, do mais nova para a mais antiga (mesma hora: a que
// entrou depois na trilha primeiro). Devolve as entradas normalizadas.
function filterAuditTrail(memory, parsed, names) {
    const { filters, fromMs, toMs } = parsed;
    const needsContent = TEXT_FILTERS.some(name => filters[name]);
    const list = Array.isArray(memory.auditLogs) ? memory.auditLogs : [];
    const matched = [];
    for (let index = 0; index < list.length; index += 1) {
        const raw = list[index];
        if (!isPlainObject(raw)) continue;
        const time = rawTimestamp(raw);
        if (fromMs !== null && time < fromMs) continue;
        if (toMs !== null && time >= toMs) continue;
        let item = null;
        if (needsContent) {
            item = normalizeAuditEntry(raw);
            if (!item || !entryMatches(item, filters, names)) continue;
        }
        matched.push({ raw, item, time, index });
    }
    matched.sort((a, b) => b.time - a.time || b.index - a.index);
    return matched;
}

function courseNames(memory) {
    return new Map((memory.courses || []).filter(isPlainObject).map(course => [String(course.id), String(course.name || course.title || course.id)]));
}

function applicationIndex(memory) {
    return new Map((memory.examApplications || []).filter(isPlainObject).map(app => [String(app.id), app]));
}

// Entrada normalizada com os nomes para a tela (quem fez, aluno, curso, prova) e o
// aparelho (user-agent) da entrada gravada. Antes, depois e detalhes passam de novo pelo
// stripSecrets (auditEntryWithoutSecrets): entrada antiga, de antes do recordAudit, pode
// ter vindo de um backup.
function enrichItem(item, context, raw) {
    const { names, courses, evaluations } = context;
    const device = raw && typeof raw.device === 'string' ? raw.device : '';
    return {
        ...auditEntryWithoutSecrets(item),
        device,
        categoryLabel: CATEGORY_LABELS[item.category] || CATEGORY_LABELS.other,
        actorName: personName(names, item.actor),
        studentName: personName(names, item.studentEmail),
        targetName: personName(names, item.targetEmail),
        courseName: item.courseId ? courses.get(String(item.courseId)) || '' : '',
        examTitle: item.examKey ? examTitle(item.examKey, { evaluations }) : '',
    };
}

function readContext(memory) {
    return {
        names: buildNameIndex(memory),
        courses: courseNames(memory),
        evaluations: memory.evaluations || {},
    };
}

// Opções dos filtros a partir da própria trilha: quem fez, cursos, turmas, provas e
// aplicações que aparecem nela (com os nomes de hoje).
function auditFacets(memory, context) {
    const actors = new Map();
    const courses = new Map();
    const classes = new Map();
    const exams = new Map();
    const applications = new Map();
    const apps = applicationIndex(memory);
    (memory.auditLogs || []).forEach(raw => {
        const item = normalizeAuditEntry(raw);
        if (!item) return;
        if (item.actor && !actors.has(item.actor)) actors.set(item.actor, personName(context.names, item.actor));
        if (item.courseId) courses.set(String(item.courseId), context.courses.get(String(item.courseId)) || String(item.courseId));
        if (item.studentClass) {
            const key = `${item.courseId || ''}::${fold(item.studentClass)}`;
            if (!classes.has(key)) classes.set(key, { courseId: item.courseId || '', name: item.studentClass });
        }
        if (item.examKey && !exams.has(item.examKey)) exams.set(item.examKey, examTitle(item.examKey, { evaluations: context.evaluations }));
        if (item.applicationId) {
            const previous = applications.get(item.applicationId);
            if (!previous || item.timestamp > previous.lastAt) {
                const app = apps.get(item.applicationId) || {};
                applications.set(item.applicationId, {
                    id: item.applicationId,
                    examKey: item.examKey || app.examKey || '',
                    studentClass: item.studentClass || app.studentClass || app.className || '',
                    courseId: item.courseId || app.courseId || '',
                    createdAt: app.createdAt || null,
                    lastAt: item.timestamp,
                });
            }
        }
    });
    const byLabel = (a, b) => a.label.localeCompare(b.label, 'pt-BR');
    const dayFormatter = dateFormatter(context.timeZone);
    return {
        categories: AUDIT_CATEGORIES.map(value => ({ value, label: CATEGORY_LABELS[value] })),
        actors: [...actors.entries()].map(([email, name]) => ({ value: email, label: name ? `${name} (${email})` : email })).sort(byLabel).slice(0, FACET_MAX),
        courses: [...courses.entries()].map(([value, label]) => ({ value, label })).sort(byLabel),
        classes: [...classes.values()].map(cls => ({ value: cls.name, courseId: cls.courseId, label: cls.name })).sort(byLabel),
        exams: [...exams.entries()].map(([value, title]) => ({ value, label: title || value })).sort(byLabel).slice(0, FACET_MAX),
        applications: [...applications.values()]
            .sort((a, b) => b.lastAt - a.lastAt)
            .slice(0, FACET_MAX)
            .map(app => {
                const title = app.examKey ? examTitle(app.examKey, { evaluations: context.evaluations }) : '';
                const when = Number(app.createdAt) || Date.parse(app.createdAt || '') || app.lastAt;
                const date = when && Number.isFinite(new Date(when).getTime()) ? dayFormatter.format(new Date(when)) : '';
                return { value: app.id, examKey: app.examKey, label: [title || app.examKey || 'Aplicação', app.studentClass, date].filter(Boolean).join(' · ') };
            }),
    };
}

// ------------------------------------------------------------ datas na tela e no CSV
// Formatadores pt-BR no fuso pedido; fuso que o Intl recusa cai no padrão das
// configurações, nunca num erro.
function zonedFormatter(timeZone, options) {
    try { return new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: timeZone || settingsUtil.DEFAULTS.timezone }); } catch (error) {
        return new Intl.DateTimeFormat('pt-BR', { ...options, timeZone: settingsUtil.DEFAULTS.timezone });
    }
}

function dateFormatter(timeZone) {
    return zonedFormatter(timeZone, { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function dateTimeFormatter(timeZone) {
    return zonedFormatter(timeZone, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

// ------------------------------------------------------------ CSV
function shortText(text) {
    const value = String(text || '');
    return value.length > CSV_VALUE_MAX ? `${value.slice(0, CSV_VALUE_MAX - 1)}…` : value;
}

// Antes e Depois de uma entrada em texto: o valor antigo/novo do campo; sem ele, as
// configurações que mudaram; a cópia do item excluído; ou o before/after.
function beforeAfterText(item) {
    const hasValue = value => value !== null && value !== undefined && value !== '';
    if (hasValue(item.oldValue) || hasValue(item.newValue)) return [valueText(item.oldValue), valueText(item.newValue)];
    const details = isPlainObject(item.details) ? item.details : null;
    if (details && Array.isArray(details.changes)) {
        const side = name => details.changes.filter(isPlainObject).map(change => `${change.key}: ${valueText(change[name])}`).join('; ');
        return [side('before'), side('after')];
    }
    if (details && details.deleted !== undefined && !hasValue(item.before)) return [valueText(details.deleted), ''];
    return [valueText(item.before), valueText(item.after)];
}

function personLabel(email, name) {
    if (!email) return '';
    if (email === 'sistema') return 'Sistema';
    return name ? `${name} (${email})` : email;
}

function auditCsv(items, { timeZone }) {
    const formatter = dateTimeFormatter(timeZone);
    const header = ['Data/hora', 'Quem', 'Ação', 'Categoria', 'Aluno', 'Curso', 'Turma', 'Prova', 'Aplicação', 'Antes', 'Depois', 'Motivo', 'IP'];
    const rows = items.map(item => {
        const [before, after] = beforeAfterText(item);
        return [
            item.timestamp ? formatter.format(new Date(item.timestamp)).replace(', ', ' ') : 'data não registrada',
            personLabel(item.actor, item.actorName),
            item.label,
            item.categoryLabel,
            personLabel(item.studentEmail, item.studentName),
            item.courseName || item.courseId || '',
            item.studentClass || '',
            item.examTitle || item.examKey || '',
            item.applicationId || '',
            shortText(before),
            shortText(after),
            item.reason || '',
            item.ip || '',
        ];
    });
    return buildCsv([header, ...rows]);
}

// ------------------------------------------------------------ rotas
function createAdminAuditRouter() {
    const router = express.Router();

    router.get('/api/admin/audit', (req, res) => {
        validateAdminPermission(req, res, 'audit.view', () => {
            const timeZone = auditTimeZone();
            const parsed = parseAuditQuery(req.query, { timeZone });
            if (!parsed.ok) return res.status(400).json(parsed.body);
            const context = { ...readContext(db.memory), timeZone };
            const matched = filterAuditTrail(db.memory, parsed, context.names);
            const items = matched.slice(parsed.offset, parsed.offset + parsed.limit)
                .map(entry => enrichItem(entry.item || normalizeAuditEntry(entry.raw), context, entry.raw));
            const body = { success: true, items, total: matched.length, offset: parsed.offset, limit: parsed.limit };
            if (String(req.query.facets || '') === '1') body.facets = auditFacets(db.memory, context);
            res.json(body);
        });
    });

    router.get('/api/admin/audit/export', (req, res) => {
        validateAdminPermission(req, res, 'audit.view', async (config, account) => {
            const timeZone = auditTimeZone();
            const parsed = parseAuditQuery(req.query, { timeZone });
            if (!parsed.ok) return res.status(400).json(parsed.body);
            const context = { ...readContext(db.memory), timeZone };
            const matched = filterAuditTrail(db.memory, parsed, context.names);
            if (matched.length > AUDIT_EXPORT_MAX) {
                return res.status(400).json({ success: false, error: AUDIT_EXPORT_TOO_LARGE, field: 'from', total: matched.length });
            }
            const items = matched.map(entry => enrichItem(entry.item || normalizeAuditEntry(entry.raw), context, entry.raw));
            const csv = auditCsv(items, { timeZone });
            // A exportação também fica na trilha: quem tirou a cópia, de quê e quantas linhas.
            recordAudit(db.memory, {
                req,
                actor: account,
                action: 'audit_exported',
                category: 'system',
                details: { filters: parsed.filters, rows: items.length },
            });
            await db.save();
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="auditoria_${settingsUtil.todayInTz(timeZone)}.csv"`);
            res.send(csv);
        });
    });

    return router;
}

module.exports = {
    AUDIT_EXPORT_MAX,
    AUDIT_PAGE_MAX,
    auditFacets,
    createAdminAuditRouter,
    parseAuditQuery,
    zonedDayStart,
};
