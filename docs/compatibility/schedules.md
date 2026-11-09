# T6 — decisão de backend de agenda (OpenCode 2.2.5)

Experimentos de 07/11/2026. CLI e HTTP versionados em 2.2.5. Somente fixture
loopback `createHarness({ schedules:true, deliveryProvider:{baseURL} })`, provider
determinístico SSE local, dados sintéticos próprios, sem chave/modelo externo.
Nenhuma condição if/until shell/Code Mode ativada. Não foi alterado o harness.

## Decisão técnica antes de T9

**Recomendar scheduler próprio para o produto**, com domínio determinístico,
relógio injetável, authorize/outbox/lease próprios antes de chamar prompt do host.
Isso não afirma que o nativo não funciona: CRUD, persistência e execução reais
funcionaram. A incompatibilidade decisiva é a fronteira pública de autorização
por ocorrência e sua identidade, não a ausência de um teste de timer.

### Alvo público nativo

O `/openapi.json` real expõe `Schedule.CreatePayload` com sessionID/name/when/
if/until/ends/prompt; prompt é obrigatório. `Schedule.Action` é anyOf contendo
somente `Schedule.Action.Prompt`. Não existe alvo callback/RPC/plugin/tool.
O SDK local `@opencode/client/dist/promise/generated/types.d.ts:492,1240`
confirma `ScheduleActionPrompt` e `ScheduleAction = ScheduleActionPrompt`.

**Discrepância medida:** apesar de additionalProperties=false no OpenAPI, o
HTTP aceitou os campos extras action RPC e tool, mas retornou ação **prompt**
com o texto original. Portanto não se deve alegar rejeição desses extras nem
usar aceitação HTTP como evidência de callback suportado. Ambos os jobs foram
imediatamente removidos, sem disparo.

### Hook público existente não é o gate transacional necessário

Há, sim, `ctx.session.hook("prompt", ...)` **antes** da admissão durável.
Não confundir com eventos após admissão nem alegar ausência de todo hook.
As docs V2 registram explicitamente:

- O hook transforma draft, sem API de rejeição tipada.
- Falha/interrupção de preparação impede admissão, mas isso não define um
  protocolo transacional de autorização do scheduler.
- Repetir ID já pending/delivered retorna a admissão original sem repetir hooks.
- Submissões concorrentes podem executar hook mais de uma vez; só uma admissão vence.
- Hooks não constituem uma fronteira exactly-once para efeitos.

O SDK público local 2.2.5 confirma em
`node_modules/@opencode/plugin/dist/promise/session.d.ts:13–19` que SessionPrompt
expõe sessionID/messageID readonly, prompt, metadata aplicativo e delivery.
Não expõe scheduleID, occurrenceID, principal autenticado do scheduler,
grantRevision ou fencing token. `SessionHooks` (:171–185) não possui hook
específico de schedule; `registration.d.ts` define callback Promise<void>|void,
sem resultado tipado de veto/transação. Não foi provado neste probe que scheduled
prompts passem pelo hook geral: a decisão **não depende** de alegar bypass.

Mesmo supondo que passem, prefixo no texto e metadata aplicativo não são prova
de origem confiável: entradas do usuário podem copiá-los. Um lookup em sessão
dedicada pode reduzir ambiguidade, mas não torna callback/replay/admissão do host
uma transação com grant/revisão/outbox do plugin. Um throw pode impedir uma
tentativa; não oferece contrato de revisão/consumo atômico, rollback ou fencing.

Consequência específica: o nativo direto não oferece primitiva pública suficiente
para vincular SCH-05 (grant/revisão e limite do produto por ocorrência) e SCH-06
(lease/fencing e única emissão entre localizações) à admissão do host. Isso é uma
limitação do contrato certificado, não uma alegação de exploit ou impossibilidade
de qualquer integração futura. Native timers + gates pode ser reconsiderado se
o host publicar callback confiável anterior à admissão, identidade da ocorrência
e semântica de retry/commit compatível, com testes independentes.

## Evidência executada

| Cenário | Resultado |
| --- | --- |
| Create/list/get | 200, mesmo job futuro |
| Pause/resume | 200; estados confirmados em requests posteriores |
| Cancel/delete | 204; get posterior 404 ScheduleNotFoundError |
| Restart 1 | Job e sessão persistem; deadline/runCount inalterados |
| Pause e restart 2 | Paused persiste; resume funciona |
| Cancel e restart 3 | Get continua 404; list vazia |
| Intervalo 365 days, ends.times=2 | Primeiro deadline calculado e remainingRuns=2 |
| Cron anual, America/New_York | Deadline corresponde a 01/01 00:00 local |
| Oito entradas inválidas | 400 InvalidRequestError: cron, zone, duração, zero, negativa, timers múltiplos, limite zero, prompt vazio |
| One-shot 1s, ends.times=1 | Provider chamado; done/fired, runCount=1, remainingRuns=0 |
| Intervalo 1s | 400: every must be at least 1 minute |
| Every 1 minute, ends.times=2 | Duas ocorrências reais em cerca de 120s; done, runCount=2, remainingRuns=0 |
| Provider bloqueado 2,2s e dois outros jobs vencidos | Uma chamada durante barreira; nova chamada após liberar; jobs marcados fired |

`done/fired` já aparece enquanto a resposta do provider está bloqueada. Portanto
indica admissão, **não conclusão de inferência**. Jobs distintos em sessão ocupada
não provam coalescing por job recorrente. Campos interval* históricos no JSON
referem-se a esse cenário ocupado one-shot; recurrence* é o teste de 1 minuto.

`GET /api/config` omite experimental.schedules mesmo com flag funcionando.
Config.Patch só oferece shell; sem flag, rodada inicial retornava 403 explícito.
A fixture agora configura a flag antes de startup, sem patch arbitrário.

## O que continua não validado

- Coalescing recorrente por job, catch-up durante downtime, drift de longo prazo.
- DST gap/fold em runtime. Próximo cron IANA não prova esses casos; não esperamos meses.
- Falha de provider e reconciliação após admissão incerta.
- Grants/revisões, limites e leases **do produto**: execução nativa não os prova.
- Condições executáveis SCH-10 não exercitadas e devem permanecer recusadas no núcleo.

O próprio ainda **não foi implementado**. A decisão permite detalhar em T9 os
contratos de jobs/runs/grantRevision/occurrenceID/outbox/fencing, sem afirmar aceite
SCH completo. Implementação posterior deve provar revogação concorrente fail-closed,
um pending coalescido, âncora UTC, regra IANA/DST explícita, catch-up e duas
localizações com relógio injetado; só então enviar prompt ao host. Outbox deve
registrar a fronteira de não retorno e reconciliar resposta incerta sem reenvio cego.
Não habilitar executor nativo em paralelo ao próprio.

## Reprodução e fontes

`bun test tests/contract/schedules.test.ts` executa também a recorrência real.
beforeAll tem timeout explícito 145s; recorrência é observada por HTTP com espera
assíncrona limitada a 125s, sem polling de modelo. `bun scripts/probes/schedules.ts`
imprime somente dados sintéticos; não persistir output raw solto na raiz temporária.
Cleanup finally remove IDs próprios e encerra host/provider. Se startup do host
falhar, provider também é fechado. Nenhum runtime interno do banco foi lido.

Fontes públicas consultadas via Context7 `/websites/opencode_ai/v2` e fetch:
https://opencode.ai/v2/docs/api,
https://opencode.ai/v2/docs/config,
https://opencode.ai/v2/docs/build/plugins/server#prompt-admission.
Confrontadas com OpenAPI real e SDK local 2.2.5. Nenhuma conclusão depende de
evento pós-admissão ou internals do scheduler.

Primeira rodada do teste longo: a recorrência passou, mas duas expectativas do
teste falharam (extras aceitos como prompt e action anyOf em vez de ref direta).
As expectativas foram corrigidas para registrar o comportamento real, sem
mascarar a discrepância schema/runtime.
