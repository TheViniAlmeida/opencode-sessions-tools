# Composição T31–T36 — plano de integração

08/11/2026. **Fluxo 0 para investigação; entrega documental autorizada, sem
implementação. T31 NÃO CONCLUÍDA.** Este arquivo planeja a composição, não
substitui a spec, o DAG de `tasks.md` ou a revisão de cada domínio.

## Baseline e limites

- T9–T30: domínios revisados/aprovados conforme handoff do integrador. Há textos
  históricos em `tasks.md` e nos documentos de gateway ainda pendentes; não
  reclassificar o estado do produto a partir desses textos antigos.
- T3-PROD: design/core/gateway/lifecycle **sintéticos** aprovados no handoff.
  Provisionamento, auditoria completa de logs, ownership operacional real e
  allowlist operacional ainda não aprovados. Não emitir nem importar segredo.
- T31/T32/T33 continuam bloqueadas pelo subgate de produto. Pode-se implementar
  composição interna e executar testes isolados, mas não expor o registry de
  tools de produto antes da aprovação dos checks T3-PROD correspondentes.
- Gateway instalado: **desabilitado por padrão**, sem listener. Não escolher
  porta fixa. Só configuração explicitamente aprovada habilita bind loopback e
  allowlist. Porta zero é exclusiva da fixture sintética.
- Não há delete de sessão de produto: AD-007 permanece. Não adicionar
  delete-preview/delete-confirm nem ligar `ctx.session.remove` aos transports.
- Este plano não executa migração, host, teste, build ou alteração de manifesto.
  Nenhuma prova E2E nova é declarada.

Fontes locais consultadas: `.specs/features/session-orchestration/tasks.md`
(T31–T36 e subgate T3-PROD), `src/**/*.ts`, `scripts/build.ts`, `package.json`,
fixtures `identity-plugin.ts`, `operator-plugin.ts` e `tool-provider.ts` em
`scripts/probes/fixtures/`, e declarations instaladas em
`node_modules/@opencode/plugin/dist/promise/`. Documentação V2 consultada:
<https://opencode.ai/v2/docs/build/plugins>. Context7 indisponível por quota;
contratos locais fixados em 2.2.5 prevalecem sobre exemplos de versão móvel.

## Uma única raiz e três fronteiras

Proposta de módulos **novos**, não existentes: `src/composition/runtime.ts`,
`src/composition/identity.ts`, `src/composition/policy.ts`,
`src/composition/registry.ts`, `src/host/native.ts`,
`src/persistence/migrations.ts` e `src/composition/supervisor.ts`.
O integrador T33 mantém a propriedade exclusiva de `src/server.ts`.

`Plugin.define({ id, setup(ctx) })` cria um runtime por instalação/ownership
resolvido. O runtime contém uma `Persistence` canônica, relógios, adapters,
registry privado e recursos canceláveis. Constructors dos serviços são ativos:
vários capturam a conexão ou constroem autorizadores. Construí-los apenas após
ownership, migrações e policy estarem disponíveis; não exportar singletons
inicializados durante import nem disparar timers/listeners em module scope.

Ordem da factory: resolver ownership → abrir/migrar DB → identity/policy →
Authorizer/Grants/Operations → adapters host → serviços por chamada → supervisor
→ registros permitidos pelo gate → listener opcional. `Requests` e `Scheduler`
capturam a conexão no constructor; `SharedMemory.start(scheduler)` e
`Scheduler.start()` são explícitos, não consequências de instanciar as classes.
Usar as assinaturas atuais, não uma factory fictícia comum `createServices(ctx)`
que omita ports obrigatórios. `Runner` recebe Tasks, Dispatcher, outcomes,
policy, usage, questions e cancellation; `Scheduler` recebe `SchedulerOptions`,
não Runner diretamente. Resolver dependências circulares por factories privadas
tipadas por owner, nunca por variável global que troca de identidade.

`setup` retorna cleanup assíncrono compatível com `Cleanup` 2.2.5. Em falha
parcial, desfazer em ordem inversa apenas recursos já adquiridos. Primeiro barrar
novas admissões e parar gateway/registros; cancelar timers/subscriptions/waits,
aguardar trabalhos em andamento e só então fechar Persistence. Guardar handles
de `Registration.dispose()`; dispose deve ser idempotente. Epoch nova em cada
setup invalida audience anterior, mas não apaga revogação/ledger persistidos.

1. **Tools**: `ctx.tool.transform`, `editor.add` e nomes efetivos observados por
   `ctx.tool.list`. `execute(input, context)` usa `context.sessionID`, `agent`,
   `id` e `signal`; resolve projeto/localização por fonte confiável. Nunca aceita
   principal, caller ID ou política do argumento como autoridade.
2. **RPC**: `ctx.rpc.register` recebe handlers cujo contexto contém `signal` e
   `error`, não identidade humana. Basic auth do host autentica transporte,
   **não operador**. Exigir identidade externa verificada por protocolo aprovado;
   até existir esse adapter, negar, não promover o chamador ou buscar identidade
   em um `sessionID` arbitrário do payload.
3. **Operador**: `createOperatorGateway` recebe core, persistência e callbacks
   lexicais SQL-only. `OperationDefinitionPort.resolve` deriva do registry
   confiável privado; nenhuma RPC/tool publica callbacks, bearers, porta de
   administração ou métodos internos. O registry público de operações de
   negócio é uma projeção permitida, não o objeto de admissão do core.

Manter uma única descrição canônica das operações de negócio: parser/schema,
capability, alvo, semântica de revisão/idempotência e invocação do serviço.
Tools, RPC e comandos projetam essa descrição. Não copiar regras de autorização,
SQL de domínio ou máquinas de estado para cada transporte. A projeção privada
de operador acrescenta método/rota/confirmation e não é exportada ao cliente.

`Authorizer.authenticateCaller` compara a **referência** retornada por
`TrustedPrincipalPort.current()`. A factory por invocação deve preservar o mesmo
objeto autenticado em todas as chamadas; não recriar objetos equivalentes a cada
`current()`, nem guardar um principal global mutável entre requests concorrentes.
Workers recebem owner persistido somente após validação canônica da admissão;
um owner serializado não autentica uma chamada externa.

## Inventário port → adapter e lacunas mínimas

Todos os adapters SQL validam a conexão canônica e a transação recebida. Toda
chamada host é assíncrona fora da transação; commit local antecede efeito externo.
Nomes em `src/composition/*` e `src/host/*` abaixo são destinos propostos.

| Consumidor e símbolos existentes | Adapter concreto a compor | Lacuna/aceite obrigatório |
| --- | --- | --- |
| `authorization/authorize.ts`: `TrustedPrincipalPort`, `AuthorizationSnapshotPort`, `Authorizer` | `composition/identity.ts` por invocação; `composition/policy.ts` para read/admission | Identidade de objeto estável; policy/profile/host ceiling/delegação, revisão e consumo once no mesmo DB. Não há storage de policy de produto pronto. |
| `authorization/grants.ts`: `GrantPolicyPort`, `Grants`; `persistence/operations.ts`: `pendingGrantOperations` | Adapter load/save canônico e `pendingGrantOperations` real | Não conceder por membership. Revogação retorna admitted separados e acorda waits após commit. |
| `contracts/index.ts`: `OwnershipPort`, `resolveOwnership`; `persistence/database.ts`: `openPersistence` | Resolver operacional em runtime, produzir claims reais e chamar `openPersistence` | Não usar `new Persistence(db, () => {})`; verificar realpath, dev:ino, nlink e ownership persistido. Evidência entre localizações não pode ser um array artificial repetido. |
| `sessions/discovery.ts`: `DiscoveryHostPort`, `DiscoveryService`; `sessions/reconcile.ts`: `ReconciliationHostPort` | `host/native.ts` sobre `ctx.session.list/get` e roteamento de localização aprovado | DTO→`SessionMetadata` sem transcript implícito; ausência provada ≠ falha de rede. `MissingSessionPort` é `ReconciliationService`. |
| `sessions/reconcile.ts`: `RemovedSessionCleanupPort`, `removedTargetPort` | Composição única de cleanup local; injetar `removedTargetPort` em todos os novos trabalhos | Conectar `inboxCleanupPort`, `repliesRemovedCleanup` e limpeza dos demais metadados próprios preservando auditoria. Sem DELETE host. |
| `sessions/create.ts`: `CreationHostPort`, `CreationRecordsPort`, `CreationService` | Native create/fork pela capacidade efetivamente provada; registry local de localização/linhagem/aprovação | `execute/inspect` devem provar operation/linhagem, preservar ID planejado de raiz/filha e retornar ID real do fork; ausência de correlação mantém unknown. `crossProjectApproval` consume na mesma admissão; `record` não herda grants/jobs. |
| `sessions/control.ts`: `ControlHostPort`, `ControlJobsPort`, `ControlProfilePort`, `SessionControls` | Native update/switchModel/switchAgent/interrupt/compact conforme DTO 2.2.5; `Scheduler.jobs`; policy ceiling/save | `validate/execute` observam resultado, não só HTTP. Reset cria sucessora limpa. Style/fork e observação exigem contrato servido/probe; não inventar método ausente em `SessionDomain`. Restore não reativa jobs. |
| `messaging/dispatcher.ts`: `TrustedChainPort`, `PromptHostPort`, `Dispatcher` | Contexto confiável de cadeia; `ctx.session.prompt` com IDs nativos, inspeção de recibo/hash | queue/steer, correlação e hops vêm do contexto. Perda de resposta não permite retry cego. Agendar `expirePending/recover` com supervisor. |
| `messaging/inbox.ts`: `Inbox`; `messaging/replies.ts`: `Replies`, `ReplyWakePort`, `ReplyTimerPort` | Inbox local sem host; fan-out pós-commit entre instâncias; timer cancelável | Cursor inbox ainda precisa contrato de transporte. Reply do operador precisa endereço de retorno autenticado: `Replies.request` não oferece solução pronta. Fan-out cobre reply, ACL e remoção, não só commits de resposta. |
| `observability/events.ts`: `Events`, `DomainEventSource`, `appendInTransaction` | Emitter transacional canônico e projeção de stream RPC | Guardar identidade do DB antes do append; notificar após commit. Retenção 30d, cursor expired e snapshot/resync; não fazer append assíncrono após mutação como substituto de atomicidade. |
| `groups/service.ts`: `GroupActiveWorkPort`, `Groups`; `orchestration/tasks.ts`: `taskActiveWork`, `Tasks`, `RunnerAccountingPorts` | OR entre `taskActiveWork` e `Scheduler.jobs.active`; `runnerAdmissionEvidence` e `runnerOutcomeEvidence` de `orchestration/runner.ts` | Uma remoção de grupo não passa se houver job/tarefa ativa. Admissão/generation/outcome vêm do journal real, não estado idle. |
| `orchestration/runner.ts`: `Runner`, `TaskOutcomePort`, `RunnerPromptPolicyPort`, `RunnerUsagePort`, `RunnerCancellationPort` | Dispatcher real; collector native→recibo persistido; policy; `UsageService` e cancelamento correlacionado | Distinto de `tasks.ts:TaskOutcomePort` (lookup síncrono). Collector busca/verifica fora da transação, persiste prova, só então Tasks contabiliza. Propagar resultado à origem; interrupt não é confirmação de cancelamento. |
| `orchestration/requests.ts`: `Requests`, `QuestionPolicyPort`, `QuestionOperatorPort`, `questionsRunnerPort` | Policy snapshot e humano autenticado privado; `questionsRunnerPort(requests)` para Runner | Usar wrapper, não Requests diretamente como substituto. `respondAsOperator` não é tool de sessão. `expire` periódico e resume da admissão correta; adapter humano só existe após auth aprovada. |
| `context/export.ts`: `ContextExportHostPort`, `ContextExportService`; `context/import.ts`: `ImportHostPort`, `ImportDestinationPort`, `ContextImportService` | Create por lote nativo completo em nova sessão; append por anexo no storage plugin associado à sessão, recuperável por ferramenta explícita: leitura exige `context.read` E `read`, principal corrente e owner/target (AD-010); anexo não concede grants | Domínio T27 APROVADO 43/328 e root v23 15/77; native adapter 6/28 aprovado, refinamento autor 10/47 aguarda follow-up independente. Preflight inteiro; append sem reescrever histórico nativo nem executar no host, sem config/ACL/jobs/grants. IDs tipados, deadlines menores que lease; transporte incerto não é `no_effect`. Fixture/adapter não certificam native-real/E2E/full. |
| `context/memory.ts`: `MemoryGroupPort`, `MemorySchedulerPort`, `SharedMemory` | Membership canônico filtrado por ACL; manutenção supervisionada | Associar grupo não concede acesso. Expiração visível imediatamente e tombstone em até 60s de serviço ativo; dispose cancela manutenção. |
| `schedules/service.ts`: `SchedulerOptions`, `Scheduler` | Clock UTC/monotônico, coordinator canônico, grants snapshot, limits, dispatcher(owner, guardedAuth), outcomes | Um scheduler próprio por ownership, sem timer nativo paralelo. Provar callbacks em todas as fases, recuperação e restart; trabalho supervised de acompanhamento permanece pendente até a slice do supervisor. |
| `observability/usage.ts`: `UsageAccessPort`, `UsageEventPort`, `RunnerUsageSource`, `UsageService`, `canonicalUsageEvents` | ACL síncrona, `canonicalUsageEvents(storage, journal)`, snapshots cumulativos de uso nativo | Fonte de preço/estimativa ausente→null e bloqueio sob teto. Não fabricar custo zero; uso reported/estimated permanece distinto. Reserva não se libera por timeout. |
| `authorization/operator-core.ts`: `OperatorCore`, `OperationDefinitionPort`, `OperatorAuthorizationPort`; `transport/operator-gateway.ts`: `createOperatorGateway` | Registry privado, `readOwn/newEffect` sobre policy canônica e `productionPersistence` da raiz | `productionPersistence` é nome proposto da referência real, não export existente. `core` e gateway devem usar essa mesma instância, claims reais e guardas; nunca a fixture de lifecycle com verificação parcial de HOME. |

### Gaps de API que não podem ser escondidos pelo wiring

- `GrantPolicyPort.load/save` exige storage canônico de policy/perfis, teto,
  operator revision e consumo once. Não existe descriptor de produto equivalente
  nos módulos lidos. Criar o mínimo nesse dono; não reusar tabelas
  `synthetic_capabilities` ou decisões default-allow.
- `OperatorCore.admit` e `OperatorGatewayOptions.operations[].local` são
  síncronos SQL-only. `Grants.link`, `Requests.respondAsOperator` e
  `UsageService.changeBudget` são APIs assíncronas de negócio: não chamá-las
  diretamente dentro de `local`, não soltar Promise após commit e não copiar seu
  SQL no gateway. Extrair no **dono do domínio** a primitiva transacional mínima
  reutilizada pela API existente e pelo callback, ou persistir comando durável
  canônico consumido pelo serviço; decidir por operação e provar idempotência.
- `CreationRecordsPort.record/crossProjectApproval`,
  `ImportDestinationPort.check` e `ControlProfilePort.ceiling/save` precisam de
  estado local confiável e revisão. Definir a extensão mínima do mesmo storage
  de policy/routing, não três fontes independentes de autorização.
- `PromptHostPort.inspect` e `CreationHostPort.inspect` precisam correlação
  verificável com o host. Ausência de recurso ou match de título não é prova.
  Se a API nativa não fornecer prova suficiente, conservar unknown e documentar
  reconciliação manual em vez de inventar sucesso.
- `Replies` não resolve retorno de request originado por operador; definir
  binding autenticado de origem/resultado antes de habilitar essa operação.
  Não fabricar uma sessão emissora para satisfazer o constructor.
- T30: `usage_reservations`, `usage_receipts` e `usage_budget_mutations` existem,
  mas falta API de **visualização só operador** de reservas órfãs e **liberação
  explícita auditada**, com chave idempotente, vínculo admission/operation,
  revisão, motivo, autor e prova de não contabilização dupla. Retenção de
  receipts/chaves e correlação de remoção externa também são gate futuro T30.
  Não expor release/refund às sessões; timeout/unknown nunca gera refund.
- `Scheduler` não elimina a obrigação de supervisor: retries de manutenção,
  expire/recover, perguntas e memória exigem acompanhamento supervisionado,
  deduplicação de tick, isolamento de falhas e shutdown aguardado. Esse follow-up
  fica pendente até sua prova, mesmo com T29 de domínio aprovado.

## Banco único e ordem de migração

Um escritor: integrador de persistência. `openPersistence` já instala v1,
valida sequência contígua, faz backup 0600 verificado e migra sob transação
exclusive (`src/persistence/database.ts:124–196`). Os descriptors não recebem
versões dos workers; `src/persistence/migrations.ts` será a única lista global.

**Ordem proposta para instalação nova**, a congelar com testes antes de adoção:

Nota vigente root v23 (lote aprovado 15/77): CURRENT 23 reconhece 20..23;
anchors preservadas, descriptor 15 restaurado, attachment novo em 23. A tabela
abaixo registra a proposta histórica anterior, não o mapa executável vigente;
não usar as alocações propostas 21–23 para editar migrations atuais.

| Versão global (proposta histórica) | Descriptor/fonte proposto |
| --- | --- |
| 1 | ownership interno de `openPersistence` (não duplicar na lista externa) |
| 2 | `GRANTS_MIGRATION`, `authorization/grants.ts` |
| 3 | `operationMigrationAt(3)`, `persistence/operations.ts` |
| 4 | `GROUPS_MIGRATION`, `groups/service.ts` |
| 5 | `reconciliationMigrationAt(5)`, `sessions/reconcile.ts` |
| 6 | `creationMigration.sql`, `sessions/create.ts`, envelopado em `Migration.apply` |
| 7 | `controlMigration.sql`, `sessions/control.ts`, mesmo envelope |
| 8 | `inboxMigrationAt(8)`, `messaging/inbox.ts` |
| 9 | `dispatcherMigrationAt(9)`, `messaging/dispatcher.ts` |
| 10 | `repliesMigrationAt(10)`, `messaging/replies.ts` |
| 11 | `eventsMigrationAt(11)`, `observability/events.ts` |
| 12 | `TASKS_MIGRATION`, `orchestration/tasks.ts` |
| 13 | `RUNNER_MIGRATION`, `orchestration/runner.ts` |
| 14 | `REQUESTS_MIGRATION`, `orchestration/requests.ts` |
| 15 | `importMigration.sql`, `context/import.ts`, envelopado |
| 16 | `MEMORY_MIGRATION`, `context/memory.ts` |
| 17 | `SCHEDULES_MIGRATION`, `schedules/service.ts` |
| 18 | `USAGE_MIGRATION`, `observability/usage.ts` |
| 19 | `operatorCoreMigration.sql`, `authorization/operator-core.ts`, envelopado |
| 20 | Nova migração dos dois índices exatos exigidos pelo gateway |
| 21 | Nova migração mínima de policy/routing/approvals e metadados de composição, após contrato da slice 2 |
| 22 | Nova migração explícita de upgrade das FKs/generation de tarefas |
| 23 | Nova migração explícita de upgrade de `question_audit` sem FK cascata |

Os índices v20 devem produzir exatamente
`CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id)`
e `CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at)`.
O gateway confere texto em `sqlite_master` antes do bind; ele não migra.

**Proposta histórica — DB nova ≠ DB antiga.** Naquela proposta, descriptors de Tasks/Requests continham a
estrutura corrigida. Num banco novo, v22/v23 verificam a estrutura esperada e
não reconstroem sem necessidade. Num banco histórico reconhecido, são upgrades
novos, não edição retroativa de descriptor já aplicado. Preservar IDs, bodies,
revisões, generations existentes e auditoria; adicionar generation=0 apenas
onde a versão histórica não a possuía. Auditar DDL/indexes e todas as FKs
dependentes antes de rebuild. Testar `foreign_key_check` e integridade, rollback
com falha no meio, backup restaurável e retenção de `question_audit` após cleanup.

Não desligar `foreign_keys` dentro da transação de `openPersistence`: essa não
é uma estratégia de rebuild válida. Planejar ordem de cópia/recriação das
tabelas dependentes com constraints habilitadas; se for necessário outro
protocolo, voltar ao dono de Persistence e obter aprovação antes de executá-lo.

As fixtures anteriores atribuem versões locais diferentes e nem sempre usam
`openPersistence` (a fixture `operator-plugin.ts` cria ownership parcial).
**`user_version` isolado não identifica lineage.** Não reinterpretar um banco
antigo como esta sequência nova. Catalogar primeiro fingerprints DDL e ordem
histórica; aceitar somente lineage reconhecida e usar bridge de upgrade
explicitamente testada, sem renumerar versões aplicadas. Lineage ambígua falha
fechado e bloqueia T35 upgrade. Essa decisão técnica deve preceder congelar a
numeração de distribuição; a tabela acima não autoriza migração em banco real.

## Slices priorizadas e observáveis

Cada slice abaixo entrega um teste vertical, não somente constructors que
compilam. E2E em host descartável 2.2.5 usa provider determinístico local,
derivado de `scripts/probes/fixtures/tool-provider.ts`, sem credencial externa.
Os testes de serviço podem usar doubles, mas não certificam o adapter nativo.

| Prioridade/slice | Dono e escopo exclusivo proposto | Prova observável / dependência |
| --- | --- | --- |
| 1. Raiz canônica e schema | Integrador: `composition/runtime.ts`, `persistence/migrations.ts`, testes de composição DB | DB nova abre fora do repo; segunda localização com claims divergentes nega; reabrir preserva dados; DB histórica reconhecida faz rebuild preservando auditoria, desconhecida recusa. Falha de migração impede qualquer efeito host/listener. |
| 2. Identidade e policy reais | Dono auth: `composition/identity.ts`, `composition/policy.ts`, extensões mínimas do domínio auth | Tool nativa current resolve sessão real; dois calls simultâneos não trocam principal. Principal falso, Basic do host, grant ausente, perfil/teto/revisão stale e once repetido negam. Sem habilitar tools de produto. Depende 1. |
| 3. Gateway protegido de integridade | Dono gateway + integrador de raiz: teste interno separado; alterações de domínio pelo respectivo dono | Endpoint **sintético protegido** usa OperatorCore real, `productionPersistence` e claims verificados; marcador público de teste, efeito SQL real e ledger recuperável. Provar DB estrangeira negada, epoch nova no reload/restart e limpeza em setup parcial. Sem enrollment real, porta fixa ou registry de produto. Depende 1/2. |
| 4. Sessões/lifecycle/contexto nativos e anexos próprios | Dono native: `host/native.ts`; extensões Creation/Control/Import pelos donos dos módulos | Create importa lote nativo completo em nova sessão; append persiste anexo próprio e tool explícita exige `context.read` E `read`, principal corrente e owner/target, sem grants/histórico reescrito/execução host. Domínio T27 43/328 e root v23 15/77 aprovados; adapter 6/28 aprovado, refinamento 10/47 aguarda follow-up; native-real/E2E/full pendentes. Observar IDs/linhagem, reset sucessora, archive suspende job e restore não o reativa, erro incerto sem duplicação. Remoção externa só fixture autorizada; produto nunca envia DELETE. Depende 1/2. |
| 5. Mensagem→reply→eventos | Dono messaging: adapters de cadeia/wake; dono journal: emitter canônico | Request por adapter nativo chega uma vez, reply correlacionado acorda wait até 30s; notificação não executa modelo; ACL revogada/removida acorda outra instância; restart reexecuta replay sem duplicar efeito. Validar retorno de operador ou manter essa operação bloqueada. Depende 2/4. |
| 6. DAG→pergunta→uso | Dono orchestration/usage: adapters de receipts, `questionsRunnerPort`, fonte de uso; APIs mínimas só no módulo dono | Fork/join no host determinístico conclui com recibo explícito; input e aprovação humana não são forjáveis; cancel_requested só termina com confirmação; orçamento desconhecido bloqueia; reservar/contabilizar não duplica. Vista/liberação órfã auditada passa gate T30 separado. Depende 5. |
| 7. Supervisor e agenda | Dono schedules: `composition/supervisor.ts`, adapters de clock/membership | Job due atravessa grants→reserva→Dispatcher; restart/lease vencida/revogação não redisparam unknown; tick falho recupera sob supervisão; memória expira/tombstone ≤60s, perguntas expiram, pending dispatcher varrido; unload cancela/aguarda workers sem acesso a DB fechado. Depende 5/6. |
| 8. Transports e entrypoint | Donos tools/RPC distintos: `transport/tools.ts`, `transport/rpc.ts`; integrador T33: `transport/commands.ts`, `server.ts`, registry | **Só após T3-PROD aprovado**: tabela de famílias da spec disponível com schemas, nomes efetivos medidos, equivalência tools/RPC e comandos humanos API-12; false operator negado, signal cancela wait, reload não duplica registros. Teste negativo comprova registry de produto ausente enquanto gate fechado. Depende 3–7 e gate. |
| 9. Bundle, documentação e candidato | Integrador release: `scripts/build.ts`, manifesto, artifacts; T34 docs/legal; T36 revisor independente | Após testes de composição, bundle real carrega no host; instalação só com dependências de produção e tarball isolado passa contratos e aceite. Upgrade/rollback e ausência de segredos provados; licença aprovada pelo titular antes da distribuição. Depende 8 e decisões humanas. |

## Ownership de trabalho paralelo

Atualização AD-010 de 08/11/2026: usuário escolheu explicitamente «Anexo de
contexto (Recomendado)», conforme solicitação documental. Append continua na
1.0 como anexo próprio, não append de histórico nativo. Leitura exige
`context.read` E `read`, principal corrente e validação de owner/target;
anexo não concede grants. Domínio create whole-batch/append attachment T27
APROVADO 43/328, root v23 15/77; adapter 6/28 aprovado e refinamento autor 10/47
aguarda follow-up independente. Fixture/adapter não certificam native-real/E2E/full.
Contrato em
[design.md](../../.specs/features/session-orchestration/design.md), critério
[CTX-02](../../.specs/features/session-orchestration/spec.md) e estado em
[tasks.md](../../.specs/features/session-orchestration/tasks.md). Sem mudança de
licença, AD-007, RPC/auth ou hardening separado do registry de operador.

- Banco/lista global, raiz e entrypoint: um integrador, nunca dois writers.
- Auth/policy pode evoluir em paralelo ao adapter nativo após contrato de
  identidade e schema acordado. Native não inventa policy nem altera auth.
- Messaging/wake e journal podem ser implementados separadamente por paths;
  callback transacional compartilhado é integrado por seu dono, não duplicado.
- Orchestration/usage e scheduler acordam contracts de accounting/limits antes
  de trabalhar em paralelo; primitiva de domínio é alterada só pelo dono.
- Tools e RPC só paralelizam depois de registry e envelope congelados. Ambos
  usam os mesmos serviços. Comandos/`server.ts` são join de T33, não propriedade
  antecipada de T31. Manifesto/build/lock ficam com integrador release.
- Cada retorno fornece diff, comandos/resultados, cenários negativos e lacunas;
  aprovação do domínio não substitui revisão independente do join.

## Auditoria de logs sem capturar segredo para fora

AUD-01 pendente requer uma execução dedicada, não simplesmente ausência de
`console.log` no módulo. Injetar sentinel **conhecidamente público** e exclusivo
de teste para autenticação do gateway; não usar o bearer real do host como
sentinel. Provocar positivos e negativos, body inválido, exceção, replay,
reload e timeout; varrer stdout/stderr completos, logs/tracing, RPC e transcritos
da fixture. Scanner comprova detecção com amostra sintética positiva e nega
aprovação se o sentinel aparecer em superfície proibida.

O startup do host pode imprimir autenticação efêmera. Não imprimir/copy/paste
stdout bruto nem enviar a captura ao chat/tool output. Capturar somente dentro
da raiz isolada aprovada, diretório 0700 e arquivos 0600; não mover para repo,
memória, logs de CI ou outro caminho. Scanner roda **antes** de qualquer excerpt,
redige Authorization/Basic/Bearer/cookies e material efêmero, e só emite contagem,
tipos, paths seguros e trechos já redigidos. Não ler a captura bruta com ferramenta
que a renderize ao modelo. Falha/erro do scanner bloqueia excerpt e gate; nunca
fallback para dump bruto. A política de retenção/descarte das capturas protegidas
precisa do operador; este plano não autoriza apagá-las.

## Build e distribuição sem exports fictícios

Hoje `package.json` declara pacote privado e `files: ["dist/harness.js"]`;
`scripts/build.ts` compila `scripts/harness.ts`. Não há entrypoint de produto.
`effect@4.0.6` é a única dependência runtime declarada; `@opencode/plugin@2.2.5`
está em devDependencies. Passar testes no checkout não prova import em pacote
limpo com install de produção.

Estratégia proposta: bundle Bun do entrypoint real `src/server.ts`, com runtime
SDK externalizado e versão compatível fixada como dependência de produção;
Effect externo com uma resolução compatível. Contrato RPC ganha bundle próprio
sem importar implementação nem iniciar recursos. A alternativa de embutir SDK
exige revisar identidade/duplicação de módulos Effect e licença/avisos; não é
fallback silencioso. Confirmar grafo resolvido/metafile e carga no host 2.2.5.

Trocar build/files/exports somente depois de os testes carregarem o entrypoint
real e mediante aprovação de manifesto/dependências. Não apontar `exports` a
arquivo inexistente, harness renomeado ou stub que só aparenta plugin. Em T35,
testar tarball, import de `.` e contrato RPC, instalação limpa sem devDeps e
negação de fixture/bancos/capturas/credenciais no pacote. Publicação/tag não estão
autorizadas por esse teste.

## Bloqueios: quem decide

| Integrador técnico — resolver com evidência | Operador — aprovação explícita |
| --- | --- |
| Lineage de migração histórica, rebuild com FKs habilitadas, ordem global final e rollback | Migrações fora de fixtures próprias e alteração de manifesto/dependências |
| Storage policy canônico, primitiva SQL-only compartilhada ou comando durável por operação; correlation/replies/outcomes | Provisionamento, importação, rotação, recuperação e isolamento de segredo real |
| Adapters 2.2.5, suporte real a fork/style/projeção, ownership entre localizações e supervisor | Porta/allowlist/configuração operacional; default continua sem listener |
| Scanner seguro e evidência de não vazamento; registry privado e recusa pré-gate | Retenção de capturas protegidas e aceitação operacional dos checks T3-PROD |
| Bundle com SDK/runtime resolvidos, testes de pacote e licença de terceiros | Instrumento jurídico definitivo: intenção não comercial, reuso profissional permitido e sem revenda; confirmar termos com titular, não escolher licença por conta própria |
| Cobertura observável das nove slices e revisão independente | Aceite final T36, Git/PR, tag/publicação e qualquer mudança real de serviço |

O teste de endpoint protegido usa marcador público e não exige chave real de
produção. Isso permite provar integração sem liberar enrollment; não elimina
os bloqueios operacionais T3-PROD. Só após suas aprovações e provas completas se
pode propor fechamento de T31/T32/T33. T34–T36 continuam tarefas próprias.
