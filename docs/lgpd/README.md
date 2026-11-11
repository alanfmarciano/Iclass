# LGPD no IClass

Guia curto para a escola e para quem mantém o IClass.

## Termos de Uso e Política de Privacidade

- Ficam em Instituição → Privacidade (LGPD) → Documentos, só para o administrador.
- O IClass traz um modelo pronto (`backend/utils/legalTemplates.js`, `MODEL_ID = 'modelo-2026.1'`). Ele vem com o aviso "Modelo de referência; não substitui orientação jurídica": revise com a direção e, se possível, com um advogado. O aviso fica fora do texto (aparece na página enquanto ela mostra o modelo e na aba Documentos), então publicar o modelo sem editar não deixa para os alunos o "revise antes de publicar". O diálogo de publicar avisa quando o texto é o modelo sem mudança ou ainda traz o aviso (copiado de outro lugar).
- Enquanto nada for publicado, as páginas `/termos` e `/privacidade` mostram o modelo com o aviso de que ainda não foi revisado, e nenhum aluno precisa aceitar nada. Depois da publicação, o portal do aluno pede o aceite da versão publicada no próximo acesso (veja "Primeiro acesso do aluno", abaixo).
- Publicar cria uma versão nova (`termos_v1`, `termos_v2`...), que não muda mais. É ela que prova qual texto o aluno aceitou.
- O texto é um só para a instalação. Os dados de cada escola entram pelos marcadores `{{...}}`:

| Marcador | De onde vem |
|---|---|
| `{{instituicao}}` | razão social da escola (ou o nome) |
| `{{nome_fantasia}}` | nome fantasia (ou o nome) |
| `{{cnpj}}` | CNPJ |
| `{{endereco}}` | endereço, cidade/UF e CEP |
| `{{contato_instituicao}}` | e-mail, telefone e site |
| `{{encarregado_nome}}`, `{{encarregado_contato}}` | encarregado (aba Controlador e encarregado) |
| `{{base_legal_menores}}` | base legal para menores (texto padrão) |
| `{{prazo_monitoramento}}`, `{{prazo_acessos}}` | prazos de retenção (H8b); sem prazo, "guardados até a escola apagá-los" |
| `{{prazo_lixeira}}` | prazo da lixeira (Sistema) |
| `{{copias_seguranca}}` | como funcionam as 14 cópias automáticas |
| `{{versao}}`, `{{data_publicacao}}` | versão e data da publicação |

Marcador vazio aparece como `[não informado]`. Marcador fora da lista fica como está e aparece como aviso na prévia.

Os dados do cadastro entram como texto literal: toda pontuação leva a barra do markdown, então nome, endereço ou link escritos no cadastro não viram formatação nem link. Só o e-mail e o site da escola e o e-mail do encarregado viram link, com o endereço exato (e-mail simples e endereço `http(s)://` ou `www.`).

## Primeiro acesso do aluno

- Política "ciência" (decisão P4): o IClass pede a todos os alunos, mas não bloqueia o login, e a prova nunca passa por essa tela. Quem clica em Sair é perguntado de novo no próximo acesso.
- No portal, o aluno vê "Antes de continuar" só com o que falta: a data de nascimento (a quem não tem), o nome e um telefone ou e-mail do responsável (menor de 18 anos sem esses dados) e, depois que a escola publica os documentos, o aceite da versão publicada, com o texto na própria tela e um link para outra aba.
- O aceite guarda o id exato do documento (`termos_v2`, por exemplo), a escola, a data, o IP e o aparelho. Publicar uma versão nova pede um aceite novo; o anterior fica no histórico do aluno. O aceite antigo "v1.0", de antes desta versão, aparece na ficha como "aceite antigo sem documento".
- O autocadastro pede a data de nascimento e, para menor, o responsável; a tela de login tem os links dos Termos e da Política.
- O professor pode informar a data no cadastro do aluno (opcional); a ficha mostra a idade.
- A página Privacidade (LGPD) mostra quantos alunos ainda têm o primeiro acesso pendente.
- Em demonstração (`TEST_MODE=1`) a tela não aparece.

## Encarregado (DPO)

- Fica nos dados da escola (`school.info.dpoName`, `dpoEmail`, `dpoPhone`), mas é gravado só pela página Privacidade (LGPD), com registro na auditoria. Editar a escola em Escolas não o troca.
- Como faz parte do cadastro das escolas, restaurar um backup volta o encarregado ao que estava no backup (as escolas são substituídas pelas do backup). Depois de restaurar, confira a aba Controlador e encarregado.

## Retenção dos registros técnicos

- Fica em Sistema → Retenção. Só o administrador muda; o professor vê os prazos com o cartão desligado.
- Vem desligada (0 = não apagar). Até o administrador salvar os prazos uma vez, o cartão mostra o aviso "Prazos de retenção ainda não definidos". "Usar prazos recomendados" preenche 180 dias para o monitoramento da prova, 365 para os registros de acesso e 30 para a lixeira; nada muda antes de salvar.
- Mínimos: 30 dias para o monitoramento (dá tempo de rever uma prova contestada), 180 para os acessos (Marco Civil da Internet, art. 15) e 1 para a lixeira. Um prazo menor sobe para o mínimo e a tela avisa. Máximo de 3.650 dias.
- O que pode ser apagado: as teclas e as saídas de tela de aplicações encerradas há mais que o prazo, os registros de acesso antigos e os itens vencidos da lixeira de arquivos. Nunca são apagados por prazo: cadastro do aluno, notas, entregas, frequência, auditoria, observações e mensagens.
- As 14 cópias de segurança automáticas guardam os dados como estavam no dia de cada cópia: um registro apagado pela retenção ainda fica nelas por até 14 dias, até a cópia ser trocada.
- A prévia mostra quanto a próxima limpeza apagaria com os prazos da tela. "Limpar agora" pede a palavra APAGAR. A limpeza nunca roda com prova em espera, em andamento ou pausada.
- Com algum prazo ligado, o IClass confere de hora em hora e limpa uma vez por dia, no máximo 20 mil de cada tipo por vez (o resto fica para a hora seguinte). Toda limpeza entra na auditoria (`retention_purge`) e mudar os prazos também (`retention_settings_changed`).
- Os prazos aparecem nos Termos e na Política (`{{prazo_monitoramento}}`, `{{prazo_acessos}}`, `{{prazo_lixeira}}`) e nas instruções da prova.

## Registro do teclado na prova

- O professor escolhe, ao preparar cada aplicação, o que o teclado registra:
  - "Só atalhos suspeitos" (padrão): copiar, colar, recortar, menu do botão direito, troca de janela e as tentativas de atalho que a prova bloqueia;
  - "Toda a digitação": todas as teclas da tela da prova;
  - "Não registrar o teclado".
- Aplicação de antes desta versão vale como "Só atalhos suspeitos".
- O que o aluno escreve em "Reportar problema" nunca é registrado, em nenhum modo.
- O bloqueio dos atalhos (copiar, imprimir, buscar) e o registro das saídas da tela continuam iguais em todos os modos.
- As instruções da prova dizem ao aluno o que é registrado e por quanto tempo fica guardado. O servidor filtra de novo, então um navegador com a versão antiga da prova também segue o modo.

## Backup

- Os documentos vão no backup. Restaurar junta pelo id: o que foi publicado depois do backup continua, e um backup antigo, sem os documentos, não apaga nada.
