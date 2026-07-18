# Casos de uso — Segurança e backup

## UC-SEC-001 — Impedir arquivos e caminhos maliciosos

- Estado: automatizado
- Testes: `upload-security.test.js` e `safe-path.test.js`

Uploads executáveis, assinaturas incompatíveis, caminhos absolutos e traversal devem ser recusados antes de qualquer leitura, gravação ou extração.

Esses testes permanecem ativos mesmo com a reformulação das apostilas, pois protegem toda a plataforma.
