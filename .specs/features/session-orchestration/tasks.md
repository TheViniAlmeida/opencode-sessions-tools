# Plano de implementação — núcleo 1.0

**Status**: revisão técnica APROVADA; execução aguarda aprovação do operador.
**Design**: [design.md](design.md). **Spec**: [spec.md](spec.md).
**Cobertura**: [coverage.md](coverage.md). **Revisão**: [review.md](review.md).

## Execution Protocol

Usar a skill `tlc-spec-driven` na execução, com teste derivado do critério antes de
declarar tarefa concluída e revisão independente no fechamento. Esta entrega é
documental. Nenhum comando abaixo foi executado como teste do plugin.

O operador pediu paralelismo: a ordem é o DAG, não serialização artificial de
tarefas independentes. Contratos e arquivos compartilhados têm um único escritor.
Cada worker recebe tarefa, caminhos, IDs, critérios, gate e proibição de ampliar
escopo. Autor não revisa o próprio lote. Integrador confere diffs e provas.

Antes de Execute, confirmar: interpretação de comunicação mínima no projeto,
defaults da spec, matriz de testes proposta e autorização para ambiente descartável,
dependências e migrações locais de teste. Publicação npm/release e licença final
têm gate próprio; autorização Git desta documentação não publica software.

## Test Coverage Matrix

Repo sem código/testes na origem. Convenções abaixo são propostas de bootstrap,
não comandos descobertos em manifests existentes. Não há suite anterior a preservar.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Domain | unit | Todos os critérios e transições aplicáveis; limites e erros | tests/unit/*.test.ts | bun run test:unit |
| Persistence | integration | Concorrência, crash, transações e migração com backup | tests/integration/*.test.ts | bun run test:integration |
| Host adapter | contract | Baseline exata; capabilities, erros e efeitos reais | tests/contract/*.test.ts | bun run test:contract |
| Transports | e2e | Happy path, recusa, origem falsa e equivalência API/tool | tests/e2e/*.test.ts | bun run test:e2e |
| Documentation/package | artifact | Links, schemas, exemplos e tarball limpo | tests/artifact/*.test.ts | bun run test:artifact |

## Gate Check Commands

Comandos a criar em T1; se a baseline exigir outro runtime, atualizar plano e
validar antes de prosseguir. Bun/TypeScript são propostas, não dependências instaladas.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| probe | T2–T8, cenário explicitamente selecionado | bun run probe -- <scenario> |
| quick | Serviço isolado | bun run typecheck && bun run test:unit |
| full | Persistência/integração/transport | bun run typecheck && bun run test:unit && bun run test:integration && bun run test:contract && bun run test:e2e |
| build | Bootstrap e joins | bun run build && bun run lint && bun run test:artifact |
| release | Candidato completo | Todos os gates anteriores + instalação limpa do tarball + aceite sintético |

T1 registra contagem inicial de testes; a partir daí cada tarefa informa contagem
antes/depois, IDs cobertos e skips justificados. Não inventar contagens antes de
existirem testes. Um critério de cobertura não implica teste já executado.

## Execution Plan

| Fase | Tarefas | Saída/gate | Paralelismo |
| --- | --- | --- | --- |
| P0 — Viabilidade | T1–T8 | Baseline, auth, idempotência, exclusão e scheduler provados | T3–T8 após snapshot, em fixtures independentes |
| P1 — Fundação | T9–T13 | Contratos, banco, autorização, grants e operações | T12 e T13 após suas dependências |
| P2 — Gestão | T14–T18 | Descoberta, grupos, criação e lifecycle | T14/T15; T16/T17/T18 isolados |
| P3 — Comunicação | T19–T22 | Inbox, dispatch, resposta e eventos | Eventos em paralelo à mensageria |
| P4 — Orquestração | T23–T25 | DAG, execução e perguntas | DAG pode iniciar após P1/grupos sem esperar P3 inteiro |
| P5 — Contexto/automação | T26–T29 | Export/import, memória e jobs | Contexto, memória e jobs em frentes distintas |
| P6 — Interfaces/uso | T30–T33 | Uso, tools, API e comandos | T31/T32 em paralelo após serviços; T30 antecipa |
| P7 — Release | T34–T36 | Docs, licença, pacote e verificação | Docs após T33; somente redação jurídica antecipável |

P0 é gate bloqueante: ausência de auth segura, reconciliação ou exclusão exata
não autoriza fallback inseguro. Revisar design/escopo com operador; não declarar
1.0 completa enquanto requisito obrigatório estiver `unsupported`. Para scheduler,
selecionar nativo ou próprio com evidência, nunca ambos por job.

### DAG autoritativo

Cada seta abaixo corresponde a `Depends on`. Fases agrupam trabalho; só o DAG
determina bloqueios. Entrypoint, schema e lockfile são integrados por um escritor.

```text
T1 -> T2
T2 -> T3
T2 -> T4
T2 -> T5
T2 -> T6
T2 -> T7
T2 -> T8
T3 -> T9
T4 -> T9
T5 -> T9
T6 -> T9
T7 -> T9
T8 -> T9
T9 -> T10
T9 -> T11
T10 -> T11
T11 -> T12
T10 -> T13
T11 -> T13
T11 -> T14
T10 -> T15
T11 -> T15
T12 -> T16
T13 -> T16
T14 -> T16
T12 -> T17
T13 -> T17
T14 -> T17
T5 -> T18
T12 -> T18
T13 -> T18
T14 -> T18
T12 -> T19
T13 -> T19
T19 -> T20
T20 -> T21
T10 -> T22
T11 -> T22
T13 -> T22
T15 -> T23
T13 -> T23
T20 -> T24
T23 -> T24
T12 -> T25
T24 -> T25
T12 -> T26
T14 -> T26
T13 -> T27
T26 -> T27
T10 -> T28
T12 -> T28
T6 -> T29
T12 -> T29
T24 -> T29
T8 -> T30
T15 -> T30
T24 -> T30
T16 -> T31
T17 -> T31
T18 -> T31
T21 -> T31
T22 -> T31
T25 -> T31
T27 -> T31
T28 -> T31
T29 -> T31
T30 -> T31
T16 -> T32
T17 -> T32
T18 -> T32
T21 -> T32
T22 -> T32
T25 -> T32
T27 -> T32
T28 -> T32
T29 -> T32
T30 -> T32
T31 -> T33
T32 -> T33
T33 -> T34
T34 -> T35
T35 -> T36
```

## Task Breakdown

Cada tarefa entrega um componente coeso com seus testes; `Where` é o arquivo
principal, não dispensa testes colocalizados em `tests/` nem ajustes mínimos de
registro pelo integrador. Nenhuma frente altera o módulo de outra em paralelo.
`coverage.md` é a fonte autoritativa de atribuição ID→implementação→cenário. O
campo Requirement também pode citar critérios que uma prova ou componente apoia,
sem substituir a responsabilidade de implementação registrada na matriz.

### Phase 0: Viabilidade técnica

### T1: Bootstrap do ambiente descartável
**What**: Criar harness de build/testes e servidor isolado, depois de aprovação de dependências/configuração.
**Where**: `package.json`
**Depends on**: None
**Requirement**: API-10, REL-02
**Done when**: runtime e versões fixados; scripts da matriz e runner `probe` existem; fixture inicia/encerra sem tocar servidor de trabalho; teste artifact verifica exclusão de segredos do pacote.
**Tests**: artifact e integração do harness.
**Gate**: build; não declarar capacidades do produto.

### T2: Fotografar contrato do host
**What**: Registrar versão efetiva, schemas usados e hash do OpenAPI servido em ambiente isolado.
**Where**: `scripts/probes/contracts.ts`
**Depends on**: T1
**Requirement**: API-10
**Done when**: diferenças docs/binário registradas e baseline candidata escolhida sem pressupor que CLI identifica servidor.
**Tests**: contract; fixture com capability ausente retorna unsupported.
**Gate**: probe contracts.

### T3: Provar principal e autorização
**What**: Demonstrar origem confiável de ferramenta, operador e comando humano.
**Where**: `scripts/probes/identity.ts`
**Depends on**: T2
**Requirement**: SES-01, ACL-02/06/07/11, API-11/12
**Done when**: payload forjado não vira identidade; credencial inválida recusada; RPC sem prova desabilitada; always/autoconfiguração não concedidos pelo agente.
**Tests**: contract/e2e negativos contra host de teste.
**Gate**: probe identity; falha bloqueia arquitetura externa.

### T4: Provar entrega e recuperação
**What**: Medir admissão, queue, resume, correlação e reconciliação após timeout.
**Where**: `scripts/probes/delivery.ts`
**Depends on**: T2
**Requirement**: MSG-02/05/06/07, REL-02
**Done when**: recibos e fronteira de não retorno conhecidos; notificação não inicia modelo; repetição incerta não gera reenvio cego.
**Tests**: contract com host idle/busy e perda de resposta injetada.
**Gate**: probe delivery.

### T5: Provar ciclo de vida e exclusão
**What**: Demonstrar parentID, fork, controle, archive e limite de cascata concorrente.
**Where**: `scripts/probes/lifecycle.ts`
**Depends on**: T2
**Requirement**: LIF-01..13, REL-03/04
**Done when**: prova da exclusão do conjunto exato inclui escritor externo; sem primitiva suficiente, relatório NO-GO e revisão obrigatória, sem habilitar delete inseguro.
**Tests**: contract apenas em família sintética; apagar fixture exige autorização do ambiente descartável.
**Gate**: probe lifecycle.

### T6: Decidir backend de agenda
**What**: Comparar garantias nativas com SCH-01..10 e escolher um executor.
**Where**: `scripts/probes/schedules.ts`
**Depends on**: T2
**Requirement**: SCH-01..10
**Done when**: flag, reinício, ocupado, revogação e DST medidos; nativo aprovado ou backend próprio justificado no design antes de T9.
**Tests**: contract com relógio controlado e duas localizações.
**Gate**: probe schedules.

### T7: Provar portabilidade
**What**: Validar export/import e limites de projeção do transcrito.
**Where**: `scripts/probes/portability.ts`
**Depends on**: T2
**Requirement**: CTX-01..04/07/08
**Done when**: round-trip sintético, conflito de IDs e falha parcial registram perdas e IDs conhecidos sem duplicação.
**Tests**: contract e integração com fixtures adulteradas.
**Gate**: probe portability.

### T8: Provar dados de uso
**What**: Determinar fontes e qualidade de tokens, custos, atividade e eventos.
**Where**: `scripts/probes/usage.ts`
**Depends on**: T2
**Requirement**: API-02..07
**Done when**: campos ausentes distinguíveis de zero; replay e limites do stream documentados; fonte por métrica definida.
**Tests**: contract com fixture de custo conhecido e desconhecido.
**Gate**: probe usage.

### Phase 1: Fundação

### T9: Congelar contratos de domínio
**What**: Definir schemas versionados, ports, enums e erros a partir das provas.
**Where**: `src/contracts/index.ts`
**Depends on**: T3, T4, T5, T6, T7, T8
**Requirement**: API-01/08/10, REL-05
**Done when**: entradas inválidas rejeitadas; estados correspondem à spec; consumers usam ports e não DTO interno do host; decisões P0 integradas.
**Tests**: unit/contract para schemas e matriz de transições.
**Gate**: quick + build.

### T10: Persistência transacional
**What**: Implementar storage próprio, schema versionado e transações.
**Where**: `src/persistence/database.ts`
**Depends on**: T9
**Requirement**: REL-01/02, CTX-05, SCH-06
**Done when**: banco fora do repo; criação/migração com backup testado; falha de gravação impede efeitos; rollback e concorrência comprovados.
**Tests**: integration com dois processos, crash e banco indisponível.
**Gate**: full.

### T11: Autorizador e principals
**What**: Aplicar interseção de política, perfil, grant e identidade comprovada.
**Where**: `src/authorization/authorize.ts`
**Depends on**: T9, T10
**Requirement**: ACL-02/03/06/07/10/11, LIF-12/13, API-11
**Done when**: matriz allow/deny cobre self/other, perfis e política restringida; negação não vaza sessão externa; operador não é inferido do texto.
**Tests**: unit e integration; principal falso, delegação excessiva e approvals salvas.
**Gate**: full.

### T12: Grants e solicitações de acesso
**What**: Implementar link/unlink e ciclo de pedidos ao operador.
**Where**: `src/authorization/grants.ts`
**Depends on**: T11
**Requirement**: ACL-01/02/04/05/08/09
**Done when**: grant direcional; expiração 24h de pedidos; revogação rejeita pendências; já admitido informado; revisão/auditoria persistidas.
**Tests**: unit/integration com corrida revoke/dispatch e solicitação duplicada.
**Gate**: full.

### T13: Operações idempotentes e outbox
**What**: Persistir operações, chave/hash, leases e reconciliação.
**Where**: `src/persistence/operations.ts`
**Depends on**: T10, T11
**Requirement**: MSG-05/06, REL-01/02/05
**Done when**: mesma chave retorna operação; payload distinto conflita; crash pós-chamada mantém incerteza; worker antigo não efetua nova admissão.
**Tests**: integration com falhas antes/depois de cada fronteira transacional.
**Gate**: full.

### Phase 2: Gestão

### T14: Descoberta e árvore
**What**: Resolver current/list/get/tree com escopo e paginação.
**Where**: `src/sessions/discovery.ts`
**Depends on**: T11
**Requirement**: SES-01..04/06, REL-03
**Done when**: até 100 itens/cursor, nenhum histórico implícito, ciclos não duplicam IDs e sessão removida é reconhecida.
**Tests**: unit/contract com dois projetos e vínculos cíclicos.
**Gate**: full.

### T15: Grupos e associação
**What**: Persistir grupos/sistemas e memberships sem conceder acesso.
**Where**: `src/groups/service.ts`
**Depends on**: T10, T11
**Requirement**: SES-05
**Done when**: remover grupo com tarefa/job ativo conflita; remover membro não revoga grant nem exclui sessão; autoria/escopo conferidos.
**Tests**: unit/integration incluindo grupos sobrepostos.
**Gate**: full.

### T16: Criação e fork
**What**: Criar raiz/filha/fork com delegação explícita e recuperação parcial.
**Where**: `src/sessions/create.ts`
**Depends on**: T12, T13, T14
**Requirement**: LIF-01/02/11/13
**Done when**: excesso de grant recusado antes do host; ausência de autorização aguarda operador; outro projeto cria raiz vinculada; fork não copia grants/jobs.
**Tests**: integration/contract com crash entre criar e registrar vínculo.
**Gate**: full.

### T17: Controles de sessão
**What**: Implementar rename/model/agent/style/interrupt/archive/restore/compact/reset.
**Where**: `src/sessions/control.ts`
**Depends on**: T12, T13, T14
**Requirement**: LIF-03..07/12, ACL-06/10/11
**Done when**: observar resultado do host; futuras execuções usam configuração; archive suspende jobs; reset cria sucessora distinta; profiles respeitam teto.
**Tests**: unit/contract; sessão busy, aguardando aprovação, modelo inválido e alteração concorrente.
**Gate**: full.

### T18: Exclusão com preview
**What**: Excluir somente conjunto aprovado e limpar conteúdo próprio relacionado.
**Where**: `src/sessions/delete.ts`
**Depends on**: T5, T12, T13, T14
**Requirement**: LIF-08..10, REL-03/04
**Done when**: token 60s e digest validados; corrida externa não amplia exclusão; conteúdo associado removido e auditoria mínima preservada; uncertain não repetido cegamente.
**Tests**: contract/integration com escritor externo e exclusão fora do plugin.
**Gate**: full; bloquear se prova T5 não sustenta a garantia.

### Phase 3: Comunicação

### T19: Inbox e envelope
**What**: Armazenar mensagens sem despertar modelo e expor inbox autorizada.
**Where**: `src/messaging/inbox.ts`
**Depends on**: T12, T13
**Requirement**: MSG-01/02/09
**Done when**: limite UTF-8 64 KiB; notificação disponível sem nova execução; grant e validade checados; payload não entra em logs.
**Tests**: unit/integration com limites 65536/65537 bytes e destinatário busy.
**Gate**: full.

### T20: Dispatcher de prompts
**What**: Admitir requests no host, serializar queue por destino e reconciliar incerteza.
**Where**: `src/messaging/dispatcher.ts`
**Depends on**: T19
**Requirement**: MSG-03/05/06/07/08, ACL-04/05
**Done when**: FIFO do plugin preservado; limite 8 saltos; revogação e timeout respeitam fronteira provada; retry sem duplicação lógica.
**Tests**: integration/contract com concorrência e perda de recibo.
**Gate**: full.

### T21: Respostas e espera
**What**: Correlacionar reply, recibos e wait sem polling de modelo.
**Where**: `src/messaging/replies.ts`
**Depends on**: T20
**Requirement**: MSG-04/10
**Done when**: origem/destino verificados, reply não forja autor; wait retorna em até 30s com cursor pendente; resultado não depende de idle.
**Tests**: unit/integration com correlação inválida, timeout e resposta duplicada.
**Gate**: full.

### T22: Journal e replay
**What**: Expor eventos persistidos com filtro de escopo e retenção.
**Where**: `src/observability/events.ts`
**Depends on**: T10, T11, T13
**Requirement**: API-02/03/08, REL-02
**Done when**: catálogo da spec, cursor crescente, retenção 30d e expired; revogação remove visibilidade no replay; reload não duplica listeners.
**Tests**: integration com desconexão, autorização alterada e cursor antigo.
**Gate**: full.

### Phase 4: Orquestração

### T23: Grafo de tarefas
**What**: Persistir tarefas, dependências e revisões do DAG.
**Where**: `src/orchestration/tasks.ts`
**Depends on**: T15, T13
**Requirement**: TSK-01/02/06, REL-05
**Done when**: ciclo rejeitado; falha bloqueia dependentes; replanejamento explícito valida novo DAG; estados finais não reabrem.
**Tests**: unit/integration com fork/join, ciclos e alterações concorrentes.
**Gate**: full.

### T24: Executor de tarefas
**What**: Admitir tarefas prontas e acompanhar resultado/cancelamento.
**Where**: `src/orchestration/runner.ts`
**Depends on**: T20, T23
**Requirement**: TSK-03/04/05/07
**Done when**: limites 4 concorrentes/profundidade 4; resultado final explícito; cancel_requested até confirmação; join não antecipa dependência.
**Tests**: integration/contract; ports de perguntas/uso testados por contrato, integração real em T31/T32.
**Gate**: full.

### T25: Perguntas e aprovações
**What**: Gerenciar solicitações com respondente esperado e estados de espera.
**Where**: `src/orchestration/requests.ts`
**Depends on**: T12, T24
**Requirement**: TSK-08/09, ACL-08/09/11
**Done when**: resposta indevida recusada; aprovação humana não vem de agente; resolução retoma tarefa correta; expiração não concede acesso.
**Tests**: unit/integration com principal falso e resposta duplicada.
**Gate**: full.

### Phase 5: Contexto e automação

### T26: Exportador de contexto
**What**: Produzir pacote selecionado e transcrito nativo autorizado.
**Where**: `src/context/export.ts`
**Depends on**: T12, T14
**Requirement**: CTX-01/04
**Done when**: versão/origem/hash presentes; configuração sensível/grants ausentes; perdas e ausência de filesystem explícitas.
**Tests**: unit/contract com conteúdo sintético e autorização insuficiente.
**Gate**: full.

### T27: Importador idempotente
**What**: Validar pacote e importar com ledger de efeitos.
**Where**: `src/context/import.ts`
**Depends on**: T13, T26
**Requirement**: CTX-02/03/07/08
**Done when**: limite 10 MiB/hash/versão validados antes do host; parcial retorna operationID/IDs; retry não duplica destino nem concede grants.
**Tests**: integration/contract, ID em conflito, filho órfão e interrupção parcial.
**Gate**: full.

### T28: Memória compartilhada
**What**: Implementar quadro por escopo com compare-and-swap e expiração.
**Where**: `src/context/memory.ts`
**Depends on**: T10, T12
**Requirement**: CTX-05/06
**Done when**: revisão conflitante rejeitada; expirado deixa de ser lido imediatamente; tombstone em até 60s de serviço ativo.
**Tests**: unit/integration com relógio controlado e dois escritores.
**Gate**: full.

### T29: Serviço de agendamento
**What**: Implementar backend escolhido em T6 com contrato uniforme de jobs.
**Where**: `src/schedules/service.ts`
**Depends on**: T6, T12, T24
**Requirement**: SCH-01..10, LIF-06
**Done when**: intervalo ancorado, DST definido, coalescing, catch-up único, leases e revogação; condições executáveis unsupported; pause não finge cancelar execução ativa.
**Tests**: unit/integration/contract com relógio virtual, reinício e duas localizações.
**Gate**: full.

### Phase 6: Interfaces e consumo

### T30: Uso e orçamento
**What**: Agregar uso deduplicado e aplicar teto persistente por grupo.
**Where**: `src/observability/usage.ts`
**Depends on**: T8, T15, T24
**Requirement**: API-04..07/13
**Done when**: custo nulo sem fonte, estimado/reportado distintos; grupo sobreposto deduplicado; alteração só operador; orçamento desconhecido com teto bloqueia admissão.
**Tests**: unit/integration com admissões concorrentes e evento budget.changed.
**Gate**: full.

### T31: Ferramentas nativas
**What**: Registrar ferramentas sobre todos os serviços com principal autenticado.
**Where**: `src/transport/tools.ts`
**Depends on**: T16, T17, T18, T21, T22, T25, T27, T28, T29, T30
**Requirement**: API-01/08/10, SES-01
**Done when**: superfície do design disponível com schemas; namespace efetivo documentado; integração real de todos os ports; cancelamento e cleanup funcionando.
**Tests**: e2e/contract com servidor descartável, nunca credenciais de trabalho.
**Gate**: full + build.

### T32: API local e cliente
**What**: Registrar RPC autenticado e cliente tipado com schemas compartilhados.
**Where**: `src/transport/rpc.ts`
**Depends on**: T16, T17, T18, T21, T22, T25, T27, T28, T29, T30
**Requirement**: API-01/08/09/11
**Done when**: principal externo verificado; fail-closed; erro/cursor/idempotência compatíveis; exemplos HTTP/TypeScript passam contra pacote de teste.
**Tests**: e2e/contract positivos e negativos, equivalência com fixtures de tools.
**Gate**: full + build.

### T33: Comandos humanos
**What**: Registrar todos os comandos normativos de API-12.
**Where**: `src/transport/commands.ts`
**Depends on**: T31, T32
**Requirement**: API-12, ACL-01/09, LIF-08/09
**Done when**: argumentos/principals/saídas da tabela cobertos; comando de agente não vira operador; link e delete exigem canal humano comprovado. T33 é o integrador e escritor único do entrypoint `src/server.ts`, registrando tools/RPC/comandos e cleanup numa prova e2e do plugin completo.
**Tests**: e2e tabela completa incluindo recusa de argumentos e identidade falsa.
**Gate**: full + build.

### Phase 7: Estabilização e publicação

### T34: Documentação e licença de distribuição
**What**: Consolidar guia público executável e aprovar instrumento de licença.
**Where**: `docs/index.md`
**Depends on**: T33
**Requirement**: API-09 e Success Criteria de licença
**Done when**: referência de todas as famílias, auth, erros, exemplos, recuperação e compatibilidade; texto jurídico aprovado pelo titular; avisos de terceiros preservados; README não anuncia recursos futuros como disponíveis.
**Tests**: artifact para links e exemplos contra ambiente fixture; checklist de licença exige decisão humana, não teste automático fictício.
**Gate**: build + aprovação explícita da licença.

### T35: Empacotamento e candidato
**What**: Produzir tarball mínimo e matriz de instalação/upgrade suportada.
**Where**: `scripts/release.ts`
**Depends on**: T34
**Requirement**: API-09/10, REL-01/02 e Success Criteria
**Done when**: instalação limpa e upgrade com dados sintéticos preservados; rollback documentado/testado; tarball exclui fixtures privadas, bancos e credenciais; versões certificadas explícitas. Executar os [cenários de aceite](../../../docs/acceptance-scenarios.md).
**Tests**: artifact/e2e no pacote empacotado, não apenas checkout.
**Gate**: release; publicar somente após T36 e autorização do operador.

### T36: Verificação independente do candidato
**What**: Reexecutar aceite e comprovar que testes detectam violações da spec.
**Where**: `.specs/features/session-orchestration/validation.md`
**Depends on**: T35
**Requirement**: Todos os IDs de coverage.md
**Done when**: revisor distinto do autor comprova cada critério, executa falhas controladas isoladas e os [cenários de aceite](../../../docs/acceptance-scenarios.md), registrando evidências; nenhuma mutação sobrevive sem nova tarefa; operador aceita release antes de tag/publicação.
**Tests**: e2e/contract/artifact e sensor independente em cópia descartável.
**Gate**: release + validate_state somente após implementação real; este relatório não existe nesta entrega.

## Diagram-Definition Cross-Check

O DAG acima é completo. Validar igualdade de todas as arestas, além do validador
da skill (que compara principalmente arestas dentro da fase). Nenhuma dependência
pode apontar para tarefa inexistente, para fase posterior ou criar ciclo.

| Faixa | Dependências/diagrama | Propriedade para paralelismo |
| --- | --- | --- |
| T1–T8 | Snapshot antes dos probes independentes | Um arquivo de probe por worker |
| T9–T13 | Contrato antes de persistência/autorização | Schema e outbox com escritores separados |
| T14–T18 | Auth antes de gestão; prova de cascata antes de delete | Serviços distintos |
| T19–T22 | Inbox → dispatch → reply; journal independente | Mensageria sequencial, journal paralelo |
| T23–T25 | DAG → runner → perguntas | Ports congelados para integrações posteriores |
| T26–T29 | Export → import; memória e agenda independentes | Três frentes |
| T30–T33 | Serviços antes dos dois transports; comandos no join | Tools e RPC com arquivos distintos |
| T34–T36 | Docs/licença → pacote → verificador | Sem publicação antes do aceite |

## Test Co-location Validation

| Tarefas | Camada | Testes exigidos e previstos |
| --- | --- | --- |
| T1 | Package/harness | artifact + integration |
| T2–T8 | Host adapters | contract, com integration/e2e nas fronteiras |
| T9 | Schemas/domain | unit + contract |
| T10–T30 | Domain/persistence/services | unit/integration; contract quando chama host |
| T31–T33 | Transport | e2e + contract |
| T34 | Docs/legal | artifact + aprovação humana da licença |
| T35 | Package | artifact + e2e |
| T36 | Verificação | todos os níveis e sensor independente |

Cada tarefa traz seus testes no mesmo diff. Casos de integração entre serviços são
adicionados nos joins; isso não substitui os testes do serviço em sua própria
tarefa. O integrador registra exceções concretas, sem marcar critério como verificado
com mocks quando o resultado depende do host real.

## Handoff e progresso

Todas as tarefas T1–T36 estão pendentes. A preparação documental possui acompanhamento
local em `.ai-data/todos/2026-11/todo-opencode-sessions-spec-061126.md` no workspace
AgentZero, com escrita exclusiva do condutor. O operador decidiu mantê-lo somente
local em 06/11/2026. Para Execute, criar o todo de implementação na mesma convenção,
`todo-opencode-sessions-implementation-<DDMMYY>.md`, com data real de início;
confirmar seu versionamento antes de publicar em outro repositório. Marcar resultados
com evidências e atualizar coverage sem reescrever o histórico.
TUI e web não possuem tarefa aqui; o [roadmap](../../../docs/roadmap.md) preserva
essa entrega posterior. Falha P0 exige replanejamento explícito, não corte silencioso.
