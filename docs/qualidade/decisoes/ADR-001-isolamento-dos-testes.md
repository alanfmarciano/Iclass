# ADR-001 — Isolamento dos testes

## Decisão

Casos automatizados usam `TEST_MODE=1`, porta `3132` e diretórios criados no temporário do sistema operacional.

## Motivo

Permite executar testes no computador do professor sem ler ou modificar dados reais. O seed de demonstração é aceito apenas nesse modo.
