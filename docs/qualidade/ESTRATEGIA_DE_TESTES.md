# Estratégia modular de testes

## Objetivo

Validar não apenas que uma tela abre, mas que o valor mostrado, a resposta do servidor, a persistência e a permissão correspondem ao caso de uso documentado.

## Camadas

| Camada | Ferramenta | Responsabilidade |
|---|---|---|
| Regras e API | `node:test` + Supertest | regras, segurança, persistência e contratos |
| Componentes | Vitest + Testing Library | renderização, interação e acessibilidade local |
| Casos de uso | Playwright | fluxos completos de professor e aluno |
| Visual | Playwright screenshots | Premium/Lumen, temas e viewports |
| Acessibilidade | axe-core | violações automatizáveis WCAG A/AA |

## Isolamento obrigatório

- E2E usa `TEST_MODE=1`, porta `3132` e diretórios temporários.
- Nenhum teste aponta para `data/`, `content/` ou `cursos_arquivados/` reais.
- Cada cenário chama o seed controlado antes das ações.
- O servidor temporário e os diretórios são removidos ao final.

## Resultado correto

Casos críticos devem conferir interface, API, persistência e autorização. O valor esperado vem do cenário fixo; não pode reutilizar a mesma função de cálculo que está sendo testada.

## Barreiras

- Teste crítico reprovado bloqueia a validação completa.
- Falta de navegador é **bloqueio de ambiente**, não reprovação do produto.
- Imagens de referência só mudam com comando explícito e revisão humana.
- Código novo ou regra alterada deve trazer teste correspondente.
- A cobertura global não deve diminuir; módulos críticos têm meta de 80%.
