# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
As seções desta lista são o que o app mostra no painel quando há atualização
disponível — então escreva pensando em quem vai ler antes de decidir se baixa.

## [Não publicado]

## [1.0.0] — 2026-08-07

Primeira versão pública.

### Adicionado

- Ilha animada no topo da tela com o uso da sessão do Claude Code: anel de
  progresso do bloco de 5h, tempo até renovar, ritmo em %/min e projeção de
  esgotamento.
- Três formatos — card, barra e pílula — alternáveis por atalho, com o painel
  completo aparecendo ao passar o mouse.
- Descida automática ao cruzar 50%, 75%, 90% e 95% do bloco, ao cruzar 75% e
  90% do limite semanal, e quando o ritmo de consumo passa de 2,5× o típico com
  projeção de estouro antes do reset.
- Live Activity: waveform enquanto uma sessão está gerando, com intensidade
  proporcional aos tokens de saída por segundo.
- Um bicho que espia da borda de cima, acompanha o cursor, pisca e foge do
  mouse. O humor dele carrega estado — sonolento sem atividade, arregalado
  acima de 85%.
- Painel de configuração centralizado com tema claro e escuro, gravador de
  atalho com teste de conflito, faixa de horários e controles do bicho.
- Bridge que se registra como `statusLine` do Claude Code, com backup do
  `settings.json` antes de qualquer alteração e recusa em sobrescrever
  configuração de terceiro.
- Instalador NSIS sem exigência de administrador, e versão portátil.

### Notas técnicas

- Animação por integrador de mola próprio, sem biblioteca. Zero frames perdidos
  em regime permanente num monitor de 240Hz.
- Nenhuma dependência em runtime. Os encoders de PNG e ICO dos ícones são
  escritos à mão.
- O bridge roda pelo próprio executável em modo Node, então **o app não exige
  Node instalado**.

[Não publicado]: https://github.com/ErikPervious/Perch/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ErikPervious/Perch/releases/tag/v1.0.0
