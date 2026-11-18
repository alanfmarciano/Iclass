// Termos de Uso e Política de Privacidade (H8a-1; SEG-08, OPS-12).
//
// Coleção legalDocuments (tabela legal_documents, declarada no registro
// db.COLLECTION_TABLES com restore 'merge' por id). Cada linha:
//   { id, kind: 'termos'|'privacidade', status: 'rascunho'|'publicado', version (inteiro
//     ou null), title, markdown (até 100000 caracteres), changeSummary, createdAt,
//     updatedAt, updatedBy, publishedAt, publishedBy }
// - O rascunho tem id fixo 'rascunho_<kind>' e é o único que muda.
// - Cada publicação cria '<kind>_v<N>', com N = maior versão publicada + 1, e essa
//   linha não muda mais (escrita nela responde 409): é ela que prova qual texto o aluno
//   aceitou (o aceite com documentId é do H8a-2).
// - Nada disso vai para config nem branding: os dois são regravados a cada save.
//
// O documento atual de cada tipo é a maior versão publicada. Sem publicação, é o modelo
// (utils/legalTemplates.js), com documentId '<MODEL_ID>:<kind>', e ninguém precisa
// aceitar nada (decisão P4: só passa a valer depois que o administrador revisa e publica).
//
// Há um texto só por instalação. Os marcadores {{...}} (lista fechada
// LEGAL_PLACEHOLDERS) são preenchidos na hora de mostrar com os dados da escola pedida
// (?escola=ID ou ?courseId=ID; ID desconhecido usa a primeira escola). Os dados do
// encarregado ficam em school.info (dpoName, dpoEmail, dpoPhone), gravados só pela rota
// de LGPD (routes/adminPrivacy.js): extractInstitutional (utils/branding.js) não os
// conhece, então editar a escola não os apaga nem os troca.

const { MODEL_ID, MODELS, DEFAULT_MINORS_LEGAL_BASIS, MODEL_NOTICE, MODEL_REVIEW_HINT, MODEL_NOTICE_RE } = require('./legalTemplates.js');

const LEGAL_KINDS = Object.freeze(['termos', 'privacidade']);
// Nome de cada tipo nas respostas públicas ({ terms, privacy }).
const PUBLIC_KEYS = Object.freeze({ termos: 'terms', privacidade: 'privacy' });
const KIND_LABELS = Object.freeze({ termos: 'Termos de Uso', privacidade: 'Política de Privacidade' });

const STATUS_DRAFT = 'rascunho';
const STATUS_PUBLISHED = 'publicado';

const MARKDOWN_MAX = 100000;
const TITLE_MAX = 200;
const SUMMARY_MAX = 500;
const NOT_INFORMED = '[não informado]';

// Lista fechada dos marcadores. Marcador vazio vira '[não informado]'; marcador fora da
// lista fica como está e aparece como aviso na pré-visualização do administrador.
const LEGAL_PLACEHOLDERS = Object.freeze([
    { key: 'instituicao', label: 'Razão social da escola (ou o nome, se não houver)' },
    { key: 'nome_fantasia', label: 'Nome fantasia da escola' },
    { key: 'cnpj', label: 'CNPJ da escola' },
    { key: 'endereco', label: 'Endereço da escola' },
    { key: 'contato_instituicao', label: 'E-mail, telefone e site da escola' },
    { key: 'encarregado_nome', label: 'Nome do encarregado (DPO)' },
    { key: 'encarregado_contato', label: 'E-mail e telefone do encarregado' },
    { key: 'base_legal_menores', label: 'Base legal adotada para menores de 18 anos' },
    { key: 'prazo_monitoramento', label: 'Prazo de guarda do monitoramento de prova' },
    { key: 'prazo_acessos', label: 'Prazo de guarda dos registros de acesso' },
    { key: 'prazo_lixeira', label: 'Prazo da lixeira' },
    { key: 'copias_seguranca', label: 'Como funcionam as cópias de segurança' },
    { key: 'versao', label: 'Número da versão publicada' },
    { key: 'data_publicacao', label: 'Data da publicação' },
]);
const PLACEHOLDER_KEYS = new Set(LEGAL_PLACEHOLDERS.map(item => item.key));
const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

const DPO_KEYS = Object.freeze(['dpoName', 'dpoEmail', 'dpoPhone']);
const DPO_LIMITS = Object.freeze({ dpoName: 120, dpoEmail: 254, dpoPhone: 40 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cópias automáticas do servidor (utils/backup.js, runAutomaticBackup keep 14).
const AUTOMATIC_BACKUPS_KEPT = 14;

class LegalDocumentError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        Object.assign(this, extra);
    }
}

function isKind(value) {
    return typeof value === 'string' && LEGAL_KINDS.includes(value);
}

function draftIdFor(kind) {
    return `rascunho_${kind}`;
}

function publishedIdFor(kind, version) {
    return `${kind}_v${version}`;
}

function modelDocumentId(kind) {
    return `${MODEL_ID}:${kind}`;
}

function collection(memory) {
    if (!Array.isArray(memory.legalDocuments)) memory.legalDocuments = [];
    return memory.legalDocuments;
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Linha publicada válida (restauração de backup pode trazer qualquer coisa).
function isPublishedRow(row, kind) {
    return isPlainObject(row)
        && row.status === STATUS_PUBLISHED
        && (!kind || row.kind === kind)
        && isKind(row.kind)
        && Number.isInteger(row.version) && row.version > 0
        && typeof row.markdown === 'string';
}

function isDraftRow(row, kind) {
    return isPlainObject(row) && row.status === STATUS_DRAFT && row.kind === kind && row.id === draftIdFor(kind) && typeof row.markdown === 'string';
}

// Versões publicadas de um tipo, da mais nova para a mais antiga.
function publishedVersions(memory, kind) {
    return (Array.isArray(memory.legalDocuments) ? memory.legalDocuments : [])
        .filter(row => isPublishedRow(row, kind))
        .sort((a, b) => b.version - a.version);
}

function latestPublished(memory, kind) {
    return publishedVersions(memory, kind)[0] || null;
}

function storedDraft(memory, kind) {
    return (Array.isArray(memory.legalDocuments) ? memory.legalDocuments : []).find(row => isDraftRow(row, kind)) || null;
}

// Documento atual de um tipo: a maior versão publicada ou, sem publicação, o modelo.
function currentDocument(memory, kind) {
    const published = latestPublished(memory, kind);
    if (published) {
        return {
            kind,
            documentId: published.id,
            version: published.version,
            publishedAt: published.publishedAt || null,
            publishedBy: published.publishedBy || null,
            isModel: false,
            title: published.title || KIND_LABELS[kind],
            markdown: published.markdown,
        };
    }
    const model = MODELS[kind];
    return {
        kind,
        documentId: modelDocumentId(kind),
        version: null,
        publishedAt: null,
        publishedBy: null,
        isModel: true,
        title: model.title,
        markdown: model.markdown,
    };
}

// Rascunho de um tipo: o gravado ou, sem ele, o texto atual (a última versão publicada
// ou o modelo) como ponto de partida, ainda não gravado (saved: false).
function draftFor(memory, kind) {
    const stored = storedDraft(memory, kind);
    const current = currentDocument(memory, kind);
    const base = stored || {
        id: draftIdFor(kind),
        kind,
        status: STATUS_DRAFT,
        title: current.title,
        markdown: current.markdown,
        changeSummary: '',
        updatedAt: null,
        updatedBy: null,
    };
    return {
        id: draftIdFor(kind),
        kind,
        title: base.title || KIND_LABELS[kind],
        markdown: base.markdown,
        changeSummary: base.changeSummary || '',
        updatedAt: base.updatedAt || null,
        updatedBy: base.updatedBy || null,
        saved: !!stored,
        // O rascunho é igual ao texto atual: publicar não teria o que mudar.
        sameAsCurrent: (base.title || KIND_LABELS[kind]) === current.title && base.markdown === current.markdown,
        // O texto é o do modelo, sem nenhuma mudança (o diálogo de publicar pede conferência).
        sameAsModel: base.markdown === MODELS[kind].markdown,
        // O texto ainda traz o aviso do modelo para o administrador (copiado de uma versão
        // anterior do modelo): publicado, ele ficaria para os alunos numa versão que não muda.
        hasModelNotice: MODEL_NOTICE_RE.test(String(base.markdown || '')),
    };
}

// ------------------------------------------------------------ marcadores
// Escola cujos dados preenchem os marcadores: a pedida por id, a do curso pedido ou a
// primeira cadastrada (id desconhecido também cai na primeira).
function resolveSchool(memory, { escola, courseId } = {}) {
    const schools = (Array.isArray(memory.schools) ? memory.schools : []).filter(isPlainObject);
    const wanted = typeof escola === 'string' ? escola.trim() : '';
    if (wanted) {
        const found = schools.find(school => String(school.id) === wanted);
        if (found) return found;
    }
    const course = typeof courseId === 'string' && courseId.trim()
        ? (Array.isArray(memory.courses) ? memory.courses : []).find(item => isPlainObject(item) && String(item.id) === courseId.trim())
        : null;
    if (course && course.schoolId) {
        const found = schools.find(school => String(school.id) === String(course.schoolId));
        if (found) return found;
    }
    return schools[0] || null;
}

function text(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

// O valor entra no meio do markdown como texto literal: todo sinal de pontuação ASCII
// leva a barra (no CommonMark todos podem ser escapados), então nada do cadastro vira
// formatação, HTML, lista, link ou link automático do GFM. Antes só alguns sinais eram
// escapados, e a barra dentro de e-mail e endereço quebrava o link automático: com
// 'joao_silva@escola.com.br' o link ia para silva@escola.com.br, e 'a_b' num site virava
// '%5C' no href. O HTML final ainda passa pelo DOMPurify no navegador.
const MARKDOWN_PUNCTUATION_RE = /[!-\/:-@[-`{-~]/g;

function escapeMarkdownInline(value) {
    return String(value).replace(MARKDOWN_PUNCTUATION_RE, '\\$&');
}

// Contatos (e-mail e site da escola, e-mail do encarregado) viram link explícito, com o
// texto escapado e o endereço entre <...>: o texto mostrado e o destino são exatamente o
// valor gravado. Só e-mail simples e endereço http(s) ou www. viram link; o resto
// (javascript:, e-mail com ?, &, espaço...) fica como texto.
const LINK_EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const LINK_URL_RE = /^(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/i;

function linkHref(value, link) {
    if (link === 'email' && LINK_EMAIL_RE.test(value)) return `mailto:${value}`;
    if (link === 'url' && LINK_URL_RE.test(value)) return /^www\./i.test(value) ? `http://${value}` : value;
    return '';
}

// Valor de um marcador em markdown. value: texto, ou lista de partes { text, link }
// (link: 'email' | 'url'), unidas por ', ' sem as vazias.
function placeholderMarkdown(value) {
    if (Array.isArray(value)) {
        return value.map(part => {
            const plain = text(isPlainObject(part) ? part.text : part);
            if (!plain) return '';
            const href = isPlainObject(part) ? linkHref(plain, part.link) : '';
            return href ? `[${escapeMarkdownInline(plain)}](<${href}>)` : escapeMarkdownInline(plain);
        }).filter(Boolean).join(', ');
    }
    const plain = text(value);
    return plain ? escapeMarkdownInline(plain) : '';
}

// Texto simples de um valor (lista de partes unida por ', ').
function placeholderText(value) {
    if (Array.isArray(value)) return value.map(part => text(isPlainObject(part) ? part.text : part)).filter(Boolean).join(', ');
    return text(value);
}

function joinFilled(values, separator = ', ') {
    return values.map(text).filter(Boolean).join(separator);
}

function formatDate(iso, timeZone) {
    const time = Date.parse(String(iso || ''));
    if (!Number.isFinite(time)) return '';
    try {
        return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(time));
    } catch (error) {
        return new Date(time).toISOString().slice(0, 10).split('-').reverse().join('/');
    }
}

function daysValue(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function retentionPhrase(days, { withDays, without }) {
    const value = daysValue(days);
    return value ? withDays(value) : without;
}

function settingsOf(memory, options) {
    if (options.settings) return options.settings;
    // Carregado aqui: utils/settings.js lê o banco (database.js), e este módulo também é
    // usado em testes de unidade com uma memória solta.
    try {
        return require('./settings.js').getSettings();
    } catch (error) {
        const raw = memory && memory.config && memory.config.settings;
        return isPlainObject(raw) ? raw : {};
    }
}

// Valores dos marcadores para uma escola e um documento ({ version, publishedAt }; sem
// versão, é o modelo ou a prévia de uma versão nova). Os contatos vêm em partes
// ({ text, link }), para o e-mail e o site virarem link (placeholderMarkdown).
function placeholderValues(memory, school, doc = {}, options = {}) {
    const settings = settingsOf(memory, options);
    const timeZone = (settings && settings.timezone) || 'America/Sao_Paulo';
    const info = school && isPlainObject(school.info) ? school.info : {};
    const branding = isPlainObject(memory.branding) ? memory.branding : {};
    const schoolName = text(school && school.name) || text(branding.displayName) || text(branding.institutionName);
    const retention = settings && isPlainObject(settings.retention) ? settings.retention : {};
    const trash = settings && isPlainObject(settings.trash) ? settings.trash : {};
    const privacy = memory.config && isPlainObject(memory.config.privacy) ? memory.config.privacy : {};
    const values = {
        instituicao: text(info.legalName) || schoolName,
        nome_fantasia: text(info.tradeName) || schoolName,
        cnpj: text(info.registrationId),
        endereco: joinFilled([info.address, info.cityState, text(info.zip) ? `CEP ${text(info.zip)}` : '']),
        contato_instituicao: [{ text: info.email, link: 'email' }, { text: info.phone }, { text: info.website, link: 'url' }],
        encarregado_nome: text(info.dpoName),
        encarregado_contato: [{ text: info.dpoEmail, link: 'email' }, { text: info.dpoPhone }],
        base_legal_menores: text(privacy.minorsLegalBasis) || DEFAULT_MINORS_LEGAL_BASIS,
        prazo_monitoramento: retentionPhrase(retention.proctoringDays, {
            withDays: days => `apagados ${days} dias depois do encerramento da prova`,
            without: 'guardados até a escola apagá-los (nenhum prazo automático definido)',
        }),
        prazo_acessos: retentionPhrase(retention.loginLogsDays, {
            withDays: days => `apagados ${days} dias depois do acesso`,
            without: 'guardados até a escola apagá-los (nenhum prazo automático definido)',
        }),
        prazo_lixeira: retentionPhrase(trash.retentionDays, {
            withDays: days => `apagados de vez ${days} dias depois de irem para a lixeira`,
            without: 'guardados até a escola esvaziar a lixeira (nenhum prazo automático definido)',
        }),
        copias_seguranca: `o IClass faz uma cópia automática por dia e guarda as ${AUTOMATIC_BACKUPS_KEPT} mais recentes; as mais antigas são apagadas sozinhas. Cópias feitas à mão ficam até a escola apagá-las.`,
        versao: doc.version ? String(doc.version) : (doc.preview ? 'nova versão (prévia)' : 'modelo padrão do IClass'),
        data_publicacao: doc.publishedAt
            ? formatDate(doc.publishedAt, timeZone)
            : (doc.preview ? 'na data em que for publicada' : 'ainda não publicado pela instituição'),
    };
    return values;
}

// Troca os marcadores conhecidos pelos valores (vazio vira '[não informado]'). Os
// desconhecidos ficam como estão e voltam em unknownPlaceholders (sem repetição).
function renderLegalMarkdown(markdown, values = {}) {
    const unknown = [];
    const rendered = String(markdown || '').replace(PLACEHOLDER_RE, (whole, name) => {
        if (!PLACEHOLDER_KEYS.has(name)) {
            if (!unknown.includes(name)) unknown.push(name);
            return whole;
        }
        const value = placeholderMarkdown(values[name]);
        return value || NOT_INFORMED;
    });
    return { markdown: rendered, unknownPlaceholders: unknown };
}

function schoolSummary(school) {
    return school ? { id: String(school.id || ''), name: text(school.name) || text(school.info && school.info.tradeName) } : null;
}

// Um documento pronto para mostrar (texto com os marcadores preenchidos).
function renderedDocument(memory, school, doc, options = {}) {
    const values = placeholderValues(memory, school, doc, options);
    const { markdown, unknownPlaceholders } = renderLegalMarkdown(doc.markdown, values);
    return { markdown, unknownPlaceholders };
}

// Resposta pública de GET /api/legal/documents. Rascunho nunca aparece aqui.
// published: há pelo menos um documento publicado (o que pode passar a ser exigido).
function publicLegalDocuments(memory, query = {}, options = {}) {
    const school = resolveSchool(memory, query);
    const out = { success: true, published: false, modelId: MODEL_ID, school: schoolSummary(school) };
    LEGAL_KINDS.forEach(kind => {
        const doc = currentDocument(memory, kind);
        const { markdown } = renderedDocument(memory, school, doc, options);
        out[PUBLIC_KEYS[kind]] = {
            kind,
            documentId: doc.documentId,
            version: doc.version,
            publishedAt: doc.publishedAt,
            isModel: doc.isModel,
            // Aviso mostrado acima do texto enquanto é o modelo (fica fora do markdown).
            notice: doc.isModel ? MODEL_NOTICE : null,
            title: doc.title,
            markdown,
        };
        if (!doc.isModel) out.published = true;
    });
    return out;
}

// ------------------------------------------------------------ escrita
function readText(body, key, { max, required = false, label }) {
    const value = body[key];
    if (value === undefined || value === null) {
        if (required) throw new LegalDocumentError(400, `Informe ${label}.`, { field: key });
        return '';
    }
    if (typeof value !== 'string') throw new LegalDocumentError(400, `${label[0].toUpperCase()}${label.slice(1)} deve ser um texto.`, { field: key });
    if (value.length > max) throw new LegalDocumentError(400, `${label[0].toUpperCase()}${label.slice(1)} pode ter no máximo ${max.toLocaleString('pt-BR')} caracteres.`, { field: key });
    if (required && !value.trim()) throw new LegalDocumentError(400, `Informe ${label}.`, { field: key });
    return value;
}

// Tipo do documento pedido: 'kind' ou o id de uma linha. Linha publicada não muda:
// qualquer escrita nela responde 409.
function resolveWritableKind(memory, body) {
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (id) {
        const row = (Array.isArray(memory.legalDocuments) ? memory.legalDocuments : []).find(item => isPlainObject(item) && item.id === id);
        if (row && row.status === STATUS_PUBLISHED) {
            throw new LegalDocumentError(409, 'Documento publicado não pode ser alterado. Edite o rascunho e publique uma nova versão.', { code: 'published_immutable' });
        }
        const kind = LEGAL_KINDS.find(item => draftIdFor(item) === id);
        if (!kind) throw new LegalDocumentError(404, 'Documento não encontrado.');
        return kind;
    }
    if (!isKind(body.kind)) throw new LegalDocumentError(400, 'Tipo de documento inválido. Use termos ou privacidade.', { field: 'kind' });
    return body.kind;
}

function writeDraft(memory, kind, { title, markdown, changeSummary }, actorEmail, now) {
    const list = collection(memory);
    const iso = new Date(now).toISOString();
    let row = list.find(item => isDraftRow(item, kind));
    if (!row) {
        // Linha de rascunho estragada (restauração) sai antes da nova.
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (isPlainObject(list[i]) && list[i].id === draftIdFor(kind)) list.splice(i, 1);
        }
        row = { id: draftIdFor(kind), kind, status: STATUS_DRAFT, version: null, createdAt: iso, publishedAt: null, publishedBy: null };
        list.push(row);
    }
    row.title = title;
    row.markdown = markdown;
    row.changeSummary = changeSummary;
    row.updatedAt = iso;
    row.updatedBy = actorEmail || null;
    return draftFor(memory, kind);
}

function saveDraft(memory, body, actorEmail, now = Date.now()) {
    const input = isPlainObject(body) ? body : {};
    const kind = resolveWritableKind(memory, input);
    const title = readText(input, 'title', { max: TITLE_MAX, label: 'o título' }).trim() || KIND_LABELS[kind];
    const markdown = readText(input, 'markdown', { max: MARKDOWN_MAX, required: true, label: 'o texto do documento' });
    const changeSummary = readText(input, 'changeSummary', { max: SUMMARY_MAX, label: 'o resumo da mudança' }).trim();
    return writeDraft(memory, kind, { title, markdown, changeSummary }, actorEmail, now);
}

// Volta o rascunho ao texto do modelo (a versão publicada continua valendo).
function restoreModelDraft(memory, body, actorEmail, now = Date.now()) {
    const input = isPlainObject(body) ? body : {};
    const kind = resolveWritableKind(memory, input);
    const model = MODELS[kind];
    return writeDraft(memory, kind, { title: model.title, markdown: model.markdown, changeSummary: 'Texto do modelo padrão do IClass.' }, actorEmail, now);
}

// Publica o rascunho como a próxima versão. draftUpdatedAt (opcional): a hora do
// rascunho que a tela mostrava; se ele mudou depois (outra aba, outro administrador),
// responde 409 em vez de publicar um texto que a pessoa não leu.
function publishDraft(memory, body, actorEmail, now = Date.now()) {
    const input = isPlainObject(body) ? body : {};
    if (!isKind(input.kind)) throw new LegalDocumentError(400, 'Tipo de documento inválido. Use termos ou privacidade.', { field: 'kind' });
    const kind = input.kind;
    if (Object.prototype.hasOwnProperty.call(input, 'draftUpdatedAt')) {
        const expected = input.draftUpdatedAt === null || input.draftUpdatedAt === '' ? null : input.draftUpdatedAt;
        if (expected !== null && typeof expected !== 'string') throw new LegalDocumentError(400, 'Data do rascunho inválida.', { field: 'draftUpdatedAt' });
        const stored = storedDraft(memory, kind);
        const actual = stored ? (stored.updatedAt || null) : null;
        if (expected !== actual) {
            throw new LegalDocumentError(409, 'O rascunho foi alterado depois que você abriu a página. Recarregue e confira o texto antes de publicar.', { code: 'draft_changed' });
        }
    }
    const summaryOverride = readText(input, 'changeSummary', { max: SUMMARY_MAX, label: 'o resumo da mudança' }).trim();
    const draft = draftFor(memory, kind);
    const previous = latestPublished(memory, kind);
    if (previous && draft.sameAsCurrent) {
        throw new LegalDocumentError(400, 'O rascunho é igual à versão publicada. Altere o texto antes de publicar uma nova versão.', { code: 'no_changes' });
    }
    if (!draft.markdown.trim()) throw new LegalDocumentError(400, 'Informe o texto do documento.', { field: 'markdown' });
    const version = previous ? previous.version + 1 : 1;
    const iso = new Date(now).toISOString();
    const list = collection(memory);
    const id = publishedIdFor(kind, version);
    if (list.some(row => isPlainObject(row) && row.id === id)) {
        // Linha com o id da próxima versão, mas fora do formato (restauração estragada):
        // não sobrescreve; o administrador resolve restaurando um backup bom.
        throw new LegalDocumentError(409, `Já existe um registro com o id ${id}. Nada foi publicado.`, { code: 'version_exists' });
    }
    const row = {
        id,
        kind,
        status: STATUS_PUBLISHED,
        version,
        title: draft.title,
        markdown: draft.markdown,
        changeSummary: summaryOverride || draft.changeSummary || '',
        createdAt: iso,
        updatedAt: iso,
        updatedBy: actorEmail || null,
        publishedAt: iso,
        publishedBy: actorEmail || null,
    };
    if (!previous && draft.markdown === MODELS[kind].markdown) row.modelId = MODEL_ID;
    list.push(row);
    // O rascunho publicado sai: o próximo começa da versão publicada.
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (isPlainObject(list[i]) && list[i].id === draftIdFor(kind)) list.splice(i, 1);
    }
    return { document: row, previous };
}

function historyEntry(row) {
    return {
        id: row.id,
        version: row.version,
        title: row.title || KIND_LABELS[row.kind],
        changeSummary: row.changeSummary || '',
        publishedAt: row.publishedAt || null,
        publishedBy: row.publishedBy || null,
    };
}

function findPublished(memory, id) {
    return (Array.isArray(memory.legalDocuments) ? memory.legalDocuments : []).find(row => isPublishedRow(row) && row.id === id) || null;
}

// ------------------------------------------------------------ encarregado (DPO)
function dpoOf(school) {
    const info = school && isPlainObject(school.info) ? school.info : {};
    const out = {};
    DPO_KEYS.forEach(key => { out[key] = typeof info[key] === 'string' ? info[key] : ''; });
    return out;
}

function validateDpoInput(body) {
    const input = isPlainObject(body) ? body : {};
    const labels = { dpoName: 'o nome do encarregado', dpoEmail: 'o e-mail do encarregado', dpoPhone: 'o telefone do encarregado' };
    const out = {};
    DPO_KEYS.forEach(key => {
        out[key] = readText(input, key, { max: DPO_LIMITS[key], label: labels[key] }).replace(/\s+/g, ' ').trim();
    });
    if (out.dpoEmail) out.dpoEmail = out.dpoEmail.toLowerCase();
    if (out.dpoEmail && !EMAIL_RE.test(out.dpoEmail)) throw new LegalDocumentError(400, 'Informe um e-mail válido para o encarregado.', { field: 'dpoEmail' });
    if (out.dpoPhone) {
        const digits = out.dpoPhone.replace(/\D/g, '').length;
        if (digits < 8 || digits > 15 || /[^\d\s()+.-]/.test(out.dpoPhone)) throw new LegalDocumentError(400, 'Informe um telefone válido para o encarregado (só números, espaços, parênteses, + e -).', { field: 'dpoPhone' });
    }
    if (out.dpoName && out.dpoName.length < 3) throw new LegalDocumentError(400, 'O nome do encarregado precisa ter pelo menos 3 letras.', { field: 'dpoName' });
    if ((out.dpoEmail || out.dpoPhone) && !out.dpoName) throw new LegalDocumentError(400, 'Informe o nome do encarregado.', { field: 'dpoName' });
    if (out.dpoName && !out.dpoEmail && !out.dpoPhone) throw new LegalDocumentError(400, 'Informe um e-mail ou telefone do encarregado.', { field: 'dpoEmail' });
    return out;
}

module.exports = {
    LEGAL_KINDS,
    PUBLIC_KEYS,
    KIND_LABELS,
    LEGAL_PLACEHOLDERS,
    MARKDOWN_MAX,
    NOT_INFORMED,
    DPO_KEYS,
    LegalDocumentError,
    isKind,
    draftIdFor,
    modelDocumentId,
    publishedVersions,
    latestPublished,
    currentDocument,
    draftFor,
    resolveSchool,
    MODEL_NOTICE,
    MODEL_REVIEW_HINT,
    placeholderValues,
    placeholderText,
    escapeMarkdownInline,
    renderLegalMarkdown,
    renderedDocument,
    schoolSummary,
    publicLegalDocuments,
    saveDraft,
    restoreModelDraft,
    publishDraft,
    historyEntry,
    findPublished,
    dpoOf,
    validateDpoInput,
};
