# Registry privado de comandos do operador

Incremento interno de composição, **não API pública estável e não API-08
concluída**. Não abre listener, cadastra operador, emite credencial ou configura
bootstrap. A exposição continua condicionada ao gate T3-PROD. Os testes usam
somente autenticação sintética.

## Allowlist e schemas

Todos os comandos usam `POST` e exigem confirmação vinculada à intenção exata.
Campos desconhecidos e nomes fora da allowlist são recusados.

| Nome | Rota privada | Capability | Target | Body |
| --- | --- | --- | --- | --- |
| `session.profile.set` | `/operator/session/profile` | `session.configure` | session | `{profile, expectedRevision}` |
| `session.model.set` | `/operator/session/model` | `session.configure` | session | `{providerID, modelID, expectedRevision}` |
| `session.grant.link` | `/operator/grants/link` | `manage` | session | `{source, capabilities, expiresAt, policyRevision, grantRevision}` |
| `group.budget.set` | `/operator/groups/budget` | `manage` | group | `{ceiling, expectedRevision}` |
| `question.approval.respond` | `/operator/questions/approve` | `manage` | session | `{requestID, response}` |

`source` é um `SessionRef` completo. `expiresAt` é uma data textual ou `null`.
`ceiling` é um número finito não negativo ou `null`. Revisões são inteiros não
negativos. Profile usa os cinco valores do domínio: `observe`, `collaborate`,
`manage`, `supervised`, `bounded-auto`.

`response` usa os campos reais de `QuestionResponse`: `revision`, `admissionID`,
`operationID`, `correlationID`, `taskGeneration`, `target` e `decision`.
`taskGeneration` é positivo e `target` deve coincidir com a sessão da intenção.
As decisões administrativas permitidas são `once` e `deny`; não há alias
`reject`, resposta textual, `answer` ou aprovação `always` neste registry.

## Contrato de integração

O owner canônico registra `OPERATOR_COMMANDS_MIGRATION` como versão global v22
em `compositionMigrations`. O módulo do registry nunca executa migrations por
conta própria; o startup do root aplica o descriptor pelo fluxo canônico de
migração.

O construtor exige persistência, `InvocationIdentity`,
`TrustedAdmissionPrincipalPort`, `OperatorExecutionAuthorityPort`, handlers,
relógio e **`OperatorCapabilityPort`**, nessa ordem.

- `TrustedAdmissionPrincipalPort.consume(sql)` devolve e limpa um latch privado
  criado pelo callback de autorização autenticado do core, na mesma invocação
  e conexão SQL. O payload não fornece esse principal.
- `OperatorExecutionAuthorityPort.current()` consulta a autenticação privada
  ainda ativa. SQL não recria autoridade para um worker independente.
- `OperatorCapabilityPort.revalidate(sql, current, capability, intention)` é
  obrigatório e síncrono. O adapter usa a política canônica T11, resolve o scope
  de grupo e verifica capability exata, projeto, target e autoridade atual. Não
  cria outra fonte de verdade. Ausência do adapter falha com `unavailable`.
- `handler.revalidate` verifica condições de negócio e revisões; não substitui
  o port de segurança. `handler.execute` chama o domínio fora da transação do
  core. Um handler ausente falha com `unsupported`, sem no-op aprovado.

Passe `registry.enqueue` a `OperatorCore.admit`. O callback persiste somente o
comando local, owner, revisão, hashes e binding da confirmação. Após commit,
chame explicitamente `registry.execute(operationID)` na invocação privada ainda
autenticada. A execução usa `runWithAuthenticatedOperator`, compara a identidade
atual com o owner persistido e revalida credencial e capability antes do handler.

## Idempotência, falhas e encalhes

O ledger de comandos tem uma entrada por `operationID` do core. Não substitui
as máquinas de estado dos domínios. No adapter de budget provado pelo teste,
o `operationID` do core é o `idempotencyKey` de `UsageService.changeBudget`;
`usage_budget_mutations` liga essa chave ao ID próprio do evento de domínio.
Outros adapters ainda precisam implementar seus contratos reais de execução.

O dispatch é **at-most-once**, sem promessa de conclusão: `pending` pode executar
uma vez; `dispatching` nunca é redisparado. Um crash nessa janela pode deixar o
comando encalhado. Erro ambíguo resulta em `unknown`; não há retry cego, worker
autônomo ou recuperação automática. Falta de autenticação ativa mantém o comando
pendente e retorna `unavailable`.

Callbacks locais que devolvem thenables continuam proibidos. A rejeição é
consumida sem log antes do erro fixo e rollback; isso não permite trabalho
assíncrono no callback nem torna sucesso uma operação recusada. Mensagens,
stacks e códigos de erro não reconhecidos não atravessam o receipt.
