# Padrão de caso de uso

Copie este modelo ao documentar uma nova regra.

```markdown
## UC-DOMINIO-000 — Nome curto

- Estado: planejado | automatizado | adiado
- Atores: administrador | professor | aluno
- Telas: caminhos da interface
- APIs: rotas envolvidas
- Testes: arquivos e títulos com o mesmo ID

### Dado
Pré-condições e dados fixos.

### Quando
Ações do usuário.

### Então — interface
Textos, números, estados e mensagens esperados.

### Então — servidor e persistência
Resposta, cálculo e dados gravados.

### Segurança e bordas
Usuários proibidos, erros, limites e estados vazios.
```

IDs não são reutilizados. Testes automatizados começam com `[UC-DOMINIO-000]`.
