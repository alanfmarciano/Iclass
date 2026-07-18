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
