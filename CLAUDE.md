# Notas para quem for mexer no código

O README explica o produto. Este arquivo é sobre as armadilhas: decisões que
parecem erradas até você saber por quê, e que já foram descobertas quebrando
alguma coisa. Mudar qualquer uma delas sem ler isto reintroduz o bug.

## Invariantes

### A janela nunca redimensiona

`WIN_WIDTH`/`WIN_HEIGHT` em `src/main/index.js` são fixos. Toda a animação
acontece numa `div` dentro da janela, via CSS vars escritas pelo loop de molas.
Redimensionar a janela do SO a cada frame é o que faz esse tipo de app parecer
travado.

### Nada de I/O síncrono no processo principal

O processo principal é o mesmo que coordena a composição da janela — um
`readFileSync` de 15MB ali vira frame perdido na animação. `transcripts.js` usa
`fs/promises` e cede o event loop (`setImmediate`) a cada lote de linhas. O tique
rápido de 1,2s só olha os arquivos "quentes"; a varredura completa de ~800
arquivos é rara e assíncrona.

### O brilho é esticado, não redimensionado

`#glow` tem tamanho fixo e recebe `scale`. Ele carrega `blur(22px)`, e mudar a
largura de um elemento borrado obriga o compositor a repintar o blur inteiro todo
frame. Foi a otimização de maior impacto.

### stdout do Electron não chega em quem redireciona (Windows)

O Electron é app de subsistema GUI. `console.log` do processo principal se perde;
`process.stderr.write` funciona. Por isso todo diagnóstico vai para stderr.

O mesmo vale para `ELECTRON_RUN_AS_NODE`: escrever no stdout quando ele é um
**pipe** estoura `EPIPE`. Redirecionar para **arquivo** funciona — é a razão de
existir o shim `.cmd` em `src/main/bridge.js`. Não troque por invocação direta de
`node`: isso reintroduz a dependência de Node instalado na máquina.

### BOM quebra JSON.parse, e ele aparece o tempo todo no Windows

Bloco de Notas, `Out-File -Encoding utf8` e o pipe do PowerShell para stdin de
executável nativo põem BOM. Sem a guarda, o `catch` devolve o padrão e a
preferência do usuário some em silêncio. Já mordeu três vezes. Os pontos de
leitura que fazem o strip:

- `src/main/config.js`
- `src/main/usage.js`
- `src/main/bridge.js`
- `bridge/statusline.js` (arquivo **e** stdin)

### O bridge é autocontido

`bridge/statusline.js` vai em `extraResources`, fora do asar, porque precisa ser
executável. Ele **não pode** fazer `require` de nada em `src/` — no pacote esse
caminho não existe. O `STATE_DIR` está duplicado ali de propósito e precisa
continuar batendo com `src/main/paths.js`.

### Handshake antes de mandar estado ao renderer

O main só envia `boot` e o primeiro estado depois de receber `island:renderer-ready`.
Usar `ready-to-show` era uma corrida: falhava em 4 de 6 execuções, porque o módulo
do renderer ainda não tinha registrado os listeners e a mensagem se perdia.

O `ready()` é chamado no **fim** do pré-aquecimento, não no carregamento. "Pronto"
tem que significar rasterizado.

### Só o processo principal escreve config

O renderer nunca grava `config.json`. Quem cicla formato, grava atalho ou muda
qualquer preferência é o main, que depois reemite o estado. Duas fontes de
verdade divergiriam.

## Coisas que parecem bug e não são

- **`ready-to-show` só faz `showInactive()`.** O resto mora no handshake.
- **Opacidade 0.01 no pré-aquecimento.** Com `0` o compositor descarta a camada e
  o aquecimento não acontece.
- **O veredito não usa `--tone`.** Ele responde ao que está dizendo, não ao nível
  de uso. Um "acaba antes do reset" verde seria mentira visual.
- **`rotateWindow` marca degraus já passados como disparados.** Sem isso, abrir o
  app em 85% alertaria 50% e 75% retroativamente.
- **O gaze do bicho usa `+dx`, não `-dx`.** Ele estar desenhado de ponta-cabeça
  não inverte nada: o SVG não está rotacionado.
- **`OWN_MARKERS` em `bridge.js` inclui `claude-island`.** É o nome antigo; sem
  ele, uma instalação anterior à renomeação seria lida como "statusLine de
  terceiro" e o app se recusaria a consertar.

## Ao mexer em atalhos

O teclado do usuário é **ABNT2**, onde AltGr é literalmente Ctrl+Alt. Evite
`Ctrl+Alt` com `Q W E C 1 2 3` — roubam caracteres da digitação, e
`globalShortcut.register` devolve `true` mesmo assim, porque o conflito não é com
outro programa. Evite também `Ctrl+Shift+Space` (VS Code).

## Ao mexer em animação

Meça, não estime:

```bash
npm run dev -- --fps --stress
```

Olhe **p95 e frames >20ms**, não a média. A referência atual é 0 frames perdidos
em regime permanente num monitor de 240Hz. Um pico de ~70ms nos 2 primeiros
segundos é esperado — é raster de inicialização, e acontece com a ilha escondida.

Constantes de mola vivem em `PRESETS` (`src/renderer/spring.js`). A regra: abrir
pode passar do ponto, fechar não.

## Ao mexer no bicho

`EYE_CY`, `EYE_RX` e `EYE_RY` em `critter.js` precisam bater com o markup em
`index.html` — o SVG é 48×48 e o elemento em CSS também, de propósito, para que
1 unidade de viewBox seja 1 pixel e o cálculo do olhar não precise converter
escala. `CRITTER_OFFSET_X` precisa bater com `--critter-dx` no `style.css`.

## Verificação

Não há suíte de testes. O que existe:

```bash
node --check <arquivo>          # CJS; para os módulos ES, copie para .mjs antes
node scripts/make-icon.js       # valida o encoder de ícone
npm run build                   # valida o schema do electron-builder
```

Para o bridge, invoque o shim com um payload realista e confira a linha de volta
e o `state.json`. Para a UI, `--show`/`--demo`/`--settings` mais captura de tela.
