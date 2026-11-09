# Arquitetura proposta

Status: implementação autorizada; revisão da mudança AD-007 APROVADA. Contrato: [spec.md](spec.md).
Decisões vigentes: [STATE.md](../../STATE.md). Evidências: [pesquisa](../../../docs/research.md).

## Architecture Overview

Um pacote com export server, definição RPC e cliente tipado. Ferramentas e API
chamam os mesmos serviços. Nenhuma lógica de autorização fica só na interface.

```text
tool context -> session principal --+
                                   +-> authorization -> services -> outbox/database
operator API -> operator principal -+                        |
                                                            v
                                                    OpenCode adapter
                                                            |
                                                public native contracts
```

TUI e web serão consumidores posteriores. Não se cria export TUI nesta etapa.
Um servidor adicional é alternativa apenas se a prova de autenticação RPC não
conseguir separar os principals com segurança; qualquer mudança desse porte volta
à revisão antes de implementação. Nunca usar sessionID do cliente como credencial.

## Alternativas consideradas

| Abordagem | Vantagem | Limitação | Decisão proposta |
| --- | --- | --- | --- |
| Somente storage/RPC do plugin | Pouca infraestrutura | Garantias transacionais e coordenação precisam ser provadas | Insuficiente para assumir fila concorrente |
| Plugin + SQLite próprio | Transações, auditoria, domínio independente da UI | Driver/runtime e instâncias locais exigem prova | Recomendada |
| Daemon independente | Um coordenador explícito | Instalação, autenticação e ciclo de vida adicionais | Reservado se P0 bloquear alternativa recomendada |

## Components

| Módulo | Responsabilidade | Contrato |
| --- | --- | --- |
| compatibility | Detectar baseline e recursos | capabilities, probe report |
| adapters/opencode | Traduzir operações públicas do host | host port, sem DTO nativo no domínio |
| authorization | Principal e grants direcionais | authorize, grant, revoke |
| persistence | Transações e schema versionado | repositories, outbox, leases |
| sessions | Identidade, árvore, lifecycle e configuração | current/list/create/control |
| groups | Organização e associação | groups, memberships |
| messaging | Envelope, entrega e resposta | send/request/reply/wait |
| orchestration | DAG, estados, perguntas e resultado | tasks, requests, approvals |
| context | Pacotes e quadro versionado | export/import/memory |
| schedules | Vencimento, pause, retomada e coalescing | jobs, runs |
| observability | Eventos autorizados e consumo | events, snapshots, usage |
| transport | Tools e RPC, schemas e erros | contrato versionado |

## Code Reuse Analysis

Repositório vazio na origem: não há padrões, testes ou módulos locais a reaproveitar.
Usar SDK público V2, sem importar internals nem ler diretamente o SQLite do host.
Referências externas orientam comportamento; código só pode ser incorporado após
checagem de licença/autoria, com avisos preservados.

## Data Models

| Registro | Chave e dados principais | Invariantes |
| --- | --- | --- |
| session_refs | instance_id + session_id, project_id, state | Dados nativos reconciliados, host é fonte da sessão |
| groups/memberships | group_id, session_ref | Sem grants implícitos |
| grants | source, target, capabilities, revision, expires_at | Operador emissor, direção explícita |
| operations | id, principal, action, key, payload_hash, state | UNIQUE(principal, action, key) |
| messages | id, source, target, type, correlation, expires_at | Envelope imutável após admissão |
| deliveries | message_id, host_receipt, state | Incerto não volta automaticamente a pendente |
| tasks/dependencies | id, group, executor, objective, result, state | Grafo acíclico; resultado não vem de idle |
| questions | id, expected_principal, response, expires_at | Aprovação humana não aceita agente |
| memory | scope, key, revision, content, expires_at | Compare-and-swap |
| jobs/runs | schedule, timezone, due_at, run_id, state | Vencimento tem identidade estável |
| events | sequence, scope, kind, operation_id, timestamp | Sem payload sensível nos logs operacionais |
| leases | resource, owner, generation, expires_at | Fencing por geração |

Payloads privados permanecem no banco local; logs de diagnóstico são redigidos e
não copiam prompts. Eventos de domínio podem referenciar conteúdo protegido, nunca
dispensam a autorização de leitura ao consultar. Banco em diretório de dados do
usuário, fora de repositórios; modo de arquivo restrito. Caminho definitivo e driver
serão provados no bootstrap, sem dependência instalada durante esta documentação.

## Estados e fronteiras transacionais

```text
operation: pending -> executing -> succeeded | failed | unknown_outcome
delivery: pending -> dispatching | rejected | expired
delivery: dispatching -> admitted | rejected | unknown_outcome
delivery: unknown_outcome -> admitted | rejected (evidência obrigatória)
task: pending -> running -> completed | failed
task: pending -> blocked | cancelled
task: running -> awaiting_input | awaiting_approval | cancel_requested
task: awaiting_input/awaiting_approval -> running | cancel_requested
task: cancel_requested -> cancelled | completed | failed
job: active -> paused | cancelled | expired
```

`delivered` não é estado do núcleo 1.0; leitura humana/modelo não é inferida.
Estados finais de tarefa são imutáveis;
retry explícito cria nova tentativa vinculada. Replanejar dependência cria revisão
do DAG e reavalia ciclo antes de desbloquear.

Persistir intenção, operação e outbox numa transação; worker adquire lease e
revalida autorização antes da chamada ao host. Banco e host não compartilham
transação: timeout/crash após chamada produz resultado incerto. Reconciliar por
recibo/chave nativa demonstrada em P0; sem prova, manter `unknown_outcome` e pedir
resolução humana. Não repetir cegamente para oferecer disponibilidade ilusória.

Revogação lineariza com a admissão local autorizada na transação do plugin;
isso não lineariza a admissão do host. Revalidar antes da saída reduz, mas não
elimina, a janela check→host. Conteúdo que saiu para o host não é revogável pelo
plugin. O limite e a questão SCH-05/06 estão no [contrato do scheduler](../../../docs/architecture/scheduler.md).

Exclusão destrutiva de sessões está fora da 1.0 (AD-007); LIF-08/09/10 ficam
deferred. O produto não chama DELETE nem expõe preview/confirm de exclusão.
Archive/restore permanecem. Exclusão externa é reconciliada por REL-03/04:
bloquear pendências, registrar tombstones e limpar somente storage próprio,
preservando auditoria mínima sem payload. Retenção local não exclui sessões do host.
A [prova T5](../../../docs/compatibility/lifecycle.md) mantém seus achados runtime;
DELETE no probe é restrito a fixtures sintéticas expressamente autorizadas.

## API proposta

Perfis de política propostos são atalhos para capacidades, nunca uma hierarquia
numérica que substitui avaliação de regras:

| Perfil | Operações | Autorização de execução |
| --- | --- | --- |
| observe | Teto: discover, read, context.read | Sem iniciar trabalho |
| collaborate | Teto: discover, read, message, context.read, context.write, task.dispatch | Dispatch depende de grant vigente |
| manage | Teto: todas as capabilities ativas enumeradas na spec | Policy e autoconfiguração continuam operador; sem exclusão de sessões |
| supervised | Mesmo teto de manage; cada mutação exige resolução individual do operador | Sem reutilizar aprovação always |
| bounded-auto | Mesmo teto de manage; somente ações dentro dos grants, limites e validade aprovados | Sem nova aprovação dentro do escopo; denies preservados |

O perfil resolve um conjunto efetivo e versionado. Mudança de perfil exige
operador, é auditada e não amplia grants de outras sessões. A tabela de comandos
de API-12 na spec é a fonte autoritativa completa. O entrypoint deve mostrar namespaces efetivos de tools,
porque o host pode prefixar nomes. Esses comandos não criam um dashboard.

Conjunto efetivo = teto do perfil ∩ grants vigentes ∩ política de delegação do
operador ∩ limites do host. Comunicação mínima do projeto é a única concessão
implícita prevista na spec; observe pode restringi-la. Na criação, intersectar
também as capacidades atuais do criador (LIF-13) antes de chamar o host.

Identificador RPC proposto: `sessions-tools-v1`. Rota e transporte final seguem o
contrato público confirmado em P0. Não documentar rota especulativa como executável.

Envelope de sucesso: `operationID`, `state`, `data`, `capabilityVersion`.
Erro v1: `code`, `message`, `retryable`, `operationID?`; sem campo `details`.
Mensagem igual ao código evita transportar dados sensíveis no envelope público.
Listagens: `items`, `nextCursor`. Eventos: `sequence`, `kind`, `scope`, `createdAt`.
Mutação: `idempotencyKey`, payload específico; origem vem do principal, não do input.

| Família | Métodos planejados |
| --- | --- |
| sessions | current, list, get, tree, create, fork, rename, setModel, setAgent, setStyle, interrupt, compact, reset, archive, restore |
| grants | link, unlink, list, request |
| groups | create, get, list, update, addMember, removeMember |
| messages | send, request, reply, inbox, wait |
| tasks | create, assign, dependencies, get, list, cancel, complete, fail |
| requests | ask, answer, approvalRequest, approvalResolve |
| context | export, import, share, memoryGet, memoryPut |
| schedules | create, list, get, pause, resume, cancel |
| telemetry | events, usage, capabilities, health |

Todos os métodos passam pela mesma autorização. AD-009 exige credencial própria
de operador, separada de sessões e da autenticação do transporte RPC do servidor.
Não enviar segredo em payload de tools/RPC nem inferir operador do texto.
O [contrato de autenticação](../../../docs/architecture/operator-auth.md) define
digest, comparação constante, capabilities, redação e revogação; gateway HTTP no
setup do plugin, mesmo processo e callback lexical privado é a preferência mínima.
Gateway separado com envelope assinado é alternativa, não escolha padrão.
As [provas de identidade](../../../docs/compatibility/identity.md) distinguem mock
de integração real: contexto de tool comprovado na fixture do host 2.2.5 para
SES-01, com claims recebidos ignorados; NÃO é identidade de operador. Comando
humano, always, provisionamento e auth de produto NÃO VALIDADOS. Unload isolado
do pacote e cleanup do listener comprovados no host 2.2.5, conforme identity.md.
Nota vigente: revisão APROVOU docs AD-008/009 e probe SES-01, não P0/T3 completo
ou auth de produto. Histórico de identity.md permanece sob seu worker responsável.
Não se presume acesso a headers HTTP no handler RPC. Auth de produto permanece
no subgate T3-PROD, incluindo revisão de armazenamento/provisionamento; emissão
somente humana posterior. Rate limiting e paginação também valem para tools/cursor.

## Importação e anexos de contexto — AD-010 (08/11/2026)

Decisão do operador: escolha explícita «Anexo de contexto (Recomendado)».
`create` usa importação nativa do lote completo em nova sessão, com preflight da
projeção inteira; não simular lote com mutações incrementais de histórico.
Domínio AD-010 aprovado no lote 43/328; adapter nativo teve lote 6/28 aprovado
e refinamento 10/47 do autor com follow-up independente ainda pendente. Fixtures
e adapter não certificam execução native-full real ou E2E/full de produto.
A decisão é de produto, não prova de plataforma.

`append` permanece obrigatório na 1.0 como anexo no storage próprio do plugin,
associado à sessão de destino e recuperável por ferramenta explícita autorizada.
Leitura exige conjuntamente `context.read` E `read`, principal corrente e
validação de owner/target; `context.read` isolado não basta. Anexo não concede grants.
Não reescreve histórico nativo nem executa prompt/modelo ou trabalho no host;
não concede grants nem trata conteúdo importado como instrução confiável.
Autorização vem do principal vigente, não do anexo. Ledger/idempotência e
parcial/replay continuam obrigatórios, sem retry cego de efeito externo incerto.
Hash/versão/limite validados antes de persistir anexo ou importar no host; IDs
distinguem anexo próprio de sessão/mensagem nativa, sem inventar efeito host.

T27 domínio AD-010 APROVADO 43/328, root v23 APROVADA 15/77, conforme evidência
recebida do revisor; follow-up adapter e execução nativa real/E2E/full pendentes.
Histórico de reabertura superado para domínio, não certifica produto. Não muda
AD-007, licença ou boundary RPC/auth/T3-PROD, nem abre gate global.

## Agendamento e relógio

Cron usa fuso IANA explícito. Intervalos usam âncora UTC e índice do vencimento.
Cron pula horário inexistente e usa somente a primeira ocorrência de horário
duplicado, conforme SCH-09. Condições executáveis são recusadas conforme SCH-10.
Um job possui exatamente um backend executor. Após a [prova T6](../../../docs/compatibility/schedules.md),
a escolha técnica é **scheduler próprio**, não timers nativos em paralelo.
O timer nativo funciona; sua ação pública somente prompt e os hooks gerais não
oferecem ocorrência/revisão de grant/fence transacionais com o plugin.
O [contrato detalhado](../../../docs/architecture/scheduler.md) define identidade,
relógio, outbox, ownership e testes de T29. Esta ratificação não é aceite SCH nem
certificação do produto: AD-008 autoriza boundary LOCAL de SCH-05/06, não
atomicidade no host. Provas de implementação nas tarefas respectivas;
unknown_outcome não admite retry cego. AD-007 APROVADA; docs AD-008/009
APROVADAS na rodada posterior de 07/11/2026. Viabilidade P0 APROVADA no lote
rev-p0-fechamento e T9 liberada por ordem explícita, com DAG ajustado.
Auth/provisionamento continuam em T3-PROD, sem retirar API da 1.0 ou autorizar
segredo. Correções documentais da divisão aguardam re-review, não novo aceite
dos docs AD-008/009 já aprovados.

## Error Handling Strategy

| Situação | Resposta |
| --- | --- |
| Host indisponível antes da chamada | unavailable, backoff limitado, sem efeito presumido |
| Timeout depois de enviar mutação | unknown_outcome, reconciliar antes de repetir |
| Falha local antes de persistir | Recusar efeito no host |
| Grant revogado | Rejeitar pendências não admitidas |
| Capability experimental ausente | unsupported, versão não certificada para a feature |
| Import parcial nativo | Registrar operação e IDs criados; não reimportar automaticamente |
| Sessão excluída externamente | Recusar destino, bloquear pendências, tombstone e limpeza própria; sem DELETE no host |

## Risks & Concerns

| Risco | Impacto | Mitigação/gate |
| --- | --- | --- |
| Docs V2 diferentes do binário | Métodos inexistentes | P0, baseline exata e testes de contrato |
| RPC sem identidade confiável | Escalada por payload | Prova principal/permission, recusa por padrão |
| Plugins por localização | Workers duplicados | Lease, fencing e duas instâncias em teste |
| APIs experimentais | Mudanças incompatíveis | Adaptadores e versão certificada |
| Exclusão nativa em cascata | Escritor externo pode ampliar conjunto removido | Exclusão do produto fora da 1.0 por AD-007; preservar prova T5 |
| Licença ainda sem texto final | Distribuição jurídica ambígua | Gate do titular antes de código distribuível |
| Mesma pasta em várias tarefas | Conflitos de arquivo | Worktrees opt-in ou serializar tarefas de escrita |

## Paralelismo

Congelar interfaces antes de abrir frentes. Cada worker recebe um módulo e seus
testes; não pode alterar contratos compartilhados sem voltar ao integrador.
Persistência, schemas e entrypoint têm um escritor por vez. Revisor não é autor.
Uma frente só começa com dependências aprovadas e fixtures suficientes para testes
reais do seu contrato. Fases de integração executam depois dos joins, não antes.
