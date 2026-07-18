# Relatorio de Paridade Funcional - IClass V3

Gerado em: 2026-07-09

## Resumo

A migracao foi comparada contra a interface anterior em `C:\Users\Alan Marciano\Desktop\atual desenvolvimento\frontend` e implementada no frontend React atual em `web/src`, preservando os contratos existentes do backend sempre que possivel.

O foco desta rodada foi reativar recursos que ja existiam no backend e estavam ausentes ou simplificados na nova UI.

## Implementado

- Login do aluno com cadastro publico e solicitacao de recuperacao de senha.
- Persistencia de turma/curso ativo para alunos com multiplas turmas.
- Portal do aluno com modulos por estrutura do curso, progresso por unidade, caderno por material, anotacoes por paragrafo e forum por unidade.
- Historico de provas do aluno com detalhes, nota, acertos, versao e gabarito quando liberado.
- Gestao de alunos com criacao, edicao, multiplas turmas, historico de resultados, reset de senha e liberacao individual de materiais/provas.
- Materiais com liberacao de apostilas, provas online e gabaritos, incluindo liberar/bloquear modulo inteiro.
- Provas com historico de aplicacoes, preview da avaliacao, token, sala de espera, importacao e remocao de questoes do banco.
- Monitor online com token, sala de espera, acoes por turma e por aluno: tempo, mensagem, versao e desbloqueio de foco.
- Resultados com detalhe da submissao, exclusao, exportacao CSV por turma/prova e lancamento manual rapido.
- Forum do instrutor com filtros por material, resposta, edicao e exclusao.
- Editor de conteudo com criacao de nova apostila/avaliacao vinculada a modulo existente.

## Parcial

- Fluxo de prova impressa: o lancamento manual e historico existem, mas a geracao/diagramacao completa de PDF impresso da UI antiga nao foi recriada nesta rodada.
- Edicao rica de respostas no forum do aluno fora do leitor de unidade: o fluxo completo existe no leitor de apostila; a tela geral de duvidas continua como visao simples.
- Banco de questoes: importacao, listagem e remocao foram ativadas; criacao manual detalhada de questao pode ser expandida depois.

## Nao Aplicavel Nesta Rodada

- Copia do layout antigo: descartada por decisao de manter a arquitetura e visual do React atual.
- Ferramentas diagnosticas internas da UI antiga: ficaram fora do caminho principal de ensino/prova.

## Validacao

- `npm.cmd run build` executado com sucesso fora do sandbox apos falha inicial de permissao do esbuild.
- Backend em modo teste respondeu `{"enabled":true}` em `http://localhost:3131/api/test-mode`.

## Observacoes

- O primeiro `npm run build` falhou porque o PowerShell bloqueia `npm.ps1`; foi usado `npm.cmd`.
- O build dentro do sandbox falhou por acesso negado do esbuild ao carregar a configuracao do Vite; a validacao foi repetida fora do sandbox e passou.
- O Vite emitiu apenas aviso de chunk grande, sem erro de compilacao.
