# Arquitetura proposta

Status: proposta técnica, implementação não iniciada. Contrato: [spec.md](spec.md).
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

Revogação lineariza no registro de intenção autorizada/admissão em coordenação com
o worker. A prova P0 deve estabelecer o ponto observável de não retorno no host;
o serviço não promete revogar conteúdo que já saiu para ele.

Exclusão em cascata só será habilitada quando o adaptador provar que o conjunto
aprovado não pode crescer entre validação e execução. Se API não oferece CAS ou
equivalente, não declarar LIF-10 atendido: exigir solução revisada, em vez de um
lock que só coordena chamadas do plugin e ignora escritores externos.

## API proposta

Perfis de política propostos são atalhos para capacidades, nunca uma hierarquia
numérica que substitui avaliação de regras:

| Perfil | Operações | Autorização de execução |
| --- | --- | --- |
| observe | Teto: discover, read, context.read | Sem iniciar trabalho |
| collaborate | Teto: discover, read, message, context.read, context.write, task.dispatch | Dispatch depende de grant vigente |
| manage | Teto: todas as capabilities enumeradas na spec | Policy/delete e autoconfiguração continuam operador |
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
Erro: `code`, `message`, `retryable`, `operationID?`, `details` redigidos.
Listagens: `items`, `nextCursor`. Eventos: `sequence`, `kind`, `scope`, `createdAt`.
Mutação: `idempotencyKey`, payload específico; origem vem do principal, não do input.

| Família | Métodos planejados |
| --- | --- |
| sessions | current, list, get, tree, create, fork, rename, setModel, setAgent, setStyle, interrupt, compact, reset, archive, restore, deletePreview, deleteConfirm |
| grants | link, unlink, list, request |
| groups | create, get, list, update, addMember, removeMember |
| messages | send, request, reply, inbox, wait |
| tasks | create, assign, dependencies, get, list, cancel, complete, fail |
| requests | ask, answer, approvalRequest, approvalResolve |
| context | export, import, share, memoryGet, memoryPut |
| schedules | create, list, get, pause, resume, cancel |
| telemetry | events, usage, capabilities, health |

Todos os métodos passam pela mesma autorização. API externa de operador é
privilegiada e não deve ficar acessível por credencial reutilizável de sessão sem
que isso seja reconhecido como fronteira de confiança do host. Autenticação do
host por si só não prova autoria de uma sessão. Rate limiting e paginação se
aplicam também a ferramentas e a acessos por cursor.

## Agendamento e relógio

Cron usa fuso IANA explícito. Intervalos usam âncora UTC e índice do vencimento.
Cron pula horário inexistente e usa somente a primeira ocorrência de horário
duplicado, conforme SCH-09. Condições executáveis são recusadas conforme SCH-10.
Um job possui exatamente um backend executor. Preferir
nativo se persistência, não sobreposição, revogação, coalescing e identidade forem
demonstrados. Caso contrário, serviço próprio com lease; não ligar os dois.

## Error Handling Strategy

| Situação | Resposta |
| --- | --- |
| Host indisponível antes da chamada | unavailable, backoff limitado, sem efeito presumido |
| Timeout depois de enviar mutação | unknown_outcome, reconciliar antes de repetir |
| Falha local antes de persistir | Recusar efeito no host |
| Grant revogado | Rejeitar pendências não admitidas |
| Capability experimental ausente | unsupported, versão não certificada para a feature |
| Import parcial nativo | Registrar operação e IDs criados; não reimportar automaticamente |
| Mudança de árvore na exclusão | Novo preview; nunca ampliar conjunto aprovado |

## Risks & Concerns

| Risco | Impacto | Mitigação/gate |
| --- | --- | --- |
| Docs V2 diferentes do binário | Métodos inexistentes | P0, baseline exata e testes de contrato |
| RPC sem identidade confiável | Escalada por payload | Prova principal/permission, recusa por padrão |
| Plugins por localização | Workers duplicados | Lease, fencing e duas instâncias em teste |
| APIs experimentais | Mudanças incompatíveis | Adaptadores e versão certificada |
| Exclusão nativa em cascata | Apagar filho criado após preview | Prova atômica obrigatória; bloquear se ausente |
| Licença ainda sem texto final | Distribuição jurídica ambígua | Gate do titular antes de código distribuível |
| Mesma pasta em várias tarefas | Conflitos de arquivo | Worktrees opt-in ou serializar tarefas de escrita |

## Paralelismo

Congelar interfaces antes de abrir frentes. Cada worker recebe um módulo e seus
testes; não pode alterar contratos compartilhados sem voltar ao integrador.
Persistência, schemas e entrypoint têm um escritor por vez. Revisor não é autor.
Uma frente só começa com dependências aprovadas e fixtures suficientes para testes
reais do seu contrato. Fases de integração executam depois dos joins, não antes.
