# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
As seções desta lista são o que o app mostra no painel quando há atualização
disponível — então escreva pensando em quem vai ler antes de decidir se baixa.

## [Não publicado]

## [1.0.3] — 2026-08-07

### Corrigido

- A versão portátil quebrava a conexão com o Claude Code. Ela se extrai num
  diretório temporário aleatório a cada execução e o apaga ao fechar, então o
  caminho gravado morria junto — sem erro, sem aviso. Pior: abrir a portátil
  **uma vez** estragava uma instalação que estava funcionando, porque o
  autoconserto reescrevia o caminho apontando para o temporário. Agora a
  portátil não instala nem regrava a conexão, e o painel explica que é preciso
  usar o instalador.

## [1.0.2] — 2026-08-07

### Adicionado

- Botão de fixar ao lado da engrenagem. O painel já podia ser travado clicando
  na ilha, mas não havia nada indicando isso — agora tem botão, com estado
  visível, que continua aparecendo enquanto estiver fixado.

### Corrigido

- Os botões do canto passavam por baixo do badge de veredito no painel de
  detalhes e ficavam colados na borda. Ganharam folga e área de clique maior.
- O olho do bicho virava um risco fino no humor sonolento. A pálpebra encolhia
  em torno do centro do olho, que fica exatamente na borda da tela, então
  fechar comia justamente a metade visível — e a pupila ficava maior que a
  fresta. O pivô desceu, e o fechamento agora come primeiro a parte que já
  está fora da tela.
- "renova em agora" quando faltava menos de um minuto para o reset. Virou
  "renova agora".
- No tema claro o bicho herdava o branco do corpo da ilha e praticamente
  desaparecia. Passou a ter cor própria.

## [1.0.1] — 2026-08-07

### Adicionado

- Verificação de novas versões. Quando há atualização, o painel mostra **o que
  mudou antes de você baixar** — as notas da release renderizadas ali mesmo,
  já que o instalador do Windows não tem tela de changelog. O aviso na ilha
  aparece uma vez por versão e respeita a faixa de horários configurada.
  Desligável em Configurações → Atualizações.
- Verificação de sintaxe e de invariantes rodando em todo pull request, mais
  build do Windows. As releases passam a ser compiladas pelo CI a partir de uma
  cópia limpa, em vez da máquina do autor.

### Corrigido

- O `statusLine` sumia do `settings.json` sem ninguém pedir. O Claude Code
  regrava aquele arquivo inteiro quando a config dele muda, e uma sessão que o
  carregou antes da instalação levava a nossa entrada junto. O sintoma não dava
  erro: sessões antigas seguiam invocando o bridge de memória, e os dados só
  paravam horas depois. Agora o app repõe a entrada sozinho, verifica a cada
  minuto e avisa no painel quando reconectou.

### Segurança

- Electron atualizado de 33.4.11 para 39.8.10, corrigindo 15 alertas — 3 de
  severidade alta.

### Notas

- A verificação de versão é a primeira e única requisição de rede do app: um
  GET anônimo na API pública de releases do GitHub, sem enviar nada.

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

[Não publicado]: https://github.com/ErikPervious/Perch/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/ErikPervious/Perch/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/ErikPervious/Perch/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/ErikPervious/Perch/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ErikPervious/Perch/releases/tag/v1.0.0
