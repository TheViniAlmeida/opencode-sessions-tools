# Ambiente de testes descartável

Este bootstrap não é um plugin de produção. O pacote permanece privado.
Use Bun 1.4.3, Node 24.21.0 e OpenCode v2.2.5 nesta baseline.

## Pré-requisito de diretório

A raiz autorizada é **somente**
`/tmp/opencode/opencode-sessions-tools`. Ela precisa ser gravável pelo usuário
que executa os testes. Neste host, `/tmp/opencode` pertence a outro usuário;
o operador provisionou a raiz exata com proprietário correto e modo `700`.

Em máquina limpa com o mesmo impedimento, o bootstrap **não resolve** essa
permissão. Solicite ao operador o provisionamento da raiz exata antes de rodar.
Não execute sudo automaticamente nem troque para outra raiz. Outra raiz requer
autorização específica. O erro do harness informa esse pré-requisito sem
imprimir ambiente ou credenciais.

`createHarness({ temporaryBase })` aceita a raiz aprovada ou uma base filha
dela. Cria bases filhas ausentes recursivamente, recusa caminhos externos e
symlinks na base. Cada fixture ocupa um `mkdtemp` próprio; `stop()` remove a
fixture, não a base fornecida pelo chamador. O chamador limpa bases filhas
criadas para sua própria tarefa.

## Verificação local

Depois da aprovação de dependências, execute na raiz do repositório:

```sh
bun install --frozen-lockfile
bun run build
bun run lint
bun run typecheck
bun run test:integration
bun run test:artifact
bun run probe -- bootstrap
```

O runner também aceita uma raiz explícita para testar descoberta de suites:

```sh
bun scripts/test-layer.ts contract --root /caminho/da/sandbox
```

Camada sem testes retorna código `2` e `NOT_IMPLEMENTED`. O teste negativo
usa sandbox vazia própria: não presume que camadas do DAG continuem ausentes.
Probes desconhecidos também falham, sem representar aprovação de capacidades.

## Isolamento do servidor

O harness executa `opencode serve` em loopback com HOME, XDG, DB e cwd próprios.
Não usa descoberta do serviço compartilhado. Recusa configuração gerenciada em
`/etc/opencode`. A credencial efêmera fica em memória; stdout posterior é
drenado e descartado, nunca registrado. Startup tem limite de 30 segundos;
encerramento envia SIGTERM e escala a SIGKILL após 5 segundos.

`request(path, init)` aceita apenas `method`, `body`, `headers` e `signal`.
Recusa origem estrangeira e opções de transporte como `unix`, `proxy` ou `tls`.
Não segue redirects. O sinal do chamador é combinado com timeout de 5 segundos;
não pode desativar o limite. Nenhum teste autoriza publicação ou gate full.

## Reinício e fixtures opcionais

`await harness.restart()` encerra e aguarda o processo antigo, então inicia outro
servidor privado preservando root, cwd, HOME/XDG, DB e configuração. A nova
autenticação fica em memória; `harness.url`, `harness.process` e `request()` usam
o servidor atual. Não guarde URL ou processo antigos para chamadas posteriores.
O retorno de `restart()` só ocorre após readiness. Chamadas durante reinício e
reinícios concorrentes são recusados. Falha ao reiniciar encerra a fixture.
Stop e restart usam uma fila de lifecycle: o cleanup espera o reinício pendente
antes de terminar o processo atual e remover a raiz. Assim, um spawn em andamento
não pode recriar arquivos depois do cleanup final. A integração exercita stop
concorrente com restart em quatro atrasos limitados.

`stop()` é idempotente e remove a fixture uma vez. Depois dele não é permitido
reiniciar. O teste de integração grava uma sessão sintética via API e confirma
o mesmo ID após reinício, autenticação obrigatória e cleanup final. Isso valida
o mecanismo de restart, não a persistência de schedules da T6.

`createHarness({ schedules: true })` mantém a configuração experimental de
schedules ao reiniciar. `createHarness({ identityPlugin: true })` empacota uma
única vez a fixture fixa `scripts/probes/fixtures/identity-plugin.ts`, com Bun,
target `bun`, formato ESM e dependências incluídas. Execute da raiz do repo.
O bundle é `<root>/identity-plugin/index.js`, acompanhado de `package.json`
com nome `identity-private-fixture`, `type: module` e export `.` para `./index.js`.
A configuração isolada recebe o diretório absoluto `<root>/identity-plugin`:
OpenCode V2 ignora entradas locais que apontam para arquivo único, conforme
[Plugins: Configure](https://opencode.ai/v2/docs/plugins#configure).
Não aceita plugin arbitrário, pacote npm ou instalação.
Sem a opção, `plugins` continua vazio. Reinício reutiliza o mesmo artefato.
O teste comprova conteúdo, configuração, estado `active` em `/api/plugin` e
arquivo inalterado após restart. A consulta de plugins espera a ativação
assíncrona por até 10 segundos, antes e depois do restart. O contexto RPC de
identidade continua sendo prova da T3, não deste teste.

## Fixture de operador opt-in

`createHarness({ operatorPlugin: true })` habilita somente a fixture fixa
`scripts/probes/fixtures/operator-plugin.ts`. O helper interno compartilha o
mecanismo de bundle com identidade: Bun ESM, dependências incluídas e
`env: disable`, sem instalação em runtime. Gera
`<root>/operator-plugin/index.js` e `package.json` com nome
`operator-private-fixture`, tipo module e export `.` para `./index.js`.
A configuração isolada acrescenta apenas `<root>/operator-plugin` à lista.

A opção não recebe caminho, configuração ou credencial. Sem `true` ela não
habilita o plugin. Pode combinar identidade e operador; restart reutiliza os
bundles existentes. A raiz da fixture é `0700`; os bundles não contêm segredos.
A integração comprova ausência por padrão, estado `active` e bundle inalterado
após restart. Não substitui a prova de lifecycle/contexto do worker T3.

## Provedor determinístico local

`createHarness({ deliveryProvider: { baseURL } })` usa somente o helper fixo
`deliveryProviderConfig` da fixture `deterministic-provider.ts`. O endereço deve
ter a forma exata `http://127.0.0.1:<porta>/v1`, com porta positiva explícita e
válida. Recusa hostname externo, `localhost`, HTTPS, userinfo, query, fragmento,
Unix socket e caminhos alternativos. Não recebe chave nem instala pacote:
o host usa `@opencode/ai/providers/openai-compatible` já incluído nele.

A configuração é escrita somente dentro da fixture; sem a opção, `providers`
continua vazio. Pode combinar `deliveryProvider`, `schedules` e `identityPlugin`.
O chamador cria e encerra o servidor determinístico loopback. A integração
comprova prompt sintético com resposta `fixture-response-1` e uma chamada SSE
ao modelo `deterministic`. Isso não prova filas, busy ou entrega da T4/T6.
## Canal de operador — T3 / AD-009 (07/11/2026)

Integrador: executar `bun scripts/probes/operator-channel.ts` e
`bun scripts/probes/identity.ts`; integrar operator-channel ao runner existente
quando autorizado. Esta rodada documental não altera código/runner nem executa
probes. Fixtures: `scripts/probes/fixtures/`; evidências mock versus host:
[identity.md](compatibility/identity.md). Literal pública não é credencial nem
segurança de produto; nunca usar segredo real nos probes.

Preferir gateway no setup do plugin, mesmo processo e callback lexical privado
não RPC/tool. Gates em [operator-auth.md](architecture/operator-auth.md): bind
127.0.0.1, porta allowlisted não exposta por RPC/tool de produto, Host/Origin,
limite streaming antes de alocar, anti-replay nonce/body/op/instância/prazo e
cleanup. Restart/stop e unload isolado/cleanup comprovados na fixture host 2.2.5.
Contexto de tool comprovado nessa fixture, não operador; operador de produto
fail-closed até T3-PROD. Loopback não autentica; shell
irrestrito fora do isolamento. Gateway separado assinado somente alternativa.
Emissão humana posterior depende da revisão de armazenamento/provisionamento.

AD-007 APROVADA; docs AD-008/009 APROVADAS na rodada posterior de 07/11/2026.
Viabilidade P0 APROVADA em rev-p0-fechamento; T9 liberada por ordem explícita,
DAG ajustado e auth/provisionamento em T3-PROD. Correções documentais da divisão
aguardam re-review; API obrigatória 1.0, sem autorização de segredo. Contagens T1
anteriores são históricas por lote. Relato atual do integrador: sete testes
integration com 98 ou 100 assertions conforme execução paralela; não é nova
medição desta rodada. Contagem fixa vigente requer execução identificada.
