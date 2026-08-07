# Contribuindo

Obrigado pelo interesse. Este é um projeto pequeno e opinativo — o guia abaixo
é curto de propósito.

## Antes de escrever código

**Leia o [CLAUDE.md](CLAUDE.md).** Ele documenta as decisões que parecem erradas
até você saber por quê, e cada uma delas foi descoberta quebrando alguma coisa.
São coisas como: por que a janela nunca redimensiona, por que o brilho é
esticado em vez de redimensionado, por que existe um shim `.cmd` em vez de
chamar `node`, e por que há guarda de BOM em quatro lugares.

Mudar qualquer uma sem ler reintroduz o bug que ela evita.

## Rodando

```bash
npm install
npm run dev
```

Flags úteis: `--show`, `--demo`, `--settings`, `--fps`, `--stress`, `--dev`.
Qualquer uma delas repassa o console do renderer para o stderr.

Para compilar o instalador: `npm run build`.

## Verificação

Não há suíte de testes automatizados — seja honesto sobre isso no seu PR.
O que existe:

```bash
node --check <arquivo>     # CJS; para os módulos ES, copie para .mjs antes
node scripts/make-icon.js  # valida o encoder de ícone
npm run build              # valida o schema do electron-builder
```

Mudou animação? **Meça**, não estime:

```bash
npm run dev -- --fps --stress
```

Olhe p95 e a contagem de frames acima de 20ms, não a média. A referência atual é
zero frames perdidos em regime permanente.

Mudou UI? Anexe captura de tela no PR.

## Estilo

- Sem dependências em runtime. O app tem zero, e a ideia é continuar assim.
- Comentário explica **por quê**, não o quê. Se a linha é estranha, diga qual
  bug ela evita.
- Português nos comentários e na documentação, acompanhando o resto do projeto.

## Atalhos de teclado

O autor usa teclado **ABNT2**, onde AltGr é literalmente Ctrl+Alt. Evite propor
`Ctrl+Alt` com `Q W E C 1 2 3` — roubam caracteres da digitação, e
`globalShortcut.register` devolve sucesso mesmo assim, porque o conflito não é
com outro programa.

## Issues

Antes de propor uma abordagem numa issue existente, leia os comentários: alguns
caminhos já foram tentados e têm o resultado documentado. A
[#1](https://github.com/ErikPervious/Perch/issues/1) é um exemplo — a abordagem
via `.credentials.json` já foi testada e não funciona, com a evidência anexada.
