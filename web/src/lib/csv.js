// Célula de CSV para abrir no Excel: sempre entre aspas e sem virar fórmula. Nome e
// e-mail vêm do autocadastro do aluno, então "=HYPERLINK(...)" não pode ser executado
// ao abrir a planilha. Mesma regra do csvSafe do servidor (backend/utils/gradebook.js).
export function csvCell(value) {
  let text = String(value ?? '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}
