// Planilhas: ler CSV e XLSX e gravar XLSX (fase 3, B3b; FUN-06, FUN-08, FUN-12), sem
// pacote novo. O XLSX é XML dentro de um ZIP; o ZIP é aberto pelo adm-zip, que já é
// dependência, e o XML é lido aqui.
//
// Contrato (C4 do P4): toda importação de planilha lê o arquivo SÓ por
// parseTabularFile(buffer, { nomeArquivo, maxLinhas, maxColunas }); toda exportação
// grava por buildCsv (utils/gradebook.js, com csvSafe) ou por buildXlsx. Importação é
// sempre em dois passos (simular e confirmar com o sha256 do arquivo, fileSha256), sem
// guardar o arquivo no servidor.
//
// O que a leitura devolve: o texto de cada célula como o Excel em português mostraria e
// gravaria num "CSV" (o mesmo que a pessoa vê na tela). Assim um CSV e um XLSX com a
// mesma planilha dão as mesmas células:
// - número: sem separador de milhar e com vírgula decimal ("7,5", "2024001"), ou com o
//   número de casas e o milhar do formato da célula ("0,0", "#.##0,00", "0%");
// - data e hora (número serial com formato de data): "dd/mm/aaaa", "dd/mm/aaaa hh:mm" ou
//   "hh:mm" (sistema 1900, com o 29/02/1900 que não existe, e o 1904 do Mac);
// - verdadeiro/falso: "VERDADEIRO"/"FALSO"; erro de fórmula: o texto do erro ("#DIV/0!");
// - fórmula: o último valor calculado que o Excel guardou (fórmula sem valor guardado
//   fica vazia, com aviso); texto com formatação (rich text): os trechos juntos.
// Só a primeira aba visível é lida (com aviso quando há outras). Linha vazia é pulada e
// não conta no limite, mas a numeração segue a da planilha (a linha 14 do Excel é a
// linha 14 da mensagem de erro). No CSV, o número é o do registro (uma célula com
// quebra de linha entre aspas não muda a contagem), como o Excel mostra ao abrir.
//
// Erros: TabularFileError com mensagem em português, `code` e `status` (400 ou 413),
// para a rota responder { error, code } como as demais.

const crypto = require('crypto');
const zlib = require('zlib');

const LIMITES = Object.freeze({
    maxBytes: 2 * 1024 * 1024, // arquivo enviado
    maxLinhas: 500, // linhas com dados, sem contar o cabeçalho
    maxColunas: 50,
    // XLSX: o XML descompactado de cada parte lida e o total (proteção contra ZIP bomb).
    maxParteXml: 24 * 1024 * 1024,
    maxTotalXml: 48 * 1024 * 1024,
    maxTextoCelula: 32767, // limite do Excel por célula
});

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const EXCEL_MAX_ROWS = 1048576;
const EXCEL_MAX_COLUMNS = 16384;

const SALVE_COMO = 'No Excel, use "Salvar como" e escolha "Pasta de Trabalho do Excel (.xlsx)" ou "CSV UTF-8 (separado por vírgulas)".';
const TEXT_EXTENSIONS = new Set(['csv', 'txt', 'tsv']);
const XLSX_EXTENSIONS = new Set(['xlsx', 'xlsm']);

class TabularFileError extends Error {
    constructor(message, code, { status = 400, linha } = {}) {
        super(message);
        this.name = 'TabularFileError';
        this.code = code;
        this.status = status;
        if (linha) this.linha = linha;
    }
}

function fileSha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionOf(nomeArquivo) {
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(String(nomeArquivo || '').trim());
    return match ? match[1].toLowerCase() : '';
}

function positiveLimit(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatCount(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ------------------------------------------------------------ texto do CSV
// Windows-1252 (o "CSV" do Excel em português no Windows) sem depender do ICU do Node:
// latin1 com a faixa 0x80-0x9F trocada pelos caracteres do Windows.
const CP1252_HIGH = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

function decodeCp1252(buffer) {
    let out = '';
    const CHUNK = 8192;
    for (let start = 0; start < buffer.length; start += CHUNK) {
        const codes = [];
        const end = Math.min(buffer.length, start + CHUNK);
        for (let index = start; index < end; index += 1) {
            const byte = buffer[index];
            codes.push(byte >= 0x80 && byte <= 0x9F ? CP1252_HIGH[byte - 0x80] : byte);
        }
        out += String.fromCharCode.apply(null, codes);
    }
    return out;
}

// UTF-8 conferido byte a byte (o TextDecoder de UTF-8 existe em qualquer Node, com ou
// sem ICU completo).
function isValidUtf8(buffer) {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return true;
    } catch (error) {
        return false;
    }
}

// Devolve { texto, codificacao }.
function decodeText(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return { texto: buffer.subarray(3).toString('utf8'), codificacao: 'utf-8' };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return { texto: buffer.subarray(2).toString('utf16le'), codificacao: 'utf-16' };
    }
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
        const body = Buffer.from(buffer.subarray(2));
        const even = body.length - (body.length % 2);
        for (let index = 0; index < even; index += 2) {
            const first = body[index];
            body[index] = body[index + 1];
            body[index + 1] = first;
        }
        return { texto: body.subarray(0, even).toString('utf16le'), codificacao: 'utf-16' };
    }
    if (isValidUtf8(buffer)) return { texto: buffer.toString('utf8'), codificacao: 'utf-8' };
    return { texto: decodeCp1252(buffer), codificacao: 'windows-1252' };
}

// ------------------------------------------------------------ leitura do CSV
// Registros do CSV com o separador dado. `limit` para a amostra da detecção. Aspas como
// no Excel: campo entre aspas aceita separador e quebra de linha, "" é uma aspa; aspa no
// meio de um campo sem aspas fica como está.
function splitCsvRecords(text, separator, limit = Infinity) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let fieldStarted = false;
    let quoteStartRecord = 0;
    let index = 0;
    const length = text.length;
    const pushField = () => { record.push(field); field = ''; fieldStarted = false; };
    const pushRecord = () => { pushField(); records.push(record); record = []; };
    while (index < length) {
        const char = text[index];
        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') { field += '"'; index += 2; continue; }
                quoted = false;
                index += 1;
                continue;
            }
            field += char;
            index += 1;
            continue;
        }
        if (char === '"' && !fieldStarted) {
            quoted = true;
            fieldStarted = true;
            quoteStartRecord = records.length + 1;
            index += 1;
            continue;
        }
        if (char === separator) { pushField(); index += 1; continue; }
        if (char === '\r' || char === '\n') {
            pushRecord();
            index += (char === '\r' && text[index + 1] === '\n') ? 2 : 1;
            if (records.length >= limit) return { records, complete: false };
            continue;
        }
        field += char;
        fieldStarted = true;
        index += 1;
    }
    if (quoted) {
        if (limit !== Infinity) { pushRecord(); return { records, complete: false }; }
        throw new TabularFileError(`O arquivo tem aspas (") sem fechar a partir da linha ${quoteStartRecord}. Confira essa linha ou salve de novo pelo Excel.`, 'unclosed_quote', { linha: quoteStartRecord });
    }
    if (fieldStarted || field || record.length) pushRecord();
    return { records, complete: true };
}

const SEPARATORS = [';', '\t', ','];

// Separador: "sep=X" na primeira linha (o Excel entende), senão o que divide a amostra
// em colunas de forma mais constante (empate: ';', tab, ',').
function detectSeparator(text) {
    const hint = /^sep=(.)\r?\n/i.exec(text.slice(0, 8));
    if (hint) return { separador: hint[1], inicio: hint[0].length };
    let best = null;
    for (const separator of SEPARATORS) {
        const sample = splitCsvRecords(text, separator, 30).records
            .filter(record => record.some(value => String(value).trim() !== ''));
        if (!sample.length) continue;
        const first = sample[0].length;
        if (first < 2) continue;
        const consistent = sample.filter(record => record.length === first).length;
        const score = consistent * 1000 + first;
        if (!best || score > best.score) best = { separator, score };
    }
    return { separador: best ? best.separator : ';', inicio: 0 };
}

function parseCsvText(buffer) {
    const { texto, codificacao } = decodeText(buffer);
    if (texto.includes('\u0000')) {
        throw new TabularFileError(`O arquivo não parece uma planilha (CSV ou XLSX). ${SALVE_COMO}`, 'unsupported_format');
    }
    const { separador, inicio } = detectSeparator(texto);
    const { records } = splitCsvRecords(texto.slice(inicio), separador);
    const rows = records.map((values, index) => ({ numero: index + 1, valores: values }));
    return { formato: 'csv', separador, codificacao, planilha: null, rows, avisos: [] };
}

// ------------------------------------------------------------ XML do XLSX
function decodeXmlText(text) {
    if (!text) return '';
    return text
        .replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (match, entity) => {
            if (entity[0] === '#') {
                const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
                return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
            }
            return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[entity];
        })
        // Escape do OOXML para caractere que o XML não aceita (_x000D_ = CR).
        .replace(/_x([0-9a-fA-F]{4})_/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// O XML de cada parte é lido por um laço só, da esquerda para a direita, sem expressão
// regular que volte atrás: o tempo cresce em linha reta com o tamanho da parte, mesmo
// com XML malformado (uma abertura sem fechamento, aspas sem fechar). Uma busca por
// expressão regular a cada elemento ficava quadrática: um .xlsx de 1 KB com "<c>" sem
// "</c>" repetido prendia o servidor por 20 s. XML malformado é recusado (o Excel, o
// LibreOffice e o openpyxl gravam XML bem formado).
const XML_MAX_DEPTH = 64;

function xmlError() {
    return new TabularFileError(`Não foi possível abrir a planilha do Excel: o arquivo parece danificado. ${SALVE_COMO}`, 'invalid_xlsx');
}

function isXmlSpace(code) {
    return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D;
}

// Letras, dígitos, "_", ":", ".", "-" e qualquer caractere fora do ASCII.
function isXmlNameChar(code) {
    return (code >= 0x61 && code <= 0x7A) || (code >= 0x41 && code <= 0x5A) || (code >= 0x30 && code <= 0x39)
        || code === 0x5F || code === 0x3A || code === 0x2E || code === 0x2D || code >= 0x80;
}

function localName(qualified) {
    const colon = qualified.indexOf(':');
    return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

// Texto de CDATA volta escapado, para que todo texto chegue do mesmo jeito (com
// entidades) a decodeXmlText.
function escapeXmlTextForDecode(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// walkXml(xml, { open(nome, atributos, fechado, caminho), close(nome, caminho),
// text(texto, caminho) }): `nome` sem o prefixo de namespace; `atributos` é o trecho cru
// (para parseAttributes); `caminho` são os nomes dos elementos acima (no text, o último
// é o elemento que contém o texto). Comentários e instruções são pulados; CDATA vira
// texto. DOCTYPE é recusado (o Excel não grava, e assim não há entidade declarada).
function walkXml(xml, { open, close, text } = {}) {
    const source = xml || '';
    const length = source.length;
    const qualifiedStack = [];
    const path = [];
    let pos = 0;
    while (pos < length) {
        const lt = source.indexOf('<', pos);
        const textEnd = lt < 0 ? length : lt;
        if (textEnd > pos && text && path.length) text(source.slice(pos, textEnd), path);
        if (lt < 0) break;
        const next = source.charCodeAt(lt + 1);
        if (next === 0x21 /* ! */) {
            if (source.startsWith('<!--', lt)) {
                const end = source.indexOf('-->', lt + 4);
                if (end < 0) throw xmlError();
                pos = end + 3;
                continue;
            }
            if (source.startsWith('<![CDATA[', lt)) {
                const end = source.indexOf(']]>', lt + 9);
                if (end < 0) throw xmlError();
                if (text && path.length && end > lt + 9) text(escapeXmlTextForDecode(source.slice(lt + 9, end)), path);
                pos = end + 3;
                continue;
            }
            throw xmlError();
        }
        if (next === 0x3F /* ? */) {
            const end = source.indexOf('?>', lt + 2);
            if (end < 0) throw xmlError();
            pos = end + 2;
            continue;
        }
        if (next === 0x2F /* / */) {
            const end = source.indexOf('>', lt + 2);
            if (end < 0) throw xmlError();
            const qualified = source.slice(lt + 2, end).trim();
            if (!qualifiedStack.length || qualifiedStack[qualifiedStack.length - 1] !== qualified) throw xmlError();
            qualifiedStack.pop();
            const name = path.pop();
            if (close) close(name, path);
            pos = end + 1;
            continue;
        }
        let index = lt + 1;
        while (index < length && isXmlNameChar(source.charCodeAt(index))) index += 1;
        if (index === lt + 1) throw xmlError();
        const qualified = source.slice(lt + 1, index);
        const attrStart = index;
        let quote = 0;
        while (index < length) {
            const code = source.charCodeAt(index);
            if (quote) {
                if (code === quote) quote = 0;
            } else if (code === 0x22 || code === 0x27) {
                quote = code;
            } else if (code === 0x3E /* > */) {
                break;
            } else if (code === 0x3C /* < */) {
                throw xmlError();
            }
            index += 1;
        }
        if (index >= length) throw xmlError();
        const selfClosing = source.charCodeAt(index - 1) === 0x2F && index - 1 >= attrStart;
        const attrs = source.slice(attrStart, selfClosing ? index - 1 : index);
        const name = localName(qualified);
        if (open) open(name, attrs, selfClosing, path);
        if (selfClosing) {
            if (close) close(name, path);
        } else {
            if (path.length >= XML_MAX_DEPTH) throw xmlError();
            qualifiedStack.push(qualified);
            path.push(name);
        }
        pos = index + 1;
    }
    if (path.length) throw xmlError();
}

// Atributos de uma abertura de elemento, também num laço só. Cada atributo fica pelo
// nome completo (r:id) e, se ainda não houver, pelo nome sem prefixo (id).
function parseAttributes(source) {
    const attrs = {};
    const text = source || '';
    const length = text.length;
    let index = 0;
    while (index < length) {
        while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;
        if (index >= length) break;
        const start = index;
        while (index < length && isXmlNameChar(text.charCodeAt(index))) index += 1;
        if (index === start) throw xmlError();
        const name = text.slice(start, index);
        while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;
        if (text[index] !== '=') throw xmlError();
        index += 1;
        while (index < length && isXmlSpace(text.charCodeAt(index))) index += 1;
        const quote = text[index];
        if (quote !== '"' && quote !== "'") throw xmlError();
        const end = text.indexOf(quote, index + 1);
        if (end < 0) throw xmlError();
        const value = decodeXmlText(text.slice(index + 1, end));
        attrs[name] = value;
        const local = localName(name);
        if (!(local in attrs)) attrs[local] = value;
        index = end + 1;
    }
    return attrs;
}

// Atributo com prefixo de namespace (r:id), qualquer que seja o prefixo.
function prefixedAttribute(attrs, localNameWanted) {
    const key = Object.keys(attrs).find(name => name.includes(':') && localName(name) === localNameWanted);
    return key ? attrs[key] : '';
}

// Junta os trechos de texto de um elemento (o texto pode vir partido por comentário
// ou CDATA) e decodifica uma vez.
function joinXmlText(parts) {
    return parts.length === 1 ? decodeXmlText(parts[0]) : decodeXmlText(parts.join(''));
}

function columnIndex(letters) {
    let index = 0;
    for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
    return index; // 1 = A
}

function columnLetter(index) {
    let number = index;
    let out = '';
    while (number > 0) {
        const rest = (number - 1) % 26;
        out = String.fromCharCode(65 + rest) + out;
        number = Math.floor((number - 1) / 26);
    }
    return out;
}

// ------------------------------------------------------------ números e datas
const BUILTIN_FORMATS = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
    12: '# ?/?', 13: '# ??/??', 14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM',
    19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};
// Formatos de data de outros idiomas (27 a 36, 50 a 58) e os de data do Excel.
const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);

// Formato sem os textos entre aspas, os caracteres escapados e os colchetes de cor e
// idioma (o [h] de hora corrida fica).
function bareFormat(code) {
    return String(code || '')
        .split(';')[0]
        .replace(/"[^"]*"/g, '')
        .replace(/\\./g, '')
        .replace(/_./g, '')
        .replace(/\*./g, '')
        .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
}

function classifyFormat(numFmtId, code) {
    if (BUILTIN_DATE_IDS.has(numFmtId)) return { kind: 'date', time: numFmtId === 22, seconds: false, dateParts: true };
    if (BUILTIN_TIME_IDS.has(numFmtId)) return { kind: 'date', time: true, seconds: [19, 21, 46].includes(numFmtId), dateParts: false, elapsed: numFmtId === 46 };
    // O Excel não aceita formato com mais de 255 caracteres; um maior só viria de arquivo
    // feito para travar a leitura (as expressões abaixo não são lineares).
    if (String(code || '').length > 255) return { kind: 'general' };
    const bare = bareFormat(code);
    if (!bare || /^general$/i.test(bare.trim()) || bare.trim() === '@') return { kind: 'general' };
    if (/[dy]/i.test(bare) || /[hs]/i.test(bare) || /\[[hms]+\]/i.test(bare) || (/m/i.test(bare) && !/[0#?]/.test(bare))) {
        const dateParts = /[dy]/i.test(bare) || (/m/i.test(bare) && !/[hs]/i.test(bare));
        const time = /[hs]/i.test(bare);
        return { kind: 'date', time, seconds: /s/i.test(bare), dateParts, elapsed: /\[h+\]/i.test(bare) };
    }
    if (/E[+-]/i.test(bare) || /\?/.test(bare)) return { kind: 'general' };
    const numberPart = /[#0,]*[0#](?:\.([0#]*))?/.exec(bare);
    if (!numberPart) return { kind: 'general' };
    // "0,0#": uma casa sempre, a segunda só quando há.
    const fraction = numberPart[1] || '';
    const decimals = fraction.length;
    const minDecimals = (/^0*/.exec(fraction) || [''])[0].length;
    const grouping = /[#0],[#0]/.test(bare);
    return { kind: bare.includes('%') ? 'percent' : 'fixed', decimals, minDecimals, grouping };
}

function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(Number((value * factor).toPrecision(15))) / factor;
}

function withCommaDecimal(text, grouping) {
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    const [integer, fraction] = body.split('.');
    const grouped = grouping ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.') : integer;
    return (negative ? '-' : '') + grouped + (fraction !== undefined ? ',' + fraction : '');
}

function generalNumber(value) {
    const clean = Number(value.toPrecision(15));
    const text = Object.is(clean, -0) ? '0' : String(clean);
    if (/e/i.test(text)) return text.replace('.', ',');
    return withCommaDecimal(text, false);
}

function pad2(value) { return String(value).padStart(2, '0'); }

// Número serial do Excel para data e hora (sem fuso: é o relógio que a pessoa digitou).
function serialToParts(serial, date1904) {
    let days = serial;
    if (date1904) days += 1462;
    // Sistema 1900: o Excel conta o 29/02/1900, que não existe.
    const epoch = (!date1904 && days < 61) ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const totalSeconds = Math.round(days * 86400);
    const date = new Date(epoch + totalSeconds * 1000);
    return {
        year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
        hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(),
        totalSeconds,
    };
}

function formatDateValue(serial, format, date1904) {
    if (!Number.isFinite(serial) || serial < 0 || serial > 2958466) return generalNumber(serial);
    const parts = serialToParts(serial, date1904);
    const dateText = `${pad2(parts.day)}/${pad2(parts.month)}/${String(parts.year).padStart(4, '0')}`;
    let hours = parts.hour;
    if (format.elapsed) hours = Math.floor(Math.round(serial * 86400) / 3600);
    const timeText = `${pad2(hours)}:${pad2(parts.minute)}${format.seconds ? ':' + pad2(parts.second) : ''}`;
    if (format.dateParts && format.time) return `${dateText} ${timeText}`;
    if (format.dateParts) return dateText;
    return timeText;
}

function formatNumberCell(raw, format, date1904) {
    const value = Number(String(raw).trim());
    if (String(raw).trim() === '' || !Number.isFinite(value)) return decodeXmlText(String(raw));
    if (!format || format.kind === 'general') return generalNumber(value);
    if (format.kind === 'date') return formatDateValue(value, format, date1904);
    const scaled = format.kind === 'percent' ? value * 100 : value;
    let text = roundTo(scaled, format.decimals).toFixed(format.decimals);
    const minDecimals = Number.isInteger(format.minDecimals) ? format.minDecimals : format.decimals;
    if (minDecimals < format.decimals) {
        const [integer, fraction = ''] = text.split('.');
        let kept = fraction;
        while (kept.length > minDecimals && kept.endsWith('0')) kept = kept.slice(0, -1);
        text = kept ? `${integer}.${kept}` : integer;
    }
    return withCommaDecimal(text, format.grouping) + (format.kind === 'percent' ? '%' : '');
}

// t="d": data ISO 8601 gravada como texto (planilhas "strict").
function formatIsoDateCell(raw) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(raw || '').trim());
    if (!match) return String(raw || '');
    const date = `${match[3]}/${match[2]}/${match[1]}`;
    if (!match[4] || (match[4] === '00' && match[5] === '00' && (!match[6] || match[6] === '00'))) return date;
    return `${date} ${match[4]}:${match[5]}`;
}

// ------------------------------------------------------------ leitura do XLSX
function openZip(buffer) {
    let AdmZip;
    try { AdmZip = require('adm-zip'); } catch (error) { AdmZip = null; }
    if (!AdmZip) throw new TabularFileError('Este computador não consegue abrir arquivos .xlsx agora. Envie a planilha em CSV.', 'xlsx_unavailable');
    let zip;
    try {
        zip = new AdmZip(buffer);
        zip.getEntries();
    } catch (error) {
        throw new TabularFileError(`Não foi possível abrir a planilha do Excel: o arquivo parece danificado. ${SALVE_COMO}`, 'invalid_xlsx');
    }
    return zip;
}

function createZipReader(zip) {
    const byName = new Map();
    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        byName.set(String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(), entry);
    }
    let totalRead = 0;
    return {
        has(name) { return byName.has(name.toLowerCase()); },
        read(name) {
            const entry = byName.get(name.toLowerCase());
            if (!entry) return null;
            const header = entry.header || {};
            if (header.encrypted || (Number(header.flags) & 1)) {
                throw new TabularFileError(`A planilha está protegida por senha. Tire a senha no Excel e envie de novo. ${SALVE_COMO}`, 'encrypted_spreadsheet');
            }
            const declared = Number(header.size) || 0;
            const remaining = LIMITES.maxTotalXml - totalRead;
            const limit = Math.min(LIMITES.maxParteXml, remaining);
            if (declared > limit) throw zipBombError();
            let compressed;
            try {
                compressed = entry.getCompressedData();
            } catch (error) {
                throw new TabularFileError(`Não foi possível abrir a planilha do Excel: o arquivo parece danificado. ${SALVE_COMO}`, 'invalid_xlsx');
            }
            let data;
            const method = Number(header.method);
            if (method === 0) {
                data = compressed;
            } else if (method === 8) {
                try {
                    data = zlib.inflateRawSync(compressed, { maxOutputLength: limit + 1 });
                } catch (error) {
                    if (error && (error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError)) throw zipBombError();
                    throw new TabularFileError(`Não foi possível abrir a planilha do Excel: o arquivo parece danificado. ${SALVE_COMO}`, 'invalid_xlsx');
                }
            } else {
                throw new TabularFileError(`A planilha usa uma compactação que o IClass não abre. ${SALVE_COMO}`, 'invalid_xlsx');
            }
            if (data.length > limit) throw zipBombError();
            totalRead += data.length;
            if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) return data.subarray(2).toString('utf16le');
            if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) return data.subarray(3).toString('utf8');
            return data.toString('utf8');
        },
    };
}

function zipBombError() {
    return new TabularFileError('A planilha descompactada é grande demais para importar. Divida em arquivos menores ou envie em CSV.', 'spreadsheet_too_large', { status: 413 });
}

function resolvePartPath(base, target) {
    const clean = String(target || '').replace(/\\/g, '/');
    const parts = (clean.startsWith('/') ? clean.slice(1) : `${base}/${clean}`).split('/');
    const out = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
}

function readRelationships(reader, path) {
    const xml = reader.read(path);
    const rels = new Map();
    if (!xml) return rels;
    walkXml(xml, {
        open(name, rawAttrs) {
            if (name !== 'Relationship') return;
            const attrs = parseAttributes(rawAttrs);
            if (attrs.Id) rels.set(attrs.Id, { type: String(attrs.Type || ''), target: attrs.Target || '' });
        },
    });
    return rels;
}

function readStyles(reader, path) {
    const xml = path ? reader.read(path) : null;
    if (!xml) return [];
    const custom = new Map();
    const xfFormatIds = [];
    walkXml(xml, {
        open(name, rawAttrs, selfClosing, parents) {
            const parent = parents[parents.length - 1];
            if (name === 'numFmt' && parent === 'numFmts') {
                const attrs = parseAttributes(rawAttrs);
                custom.set(Number(attrs.numFmtId), attrs.formatCode || '');
            } else if (name === 'xf' && parent === 'cellXfs') {
                // Só a abertura importa (numFmtId); o <xf> de cellStyleXfs não conta.
                xfFormatIds.push(Number(parseAttributes(rawAttrs).numFmtId) || 0);
            }
        },
    });
    return xfFormatIds.map(id => {
        const code = custom.has(id) ? custom.get(id) : (BUILTIN_FORMATS[id] || 'General');
        return classifyFormat(custom.has(id) ? -1 : id, code);
    });
}

// Texto de um <si> ou <is>: os <t> em ordem (também os de dentro de <r>, o rich text),
// sem a leitura fonética (<rPh>). `collector` é usado dentro do walkXml.
function createRichTextCollector() {
    let parts = null;
    let phonetic = 0;
    let textParts = null;
    return {
        start() { parts = []; phonetic = 0; textParts = null; },
        get active() { return parts !== null; },
        open(name, selfClosing) {
            if (parts === null) return;
            if (name === 'rPh' && !selfClosing) phonetic += 1;
            else if (name === 't' && !phonetic && !selfClosing) textParts = [];
        },
        text(raw, parents) {
            if (textParts && parents[parents.length - 1] === 't') textParts.push(raw);
        },
        close(name) {
            if (parts === null) return;
            if (name === 'rPh' && phonetic) phonetic -= 1;
            else if (name === 't' && textParts) { parts.push(joinXmlText(textParts)); textParts = null; }
        },
        finish() { const value = (parts || []).join(''); parts = null; return value; },
    };
}

function readSharedStrings(reader, path) {
    const xml = path ? reader.read(path) : null;
    if (!xml) return [];
    const strings = [];
    const rich = createRichTextCollector();
    walkXml(xml, {
        open(name, rawAttrs, selfClosing) {
            if (name === 'si' && !rich.active) {
                rich.start();
                if (selfClosing) strings.push(rich.finish());
                return;
            }
            rich.open(name, selfClosing);
        },
        text(raw, parents) { rich.text(raw, parents); },
        close(name) {
            if (name === 'si' && rich.active) { strings.push(rich.finish()); return; }
            rich.close(name);
        },
    });
    return strings;
}

// cell: { attrs (já lidos), raw (texto cru do <v>), hasFormula, inline (texto do <is> ou null) }
function cellValue(cell, context) {
    const attrs = cell.attrs;
    const type = attrs.t || 'n';
    const raw = cell.raw;
    if (type === 'inlineStr') return cell.inline !== null ? cell.inline : decodeXmlText(raw);
    // Fórmula sem o resultado guardado (o openpyxl grava <v></v>): fica vazia, com aviso.
    // Fórmula de texto (t="str") que dá "" é resultado de verdade.
    if (cell.hasFormula && String(raw).trim() === '' && type !== 'str') {
        context.formulasSemValor += 1;
        return '';
    }
    if (type === 's') {
        const text = String(raw).trim();
        const index = Number(text);
        return text !== '' && Number.isInteger(index) && index >= 0 && index < context.sharedStrings.length ? context.sharedStrings[index] : '';
    }
    if (type === 'str' || type === 'e') return decodeXmlText(raw);
    if (type === 'b') {
        const text = String(raw).trim();
        if (text === '') return '';
        return text === '1' || text.toLowerCase() === 'true' ? 'VERDADEIRO' : 'FALSO';
    }
    if (type === 'd') return formatIsoDateCell(decodeXmlText(raw));
    const styleIndex = Number(attrs.s) || 0;
    return formatNumberCell(raw, context.styles[styleIndex], context.date1904);
}

function parseXlsx(buffer, limits) {
    const zip = openZip(buffer);
    const reader = createZipReader(zip);
    if (!reader.has('xl/workbook.xml')) {
        if (reader.has('mimetype') || reader.has('content.xml')) {
            throw new TabularFileError('Esta é uma planilha do LibreOffice (.ods). No LibreOffice, use "Salvar como" e escolha "Excel 2007-365 (.xlsx)" ou "CSV".', 'unsupported_format');
        }
        // Workbook com outro nome: o [Content_Types].xml e o _rels/.rels dizem onde está.
        const rootRels = readRelationships(reader, '_rels/.rels');
        const office = [...rootRels.values()].find(rel => /\/officeDocument$/.test(rel.type));
        const target = office ? resolvePartPath('', office.target) : '';
        if (!target || !reader.has(target)) {
            throw new TabularFileError(`O arquivo não tem uma planilha do Excel. ${SALVE_COMO}`, 'invalid_xlsx');
        }
        return parseWorkbook(reader, target, limits);
    }
    return parseWorkbook(reader, 'xl/workbook.xml', limits);
}

function parseWorkbook(reader, workbookPath, limits) {
    const workbookXml = reader.read(workbookPath) || '';
    const baseDir = workbookPath.includes('/') ? workbookPath.slice(0, workbookPath.lastIndexOf('/')) : '';
    const relsPath = `${baseDir ? baseDir + '/' : ''}_rels/${workbookPath.slice(workbookPath.lastIndexOf('/') + 1)}.rels`;
    const rels = readRelationships(reader, relsPath);
    let prAttrs = null;
    const sheetAttrs = [];
    walkXml(workbookXml, {
        open(name, rawAttrs, selfClosing, parents) {
            if (name === 'workbookPr' && !prAttrs) prAttrs = parseAttributes(rawAttrs);
            else if (name === 'sheet' && parents[parents.length - 1] === 'sheets') sheetAttrs.push(parseAttributes(rawAttrs));
        },
    });
    prAttrs = prAttrs || {};
    const date1904 = prAttrs.date1904 === '1' || String(prAttrs.date1904).toLowerCase() === 'true';

    const sheets = sheetAttrs.map(attrs => {
        const relId = prefixedAttribute(attrs, 'id');
        const rel = rels.get(relId);
        return {
            name: attrs.name || '',
            hidden: attrs.state === 'hidden' || attrs.state === 'veryHidden',
            rel,
            path: rel ? resolvePartPath(baseDir, rel.target) : '',
        };
    });
    const worksheets = sheets.filter(sheet => sheet.rel && /\/worksheet$/.test(sheet.rel.type) && reader.has(sheet.path));
    let chosen = worksheets.find(sheet => !sheet.hidden) || worksheets[0];
    if (!chosen && !sheets.length) {
        // Sem a lista de abas: o caminho de sempre.
        const fallback = `${baseDir ? baseDir + '/' : ''}worksheets/sheet1.xml`;
        if (reader.has(fallback)) chosen = { name: '', path: fallback, hidden: false };
    }
    if (!chosen) throw new TabularFileError(`A planilha não tem nenhuma aba com dados. ${SALVE_COMO}`, 'invalid_xlsx');

    const relValues = [...rels.values()];
    const sharedRel = relValues.find(rel => /\/sharedStrings$/.test(rel.type));
    const stylesRel = relValues.find(rel => /\/styles$/.test(rel.type));
    const sharedPath = sharedRel ? resolvePartPath(baseDir, sharedRel.target) : `${baseDir ? baseDir + '/' : ''}sharedStrings.xml`;
    const stylesPath = stylesRel ? resolvePartPath(baseDir, stylesRel.target) : `${baseDir ? baseDir + '/' : ''}styles.xml`;
    const context = {
        sharedStrings: readSharedStrings(reader, sharedPath),
        styles: readStyles(reader, stylesPath),
        date1904,
        formulasSemValor: 0,
    };

    const sheetXml = reader.read(chosen.path) || '';
    const rows = [];
    let dataRows = 0;
    let previousRow = 0;
    let sheetDataDone = false;
    let inSheetData = false;
    // Linha e célula em leitura (a aba é lida aos poucos, sem montar a árvore do XML).
    let row = null;
    let cell = null;
    let valueParts = null;
    const rich = createRichTextCollector();

    const finishCell = () => {
        const current = cell;
        cell = null;
        const cellAttrs = current.attrs;
        const ref = /^([A-Za-z]{1,3})\d*$/.exec(String(cellAttrs.r || ''));
        const column = ref ? columnIndex(ref[1]) : row.previousColumn + 1;
        row.previousColumn = column;
        const value = cellValue(current, context);
        if (value === '') return;
        if (column > limits.maxColunas) throw tooManyColumns(limits.maxColunas, row.number);
        while (row.values.length < column - 1) row.values.push('');
        row.values[column - 1] = value;
        if (value.trim() !== '') row.hasContent = true;
    };
    const finishRow = () => {
        const current = row;
        row = null;
        if (!current.hasContent) return;
        rows.push({ numero: current.number, valores: current.values });
        dataRows += 1;
        // Cabeçalho + maxLinhas: não precisa ler o resto para recusar.
        if (dataRows > limits.maxLinhas + 1) throw tooManyRows(limits.maxLinhas);
    };

    walkXml(sheetXml, {
        open(name, rawAttrs, selfClosing, parents) {
            if (sheetDataDone) return;
            const parent = parents[parents.length - 1];
            if (name === 'sheetData') {
                if (selfClosing) sheetDataDone = true; else inSheetData = true;
                return;
            }
            if (!inSheetData) return;
            if (name === 'row' && parent === 'sheetData') {
                const rowAttrs = parseAttributes(rawAttrs);
                const number = Number(rowAttrs.r) > 0 ? Number(rowAttrs.r) : previousRow + 1;
                previousRow = number;
                row = { number, values: [], previousColumn: 0, hasContent: false };
                if (selfClosing) finishRow();
                return;
            }
            if (!row) return;
            if (name === 'c' && parent === 'row') {
                cell = { attrs: parseAttributes(rawAttrs), raw: '', hasFormula: false, inline: null, hasValue: false };
                if (selfClosing) finishCell();
                return;
            }
            if (!cell) return;
            if (name === 'v' && parent === 'c') {
                if (!cell.hasValue && !selfClosing) valueParts = [];
                cell.hasValue = true;
            } else if (name === 'f' && parent === 'c') {
                cell.hasFormula = true;
            } else if (name === 'is' && parent === 'c' && !rich.active) {
                rich.start();
                if (selfClosing) cell.inline = rich.finish();
            } else {
                rich.open(name, selfClosing);
            }
        },
        text(raw, parents) {
            if (!cell) return;
            if (valueParts && parents[parents.length - 1] === 'v') valueParts.push(raw);
            else rich.text(raw, parents);
        },
        close(name, parents) {
            if (sheetDataDone) return;
            const parent = parents[parents.length - 1];
            if (name === 'sheetData' && inSheetData) { inSheetData = false; sheetDataDone = true; return; }
            if (!row) return;
            if (name === 'row' && parent === 'sheetData') { finishRow(); return; }
            if (!cell) return;
            if (name === 'c' && parent === 'row') { finishCell(); return; }
            if (name === 'v' && parent === 'c' && valueParts) { cell.raw = valueParts.join(''); valueParts = null; return; }
            if (name === 'is' && parent === 'c' && rich.active) { cell.inline = rich.finish(); return; }
            rich.close(name);
        },
    });

    const avisos = [];
    const visibleSheets = sheets.filter(sheet => !sheet.hidden);
    if (visibleSheets.length > 1) {
        avisos.push(`A planilha tem ${visibleSheets.length} abas; só a primeira ("${chosen.name}") foi lida.`);
    }
    if (context.formulasSemValor) {
        avisos.push(`${context.formulasSemValor === 1 ? '1 célula com fórmula ficou vazia' : `${context.formulasSemValor} células com fórmula ficaram vazias`} (o arquivo não guardou o resultado). Abra e salve a planilha no Excel antes de enviar.`);
    }
    return { formato: 'xlsx', separador: null, codificacao: null, planilha: chosen.name || null, rows, avisos };
}

function tooManyRows(maxLinhas) {
    return new TabularFileError(`A planilha tem mais de ${formatCount(maxLinhas)} linhas com dados. Divida em arquivos menores.`, 'too_many_rows');
}

function tooManyColumns(maxColunas, linha) {
    return new TabularFileError(`A planilha tem mais de ${formatCount(maxColunas)} colunas (linha ${linha}). Apague as colunas que não fazem parte da importação.`, 'too_many_columns', { linha });
}

// ------------------------------------------------------------ entrada única
// parseTabularFile(buffer, { nomeArquivo, maxLinhas, maxColunas, maxBytes, cabecalho })
// => { formato: 'csv'|'xlsx', separador, codificacao, planilha, cabecalho: string[],
//      linhas: [{ numero, valores: string[] }], totalColunas, sha256, avisos }
// `cabecalho: false` devolve todas as linhas em `linhas` (cabecalho fica []). As linhas
// vêm completadas com '' até totalColunas; linha só com espaços não entra.
function parseTabularFile(buffer, options = {}) {
    const limits = {
        maxBytes: positiveLimit(options.maxBytes, LIMITES.maxBytes),
        maxLinhas: positiveLimit(options.maxLinhas, LIMITES.maxLinhas),
        maxColunas: positiveLimit(options.maxColunas, LIMITES.maxColunas),
    };
    const withHeader = options.cabecalho !== false;
    if (!Buffer.isBuffer(buffer)) {
        if (buffer instanceof Uint8Array) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        else throw new TabularFileError('Nenhum arquivo foi enviado.', 'file_missing');
    }
    if (!buffer.length) throw new TabularFileError('O arquivo está vazio.', 'file_empty');
    if (buffer.length > limits.maxBytes) {
        const megabytes = limits.maxBytes / (1024 * 1024);
        const sizeText = Number.isInteger(megabytes) ? String(megabytes) : megabytes.toFixed(1).replace('.', ',');
        throw new TabularFileError(`O arquivo passa de ${sizeText} MB. Divida a planilha em arquivos menores.`, 'file_too_large', { status: 413 });
    }
    const extension = extensionOf(options.nomeArquivo);
    const head = buffer.subarray(0, 8);
    const isZip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4B && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
    const isOle = head.length >= 8 && head.readUInt32BE(0) === 0xD0CF11E0 && head.readUInt32BE(4) === 0xA1B11AE1;

    let parsed;
    if (isOle) {
        throw new TabularFileError(`A planilha é do formato antigo do Excel (.xls) ou está protegida por senha. ${SALVE_COMO}`, 'unsupported_format');
    } else if (isZip) {
        parsed = parseXlsx(buffer, limits);
    } else if (head.toString('latin1', 0, 5) === '%PDF-') {
        throw new TabularFileError(`O arquivo é um PDF, não uma planilha. ${SALVE_COMO}`, 'unsupported_format');
    } else if (XLSX_EXTENSIONS.has(extension)) {
        throw new TabularFileError(`O arquivo tem o nome de uma planilha do Excel (.${extension}), mas não é uma. ${SALVE_COMO}`, 'invalid_xlsx');
    } else if (extension && !TEXT_EXTENSIONS.has(extension)) {
        throw new TabularFileError(`Envie a planilha em CSV ou XLSX (o arquivo é .${extension}). ${SALVE_COMO}`, 'unsupported_format');
    } else {
        parsed = parseCsvText(buffer);
    }

    const rows = [];
    let totalColunas = 0;
    for (const row of parsed.rows) {
        const values = row.valores.map(value => {
            const text = String(value == null ? '' : value);
            return text.length > LIMITES.maxTextoCelula ? text.slice(0, LIMITES.maxTextoCelula) : text;
        });
        let last = values.length;
        while (last > 0 && values[last - 1].trim() === '') last -= 1;
        if (!last) continue;
        if (last > limits.maxColunas) throw tooManyColumns(limits.maxColunas, row.numero);
        const trimmed = values.slice(0, last);
        totalColunas = Math.max(totalColunas, trimmed.length);
        rows.push({ numero: row.numero, valores: trimmed });
        if (rows.length > limits.maxLinhas + (withHeader ? 1 : 0)) throw tooManyRows(limits.maxLinhas);
    }
    for (const row of rows) while (row.valores.length < totalColunas) row.valores.push('');
    const cabecalho = withHeader && rows.length ? rows.shift().valores : [];
    return {
        formato: parsed.formato,
        separador: parsed.separador,
        codificacao: parsed.codificacao,
        planilha: parsed.planilha,
        cabecalho,
        linhas: rows,
        totalColunas,
        sha256: fileSha256(buffer),
        avisos: parsed.avisos,
    };
}

// ------------------------------------------------------------ gravação do XLSX
// buildXlsx(linhas, { nomePlanilha, cabecalho, formatos }) => Buffer (.xlsx, uma aba).
// Célula: número (célula de número), texto, true/false, null/undefined/'' (vazia).
// `formatos[i]` vale para a coluna i: 'texto' (sempre texto, para matrícula e telefone
// não perderem o zero da frente), 'numero', 'inteiro' (0), 'nota' ou 'decimal1' (0,0),
// 'decimal2' (0,00), 'data' ('AAAA-MM-DD' ou 'dd/mm/aaaa' viram data dd/mm/aaaa) e
// 'dataHora' ('AAAA-MM-DD HH:MM[:SS]', ou com T). Instante em ms deve chegar já como
// texto da hora da escola (utils/schoolTime.js), porque a planilha não tem fuso.
// O cabeçalho sai em negrito, com a primeira linha fixa ao rolar.
// Texto que começa com "=" fica texto (célula de texto não é fórmula no XLSX): ao
// contrário do CSV, não precisa do apóstrofo do csvSafe.
const STYLE = { padrao: 0, cabecalho: 1, decimal1: 2, decimal2: 3, inteiro: 4, data: 5, dataHora: 6, texto: 7 };
const FORMAT_ALIASES = { nota: 'decimal1', decimal1: 'decimal1', decimal2: 'decimal2', inteiro: 'inteiro', numero: 'padrao', data: 'data', dataHora: 'dataHora', texto: 'texto' };

function xmlEscape(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Texto para dentro de <t>: tira o que o XML não aceita e protege o "_xHHHH_" literal.
function xmlCellText(value) {
    let text = String(value);
    if (text.length > LIMITES.maxTextoCelula) text = text.slice(0, LIMITES.maxTextoCelula);
    text = text.replace(/_(x[0-9a-fA-F]{4}_)/g, '_x005F_$1');
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, char => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
    text = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
    return xmlEscape(text);
}

function safeSheetName(name) {
    const clean = String(name || '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F\uFFFE\uFFFF]/g, ' ')
        .replace(/[[\]:*?/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^'+|'+$/g, '')
        .slice(0, 31)
        // Metade de um par (emoji cortado no limite de 31) não vale no XML.
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1')
        .trim();
    return clean || 'Planilha';
}

function dateSerial(year, month, day, hour = 0, minute = 0, second = 0) {
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    let serial = (ms - Date.UTC(1899, 11, 30)) / 86400000;
    if (serial < 61) serial -= 1; // o 29/02/1900 do Excel
    return serial >= 1 ? serial : null;
}

function parseDateText(value, withTime) {
    const text = String(value).trim();
    let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
    if (match) {
        return dateSerial(Number(match[1]), Number(match[2]), Number(match[3]), withTime ? Number(match[4] || 0) : 0, withTime ? Number(match[5] || 0) : 0, withTime ? Number(match[6] || 0) : 0);
    }
    match = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
    if (match) {
        return dateSerial(Number(match[3]), Number(match[2]), Number(match[1]), withTime ? Number(match[4] || 0) : 0, withTime ? Number(match[5] || 0) : 0, withTime ? Number(match[6] || 0) : 0);
    }
    return null;
}

function numberText(value) {
    const clean = Number(value.toPrecision(15));
    return Object.is(clean, -0) ? '0' : String(clean);
}

function cellXml(ref, value, formatName, isHeader) {
    if (value === null || value === undefined || value === '') return '';
    if (isHeader) return `<c r="${ref}" t="inlineStr" s="${STYLE.cabecalho}"><is><t xml:space="preserve">${xmlCellText(value)}</t></is></c>`;
    const format = FORMAT_ALIASES[formatName] || null;
    if (format === 'data' || format === 'dataHora') {
        const serial = typeof value === 'string' ? parseDateText(value, format === 'dataHora') : null;
        if (serial !== null) return `<c r="${ref}" s="${STYLE[format]}"><v>${numberText(serial)}</v></c>`;
    }
    if (format !== 'texto' && typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        const style = format && format !== 'data' && format !== 'dataHora' ? STYLE[format] : STYLE.padrao;
        return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${numberText(value)}</v></c>`;
    }
    if (format !== 'texto' && typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
    const text = typeof value === 'boolean' ? (value ? 'VERDADEIRO' : 'FALSO') : String(value);
    if (text === '') return '';
    return `<c r="${ref}" t="inlineStr"${format === 'texto' ? ` s="${STYLE.texto}"` : ''}><is><t xml:space="preserve">${xmlCellText(text)}</t></is></c>`;
}

function columnWidths(allRows, totalColumns) {
    const widths = [];
    for (let column = 0; column < totalColumns; column += 1) {
        let longest = 0;
        for (const row of allRows) {
            const value = row[column];
            if (value === null || value === undefined) continue;
            const text = typeof value === 'number' ? numberText(value) : String(value);
            const longestLine = text.split(/\r?\n/).reduce((max, line) => Math.max(max, line.length), 0);
            longest = Math.max(longest, longestLine);
        }
        widths.push(Math.min(60, Math.max(8, longest + 2)));
    }
    return widths;
}

function buildXlsx(linhas, { nomePlanilha = 'Planilha', cabecalho = null, formatos = null } = {}) {
    const AdmZip = require('adm-zip');
    const dataRows = Array.isArray(linhas) ? linhas.map(row => (Array.isArray(row) ? row : [])) : [];
    const header = Array.isArray(cabecalho) && cabecalho.length ? cabecalho : null;
    const allRows = header ? [header, ...dataRows] : dataRows;
    if (allRows.length > EXCEL_MAX_ROWS) throw new TabularFileError(`A planilha passa do limite do Excel (${formatCount(EXCEL_MAX_ROWS)} linhas).`, 'too_many_rows');
    const totalColumns = allRows.reduce((max, row) => Math.max(max, row.length), 0);
    if (totalColumns > EXCEL_MAX_COLUMNS) throw new TabularFileError(`A planilha passa do limite do Excel (${formatCount(EXCEL_MAX_COLUMNS)} colunas).`, 'too_many_columns');
    const columnFormats = Array.isArray(formatos) ? formatos : [];

    const rowsXml = allRows.map((row, rowIndex) => {
        const number = rowIndex + 1;
        const isHeader = !!header && rowIndex === 0;
        const cells = row.map((value, columnIdx) => cellXml(`${columnLetter(columnIdx + 1)}${number}`, value, columnFormats[columnIdx], isHeader)).join('');
        return `<row r="${number}">${cells}</row>`;
    }).join('');
    const widths = columnWidths(allRows, totalColumns);
    const colsXml = widths.length
        ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
        : '';
    const lastRef = totalColumns && allRows.length ? `A1:${columnLetter(totalColumns)}${allRows.length}` : 'A1';
    const paneXml = header && allRows.length > 1
        ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>'
        : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    const sheetName = safeSheetName(nomePlanilha);

    const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
            + '</Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
            + '</Relationships>',
        'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>IClass</Application></Properties>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + '<bookViews><workbookView/></bookViews>'
            + `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
            + '</workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            + '</Relationships>',
        'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy hh:mm"/></numFmts>'
            + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
            + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            + '<cellXfs count="8">'
            + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '</cellXfs>'
            + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            + '</styleSheet>',
        'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            + `<dimension ref="${lastRef}"/>`
            + paneXml
            + '<sheetFormatPr defaultRowHeight="15"/>'
            + colsXml
            + `<sheetData>${rowsXml}</sheetData>`
            + '</worksheet>',
    };
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content, 'utf8'));
    return zip.toBuffer();
}

module.exports = {
    LIMITES,
    XLSX_CONTENT_TYPE,
    TabularFileError,
    buildXlsx,
    columnLetter,
    fileSha256,
    parseTabularFile,
    // Para os testes.
    _internals: { classifyFormat, detectSeparator, decodeText, formatNumberCell, serialToParts, splitCsvRecords },
};
