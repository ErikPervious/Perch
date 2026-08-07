---
name: Bug
about: Algo não funciona como deveria
labels: bug
---

## O que acontece

<!-- E o que você esperava que acontecesse. -->

## Como reproduzir

1.
2.

## Ambiente

- Versão do Perch:
- Windows (10 ou 11, e a build):
- Versão do Claude Code (`claude --version`):
- Formato em uso: card / barra / pílula

## Diagnóstico

Rode o app pelo terminal com a flag de diagnóstico e cole a saída — ela mostra
erros do renderer que de outro modo somem sem deixar rastro:

```bash
npm run dev -- --show --fps
```

Se o problema for com os **números** (cota errada, congelada, ausente), diga
também:

- o painel mostra "conectado" em *Conexão com o Claude Code*?
- havia alguma sessão do Claude Code aberta no momento?
- o que aparece no rodapé do painel de detalhes ("ao vivo" ou "dado de X atrás")?

Se for de **animação ou visual**, anexe captura de tela. Para travamento, cole a
saída de `npm run dev -- --fps --stress` (p95 e a contagem de frames >20ms).
