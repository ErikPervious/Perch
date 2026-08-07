# Segurança e privacidade

Este é um app que lê dados do seu Claude Code. É justo querer saber exatamente
o que ele toca antes de instalar.

## O que ele lê

Só arquivos locais, todos já na sua máquina:

| Caminho | Para quê |
|---|---|
| stdin do `statusLine` | o JSON que o Claude Code entrega a cada render — é daqui que vem a porcentagem de cota |
| `~/.claude/projects/**/*.jsonl` | transcripts, para a Live Activity e o gráfico de 7 dias |
| `~/.claude/settings.json` | para saber se o bridge está registrado |

## O que ele escreve

| Caminho | O quê |
|---|---|
| `%LOCALAPPDATA%\Perch\state.json` | leituras de cota e histórico de amostras |
| `%LOCALAPPDATA%\Perch\config.json` | suas preferências |
| `%LOCALAPPDATA%\Perch\statusline.cmd` | o atalho de invocação do bridge |
| `~/.claude/settings.json` | **só** a chave `statusLine`, e só quando você clica em *conectar* |

Antes de tocar no `settings.json` ele faz uma cópia com timestamp em
`settings.json.perch-backup-*`, e essas cópias nunca são apagadas
automaticamente. Se já existir um `statusLine` seu, o app avisa e **não**
sobrescreve.

## A única requisição de rede

O app faz **uma** conexão, e só para verificar se há versão nova:

```
GET https://api.github.com/repos/ErikPervious/Perch/releases/latest
```

É um GET anônimo, sem token, no mesmo endereço que qualquer pessoa abriria no
navegador. **Nada é enviado**: nenhum identificador, nenhum dado de uso,
nenhuma informação sobre sua cota, nenhuma credencial. A requisição não carrega
nada além do cabeçalho `User-Agent` com o nome e a versão do app.

Ela acontece 20 segundos após abrir e depois a cada 6 horas. Dá para desligar
em **Configurações → Atualizações**, e aí o app não fala com ninguém.

O código inteiro que faz isso está em
[`src/main/updates.js`](src/main/updates.js), num arquivo só, e é o único lugar
do projeto onde a palavra `fetch` aparece fora do renderizador:

```bash
git grep -nE "fetch\(|require\('https?'\)" src bridge
```

## O que ele não faz

- **Não envia nada.** A verificação de versão é só leitura.
- **Não lê `~/.claude/.credentials.json`** nem qualquer token, chave ou senha.
- **Não tem telemetria**, analytics ou relatório de erro remoto.
- **Não baixa nem executa nada sozinho.** Ao encontrar versão nova, ele mostra
  o que mudou e abre a página da release no seu navegador. Quem baixa e instala
  é você.
- **Não tem dependências em runtime.** O `package.json` tem `dependencies`
  vazio; só Electron e electron-builder em desenvolvimento.

Isso foi considerado uma vez: a [issue #1](https://github.com/ErikPervious/Perch/issues/1)
avaliou consultar um endpoint de uso autenticado com o token OAuth para cobrir
o caso do Claude Code fechado. Foi testado, **não funciona** e o código não
entrou. O motivo e a evidência estão documentados lá.

## Sobre a assinatura do executável

Os binários da release **não são assinados** — um certificado de code signing é
pago. O SmartScreen vai avisar que o autor é desconhecido.

Se preferir não confiar num binário não assinado, compile você mesmo:

```bash
git clone https://github.com/ErikPervious/Perch.git
cd Perch
npm install
npm run build
```

O resultado sai em `dist/`.

## Reportando um problema

Para vulnerabilidades, use
[Security → Report a vulnerability](https://github.com/ErikPervious/Perch/security/advisories/new),
que mantém o relato privado até ter correção. Para o resto, uma
[issue](https://github.com/ErikPervious/Perch/issues) normal serve.
