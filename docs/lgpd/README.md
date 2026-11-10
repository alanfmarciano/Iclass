# LGPD no IClass

Guia curto para a escola e para quem mantém o IClass.

## Termos de Uso e Política de Privacidade

- Ficam em Instituição → Privacidade (LGPD) → Documentos, só para o administrador.
- O IClass traz um modelo pronto (`backend/utils/legalTemplates.js`, `MODEL_ID = 'modelo-2026.1'`). Ele vem com o aviso "Modelo de referência; não substitui orientação jurídica": revise com a direção e, se possível, com um advogado. O aviso fica fora do texto (aparece na página enquanto ela mostra o modelo e na aba Documentos), então publicar o modelo sem editar não deixa para os alunos o "revise antes de publicar". O diálogo de publicar avisa quando o texto é o modelo sem mudança ou ainda traz o aviso (copiado de outro lugar).
- Enquanto nada for publicado, as páginas `/termos` e `/privacidade` mostram o modelo com o aviso de que ainda não foi revisado, e nenhum aluno precisa aceitar nada. Pedir o aceite da versão publicada no próximo acesso é do portão do H8a-2.
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
| `{{base_legal_menores}}` | base legal para menores (texto padrão até o H8a-2) |
| `{{prazo_monitoramento}}`, `{{prazo_acessos}}` | prazos de retenção (H8b); sem prazo, "guardados até a escola apagá-los" |
| `{{prazo_lixeira}}` | prazo da lixeira (Sistema) |
| `{{copias_seguranca}}` | como funcionam as 14 cópias automáticas |
| `{{versao}}`, `{{data_publicacao}}` | versão e data da publicação |

Marcador vazio aparece como `[não informado]`. Marcador fora da lista fica como está e aparece como aviso na prévia.

Os dados do cadastro entram como texto literal: toda pontuação leva a barra do markdown, então nome, endereço ou link escritos no cadastro não viram formatação nem link. Só o e-mail e o site da escola e o e-mail do encarregado viram link, com o endereço exato (e-mail simples e endereço `http(s)://` ou `www.`).

## Encarregado (DPO)

- Fica nos dados da escola (`school.info.dpoName`, `dpoEmail`, `dpoPhone`), mas é gravado só pela página Privacidade (LGPD), com registro na auditoria. Editar a escola em Escolas não o troca.
- Como faz parte do cadastro das escolas, restaurar um backup volta o encarregado ao que estava no backup (as escolas são substituídas pelas do backup). Depois de restaurar, confira a aba Controlador e encarregado.

## Backup

- Os documentos vão no backup. Restaurar junta pelo id: o que foi publicado depois do backup continua, e um backup antigo, sem os documentos, não apaga nada.
