# Casos de uso — Provas

## UC-PROVA-001 — Aplicar e concluir uma prova online

- Estado: automatizado
- Atores: professor e aluno
- Telas: `/provas`, `/monitor`, `/aluno/provas`, `/aluno/prova/:examKey`
- Testes: `exam-flow.spec.js` e `exam-applications.test.js`

### Dado

Existe turma com aluno matriculado e uma prova válida com quantidade, duração, espera e tentativas conhecidas.

### Quando

O professor prepara, inicia e libera a aplicação; o aluno entra, responde e envia.

### Então

O aluno vê apenas a aplicação da própria turma, o monitor acompanha o estado, a correção ocorre no servidor, a submissão é persistida e nenhum gabarito é exposto no cliente.

## UC-PROVA-002 — Retomar e respeitar tentativas

- Estado: automatizado
- Testes: `exam-flow.spec.js` e `exam-attempts.test.js`

O rascunho deve sobreviver à saída autorizada, a tentativa deve ser retomada sem duplicação e uma nova aplicação não pode reutilizar o estado da anterior.

## UC-DIGITACAO-001 — Guardar e mostrar o histórico de digitação da prova

- Estado: automatizado
- Testes: `keystroke-store.test.js`, `exam-application-guards.test.js` e `entrada-e-erros.test.js`

No Modo Prova Rigoroso o navegador do aluno manda as teclas em lotes. O servidor guarda cada tecla numa linha da tabela própria `exam_keystroke_events` (fora da memória) e só responde depois que elas estão no disco; com o banco travado o aluno recebe 503 e o servidor grava sozinho quando a trava sai. Prova, aplicação e tentativa precisam ser texto curto (até 200 caracteres) e cada campo da tecla tem tamanho máximo. O professor acompanha a digitação ao vivo pelo cursor da última tecla recebida, na ordem em que chegaram, mesmo quando a página do aluno recarrega e o número de sequência recomeça. O Monitor mostra quantas teclas e quantas suspeitas cada aluno tem na aplicação, sem percorrer todas as teclas. Cada aluno guarda no máximo 20 mil teclas por aplicação: as mais antigas saem. Excluir o aluno apaga as teclas dele; trocar o e-mail leva as teclas para o e-mail novo. Na primeira subida depois da atualização, as teclas guardadas no formato antigo passam para a tabela nova (o console mostra quantas e quanto tempo levou); o que não puder ser lido fica onde estava.
