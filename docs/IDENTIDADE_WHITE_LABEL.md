# Identidade White-label — Sistema → Escola → Curso

Sistema de personalização de marca e dados institucionais do IClass, em três níveis
com herança em cascata. Um mesmo professor pode dar o mesmo curso em várias escolas,
e cada curso herda a identidade e os dados da escola à qual pertence.

## Hierarquia e herança

```
Sistema (padrão global)
   └── Escola / Instituição   (marca + dados institucionais)
          └── Curso           (herda a escola; pode sobrescrever e ter dados próprios)
```

Valor efetivo de qualquer campo:
`Curso[campo] ?? Escola[campo] ?? Sistema[campo] ?? padrãoDeFábrica`

- **Escola** é uma entidade própria e **compartilhável**: vários cursos apontam para a mesma escola (`course.schoolId`) e herdam tudo dela.
- Trocar um dado na Escola reflete em **todos** os cursos dela que não sobrescrevem aquele campo.
- Documentos (certificados) puxam automaticamente os **dados institucionais da escola** do curso — sem redigitar.

Legenda de viabilidade no modo local (Express + React):
✅ viável · ⚠️ com ressalva · ⛔ fora do escopo local.

---

## Entidade: Escola / Instituição

### A. Dados institucionais (novos — usados em documentos e cabeçalhos)

| Campo | key | Tipo | Exemplo | Padrão | Viável |
|------|-----|------|---------|--------|--------|
| Nome fantasia | `tradeName` | texto | "Instituto Horizonte" | — | ✅ |
| Razão social | `legalName` | texto | "Instituto Horizonte Educação LTDA" | = nome fantasia | ✅ |
| CNPJ / registro | `registrationId` | texto | "12.345.678/0001-90" | vazio | ✅ |
| Endereço | `address` | texto | rua, número, bairro | vazio | ✅ |
| Cidade / UF | `cityState` | texto | "Sertãozinho / SP" | vazio | ✅ |
| CEP | `zip` | texto | "14160-000" | vazio | ✅ |
| Telefone | `phone` | texto | "(16) 3000-0000" | vazio | ✅ |
| E-mail de contato | `email` | e-mail | "contato@horizonte.edu.br" | vazio | ✅ |
| Site | `website` | url | "horizonte.edu.br" | vazio | ✅ |
| Diretor / responsável | `directorName` | texto | "Ana Souza" | vazio | ✅ |
| Cargo do responsável | `directorRole` | texto | "Diretora pedagógica" | vazio | ✅ |
| Assinatura (imagem) | `signatureUrl` | imagem | PNG transparente | vazio | ✅ |

### B. Identidade visual da escola

A escola tem **todos** os campos de marca/tema abaixo (Níveis 1–3). O curso herda e pode sobrescrever qualquer um.

---

## Entidade: Curso

| Campo | key | Tipo | Observação |
|------|-----|------|-----------|
| Escola vinculada | `schoolId` | ref | de qual escola o curso herda identidade e dados |
| Sobrescritas de marca | (mesmos campos abaixo) | — | qualquer campo de identidade pode ser redefinido só neste curso |
| Dados próprios do curso | `courseInfo` | texto | infos específicas (turno, carga horária, coordenador do curso) que não vêm da escola |

---

## Campos de identidade (valem para Sistema, Escola e Curso)

### Nível 1 — Essencial

| Campo | key | Tipo | Valores | Padrão | Viável |
|------|-----|------|---------|--------|--------|
| Nome de exibição | `displayName` | texto | até 60 car. | nome da escola | ✅ |
| Nome curto | `shortName` | texto | até 16 car. | iniciais | ✅ |
| Logo (tema claro) | `logoLightUrl` | imagem | SVG/PNG transp. | vazio → nome | ✅ |
| Logo (tema escuro) | `logoDarkUrl` | imagem | SVG/PNG transp. | usa o claro | ✅ |
| Favicon | `faviconUrl` | imagem | PNG/ICO/SVG | ícone padrão | ✅ |
| Monograma | `monogram` | texto/img | 1–2 letras ou ícone | iniciais | ✅ |
| Cor primária | `primaryColor` | cor hex | qualquer | #ef4444 | ✅ |
| Cor secundária | `secondaryColor` | cor hex | qualquer | derivada | ✅ |
| Modo de tema | `themeMode` | opção | light · dark · auto | auto | ✅ |
| Preset de paleta | `palettePreset` | opção | lista curada | — | ✅ |

### Nível 2 — Avançado

| Campo | key | Tipo | Valores | Padrão | Viável |
|------|-----|------|---------|--------|--------|
| Cor de destaque | `accentColor` | cor hex | qualquer | = primária | ✅ |
| Cores semânticas | `successColor` `warningColor` `dangerColor` | cor hex | qualquer | padrão do tema | ✅ |
| Arredondamento | `radius` | opção | reto · padrão · suave | padrão | ✅ |
| Densidade | `density` | opção | compacto · confortável | confortável | ✅ |
| Fonte (títulos/corpo) | `fontHeading` `fontBody` | opção | Inter, Poppins, Roboto, Montserrat, Lato, Nunito | Inter | ✅ |
| Tamanho base | `fontScale` | opção | pequeno · padrão · grande | padrão | ✅ |
| Login: layout | `loginLayout` | opção | centralizado · dividido | centralizado | ✅ |
| Login: fundo (img/cor) | `loginBgUrl` `loginBgColor` | imagem/cor | — | cor sólida | ✅ |
| Login: boas-vindas | `loginWelcome` | texto | até 120 car. | vazio | ✅ |
| Nomenclatura | `termStudent` `termClass` `termCourse` `termTeacher` | texto | renomear termos | padrões | ✅ |
| Idioma | `locale` | opção | pt-BR | pt-BR | ⚠️ só pt-BR hoje |

### Nível 3 — Premium

| Campo | key | Tipo | Valores | Padrão | Viável |
|------|-----|------|---------|--------|--------|
| Logo do certificado | `certLogoUrl` | imagem | alta resolução | usa logo principal | ✅ |
| Rodapé do certificado | `certFooter` | texto | validação/endereço | dados institucionais da escola | ✅ |
| Ocultar "powered by IClass" | `hideVendorMark` | booleano | sim/não | não | ✅ |
| CSS customizado | `customCss` | texto (código) | CSS livre | vazio | ⚠️ cautela |
| Domínio próprio | — | — | — | — | ⛔ local |
| E-mails com marca | — | — | — | — | ⛔ depende de infra |

---

## Permissões

- **Administrador:** cria/edita **todas** as escolas e cursos e a identidade de cada um, além do padrão global do sistema.
- **Professor:** cria/edita a identidade e os dados **das escolas e cursos atribuídos a ele** (o escopo por turma/curso que já existe passa a valer também para escola e identidade). Não mexe no padrão global do sistema nem em escolas/cursos de outros.
- **Aluno:** apenas visualiza a identidade aplicada ao curso em que está.
- Toda alteração de identidade/dados institucionais entra na **auditoria** (quem, quando, o quê).

Observação: isso ajusta a regra anterior (branding era só do admin). Agora o professor
tem poder de identidade **dentro do escopo dele** — coerente com "professor que dá aula
em várias escolas".

---

## Comportamento

- **Herança em cascata:** Curso → Escola → Sistema → padrão de fábrica.
- **Preview ao vivo:** editor mostra mini-portal refletindo cada mudança antes de salvar.
- **Aplicação em runtime:** ao entrar num curso, o tema injeta as variáveis CSS (cores, fonte, raio, densidade) sem recarregar, respeitando claro/escuro.
- **Documentos automáticos:** certificado do curso usa nome oficial, logo, endereço, assinatura e responsável **da escola** daquele curso.
- **Restaurar herança:** curso pode limpar sobrescritas e voltar a herdar a escola; escola pode voltar a herdar o sistema.
- **Acessibilidade:** aviso de contraste (WCAG) ao escolher cores.

## Ordem sugerida de implementação

1. Entidade **Escola** (dados institucionais + identidade) + vínculo `course.schoolId` + motor de herança Curso→Escola→Sistema.
2. Motor de tema aplicando a identidade efetiva no sistema todo (Nível 1).
3. Editor visual com preview ao vivo + seletor de nível (Sistema / Escola / Curso).
4. Permissões de professor sobre escolas/cursos do escopo dele.
5. Níveis 2 e 3 (avançado e premium), incluindo certificado com dados da escola.
