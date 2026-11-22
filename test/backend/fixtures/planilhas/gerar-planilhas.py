# Gera as planilhas de teste do leitor de planilhas (backend/utils/tabularFile.js).
# Rodar desta pasta: python3 gerar-planilhas.py (precisa do openpyxl e do LibreOffice,
# comando soffice). Os arquivos gerados ficam no repositório; o teste não roda este
# script. Ver README.md.
import datetime
import os
import shutil
import subprocess
import tempfile

import openpyxl
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
from openpyxl.utils.datetime import CALENDAR_MAC_1904

AQUI = os.path.dirname(os.path.abspath(__file__))


def caminho(nome):
    return os.path.join(AQUI, nome)


# Tabela de referência: o que o Excel em português mostra em cada célula (e o que o
# leitor deve devolver), igual em todos os formatos.
CABECALHO = ['Nome', 'E-mail', 'Matrícula', 'Data de nascimento', 'Nota', 'Valor', 'Frequência', 'Horário', 'Observação']
LINHAS = [
    ['João da Silva', 'joao@escola.local', '00123', '15/03/2008', '7,5', '1.234,50', '75%', '12:00', 'Começou em março'],
    ['Ângela Müller', 'angela@escola.local', '2024002', '29/02/2008', '10,0', '0,00', '100%', '07:30', 'Linha 1\nLinha 2'],
    ['Zé "Pequeno"', '', '2024003', '', '', '', '', '', 'célula vazia no meio; com ponto e vírgula'],
]


def preencher_alunos(ws):
    ws.append(CABECALHO)
    # Linha 2: datas, nota com uma casa, milhar, porcentagem e hora.
    ws.append(['João da Silva', 'joao@escola.local', '00123', datetime.date(2008, 3, 15), 7.5, 1234.5, 0.75, datetime.time(12, 0), 'Começou em março'])
    ws.append(['Ângela Müller', 'angela@escola.local', 2024002, datetime.date(2008, 2, 29), 10, 0, 1, datetime.time(7, 30), 'Linha 1\nLinha 2'])
    ws.append([])  # linha vazia no meio: pulada, sem mudar a numeração
    ws.append(['Zé "Pequeno"', None, 2024003, None, None, None, None, None, 'célula vazia no meio; com ponto e vírgula'])
    for linha in (2, 3, 5):
        ws.cell(row=linha, column=4).number_format = 'dd/mm/yyyy'
        ws.cell(row=linha, column=5).number_format = '0.0'
        ws.cell(row=linha, column=6).number_format = '#,##0.00'
        ws.cell(row=linha, column=7).number_format = '0%'
        ws.cell(row=linha, column=8).number_format = 'hh:mm'
    ws.cell(row=2, column=3).number_format = '@'


def alunos_openpyxl():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'Alunos'
    preencher_alunos(ws)
    outra = wb.create_sheet('Outra aba')
    outra.append(['Não deve ser lida'])
    wb.save(caminho('alunos-openpyxl.xlsx'))


def alunos_libreoffice():
    # O LibreOffice abre o arquivo do openpyxl e grava com o próprio gravador de XLSX.
    with tempfile.TemporaryDirectory() as pasta:
        origem = os.path.join(pasta, 'alunos-libreoffice.xlsx')
        shutil.copy(caminho('alunos-openpyxl.xlsx'), origem)
        saida = os.path.join(pasta, 'saida')
        subprocess.run(['soffice', '--headless', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', saida, origem], check=True, capture_output=True, timeout=180)
        shutil.copy(os.path.join(saida, 'alunos-libreoffice.xlsx'), caminho('alunos-libreoffice.xlsx'))
        # CSV do LibreOffice: ';', aspas e UTF-8 (filtro 59,34,76).
        subprocess.run(['soffice', '--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):59,34,76,1', '--outdir', saida, origem], check=True, capture_output=True, timeout=180)
        shutil.copy(os.path.join(saida, 'alunos-libreoffice.csv'), caminho('alunos-libreoffice.csv'))


def especiais_openpyxl():
    # Texto com formatação (rich text), fórmula sem valor guardado, verdadeiro/falso,
    # número grande e decimal sem formato, e a primeira aba escondida.
    wb = openpyxl.Workbook()
    escondida = wb.active
    escondida.title = 'Rascunho'
    escondida.append(['aba escondida'])
    escondida.sheet_state = 'hidden'
    ws = wb.create_sheet('Dados')
    ws.append(['Nome', 'Conta', 'Ativo', 'Decimal', 'Inteiro grande'])
    ws.append([CellRichText(['Ana ', TextBlock(InlineFont(b=True), 'Negrito'), ' Souza']), '=1+1', True, 0.1 + 0.2, 123456789012])
    ws.append(['Bia', None, False, -2.5, 7])
    wb.save(caminho('especiais-openpyxl.xlsx'))


def especiais_libreoffice():
    # O mesmo arquivo gravado pelo LibreOffice: a fórmula ganha o resultado (2), o
    # verdadeiro/falso vira número com formato e os textos vão para sharedStrings.
    with tempfile.TemporaryDirectory() as pasta:
        origem = os.path.join(pasta, 'especiais-libreoffice.xlsx')
        shutil.copy(caminho('especiais-openpyxl.xlsx'), origem)
        saida = os.path.join(pasta, 'saida')
        subprocess.run(['soffice', '--headless', '--convert-to', 'xlsx:Calc MS Excel 2007 XML', '--outdir', saida, origem], check=True, capture_output=True, timeout=180)
        shutil.copy(os.path.join(saida, 'especiais-libreoffice.xlsx'), caminho('especiais-libreoffice.xlsx'))


def mac1904_openpyxl():
    wb = openpyxl.Workbook()
    wb.epoch = CALENDAR_MAC_1904
    ws = wb.active
    ws.title = 'Mac'
    ws.append(['Data'])
    ws.append([datetime.date(2026, 3, 1)])
    ws.cell(row=2, column=1).number_format = 'dd/mm/yyyy'
    wb.save(caminho('data-1904-openpyxl.xlsx'))


def csv_variantes():
    # O que o Excel em português grava em cada "Salvar como", feito aqui à mão.
    linhas = [CABECALHO] + LINHAS

    def campo(valor, sep):
        if any(c in valor for c in (sep, '"', '\n', '\r')):
            return '"' + valor.replace('"', '""') + '"'
        return valor

    def texto(sep, fim='\r\n'):
        return fim.join(sep.join(campo(v, sep) for v in linha) for linha in linhas) + fim

    # "CSV (separado por vírgulas)" do Excel em português: ';' e Windows-1252.
    with open(caminho('alunos-excel-ansi.csv'), 'wb') as f:
        f.write(texto(';').encode('cp1252'))
    # "CSV UTF-8": ';' com BOM.
    with open(caminho('alunos-excel-utf8.csv'), 'wb') as f:
        f.write(b'\xef\xbb\xbf' + texto(';').encode('utf-8'))
    # Google Planilhas e sistemas em inglês: ',' sem BOM, fim de linha \n.
    with open(caminho('alunos-virgula.csv'), 'wb') as f:
        f.write(texto(',', '\n').encode('utf-8'))
    # "Texto Unicode": tabulação em UTF-16 LE com BOM.
    with open(caminho('alunos-unicode.txt'), 'wb') as f:
        f.write(b'\xff\xfe' + texto('\t').encode('utf-16-le'))


if __name__ == '__main__':
    alunos_openpyxl()
    alunos_libreoffice()
    especiais_openpyxl()
    especiais_libreoffice()
    mac1904_openpyxl()
    csv_variantes()
    print('Planilhas geradas em', AQUI)
