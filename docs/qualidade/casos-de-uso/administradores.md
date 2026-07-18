# Casos de uso — Administradores e permissões

## UC-ADMIN-001 — Restringir gestão de contas por perfil

- Estado: automatizado
- Atores: administrador e professor
- Tela: `/admins`
- Regra: `accounts.manage`
- Testes: `admin-access.spec.js` e `admin-rbac-catalog.test.js`

O administrador autorizado deve visualizar e acessar a gestão de contas. O professor não deve ver o item de navegação e não pode obter acesso digitando a URL diretamente ou chamando a API protegida.

## UC-ADMIN-002 — Catálogo RBAC completo

- Estado: automatizado
- Teste: `admin-rbac-catalog.test.js`

Toda rota `/api/admin` deve possuir decisão explícita no catálogo de permissões.
