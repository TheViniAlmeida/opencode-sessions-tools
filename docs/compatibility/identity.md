# T3 — evidências de viabilidade e limites de produto

Nota vigente de 07/11/2026: viabilidade T3-P0/P0 APROVADA pelo revisor em
rev-p0-fechamento (45 contract/401 assertions, lote informado); docs AD-008/009
APROVADAS na rodada posterior, AD-007 preservada. T9 liberada por ordem explícita
após P0, DAG ajustado; auth/provisionamento/humano/always pertencem a T3-PROD.
Snapshots, comandos e resultados abaixo são históricos por lote, não instrução
para congelar o runner ou negar provas posteriores. Contexto tool e unload
isolado/cleanup provados na fixture host 2.2.5, não identidade de operador.
Nenhum script/runner alterado por esta nota; nenhum segredo autorizado. Correções
documentais da divisão aguardam re-review, não novo aceite dos docs AD-008/009.

## Gate de viabilidade: comando humano/agente e always

Consulta atual: SDK local 2.2.5, snapshot T2 e Context7 oficial V2
`ctx.command.transform`/`ctx.permission.reply`. Pesquisa de contratos, **não nova
prova runtime de autoria humana**. Nenhum reply once/always foi enviado; nenhuma
alteração de modelo, policy ou permissão administrativa foi executada.

| Superfície pública | Evidência e consequência |
| --- | --- |
| CommandInvocation | `@opencode/plugin/dist/promise/command.d.ts:6-10`: sessionID, prompt, delivery. Não declara principal humano, identidade autenticada, origin ou headers. |
| CommandDefinition.execute | Mesmo arquivo :11-14 recebe somente CommandInvocation, não contexto de transporte confiável. |
| POST `/api/session/{sessionID}/command` | Snapshot: name/text obrigatórios; files/agents/skills/delivery opcionais. Executa slash callback imediatamente. Não declara origem humana verificada. |
| PermissionDomain | `dist/promise/permission.d.ts:20` expõe list/get/reply. Disponibilidade da API não estabelece quem é operador. |
| PermissionEvaluation | Mesmo arquivo :7-15: sessionID, agent opcional, action/resources/metadata/source/effect/message. Nenhum principal operador declarado. |
| Permission.Source | Snapshot: type tool, messageID e id. Correlaciona tool; não autentica pessoa ou grant. |
| POST permission reply | Snapshot: path sessionID/requestID; body decision e message opcional; decision enum once/always/reject. Nenhum campo de principal verificado no contrato. |
| RPC handler | Runtime anterior observou error/signal; Basic do servidor não se converte em operador. |

Texto `/comando`, delivery, nome de agente, sessionID, attachments ou claim
principal não demonstram autoria humana. Ausência nos contratos consultados não
prova ausência universal de toda API futura; significa que **não há fundamento
atual para promover comando a operador**. Não fabricar humano via RPC nem tomar
204 de command/reply como prova de pessoa autenticada. Exemplo Context7 usa
reply/input SDK, enquanto snapshot HTTP usa decision; não misturar DTOs.

### Resultado decisivo para a arquitetura mínima

**Viabilidade técnica do canal separado demonstrada pela fixture; principal
humano nativo de command/reply NÃO estabelecido.** Produto deve SEMPRE reservar
concessão de operador ao gateway com autenticação própria revisada. Comando é
entrada sem autoridade: pode consultar ou abrir solicitação, nunca conceder
always, modificar a própria policy/model/config ou inferir aprovação pelo texto.
Tool só recebe autoridade restrita proveniente do contexto host. Gateway deve
verificar operação/escopo e gate humano e chamar callback privado; nada disso
deve ser exposto como admin em RPC genérico.

Essa decisão resolve a bifurcação de viabilidade sem exigir implementar todos
os controles de produto em P0. Não é GO para provisionamento/produção: credencial
real e hardening exigem revisão própria. Também não impede uso direto do reply
nativo por outro cliente com acesso ao host ou código com mesmo usuário/segredo:
o plugin não transforma API nativa em fronteira de segurança. Se o adversário
inclui agente com shell/credencial de host, precisa isolamento de identidade
OS/processo e restrição de acesso nativo; reservar o wrapper por convenção não
constitui prova anti-bypass.

Não foi adicionado mock de “refusal de always” como se fosse prova nativa: um
wrapper que simplesmente devolve false prova sua própria regra, não autorização
do host. Gates restantes são implementação/revisão de auth operador, prevenção
de bypass, auditoria/rotação/replay/limites, confirmação por operação e ensaios
de concessão só em ambiente aprovado. TOOL e unload isolado já provados, não
continuam pendências. Campo de probe agora se chama
`toolExecutionProvenByThisProbe`: false apenas no operator-channel, sem contradizer
o sibling `probeToolIdentity` que executou ferramenta real.

## Estado vigente: unload isolado e retirada de descoberta por RPC

Tool runtime SES-01 continua **provado**; blocos históricos que o chamam não
validado ou exigem forgedDenied estão superados pela correção SES-01 abaixo.
Gateway não publica mais porta por RPC: `gateway` retorna estritamente
callbackCount/transportOnly. Nenhuma tool registrada devolve endpoint/descriptor.
RPCs port/descriptor/listener/admin/probe/execute/tool inexistentes são negativos
400. Isso não garante não-descoberta via shell, /proc ou varredura local: porta
não é segredo e autenticação é que deve proteger operações.

Canal de descoberta do teste: setup grava **apenas**
`<HOME privado>/identity-channel.json`, mode 0600, com porta, PID e state.
HOME é validado no prefixo fixo /tmp/opencode/opencode-sessions-tools/fixture-
e sufixo /home; escrita fora dessa fixture é recusada. Probe lê seu próprio
arquivo, não host storage/RPC. Descriptor não contém credencial nem powers;
cleanup marca state unloaded e fecha listener. Não usar isso como mecanismo de
segurança contra agente com acesso ao mesmo HOME/usuário. Não é um formato de
descoberta/administração de produção.

### Contrato público e evidência de unload sem stop

SDK PluginApi e snapshot T2 `/api/plugin` oferecem **list**, não operação de
unload. Docs oficiais [Plugins V2 Control/Reload](https://opencode.ai/v2/docs/plugins)
e Context7 confirmam controle por `plugins: [..., "-<plugin-id>"]` e reload
automático de config vigiada. Em vez de inventar endpoint, probe adiciona
`-identity-private-fixture` somente na config temporária do próprio harness.

Observado: cleanup escreve unloaded; socket retorna ECONNREFUSED; `/api/info`
permanece 200; PID do host continua vivo e starttime em `/proc/<pid>/stat`
inalterado. RPC gateway torna-se indisponível (400). Tudo isso é medido **antes**
de harness.stop. Logo unload isolado do pacote e cleanup do listener provados
sem confundir com encerramento do processo. Prova anterior de restart/stop
continua passando. Nenhum arquivo/config global ou harness foi alterado.

### Transporte mock endurecido, não autenticação produto

Além de Origin, fixture exige Host exato 127.0.0.1:porta e limita body a 1024
bytes durante leitura em streaming, antes de concatenar além do limite/parsear
JSON. Testes cobrem Host errado, oversized e stream chunked sem Content-Length;
callback permanece não alcançado. Runtime pode alocar um chunk recebido antes
de entregá-lo ao reader; limite é da aplicação, não promessa de memória total.
Não há ainda timeout de leitura/rate limit/replay store ou token real.

**Gates restantes:** revisão de provisionamento/auth operador e isolamento OS,
controle produto real, comando humano versus agente, always/autoconfiguração,
auditoria/rotação/replay/limites e gates humanos por operação. Não há segredo
real nem efeito administrativo. Não exigir novo gate de rejeitar campos tool:
invariante exigido é ignorá-los para identidade, já provado.

## Correção vigente SES-01 — ignorar claims, não exigir rejeição

Revisão independente identificou `forgedDenied` como aceite inventado: SES-01
exige identidade originada no host, não recusa de campos extras. Correção
específica aprovada, sem alteração de spec. Seções históricas abaixo que chamam
normalização de bloqueador de requisito estão **superadas por esta correção**.

Fixture agora registra dois diagnósticos sem efeitos: identity_diagnostic aceita
caller_sessionID/principal opcionais e retorna receivedKeys; versão
identity_diagnostic_strict mantém apenas action e additionalProperties false.
Ambos derivam sessionID/agent/callID exclusivamente do contexto host, ignoram
claims e recusam ação diferente de diagnostic. Nenhum grant/admin adicionado.

Probe executa quatro sessões sintéticas numa execução compartilhada pelos testes:
duas normais separadas por restart de host/provider, uma permissiva forjada e uma
strict forjada. `forgedSession: { id, observations, callIDs, forgedOutcome }`
elimina prova vacuamente verdadeira: observações devem existir, receivedKeys
deve conter action/caller_sessionID/principal, sessionID deve ser o ID próprio
da sessão e diferente de synthetic-forged, agent build e callID deve constar do
tool part real no histórico. Dois IDs normais e forgedSession são distintos.

Strict é observação versionada: rejeição ou normalização preservando identidade
são válidas; ausência de observação sem erro reconhecido é `unobserved` e falha.
No 2.2.5 observado: **normalized-identity-preserved**. Permissivo:
**received-claims-ignored**. Logo os claims realmente chegaram ao handler no
caso permissivo, sem serem tratados como identidade; não depende só de stripping.
`forgedDenied` removido, sem flexibilizar o invariante de identidade.

Exports para runner: `probeToolIdentity()` e `probeIdentity()` em
`scripts/probes/identity.ts`; `createToolProvider()` em fixture exclusiva.
`probeToolIdentity` devolve sessions, forgedSession, strictSession,
hostAndProviderRestarted, providerRequests, forgedIdentityObserved e toolExecuted.

**Estado:** identidade TOOL runtime provada nesta fixture/host 2.2.5, não controle
de produto completo. Comando humano, always/autoconfiguração,
provisionamento e autenticação operador de produção continuam não validados.
Unload isolado foi provado no incremento do início deste documento; a antiga
menção a unload pendente nesta seção está superada.
Gateway literal continua mock; RPC auth do servidor continua distinto de operador.

## Histórico superado: TOOL real e exigência incorreta de rejeição estrita

O suposto bloqueio de rejeição estrita desta seção foi removido por revisão
SES-01. A seção de correção acima é o contrato de teste atual; texto abaixo é
registro da investigação anterior, não requisito ou pendência vigente.

Context7 V2 e SDK consultados antes de implementar: ctx.tool.transform/add,
execute(input, context), options codemode; `@opencode/schema/dist/tool.d.ts:10-15`
declara sessionID, agent, messageID e id. Fixture registra apenas operação
diagnostic, sem caller_sessionID, additionalProperties false, guard adicional
no execute rejeitando qualquer ação diferente. Nenhum execute chamado manualmente.

Provider exclusivo `fixtures/tool-provider.ts` serve OpenAI-compatible SSE em
loopback, emite tool_calls identity_diagnostic e encerra após mensagem role tool.
Não acessa rede externa, não armazena headers/prompts e não modifica provider
compartilhado. Modelo/config tools=false **não impediu** esse caminho no 2.2.5:
requisições reais continham tools e host executou a chamada. Não foi necessário
alterar harness. Não interpretar capabilities como controle de autorização.

Primeira prova falhou: ferramenta custom omitida do catálogo direto por modo
Code Mode. `options: { codemode: false }` tornou-a presente no request e a
execução passou. Em duas sessões próprias, separadas por restart do host e do
provider (mesma porta privada), histórico contém resultado do callback com
sessionID correspondente, agent build e callID sintético. Provider observou
mensagem tool na sequência. Isso prova provider -> host -> plugin -> histórico,
não somente emissão protocolar. Histórico pode marcar executed:false mesmo com
state completed e conteúdo real da fixture; não usar esse booleano isolado.

**Bloqueio novo real:** terceira sessão recebe argumentos action diagnostic,
caller_sessionID synthetic-forged e principal operator. Apesar de
additionalProperties:false, host executou tool e identidade permaneceu do host.
O guard do executor não detectou extras: evidência consistente com normalização
antes de execute (não afirmar implementação interna sem fonte). Tentativa de
execute.before guard também não impediu e foi removida como ineficaz. Não
anunciar rejeição estrita com schema somente. Payload forjado não altera
identidade, mas exigência de **recusar argumento** não foi satisfeita.

Teste de identidade e teste de rejeição separados: o segundo exige forgedDenied
true e permanece VERMELHO, sem skip/TODO nem expectativa invertida. Integrador
precisa revisar contrato público de validação preservando input bruto (ex.
schema validator estrito suportado), antes de fechar T3. Não alterar harness
para tools:true por esse resultado: não é o bloqueador observado.

Host e provider encerram em finally; provider reinicia sem instalação ou config
nova. Sem grants always/autoconfig/admin. Prova de identidade tool não resolve
principal operador RPC, credencial produção ou comando humano.

## AD009 — proposta de canal administrativo separado (não provisionado)

### Histórico superado: listener real em setup e lifecycle de processo provados

Registro histórico do estágio anterior ao unload isolado. Porta em RPC e
unload pendente descritos nesta subseção NÃO são o estado vigente; ver início
do documento para descriptor privado, reload e fechamento com host vivo.

Fixture `identity-plugin.ts` agora cria listener via helper importado no setup
real. O callback é lexical privado no helper: incrementa contador e retorna
somente dados sintéticos sem efeito administrativo. RPC diagnóstico separado
`identity-candidate.gateway` aceita objeto vazio e expõe apenas porta, contador
e flag transportOnly. Não fornece token, função, proxy ou operação admin.
`current` continua expondo somente operator false e contextKeys, compatível
com os testes de identidade anteriores.

`probePluginOperatorChannel` usa harness isolado com identityPlugin true e
harness.request para localizar porta via RPC. Provas reais:

- Registro/lifecycle: listener criado no setup, diagnóstico RPC 200.
- Tentativas RPC admin/probe/execute/tool, payload administrativo no gateway e
  claim operador em current deixam contador zero; métodos não registrados e
  input extra são rejeitados. Isso não é teste de execução de tool pelo modelo.
- HTTP sem header mock: 401 e contador intacto; com literal público: 200 e
  contador passa a um.
- Restart: socket antigo retorna ECONNREFUSED antes de inicializar novo plugin;
  novo listener tem contador zero e aceita request sintético autorizado pelo mock.
- Stop final: sockets antigo e novo retornam ECONNREFUSED. Timeout não conta
  como fechamento no teste. Cleanup retornado por setup chama stop e dispose;
  falha de registro também chama stop. **Unload individual sem encerrar processo
  ainda não foi exercitado**; restart/stop encerram processo e não isolam o efeito
  específico da função cleanup em unload.

Red/green executado: teste inicialmente falhou por export de probe inexistente;
após implementação executa no host real. Não mudou harness/dependência/config.
CLI operator-channel agora executa prova sintética e integração plugin.

**Atualização de conclusão:** viabilidade de listener e callback privado dentro
do setup e lifecycle restart/stop comprovada. Referências abaixo a listener
“ainda não testado” são estágio anterior, superado por este incremento. Não
conclui segurança produto: literal é público, igualdade mock, porta diagnóstica
é pública aos clientes do host, e não foi executada ferramenta real. Não existe
segredo real nem grant. Mesmo processo não isola de shell irrestrito, nem da
execução arbitrária de código do próprio plugin. Revisão de provisionamento,
Controles de produção e gate humano permanecem necessários. A antiga pendência
de unload isolado foi resolvida e não deve ser transportada para o gate atual.

Status: **proposta para revisão**, autorização recebida somente para projetar.
Este registro está neste arquivo porque o escopo desta subtarefa não autoriza
criar `docs/architecture/operator-auth.md` nem editar o catálogo de decisões.
Integrador deve publicar/mover AD009 nesses destinos após revisão. Nenhum
segredo real criado; nenhum serviço persistente, dependência ou config alterados.

### Contrato mínimo escolhido para investigação

Preferir **gateway HTTP hospedado dentro de setup do plugin**, chamando callback
lexical privado do núcleo, não RPC administrativo genérico. Fluxo:

`operador -> loopback HTTP gateway -> autenticação e validação -> callback privado -> núcleo`

Gateway e núcleo no mesmo processo; segredo futuro apenas no verificador do
gateway. Nenhum handler RPC deve conseguir fabricar principal operador ou chamar
esse callback através de parâmetros. Ferramentas chamam entrada restrita própria,
sem booleano `isOperator` controlável pelo input. Não exportar função admin em
contrato RPC, nem criar método `proxy` que o encaminhe. Loopback sozinho não é
autorização: outro processo local pode alcançá-lo.

SDK `dist/promise/plugin.d.ts:26-58` não declara listener HTTP, callback IPC ou
bridge HTTP privilegiado; RPC context declara error/signal. Métodos client aceitam
headers de transporte, mas handler não os recebe como identidade. Não foi
encontrada API pública IPC autenticada nesse inventário; isso não é prova global
de inexistência. `Plugin.define` exporta setup e cleanup, permitindo recursos
pertencentes ao plugin em runtime. Docs oficiais
[migração V2](https://opencode.ai/v2/docs/build/plugins/migrate-v1) explicitam
cleanup de sockets/subprocessos/recursos próprios; consulta Context7 corroborou.
Hospedar listener por `Bun.serve` é proposta de uso do runtime, **não API HTTP
administrativa oficial do SDK nem integração host já testada**. Deve ser provado
em setup real e stop/restart antes de adotar. Sem alteração do harness aqui.

Alternativa para gateway em processo separado: envelope autenticado assinado
verificado pelo núcleo com capability inacessível ao agente, cobrindo versão,
audience/plugin instance, método, caminho, body exato/hash, operação, expiry e
nonce de uso único. RPC genérico pode transportar envelope, nunca conferir
administração sem verificá-lo. Exige gestão de chaves e replay store, tornando-o
maior e ainda não implementado. Não adotar HMAC com segredo acessível ao modelo
ou Basic do servidor como substituto.

### Prova sintética disponível

`bun scripts/probes/operator-channel.ts` e teste contract correspondente abrem
somente servidor aleatório `127.0.0.1`, encerrado em finally. Literal pública
`TEST_ONLY_NOT_A_CREDENTIAL`, igualdade simples em header `X-Operator-Test`:
**mock, não mecanismo seguro ou segredo**. Não testar valores reais aqui.

Transporte exige POST `/operator/probe`, JSON estrito action/requestID, header
mock, sem Origin; não aceita claim principal, sessionID, credencial em payload
ou query. Sem header/valor inválido: 401; preflight sem auth: 401; OPTIONS com
auth: 405; Origin com auth: 403; RPC path com auth: 404; sessão forjada com auth:
400. Somente pedido válido alcança callback privado uma vez, sem efeito admin.
Sem ACAO em todas as respostas. Isto prova seleção do callback no **mock**, não
não-alcançabilidade de um núcleo real ou segurança de produto. Request binding
aqui é validação de método/caminho/corpo/header; não assinatura nem anti-replay.

### Gates antes de provisionar segredo real

1. Revisar ameaça: mesma conta/shell irrestrito pode ler memória/env/arquivos do
   processo. Não prometer isolamento sem usuário/processo/OS separados.
2. Provar listener no setup real, exclusivamente loopback, porta allowlisted,
   instância/localização correta, cleanup em unload/restart e callback não exposto
   por tool/RPC; nenhuma rota admin no RPC genérico.
3. Revisar fonte de segredo, identidade OS, escopo, permissão, entrega fora do
   modelo, rotação/revogação e redaction. Não usar options/storage de plugin,
   histórico de sessão, URL, logs ou config legível ao agente como cofre.
4. Projetar token de alta entropia, comparação segura, limite de corpo em streaming
   antes de alocar, timeout, rate limit, validação Host/Origin, anti-replay e
   confirmação humana por operação destrutiva. Mock lê corpo antes de limitar e
   NÃO implementa esses controles; não reutilizar como produção.
5. Testar falhas e concorrência, restart, replay, grants/always/autoconfiguração,
   ferramentas versus operador, auditoria sem segredo e rollback. Autenticação
   não substitui policy/deny nem gate humano; sem autoaprovação always.

**Veredito:** caminho in-process é arquitetura mínima plausível, não GO. Prova de
transporte não fecha T3; integração lifecycle e isolamento ainda são pendências.

## Histórico: RPC ativo e contexto real observado (status parcial superado)

O contexto RPC continua evidência válida; a lista de tool/unload pendentes
abaixo registra apenas aquele estágio e está superada pelas provas no início.

Após correção do diretório no harness pelo integrador, executado novamente com
`createHarness({ identityPlugin: true })`. Plugin listado, único não-builtin,
RPC externo retorna **200** com output:

```json
{ "operator": false, "contextKeys": ["error", "signal"] }
```

Chamadas sem claims, com sessão sintética própria/agent e com sessionID forjado/
operator retornam as mesmas chaves e operator false. Isso prova execução do
handler e que **esta fixture ignora claims**; não prova rejeição universal de
forgery pelo host. `operator: false` vem do código da fixture. As duas chaves
são observação runtime desta versão/caminho, não enumeração universal de toda
API nem garantia sobre campos não enumeráveis. Tipos SDK também só declaram
signal/error. Não há principal operador utilizável comprovado.

Auth ausente/Bearer inválido: **401** tanto em `/api/info` quanto no RPC ativo.
Basic inválido: **401** em info. Auth Basic válido autentica acesso ao servidor,
não determina humano/operador ou sessão originadora de RPC. CORS não é auth.
Regra deny de sessão sintética continua sendo avaliada como deny.

Não há TODO de ativação de arquivo: resolvido. O teste agora exige fixture
presente, RPC 200, outputs reais invariantes sob claims e negativos 401; erro
rpc.unavailable passa a falhar em vez de ser expectativa aceitável.

### Fronteiras ainda não provadas

- Tool execution context e comando humano/agente: **NÃO VALIDADOS**. Snapshot T2
  só expõe command/generate, nenhum endpoint público de execução direta de tool.
  Não foi usada chamada manual ao execute da fixture como se fosse execução host.
  Provider determinístico com tools=false não basta para provocar tool execution;
  precisa caminho host real e fixture que emita tool call, aprovados pelo
  integrador, ou outro contrato público comprovado. Nenhuma alteração no provider.
- Always/autoconfiguração: **NÃO VALIDADOS**, nenhum grant permanente enviado.
- Fail-closed do produto não foi implementado; relatório recomenda externo
  desabilitado. RPC diagnóstico não possui poderes.

### Consequência arquitetural

Sem prova de principal RPC nativo, é inválido modelar RPC autenticado no host como
operador. Isso bloqueia **essa suposição**, não demonstra impossibilidade de uma
API de produto. Possível alternativa a desenhar/aprovar: credencial operador
separada, fora de sessão/modelo, validada pelo adaptador contra segredo runtime
do operador, com comparação segura e negação por padrão. Nunca derivá-la de
sessionID/input principal ou reutilizar Basic do host. Exige projeto e testes de
provisionamento, rotação, não exposição em logs/modelo, replay, escopo e auditoria;
não foi criada credencial nem implantado esse controle aqui. Shell irrestrito que
alcança o mesmo segredo continua rompendo isolamento, exigindo fronteira OS/processo.

## Histórico de diagnóstico (superado pelo estado vigente acima)

As seções abaixo registram tentativas anteriores; seus bloqueios de ativação e
propostas de harness não descrevem mais o estado atual. Retidos como evidência
da descoberta do contrato de loader, não como critérios de aceite atuais.

## Causa concreta e menor correção (substitui contrato anterior de arquivo)

[Plugins V2](https://opencode.ai/v2/docs/plugins), seção Configure:
**Configured local paths must be directories. A path to a single file is skipped.**
O harness escreve `plugins: [<root>/identity-plugin.mjs]`: aponta a arquivo,
portanto o loader o ignora. Não é erro de setup exposto no Plugin.State: a
entrada não chega ao registro. Após inicializar a localização com GET `/api/agent`,
GET `/api/plugin` mostra somente builtin e nenhuma fixture; RPC continua
rpc.unavailable. Consulta usa `location[directory]`, corroborado pelo client
local `dist/mcp.js:103`. Não é preciso trocar essa sintaxe.

Menor correção exata para o integrador (NÃO aplicada ao harness aqui):
criar diretório `<root>/identity-plugin/`, gravar bundle como `index.js` e
`package.json` com `{ "name": "identity-private-fixture", "type": "module",
"exports": { ".": "./index.js" } }`; config `plugins: [<root>/identity-plugin]`.
Manter allowlist fixa e bundling atual; sem instalação de dependência em runtime.
Reexecutar e exigir Plugin.State active e RPC 200 antes de observar contexto.

SDK inspecionado: `@opencode/plugin/dist/promise/plugin.js:1-3` simplesmente
retorna o argumento de define; `@opencode/schema/dist/rpc.js:2-9` valida nomes
de erros reservados e retorna a definição. Não há marca de identidade Effect
nesses dois define. Não existe evidência para externalizar SDK como correção;
isso acrescentaria resolução de módulo desnecessária antes de corrigir o loader.

Teste diagnóstico do bloqueio é separado de `test.todo` do aceite de identidade.
Passar diagnósticos de baseline NÃO fecha T3/P0. Não houve erro de plugin a
sanitizar porque a fixture foi omitida antes de setup; não foram lidos stdout
nem credenciais. Nenhum principal foi estabelecido.

## Reteste com ativação solicitada ao harness

Executado `createHarness({ identityPlugin: true })` após implementação do
integrador. Com query pública `location[directory]=<root>/project`, resultado:
`GET /api/plugin` → 200, `data: []`; POST
`/api/rpc/identity-candidate/current` → 400, `RpcError`,
`type: rpc.unavailable`, `RPC is unavailable: identity-candidate`.
Sem location o mesmo RPC também retornou indisponível. Portanto a config e o
bundle existem no procedimento, mas **ativação não comprovada**. Nenhum contexto
de handler foi observado. Não chamar isso de rejeição de payload forjado.

O teste de contrato registra explicitamente esse bloqueio de baseline, não aceite
de integração: quando a ativação for corrigida, substituir esse caso por resposta
200 com chaves reais e manter os negativos 401. Integração P0 segue reprovada.
Integrador deve investigar descoberta da config privada e carregamento do bundle;
sem listar logs brutos, auth ou config no chat. Harness não foi alterado aqui.
Reteste posterior observou 92 itens em plugin.data, contra zero na primeira
consulta. Contagem é diagnóstico transitório e não prova fixture carregada;
RPC permaneceu indisponível. Assertion de zero removida por essa evidência,
preservando erro rpc.unavailable e todos os negativos de autenticação.

Fluxo 4, escopo restrito de probe privado. Baseline: OpenCode 2.2.5; captura
executada em 07/11/2026. Não é plugin de produção nem certificação de principal.

## Reprodução e observações reais

`bun scripts/probes/identity.ts` e `bun test tests/contract/identity.test.ts`.
Usam exclusivamente `createHarness` e `request(path, init)`. Servidor privado,
HOME/XDG/DB descartáveis, nenhuma sessão de trabalho, nenhum provedor/modelo.
O encerramento do harness remove somente o ambiente criado por ele.

| Prova | Observação |
| --- | --- |
| GET autenticado `/api/info`, sem Origin | 200, sem Access-Control-Allow-Origin |
| Origin `http://localhost:4096` | 200, ACAO igual ao Origin |
| Origin `https://untrusted.invalid` | 200, sem ACAO |
| Sessão sintética com regra deny; POST permission | 200, efeito `deny` |
| RPC não registrado com input sessionID/principal forjados | 400; NÃO prova rejeição de identidade por handler |

Origin não é autenticação: origem não permitida ainda recebe HTTP 200 em cliente
não-browser. A regra deny foi avaliada sem executar ferramenta/modelo; não prova
preservação de denies por um futuro adaptador. `source.type=tool`, messageID e id
sintéticos são campos aceitos via HTTP, não evidência de execução de ferramenta.
Primeira tentativa com `source.type=api` retornou 400 InvalidRequestError
(`Expected Permission.Source`); ajustado para o contrato público capturado em T2.

## Limites que não podem ser chamados de PASSOU

- **401 ausente/Bearer inválido/Basic inválido: servidor testado.** Fetch com
  `/api/info` fixo, base `harness.url`, redirect error e timeout; sem aproveitar
  o wrapper autenticado. Não demonstra autorização de produto nem identidade de
  operador. Negativos específicos de session/RPC ainda não executados.
- **Tool/RPC integrado: NÃO VALIDADO.** Integrador instalou SDK exato 2.2.5;
  fixture `scripts/probes/fixtures/identity-plugin.ts` compila, mas ainda não foi
  ativada no host. Tipos públicos `dist/promise/rpc.d.ts:5-8` oferecem apenas
  `signal` e `error` em RpcCallContext; não há principal declarado. ToolContext
  é distinto (`dist/promise/tool.d.ts:9-14`). Tipagem não é prova de runtime.
- **Comando humano, always/autoconfiguração: NÃO VALIDADO.** Campo sessionID de
  comando não demonstra autoria humana. Nenhum `always` foi enviado, nenhuma
  aprovação concedida, nenhum agente/modelo/configuração própria foi alterado.

## Contrato público e decisão fail-closed

Fontes oficiais consultadas: [overview V2](https://opencode.ai/v2/docs/build/plugins),
[server V2](https://opencode.ai/v2/docs/build/plugins/server),
[RPC V2](https://opencode.ai/v2/docs/build/plugins/rpc), snapshot
`contracts-baseline.json` e Context7 `/websites/opencode_ai/v2` (consulta sobre
tool execute context e identidade RPC). Context7 foi apenas corroborativo.

Server documenta identidade de execução via `context.sessionID`, `agent`,
`messageID`, `id` em ferramentas. `ctx.location` identifica a instância do plugin,
não o chamador de cada operação. RPC documenta `signal` e `context.error`; não
oferece nessa referência principal operador verificado. Ausência na documentação
não demonstra ausência em runtime; schema e handler inexistente também não provam
um mecanismo de autenticação.

Logo, superfície externa deve permanecer **desabilitada** até prova independente
de principal operador; o booleano do relatório é recomendação/candidato, não um
controle implantado. Nunca elevar input `sessionID`, `principal`, Origin ou
`source.type=tool` a identidade. Ferramentas in-process poderão usar apenas
contexto fornecido pelo host após integração comprovada, sem promover sessão a
operador. Grants, policy, delete, always e autoconfiguração exigem operador.

Próximo incremento mínimo: ativação privada da fixture já tipada com SDK 2.2.5.
Contrato solicitado ao integrador, sem alteração do harness nesta tarefa:
adicionar opção específica `identityPlugin?: boolean`; antes de spawn, compilar
somente `scripts/probes/fixtures/identity-plugin.ts` com `Bun.build`, target bun,
format esm e dependências bundled, para `<root>/identity-plugin.mjs`; definir
`plugins: [<caminho absoluto desse arquivo>]` na config privada em vez de `[]`.
Aceitar somente esse artefato criado pelo próprio harness sob root temporário,
nunca um path arbitrário ou pacote npm; nenhuma instalação em runtime. Sem a
opção, preservar `plugins: []`. A fixture registra RPC sem poderes, ignora claims
de input e retorna operator false mais nomes das chaves do contexto, sem valores.
Seu false é controle da fixture, não reconhecimento de principal pelo host.
Uma vez ativada, chamar RPC externamente com payload alegando sessão/operador e
conferir as chaves reais. Ainda é necessário adicionar ferramenta de diagnóstico
e usar execução determinística aprovada para
comparar contexto host de sessão A com payload alegando B/operador. Deve testar
comandos humano e agente separadamente, denies e recusa de always, sem chamar
modelo externo nem conceder permissões permanentes. Se RPC não disponibilizar
principal verificável, manter externo desligado e voltar à revisão arquitetural.

Shell irrestrito continua fora do sandbox: agente com acesso aos arquivos/env e
credenciais do operador pode reutilizar autenticação do host. Separar DTOs ou
checar sessionID não resolve essa fronteira. Não anunciar isolamento contra esse
adversário; requer separação de processo/credencial/OS e decisão do integrador.
