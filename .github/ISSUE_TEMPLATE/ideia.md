---
name: Ideia
about: Sugerir uma funcionalidade ou mudança
labels: enhancement
---

## O problema

<!-- Comece pelo incômodo, não pela solução. O que você tenta fazer hoje e
     não consegue, ou consegue de um jeito ruim? -->

## O que você imagina

<!-- Sua proposta, se já tiver uma. Tudo bem não ter. -->

## Encaixa no que o projeto é?

O Perch tem algumas escolhas firmes, documentadas no
[CLAUDE.md](../../CLAUDE.md). As que mais afetam propostas:

- **Zero dependências em runtime.** Se a ideia precisa de biblioteca nova, ela
  precisa valer muito.
- **Nada de I/O síncrono no processo principal** — ele coordena a composição da
  janela, e travá-lo trava a animação.
- **Nenhuma chamada de rede.** Hoje o app não faz nenhuma, e isso é uma
  propriedade que vale defender.
- **Aviso que aparece demais deixa de ser aviso.** Propostas de notificar mais
  precisam justificar por que não viram ruído.

Não são regras intocáveis — só custam argumento para mudar.
