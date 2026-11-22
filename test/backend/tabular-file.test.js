// Leitor e gravador de planilhas (fase 3, B3b; FUN-06, FUN-08, FUN-12): CSV e XLSX lidos
// por parseTabularFile e XLSX gravado por buildXlsx (backend/utils/tabularFile.js), sem
// pacote novo. As planilhas de test/backend/fixtures/planilhas/ foram feitas pelo
// openpyxl e pelo LibreOffice (ver o README.md da pasta).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const {
    LIMITES,
    TabularFileError,
    XLSX_CONTENT_TYPE,
    buildXlsx,
    columnLetter,
    fileSha256,
    parseTabularFile,
    _internals,
} = require('../../backend/utils/tabularFile.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'planilhas');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name));

// O que o Excel em português mostra em cada célula da planilha de alunos (a mesma
// tabela do gerar-planilhas.py).
const CABECALHO = ['Nome', 'E-mail', 'Matrícula', 'Data de nascimento', 'Nota', 'Valor', 'Frequência', 'Horário', 'Observação'];
const LINHAS = [
    ['João da Silva', 'joao@escola.local', '00123', '15/03/2008', '7,5', '1.234,50', '75%', '12:00', 'Começou em março'],
    ['Ângela Müller', 'angela@escola.local', '2024002', '29/02/2008', '10,0', '0,00', '100%', '07:30', 'Linha 1\nLinha 2'],
    ['Zé "Pequeno"', '', '2024003', '', '', '', '', '', 'célula vazia no meio; com ponto e vírgula'],
];

// No Windows, o git com core.autocrlf pode trocar \n por \r\n nos CSV de teste ao
// baixar o repositório (inclusive dentro da célula com quebra de linha).
const sameBreaks = rows => rows.map(values => values.map(value => value.replace(/\r\n/g, '\n')));

function expectError(fn, code, extra = {}) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    assert.ok(caught, `esperava o erro ${code}`);
    assert.ok(caught instanceof TabularFileError, `erro de planilha, não ${caught && caught.stack}`);
    assert.equal(caught.code, code, caught.message);
    assert.ok(caught.message && /[a-zà-ú]/i.test(caught.message), 'mensagem em português');
    for (const [key, value] of Object.entries(extra)) assert.equal(caught[key], value, `${key} de ${caught.message}`);
    return caught;
}

// XLSX montado à mão (para os casos que o Excel não grava, mas outros programas sim).
function handmadeXlsx(parts, { omit = [] } = {}) {
    const base = {
        '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Folha" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ...parts,
    };
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(base)) {
        if (omit.includes(name) || content === null) continue;
        zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    }
    return zip.toBuffer();
}

function sheetXml(rows) {
    return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
}

// Troca um campo do diretório central do ZIP (para simular arquivo malfeito).
function patchCentralEntry(buffer, entryName, patch) {
    const copy = Buffer.from(buffer);
    for (let offset = 0; offset < copy.length - 46; offset += 1) {
        if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
        const nameLength = copy.readUInt16LE(offset + 28);
        const name = copy.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (name === entryName) { patch(copy, offset); return copy; }
    }
    throw new Error(`entrada ${entryName} não encontrada`);
}

function sofficeAvailable() {
    const probe = spawnSync('soffice', ['--version'], { encoding: 'utf8', timeout: 60000 });
    return probe.status === 0;
}

// Converte com o LibreOffice sem interface, num perfil próprio (outros testes podem estar
// usando o LibreOffice ao mesmo tempo).
function sofficeConvert(file, filter, outDir) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-soffice-'));
    try {
        const result = spawnSync('soffice', [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', filter, '--outdir', outDir, file], { encoding: 'utf8', timeout: 180000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
        fs.rmSync(profile, { recursive: true, force: true });
    }
}

test('XLSX do openpyxl e do LibreOffice e os CSV do Excel (ANSI, UTF-8, vírgula, Unicode) dão as mesmas células', () => {
    const casos = [
        ['alunos-openpyxl.xlsx', { formato: 'xlsx', planilha: 'Alunos' }],
        ['alunos-libreoffice.xlsx', { formato: 'xlsx', planilha: 'Alunos' }],
        ['alunos-excel-ansi.csv', { formato: 'csv', separador: ';', codificacao: 'windows-1252' }],
        ['alunos-excel-utf8.csv', { formato: 'csv', separador: ';', codificacao: 'utf-8' }],
        ['alunos-virgula.csv', { formato: 'csv', separador: ',', codificacao: 'utf-8' }],
        ['alunos-unicode.txt', { formato: 'csv', separador: '\t', codificacao: 'utf-16' }],
    ];
    for (const [nome, esperado] of casos) {
        const resultado = parseTabularFile(fixture(nome), { nomeArquivo: nome });
        for (const [key, value] of Object.entries(esperado)) assert.equal(resultado[key], value, `${nome}: ${key}`);
        assert.deepEqual(resultado.cabecalho, CABECALHO, `${nome}: cabeçalho`);
        assert.deepEqual(sameBreaks(resultado.linhas.map(linha => linha.valores)), LINHAS, `${nome}: células`);
        assert.equal(resultado.totalColunas, CABECALHO.length);
        assert.equal(resultado.sha256, fileSha256(fixture(nome)));
    }
    // Numeração da planilha: a linha vazia do XLSX (4) é pulada sem mudar a da próxima;
    // no CSV, a célula com quebra de linha entre aspas não conta como linha a mais.
    assert.deepEqual(parseTabularFile(fixture('alunos-openpyxl.xlsx')).linhas.map(linha => linha.numero), [2, 3, 5]);
    assert.deepEqual(parseTabularFile(fixture('alunos-excel-ansi.csv')).linhas.map(linha => linha.numero), [2, 3, 4]);
    // Só a primeira aba, com aviso.
    assert.deepEqual(parseTabularFile(fixture('alunos-openpyxl.xlsx')).avisos, ['A planilha tem 2 abas; só a primeira ("Alunos") foi lida.']);
});

test('CSV do LibreOffice em inglês: separador, aspas, acentos e a linha vazia', () => {
    const resultado = parseTabularFile(fixture('alunos-libreoffice.csv'), { nomeArquivo: 'alunos-libreoffice.csv' });
    assert.equal(resultado.separador, ';');
    assert.deepEqual(resultado.cabecalho, CABECALHO);
    assert.deepEqual(resultado.linhas.map(linha => linha.numero), [2, 3, 5], 'a linha só com ";;;" é pulada');
    assert.deepEqual(resultado.linhas[0].valores, ['João da Silva', 'joao@escola.local', '00123', '15/03/2008', '7.5', '1,234.50', '75%', '12:00', 'Começou em março']);
    assert.equal(resultado.linhas[1].valores[8].replace('\r\n', '\n'), 'Linha 1\nLinha 2');
    assert.equal(resultado.linhas[2].valores[0], 'Zé "Pequeno"');
});

test('XLSX: texto com formatação, fórmula com e sem resultado, verdadeiro/falso, aba escondida e data do Mac', () => {
    const openpyxl = parseTabularFile(fixture('especiais-openpyxl.xlsx'));
    assert.equal(openpyxl.planilha, 'Dados', 'a primeira aba está escondida');
    assert.deepEqual(openpyxl.cabecalho, ['Nome', 'Conta', 'Ativo', 'Decimal', 'Inteiro grande']);
    assert.deepEqual(openpyxl.linhas.map(linha => linha.valores), [
        ['Ana Negrito Souza', '', 'VERDADEIRO', '0,3', '123456789012'],
        ['Bia', '', 'FALSO', '-2,5', '7'],
    ]);
    assert.equal(openpyxl.avisos.length, 1);
    assert.match(openpyxl.avisos[0], /1 célula com fórmula ficou vazia/);

    const libreoffice = parseTabularFile(fixture('especiais-libreoffice.xlsx'));
    assert.equal(libreoffice.planilha, 'Dados');
    assert.deepEqual(libreoffice.linhas.map(linha => linha.valores), [
        ['Ana Negrito Souza', '2', 'VERDADEIRO', '0,3', '123456789012'],
        ['Bia', '', 'FALSO', '-2,5', '7'],
    ], 'o LibreOffice guarda o resultado da fórmula');
    assert.deepEqual(libreoffice.avisos, []);

    const mac = parseTabularFile(fixture('data-1904-openpyxl.xlsx'));
    assert.deepEqual(mac.linhas.map(linha => linha.valores), [['01/03/2026']]);
});

test('XLSX montado à mão: inlineStr, sem r nas células, prefixo de namespace, rich text com leitura fonética, escapes e sem styles', () => {
    const buffer = handmadeXlsx({
        'xl/worksheets/sheet1.xml': '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>'
            + '<x:row><x:c t="inlineStr"><x:is><x:t>Nome</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Nota</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>Obs</x:t></x:is></x:c></x:row>'
            + '<x:row><x:c t="inlineStr"><x:is><x:r><x:t>Jo</x:t></x:r><x:r><x:t>ão</x:t></x:r><x:rPh sb="0" eb="1"><x:t>ジョ</x:t></x:rPh></x:is></x:c><x:c><x:v>8.25</x:v></x:c><x:c t="inlineStr"><x:is><x:t>a &amp; b &lt;c&gt; &#233; &#x00E7; linha_x000D__x000A_nova</x:t></x:is></x:c></x:row>'
            + '<x:row r="7"><x:c r="C7" t="str"><x:f>"x"</x:f><x:v>calc</x:v></x:c><x:c r="A7" t="e"><x:v>#DIV/0!</x:v></x:c></x:row>'
            + '</x:sheetData></x:worksheet>',
    });
    const resultado = parseTabularFile(buffer, { nomeArquivo: 'feito-a-mao.xlsx' });
    assert.equal(resultado.planilha, 'Folha');
    assert.deepEqual(resultado.cabecalho, ['Nome', 'Nota', 'Obs']);
    assert.deepEqual(resultado.linhas, [
        { numero: 2, valores: ['João', '8,25', 'a & b <c> é ç linha\r\nnova'] },
        { numero: 7, valores: ['#DIV/0!', '', 'calc'] },
    ]);
});

test('XLSX: formatos de número e data do Excel (datas seriais, 1900 com o 29/02, hora, porcentagem, milhar, moeda e texto)', () => {
    const styles = '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<numFmts count="4"><numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/><numFmt numFmtId="165" formatCode="[$-416]dd/mm/yyyy\\ hh:mm:ss"/><numFmt numFmtId="166" formatCode="0.0#"/><numFmt numFmtId="167" formatCode="[h]:mm"/></numFmts>'
        + '<cellXfs count="10"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="22"/><xf numFmtId="20"/><xf numFmtId="10"/><xf numFmtId="4"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="49"/><xf numFmtId="11"/></cellXfs></styleSheet>';
    const cells = [
        ['1', 1], ['59', 1], ['61', 1], ['45000', 1], ['45000.75', 2], ['0.3125', 3], ['0.1234', 4], ['1234567.891', 5],
        ['-1234.5', 6], ['45000.5', 7], ['3.14159', 8], ['1.5', 9], ['42', 10], ['12345', 11], ['0.1', 0], ['1E-3', 0],
        ['3.1', 8], ['3', 8], ['0.3333333333333333', 0], ['44197.999988', 2],
    ];
    const row = cells.map(([value, style], index) => `<c r="${columnLetter(index + 1)}2" s="${style}"><v>${value}</v></c>`).join('');
    const header = cells.map((_, index) => `<c r="${columnLetter(index + 1)}1" t="inlineStr"><is><t>c${index + 1}</t></is></c>`).join('');
    const buffer = handmadeXlsx({
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': styles,
        'xl/worksheets/sheet1.xml': sheetXml(`<row r="1">${header}</row><row r="2">${row}</row>`),
    });
    const resultado = parseTabularFile(buffer);
    assert.deepEqual(resultado.linhas[0].valores, [
        '01/01/1900', '28/02/1900', '01/03/1900', '15/03/2023', '15/03/2023 18:00', '07:30', '12,34%', '1.234.567,89',
        '-1.234,50', '15/03/2023 12:00:00', '3,14', '36:00', '42', '12345', '0,1', '0,001',
        '3,1', '3,0', '0,333333333333333', '01/01/2021 23:59',
    ]);
});

test('CSV: separador, "sep=", aspas, fins de linha, linhas e colunas vazias e cabecalho: false', () => {
    const ler = (texto, opcoes) => parseTabularFile(Buffer.from(texto, 'utf8'), opcoes);
    // ';' vence quando a vírgula é decimal; tabulação; vírgula.
    assert.equal(ler('Nome;Nota\nAna;7,5\nBia;8,0\n').separador, ';');
    assert.deepEqual(ler('Nome;Nota\nAna;7,5\n').linhas[0].valores, ['Ana', '7,5']);
    assert.equal(ler('Nome\tNota\nAna\t7,5\n').separador, '\t');
    assert.equal(ler('Nome,Nota\nAna,"7,5"\n').separador, ',');
    assert.deepEqual(ler('Nome,Nota\nAna,"7,5"\n').linhas[0].valores, ['Ana', '7,5']);
    // Uma coluna só (lista de e-mails): nada se divide.
    assert.deepEqual(ler('E-mail\nana@x.local\nbia@x.local').linhas.map(linha => linha.valores), [['ana@x.local'], ['bia@x.local']]);
    // "sep=" do Excel: vale e não vira linha.
    const sep = ler('sep=,\r\nNome,Obs\r\nAna,a;b\r\n');
    assert.equal(sep.separador, ',');
    assert.deepEqual(sep.cabecalho, ['Nome', 'Obs']);
    assert.deepEqual(sep.linhas, [{ numero: 2, valores: ['Ana', 'a;b'] }]);
    // Aspas: "" é aspa, separador e quebra dentro das aspas, aspa no meio de campo sem aspas.
    const aspas = ler('A;B;C\r\n"ele disse ""oi""";"x;y";meu "apelido"\r\n"duas\r\nlinhas";2;3\r\n');
    assert.deepEqual(aspas.linhas.map(linha => linha.valores), [['ele disse "oi"', 'x;y', 'meu "apelido"'], ['duas\r\nlinhas', '2', '3']]);
    assert.deepEqual(aspas.linhas.map(linha => linha.numero), [2, 3]);
    // \r sozinho (Mac antigo), \n e \r\n misturados; linha vazia e só com separadores puladas.
    const fins = ler('A;B\rum;1\n\n;;\r\ndois;2');
    assert.deepEqual(fins.linhas, [{ numero: 2, valores: ['um', '1'] }, { numero: 5, valores: ['dois', '2'] }]);
    // Colunas vazias no fim saem; linhas curtas são completadas.
    const colunas = ler('A;B;C;;\nx\ny;;z;;\n');
    assert.deepEqual(colunas.cabecalho, ['A', 'B', 'C']);
    assert.deepEqual(colunas.linhas.map(linha => linha.valores), [['x', '', ''], ['y', '', 'z']]);
    assert.equal(colunas.totalColunas, 3);
    // Sem cabeçalho: todas as linhas.
    const semCabecalho = ler('1;2\n3;4\n', { cabecalho: false });
    assert.deepEqual(semCabecalho.cabecalho, []);
    assert.deepEqual(semCabecalho.linhas.map(linha => linha.numero), [1, 2]);
    // Aspa sem fechar: erro com a linha onde começou.
    const erro = expectError(() => ler('A;B\nok;1\n"sem fim;2\nmais;3\n'), 'unclosed_quote');
    assert.equal(erro.linha, 3);
    assert.match(erro.message, /linha 3/);
    // BOM do UTF-8 não entra no primeiro nome do cabeçalho.
    assert.equal(parseTabularFile(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('Nome;Nota\nAna;1')])).cabecalho[0], 'Nome');
    // Windows-1252 com os caracteres da faixa 0x80-0x9F (€, aspas curvas, travessão).
    const ansi = parseTabularFile(Buffer.from([0x4E, 0x6F, 0x6D, 0x65, 0x0A, 0x80, 0x20, 0x93, 0x61, 0x94, 0x20, 0x96, 0x20, 0xC7, 0xE3]));
    assert.equal(ansi.codificacao, 'windows-1252');
    assert.deepEqual(ansi.linhas[0].valores, ['€ “a” – Çã']);
});

test('limites e arquivos que não são planilha: mensagens em português, sem ler o resto', () => {
    expectError(() => parseTabularFile(Buffer.alloc(0)), 'file_empty');
    expectError(() => parseTabularFile(null), 'file_missing');
    const grande = Buffer.alloc(LIMITES.maxBytes + 1, 'a');
    const tooLarge = expectError(() => parseTabularFile(grande, { nomeArquivo: 'alunos.csv' }), 'file_too_large', { status: 413 });
    assert.match(tooLarge.message, /2 MB/);
    // 500 linhas de dados passam; 501 não (o cabeçalho não conta).
    const linhas = count => ['Nome;Nota', ...Array.from({ length: count }, (_, index) => `Aluno ${index};5`)].join('\n');
    assert.equal(parseTabularFile(Buffer.from(linhas(500))).linhas.length, 500);
    const muitas = expectError(() => parseTabularFile(Buffer.from(linhas(501))), 'too_many_rows', { status: 400 });
    assert.match(muitas.message, /mais de 500 linhas/);
    expectError(() => parseTabularFile(Buffer.from(linhas(11)), { maxLinhas: 10 }), 'too_many_rows');
    // Colunas.
    const largo = Array.from({ length: 51 }, (_, index) => `c${index}`).join(';');
    expectError(() => parseTabularFile(Buffer.from(`${largo}\n`)), 'too_many_columns');
    assert.equal(parseTabularFile(Buffer.from(`${largo}\n`), { maxColunas: 60 }).totalColunas, 51);
    // XLSX com linhas e colunas demais.
    const xlsxRows = Array.from({ length: 502 }, (_, index) => `<row r="${index + 1}"><c t="inlineStr"><is><t>x${index}</t></is></c></row>`).join('');
    expectError(() => parseTabularFile(handmadeXlsx({ 'xl/worksheets/sheet1.xml': sheetXml(xlsxRows) })), 'too_many_rows');
    const xlsxWide = sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="AZ1" t="inlineStr"><is><t>longe</t></is></c></row>');
    const wide = expectError(() => parseTabularFile(handmadeXlsx({ 'xl/worksheets/sheet1.xml': xlsxWide })), 'too_many_columns');
    assert.equal(wide.linha, 1);
    // Célula formatada sem valor longe não conta como coluna.
    const styledEmpty = sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="XFD1" s="1"/></row>');
    assert.equal(parseTabularFile(handmadeXlsx({ 'xl/worksheets/sheet1.xml': styledEmpty })).totalColunas, 1);

    // Excel antigo ou com senha (arquivo OLE), PDF, ODS, Word, ZIP danificado, nome errado.
    const ole = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(512)]);
    assert.match(expectError(() => parseTabularFile(ole, { nomeArquivo: 'alunos.xls' }), 'unsupported_format').message, /\.xls|senha/);
    expectError(() => parseTabularFile(Buffer.from('%PDF-1.7\n...'), { nomeArquivo: 'alunos.pdf' }), 'unsupported_format');
    const ods = new AdmZip();
    ods.addFile('mimetype', Buffer.from('application/vnd.oasis.opendocument.spreadsheet'));
    ods.addFile('content.xml', Buffer.from('<office:document-content/>'));
    assert.match(expectError(() => parseTabularFile(ods.toBuffer(), { nomeArquivo: 'alunos.ods' }), 'unsupported_format').message, /LibreOffice/);
    const docx = new AdmZip();
    docx.addFile('word/document.xml', Buffer.from('<w:document/>'));
    expectError(() => parseTabularFile(docx.toBuffer(), { nomeArquivo: 'alunos.docx' }), 'invalid_xlsx');
    expectError(() => parseTabularFile(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 7)]), { nomeArquivo: 'alunos.xlsx' }), 'invalid_xlsx');
    expectError(() => parseTabularFile(Buffer.from('Nome;Nota\nAna;1\n'), { nomeArquivo: 'alunos.xlsx' }), 'invalid_xlsx');
    expectError(() => parseTabularFile(Buffer.from('Nome;Nota\nAna;1\n'), { nomeArquivo: 'foto.jpg' }), 'unsupported_format');
    expectError(() => parseTabularFile(Buffer.from('Nome\u0000;\u0000Nota'), { nomeArquivo: 'alunos.csv' }), 'unsupported_format');
    // Planilha sem aba de dados (workbook sem <sheet>, sem o caminho de sempre).
    const semAba = handmadeXlsx({ 'xl/workbook.xml': '<workbook><sheets/></workbook>' });
    expectError(() => parseTabularFile(semAba), 'invalid_xlsx');
    // Sem a lista de abas, o caminho de sempre (xl/worksheets/sheet1.xml) é lido.
    const semRels = handmadeXlsx({
        'xl/workbook.xml': '<workbook/>',
        'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c t="inlineStr"><is><t>ok</t></is></c></row>'),
    }, { omit: ['xl/_rels/workbook.xml.rels'] });
    assert.deepEqual(parseTabularFile(semRels).cabecalho, ['ok']);
});

test('XLSX: ZIP bomb (tamanho declarado e tamanho de verdade) e planilha com senha são recusados', () => {
    // 30 MB de XML que compactam para poucos KB.
    const enorme = Buffer.alloc(30 * 1024 * 1024, ' ');
    enorme.write(sheetXml('<row r="1"><c t="inlineStr"><is><t>a</t></is></c></row>'), 0);
    const bomba = handmadeXlsx({ 'xl/worksheets/sheet1.xml': enorme });
    assert.ok(bomba.length < LIMITES.maxBytes, `a bomba cabe no limite do envio (${bomba.length} bytes)`);
    expectError(() => parseTabularFile(bomba, { nomeArquivo: 'bomba.xlsx' }), 'spreadsheet_too_large', { status: 413 });
    // O diretório central mente o tamanho (100 bytes): a descompactação para no limite.
    const mentirosa = patchCentralEntry(bomba, 'xl/worksheets/sheet1.xml', (copy, offset) => copy.writeUInt32LE(100, offset + 24));
    expectError(() => parseTabularFile(mentirosa, { nomeArquivo: 'bomba.xlsx' }), 'spreadsheet_too_large');
    // Marca de cifrado no ZIP.
    const normal = handmadeXlsx({ 'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c t="inlineStr"><is><t>a</t></is></c></row>') });
    const cifrada = patchCentralEntry(normal, 'xl/workbook.xml', (copy, offset) => copy.writeUInt16LE(copy.readUInt16LE(offset + 8) | 1, offset + 8));
    expectError(() => parseTabularFile(cifrada, { nomeArquivo: 'senha.xlsx' }), 'encrypted_spreadsheet');
    // Sem bomba: o mesmo arquivo pequeno abre.
    assert.deepEqual(parseTabularFile(normal).cabecalho, ['a']);
    // A descompactação usa o limite do Node 20 (maxOutputLength).
    assert.throws(() => zlib.inflateRawSync(zlib.deflateRawSync(Buffer.alloc(1000)), { maxOutputLength: 10 }), RangeError);
});

test('XLSX com XML malformado é recusado em tempo linear (um .xlsx de 1 KB não prende o servidor)', () => {
    // Com a leitura por expressão regular, cada "<c>" sem "</c>" fazia uma busca até o
    // fim da parte: 160 mil (1 KB compactado) levavam 20 s, e 8 milhões levariam horas,
    // com o servidor parado (provas, autosave e monitor juntos).
    const linha = inner => sheetXml(`<row r="1">${inner}</row>`);
    const casos = {
        'célula aberta sem fechar': sheetXml('<row r="1">' + '<c>'.repeat(160000) + '</row>'),
        'linha aberta sem fechar': sheetXml('<row>'.repeat(80000)),
        'valor aberto sem fechar': linha('<c><v>'.repeat(100000) + '</c>'),
        'abertura sem ">"': '<worksheet><sheetData><row r="1">' + '<c '.repeat(400000),
        'aspas sem fechar': '<worksheet><sheetData><row r="1"><c r="' + 'a'.repeat(2000000),
        'nome de atributo sem "="': linha('<c ' + 'a'.repeat(2000000) + '/>'),
        'comentário sem fechar': '<worksheet>' + '<!--'.repeat(300000),
        'CDATA sem fechar': '<worksheet>' + '<![CDATA['.repeat(200000),
        'instrução sem fechar': '<worksheet>' + '<?'.repeat(500000),
        'elementos sem fim (profundidade)': '<worksheet>' + '<a>'.repeat(400000),
        'fechamento trocado': sheetXml('<row r="1"><c><v>1</c></v></row>'),
        DOCTYPE: '<!DOCTYPE worksheet [<!ENTITY a "aaaa">]>' + sheetXml(''),
        'atributo sem aspas': linha('<c r=A1><v>1</v></c>'),
    };
    for (const [nome, xml] of Object.entries(casos)) {
        const buffer = handmadeXlsx({ 'xl/worksheets/sheet1.xml': xml });
        assert.ok(buffer.length < LIMITES.maxBytes, nome);
        const inicio = Date.now();
        expectError(() => parseTabularFile(buffer, { nomeArquivo: 'malformada.xlsx' }), 'invalid_xlsx');
        const ms = Date.now() - inicio;
        assert.ok(ms < 2000, `${nome}: ${ms} ms`);
    }
    // Shared strings malformadas também.
    const sst = handmadeXlsx({
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c t="s"><v>0</v></c></row>'),
        'xl/sharedStrings.xml': '<sst>' + '<si><rPh>'.repeat(200000) + '</sst>',
    });
    const inicio = Date.now();
    expectError(() => parseTabularFile(sst, { nomeArquivo: 'malformada.xlsx' }), 'invalid_xlsx');
    assert.ok(Date.now() - inicio < 2000);

    // Bem formado e grande (perto do limite da parte): termina rápido. 6 milhões de
    // células vazias e um formato de número de 1 milhão de caracteres (o Excel aceita
    // até 255; acima disso o formato é ignorado).
    const vazias = handmadeXlsx({
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="x/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="200" formatCode="' + '['.repeat(1000000) + '"/><numFmt numFmtId="201" formatCode="' + ','.repeat(1000000) + '"/></numFmts>'
            + '<cellXfs><xf numFmtId="200"/><xf numFmtId="201"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': sheetXml('<row r="1"><c t="inlineStr"><is><t>Nota</t></is></c></row><row r="2"><c s="0"><v>7.5</v></c><c s="1"><v>8</v></c>' + '<c/>'.repeat(6000000) + '</row>'),
    });
    const comeco = Date.now();
    const lida = parseTabularFile(vazias, { nomeArquivo: 'vazias.xlsx' });
    assert.deepEqual(lida.linhas, [{ numero: 2, valores: ['7,5', '8'] }]);
    assert.ok(Date.now() - comeco < 5000, `${Date.now() - comeco} ms`);
});

test('XLSX: CDATA vira texto, comentário XML não é lido e índice de texto vazio não pega o primeiro texto', () => {
    const buffer = handmadeXlsx({
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<?xml version="1.0"?><!-- gerado por outro programa --><sst><si><t>Primeiro</t></si><si><t><![CDATA[a<b & c]]></t></si><si><r><t>par</t></r><!-- <t>não</t> --><r><t><![CDATA[te]]>s</t></r></si></sst>',
        'xl/worksheets/sheet1.xml': sheetXml(
            '<row r="1"><c t="inlineStr"><is><t>A</t></is></c><c t="inlineStr"><is><t>B</t></is></c><c t="inlineStr"><is><t>C</t></is></c></row>'
            + '<row r="2"><c r="A2" t="s"><v>1</v></c><!-- <c r="B2"><v>9</v></c> --><c r="C2" t="inlineStr"><is><t><![CDATA[<x> &amp;]]></t></is></c></row>'
            + '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v></v></c><c r="C3" t="s"/></row>'
            + '<!-- <row r="4"><c r="A4"><v>1</v></c></row> -->'
            + '<row r="5"><c r="A5"><v><![CDATA[3.5]]></v></c></row>',
        ),
    });
    const resultado = parseTabularFile(buffer, { nomeArquivo: 'cdata.xlsx' });
    assert.deepEqual(resultado.cabecalho, ['A', 'B', 'C']);
    assert.deepEqual(resultado.linhas, [
        { numero: 2, valores: ['a<b & c', '', '<x> &amp;'] },
        { numero: 3, valores: ['partes', '', ''] },
        { numero: 5, valores: ['3,5', '', ''] },
    ]);
});

test('buildXlsx: cabeçalho em negrito, número de verdade com formato, texto que fica texto, datas e nomes de aba', () => {
    const linhas = [
        ['Ana', '00123', 7, 7.25, 3, '2008-03-15', '2026-03-01 08:05', '=HYPERLINK("http://x")', true, null],
        ['Bia', 2024002, null, 0.1 + 0.2, 0, '15/03/2008', '2026-03-01T23:59:30', 'texto _x0041_ literal\u0001', false, ''],
        ['Caio', '', '', NaN, Infinity, 'não é data', '', 'a'.repeat(40000), 'x', -0],
    ];
    const cabecalho = ['Nome', 'Matrícula', 'Nota', 'Valor', 'Faltas', 'Nascimento', 'Quando', 'Obs', 'Ativo', 'Vazio'];
    const formatos = ['texto', 'texto', 'nota', 'decimal2', 'inteiro', 'data', 'dataHora', 'texto', 'numero', 'numero'];
    const buffer = buildXlsx(linhas, { nomePlanilha: "  Notas: 1/A [manhã] ? * 'muito longo demais para o excel'  ", cabecalho, formatos });
    assert.ok(Buffer.isBuffer(buffer));
    assert.equal(buffer.toString('latin1', 0, 2), 'PK');
    const zip = new AdmZip(buffer);
    const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
    const workbook = zip.readAsText('xl/workbook.xml');
    const styles = zip.readAsText('xl/styles.xml');
    assert.doesNotMatch(sheet, /<f>/, 'nenhuma fórmula na planilha');
    assert.match(styles, /<font><b\/>/);
    assert.match(sheet, /<c r="A1" t="inlineStr" s="1">/, 'cabeçalho com o estilo em negrito');
    assert.match(sheet, /<c r="C2" s="2"><v>7<\/v><\/c>/, 'nota como número com formato 0,0');
    assert.match(sheet, /<c r="E2" s="4"><v>3<\/v><\/c>/);
    assert.match(sheet, /<pane ySplit="1"/, 'primeira linha fixa');
    const sheetName = /<sheet name="([^"]*)"/.exec(workbook)[1];
    assert.ok(sheetName.length <= 31 && !/[[\]:*?/\\]/.test(sheetName), sheetName);
    assert.ok(sheetName.startsWith('Notas 1 A'), sheetName);

    const lido = parseTabularFile(buffer, { nomeArquivo: 'saida.xlsx' });
    assert.deepEqual(lido.cabecalho, cabecalho);
    assert.deepEqual(lido.linhas[0].valores, ['Ana', '00123', '7,0', '7,25', '3', '15/03/2008', '01/03/2026 08:05', '=HYPERLINK("http://x")', 'VERDADEIRO', '']);
    assert.deepEqual(lido.linhas[1].valores, ['Bia', '2024002', '', '0,30', '0', '15/03/2008', '01/03/2026 23:59', 'texto _x0041_ literal\u0001', 'FALSO', '']);
    assert.equal(lido.linhas[2].valores[9], '0', '-0 vira 0');
    assert.equal(lido.linhas[2].valores[5], 'não é data');
    assert.equal(lido.linhas[2].valores[7].length, LIMITES.maxTextoCelula, 'texto acima do limite do Excel é cortado');
    assert.equal(lido.linhas[2].valores[3], '', 'NaN e Infinity ficam vazios');
    assert.equal(lido.planilha, sheetName);

    // Sem cabeçalho e vazia.
    assert.deepEqual(parseTabularFile(buildXlsx([[1, 'a']]), { cabecalho: false }).linhas[0].valores, ['1', 'a']);
    assert.ok(buildXlsx([]).length > 0);
    assert.equal(/<sheet name="([^"]*)"/.exec(new AdmZip(buildXlsx([], { nomePlanilha: '[]' })).readAsText('xl/workbook.xml'))[1], 'Planilha');
    assert.equal(XLSX_CONTENT_TYPE, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('buildXlsx: nome de aba com caractere de controle ou emoji cortado no limite continua XML válido', () => {
    const nome = (texto) => /<sheet name="([^"]*)"/.exec(new AdmZip(buildXlsx([['x']], { nomePlanilha: texto })).readAsText('xl/workbook.xml'))[1];
    assert.equal(nome('Turma\u0001A\u0007\u001F B\uFFFE'), 'Turma A B');
    // 30 letras + emoji: o corte em 31 deixaria meio par de surrogates.
    assert.equal(nome('a'.repeat(30) + '\u{1F600}fim'), 'a'.repeat(30));
    const buffer = buildXlsx([['x']], { nomePlanilha: 'Turma\u0001A', cabecalho: ['Nome'] });
    assert.equal(parseTabularFile(buffer, { nomeArquivo: 'turma.xlsx' }).planilha, 'Turma A');
});

test('buildXlsx abre no LibreOffice e no openpyxl com as mesmas células (pulado se não estiverem instalados)', { skip: !sofficeAvailable() && 'LibreOffice (soffice) não instalado' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iclass-xlsx-lo-'));
    try {
        const file = path.join(dir, 'notas.xlsx');
        fs.writeFileSync(file, buildXlsx([['Ana', '00123', 7.5, '2008-03-15'], ['Bia "B"', '2024002', 10, '']], {
            cabecalho: ['Nome', 'Matrícula', 'Nota', 'Nascimento'], formatos: ['texto', 'texto', 'nota', 'data'], nomePlanilha: 'Notas 1A',
        }));
        sofficeConvert(file, 'csv:Text - txt - csv (StarCalc):59,34,76,1', dir);
        const csv = parseTabularFile(fs.readFileSync(path.join(dir, 'notas.csv')), { nomeArquivo: 'notas.csv' });
        assert.deepEqual(csv.cabecalho, ['Nome', 'Matrícula', 'Nota', 'Nascimento']);
        // O LibreOffice da nuvem está em inglês: ponto decimal.
        assert.deepEqual(csv.linhas.map(linha => linha.valores.map(value => value.replace('.', ','))), [['Ana', '00123', '7,5', '15/03/2008'], ['Bia "B"', '2024002', '10,0', '']]);
        // O LibreOffice grava de novo em XLSX e o leitor lê igual.
        const again = path.join(dir, 'regravada');
        fs.mkdirSync(again);
        sofficeConvert(file, 'xlsx:Calc MS Excel 2007 XML', again);
        const relido = parseTabularFile(fs.readFileSync(path.join(again, 'notas.xlsx')));
        assert.equal(relido.planilha, 'Notas 1A');
        assert.deepEqual(relido.linhas.map(linha => linha.valores), [['Ana', '00123', '7,5', '15/03/2008'], ['Bia "B"', '2024002', '10,0', '']]);
        const python = spawnSync('python3', ['-I', '-c', 'import sys, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nws = wb.active\nprint(ws.title, ws["C2"].value, ws["C2"].number_format, ws["B2"].value, ws["A1"].font.b)', file], { encoding: 'utf8', timeout: 60000 });
        if (python.status === 0) assert.equal(python.stdout.trim(), 'Notas 1A 7.5 0.0 00123 True');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('detalhes: letras de coluna, separador da amostra, sha256 e o erro com status', () => {
    assert.deepEqual([1, 26, 27, 52, 703, 16384].map(columnLetter), ['A', 'Z', 'AA', 'AZ', 'AAA', 'XFD']);
    assert.equal(_internals.detectSeparator('a,b;c\n1,2;3\n4,5;6').separador, ';');
    assert.equal(fileSha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const error = new TabularFileError('Mensagem.', 'qualquer');
    assert.equal(error.status, 400);
    assert.equal(error.name, 'TabularFileError');
});
