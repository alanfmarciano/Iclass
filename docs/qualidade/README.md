# Qualidade e testes automatizados — IClass V3

Este diretório é a entrada da documentação viva de qualidade. Um caso marcado como **automatizado** deve possuir pelo menos um teste com o mesmo identificador no título.

## Fontes de verdade

- [ESTRATEGIA_DE_TESTES.md](./ESTRATEGIA_DE_TESTES.md) — camadas, isolamento e critérios de aprovação.
- [PADRAO_DE_CASO_DE_USO.md](./PADRAO_DE_CASO_DE_USO.md) — modelo obrigatório para novos casos.
- [MATRIZ_DE_RASTREABILIDADE.md](./MATRIZ_DE_RASTREABILIDADE.md) — ligação entre requisito, tela, API e teste.
- [`casos-de-uso/`](./casos-de-uso/) — comportamento esperado por domínio.
- [`decisoes/`](./decisoes/) — decisões arquiteturais de qualidade.

## Regra de manutenção

Toda alteração de regra deve atualizar o caso correspondente e seu teste. Alterações somente visuais atualizam o caso visual e, após revisão humana, a imagem de referência. Resultados gerados ficam em `test-results/` e não são versionados.

## Escopo adiado

Novos testes de apostilas, unidades e conteúdo pedagógico não fazem parte desta etapa. Os testes existentes continuam sendo executados para impedir regressões acidentais, mas a nova cobertura será planejada somente após a definição da nova arquitetura do módulo.
