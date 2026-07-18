# ADR-002 — Regressão visual

## Decisão

Playwright manterá imagens aprovadas para Premium/Lumen em desktop e celular. Mudanças de referência exigem execução explícita com atualização de snapshots e revisão humana.

## Motivo

Asserções de texto não detectam sobreposição, corte, espaçamento ou quebra responsiva.
