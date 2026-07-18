# Documentação de Engenharia — IClass V3

LMS **local-first** para sala de aula. Backend **Express + SQLite** (regras de negócio no servidor) e interface **React + Vite + Tailwind**. Roda **100% local**, sem internet.

Esta pasta reúne o **padrão de desenvolvimento** do projeto: o que ler antes de codar, quais convenções seguir e como validar o resultado. Não é documentação de usuário final.

---

## Comece por aqui

| Documento | Para quê |
|-----------|----------|
| [AI_CONTEXT_MELHORADO.md](./AI_CONTEXT_MELHORADO.md) | **Fonte de verdade** do produto — propósito, regras e visão. Ler antes de qualquer alteração. |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Fluxo de trabalho, como rodar, padrão de commits e definição de "pronto". |
| [ARQUITETURA.md](./ARQUITETURA.md) | Camadas, fluxo de dados e decisões arquiteturais (server-authoritative). |
| [PADROES_CODIGO.md](./PADROES_CODIGO.md) | Convenções de código, nomenclatura e estrutura de pastas. |
| [MODELO_DADOS.md](./MODELO_DADOS.md) | Coleções em `db.memory`, persistência e compatibilidade retroativa. |
| [API.md](./API.md) | Convenções de rotas, autenticação e formato de resposta/erro. |
| [SEGURANCA.md](./SEGURANCA.md) | Regras de segurança server-authoritative e histórico de correções. |
| [TESTES.md](./TESTES.md) | Estratégia de testes (backend, web, E2E) e como rodar. |
| [PADROES_UI.md](./PADROES_UI.md) | Design system, tokens, acessibilidade e responsividade. |

### Documentos de referência de feature (mantidos)

- [IDENTIDADE_WHITE_LABEL.md](./IDENTIDADE_WHITE_LABEL.md) — modelo white-label Sistema → Escola → Curso.
- [OPERACAO_SEGURANCA_TESTES.md](./OPERACAO_SEGURANCA_TESTES.md) — operação, backup e recuperação.
- [ESPECIFICACAO_UI_PROVAS.md](./ESPECIFICACAO_UI_PROVAS.md) — spec detalhada da UI do módulo de provas.
- [PLANO_UIUX.md](./PLANO_UIUX.md) — linguagem visual flagship das telas.
- [MANUAL_NOVAS_UNIDADES_REVISADO.md](./MANUAL_NOVAS_UNIDADES_REVISADO.md) — padrão de criação de conteúdo pedagógico.

### Histórico

Planos concluídos, relatórios de teste datados e mockups ficam em [`docs/arquivo/`](./arquivo/). São mantidos como registro, mas **não** representam o estado atual do sistema.

---

## Início rápido (Windows)

Dê um duplo clique em **`ligarIclassV3.bat`** e use o menu:

1. Opção **[4] Instalar Dependências e Compilar Interface** (primeira vez, ou quando mudar a interface).
2. Opção **[1] Iniciar Servidor** — abre `http://localhost:3000`.

Outras opções: `[2]` parar, `[3]` reiniciar, `[6]` modo demonstração, `[7]` backup ZIP, `[8]` sair.

## Início rápido (linha de comando)

```bash
npm run setup     # instala backend + web (uma vez)
npm run build     # gera web/dist
npm start         # Express serve API + interface em http://localhost:3000
```

Modo desenvolvimento com hot-reload da interface:

```bash
npm start         # terminal 1 — backend (porta 3000)
npm run dev:web   # terminal 2 — interface (porta 5173, proxy /api -> 3000)
```

Requer **Node.js 20.19+**.
