# Casos de uso — Segurança e backup

## UC-SEC-001 — Impedir arquivos e caminhos maliciosos

- Estado: automatizado
- Testes: `upload-security.test.js` e `safe-path.test.js`

Uploads executáveis, assinaturas incompatíveis, caminhos absolutos e traversal devem ser recusados antes de qualquer leitura, gravação ou extração.

Esses testes permanecem ativos mesmo com a reformulação das apostilas, pois protegem toda a plataforma.

## UC-GRAVACAO-001 — Gravar sem perder o que foi confirmado

- Estado: automatizado
- Testes: `database-storage.test.js` e `save-response.test.js`

Toda resposta de "salvo" só sai depois que o dado está no disco (COMMIT do SQLite em modo WAL com `synchronous=FULL`): um kill -9, o Reiniciar ou uma queda logo depois do 200 não perdem a gravação. Um leitor externo do banco não trava a gravação; outro programa prendendo o arquivo por mais que o `busy_timeout` faz a tela receber 503 "Não foi possível gravar os dados agora. Tente de novo em alguns segundos." (sem pendurar e sem derrubar a sessão) e o servidor regrava sozinho quando a trava sai. A primeira gravação depois do boot escreve só o que mudou, linhas com JSON ilegível nunca são apagadas, e um erro no meio da gravação desfaz a transação inteira sem obrigar a regravar o banco todo.
