# Casos de uso — LGPD (Termos, Privacidade e encarregado)

## UC-LGPD-001 — Ler os Termos de Uso e a Política de Privacidade

- Estado: automatizado
- Testes: `lgpd-documentos.test.js` e `LegalDocumentPage.test.jsx`

Qualquer pessoa, com ou sem login, abre `/termos` e `/privacidade` (também no celular, sem internet). A página mostra o texto atual com os dados da escola: nome, razão social, CNPJ, endereço, contatos, encarregado e prazos de guarda. Enquanto a escola não publica, o texto é o modelo do IClass, com o aviso "Modelo padrão do IClass, ainda não revisado e publicado pela instituição", e o aviso "Modelo de referência; não substitui orientação jurídica" (fora do texto: a versão publicada a partir do modelo não o leva), e ninguém precisa aceitar nada. Os dados do cadastro aparecem como texto, sem virar formatação; o e-mail e o site da escola e o e-mail do encarregado viram link com o endereço exato. Depois da publicação, aparece "Versão N, publicada em DD/MM/AAAA". `?courseId=` ou `?escola=` escolhem a escola cujos dados preenchem o texto; o texto é um só para a instalação.

## UC-LGPD-002 — Revisar e publicar os documentos

- Estado: automatizado
- Testes: `lgpd-documentos.test.js` e `PrivacidadePage.test.jsx`

O administrador abre Instituição → Privacidade (LGPD) → Documentos, revisa o modelo, grava o rascunho e confere a prévia com os dados de cada escola (marcador desconhecido aparece como aviso). Publicar pede a palavra PUBLICAR (o campo já vem com o foco) e diz quantos alunos com cadastro ativo passam a ver a versão; o pedido de aceite no próximo acesso chega com o portão do H8a-2. O diálogo avisa quando o texto é o modelo sem nenhuma mudança e quando ainda traz o aviso do modelo para o administrador. A versão publicada fica guardada como foi e não muda mais; uma mudança vira uma versão nova. "Restaurar modelo" volta o rascunho ao texto do IClass sem mexer na versão publicada. Cada publicação fica na auditoria (`legal_publish`).

## UC-LGPD-003 — Informar o controlador e o encarregado

- Estado: automatizado
- Testes: `lgpd-documentos.test.js` e `PrivacidadePage.test.jsx`

Na aba Controlador e encarregado, o administrador vê os dados da escola que entram nos textos (com o atalho para editá-los em Escolas) e grava o nome, o e-mail e o telefone do encarregado (DPO), para uma escola ou para todas. A troca fica na auditoria (`dpo_changed`). Editar a escola não troca o encarregado. Restaurar um backup volta o encarregado ao que estava no backup (as escolas vêm do backup), e a aba avisa disso.

## UC-LGPD-004 — Só o administrador cuida da privacidade

- Estado: automatizado
- Testes: `lgpd-documentos.test.js`, `PrivacidadePage.test.jsx`, `AdminCourseGate.test.jsx` e `admin-rbac-catalog.test.js`

A página e as rotas `/api/admin/lgpd/*` são só do administrador (`students.security`). O professor não vê o item do menu e recebe 403. O administrador chega à página pelo menu do ambiente da instituição, sem escolher curso.

## UC-LGPD-005 — Restaurar backup sem perder os documentos

- Estado: automatizado
- Testes: `lgpd-documentos.test.js`

O backup leva os documentos. A restauração junta pelo id: o que foi publicado depois do backup continua, e o backup de uma versão anterior do IClass (sem os documentos) não apaga nada.

## UC-LGPD-006 — Cadastrar-se com a data de nascimento e o aceite do documento

- Estado: automatizado
- Testes: `lgpd-primeiro-acesso.test.js`, `LoginPage.test.jsx`

O autocadastro pede a data de nascimento e, para menor de 18 anos, o nome e um telefone ou e-mail do responsável. O aceite guarda o id exato do documento que a tela mostrou (o modelo, antes da publicação). Se a escola publicou outra versão com a tela aberta, o cadastro é recusado e a tela pede o aceite da versão nova. O login tem os links dos Termos e da Política.

## UC-LGPD-007 — Completar o primeiro acesso no portal

- Estado: automatizado
- Testes: `lgpd-primeiro-acesso.test.js`, `StudentPrivacyGate.test.jsx`, `legalAcceptance.test.js`, `PrivacidadePage.test.jsx`, `lazyPage.test.jsx`

No portal, o aluno vê "Antes de continuar" só com o que falta: a data de nascimento, o responsável do menor e, depois da publicação, o aceite da versão publicada. O login não é bloqueado (política "ciência"), a prova não passa por essa tela e, em demonstração, ela não aparece. Uma publicação nova pede aceite novo; o anterior fica no histórico. O professor informa a data no cadastro; a ficha mostra a idade e o texto do aceite; a página Privacidade conta os pendentes.

## O que vem depois

- Prazos de retenção e modo do teclado na prova: H8b. Os marcadores `{{prazo_monitoramento}}` e `{{prazo_acessos}}` passam a mostrar os prazos quando eles existirem.
- "Meus dados" e exportação do administrador: H8c.
