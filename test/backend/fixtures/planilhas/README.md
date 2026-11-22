# Planilhas de teste do leitor de planilhas

Usadas por `test/backend/tabular-file.test.js` para conferir `parseTabularFile` (`backend/utils/tabularFile.js`) com arquivos feitos por programas de verdade, e não só pelo próprio IClass. O teste só lê estes arquivos; quem os gera é o `gerar-planilhas.py` desta pasta.

## Como foram feitas (22/11/2026)

```bash
cd test/backend/fixtures/planilhas
python3 gerar-planilhas.py
```

Na nuvem do projeto, com o openpyxl 3.1.5 (Python 3) e o LibreOffice 24.2 sem interface (`soffice --headless`). Gerar de novo muda só datas internas dos arquivos; as células ficam iguais e o teste continua passando.

| Arquivo | Quem gravou | O que cobre |
|---|---|---|
| `alunos-openpyxl.xlsx` | openpyxl | textos em `inlineStr`, data com formato `dd/mm/yyyy`, nota `0.0`, milhar `#,##0.00`, porcentagem `0%`, hora `hh:mm`, matrícula como texto (`00123`) e como número, célula com quebra de linha, linha vazia no meio, célula vazia no meio e uma segunda aba que não é lida |
| `alunos-libreoffice.xlsx` | LibreOffice (abriu o do openpyxl e gravou em XLSX) | o mesmo conteúdo com `sharedStrings.xml`, os estilos e o tema do LibreOffice |
| `alunos-libreoffice.csv` | LibreOffice ("Texto CSV", filtro `59,34,76,1`: `;`, aspas, UTF-8) | CSV com aspas, quebra de linha dentro da célula e a linha vazia como `;;;;;;;;` (o LibreOffice da nuvem está em inglês: ponto decimal) |
| `alunos-excel-ansi.csv` | o script, como o "CSV (separado por vírgulas)" do Excel em português | `;` e Windows-1252 (acentos sem UTF-8) |
| `alunos-excel-utf8.csv` | o script, como o "CSV UTF-8" do Excel | `;` com BOM |
| `alunos-virgula.csv` | o script, como o Google Planilhas | `,`, sem BOM, fim de linha `\n` |
| `alunos-unicode.txt` | o script, como o "Texto Unicode" do Excel | tabulação em UTF-16 LE com BOM |
| `especiais-openpyxl.xlsx` | openpyxl | primeira aba escondida, texto com negrito no meio (rich text), fórmula sem resultado guardado, verdadeiro/falso, decimal `0.30000000000000004` e número grande |
| `especiais-libreoffice.xlsx` | LibreOffice (abriu o anterior e gravou em XLSX) | a mesma planilha com o resultado da fórmula guardado e o verdadeiro/falso como fórmula `TRUE()` |
| `data-1904-openpyxl.xlsx` | openpyxl | data no sistema de 1904 (Excel antigo do Mac) |

O texto que cada célula deve dar (o que o Excel em português mostra) está em `CABECALHO` e `LINHAS`, iguais no script e no teste. Os arquivos do Excel de verdade ficam para a conferência no Windows do Alan (ver as notas da fase 3).
