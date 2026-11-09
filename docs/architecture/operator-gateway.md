# Gateway de operador — incremento sintético

08/11/2026. **Core e gateway implementados e testados em fixtures sintéticas;
revisão independente pendente. Não certificado para produção.** Nenhum segredo
real, bootstrap, porta fixa de produto ou integração com o lifecycle do plugin
foi provisionado. Ver [auth](operator-auth.md),
[ameaças](operator-threat-model.md) e [core](operator-core-fixtures.md).

## Composição e fronteira

`src/transport/operator-gateway.ts` exporta `createOperatorGateway`; importar o
módulo não abre listener. O chamador fornece core, persistência canônica, registry
SQL local confiável e configuração explícita. Referências ao core e handlers
ficam na closure; o retorno oferece URL, handler autenticado, stats e stop, não
um port de admissão sem autenticação. Não há bridge RPC nem executor de host.

O bind é exclusivamente `127.0.0.1`. Porta fixa deve estar na allowlist explícita;
nenhuma foi escolhida ou autorizada para uso real. Porta `0` exige
`fixtureEphemeral: true` e allowlist vazia. Host deve ser exatamente o endereço
com a porta efetivamente ligada. Origin, inclusive `null`, preflight, proxy
headers, método/rota fora do registry e Content-Type diferente de
`application/json` são negados. A rota de challenge recebe `{}` e bindings em
headers; a admissão recebe bytes do envelope do core, sem bearer no corpo/RPC.

## Orçamentos efetivos

| Recurso | Limite deste incremento |
| --- | --- |
| Corpo nativo Bun | 65.536 bytes (`maxRequestBodySize`) |
| Corpo da aplicação | 65.536 bytes antes do parse; um buffer fixo por leitor, sem lista crescente de chunks |
| Headers | Soma UTF-8 de nomes/valores mais quatro bytes por par: 8.192 bytes; não é medição do framing TCP |
| Leitura | Deadline total de 5.000 ms; idle de 2.000 ms renovado por chunk; Bun `idleTimeout: 2` como guarda adicional |
| Leitores | Oito; nono negado antes de adquirir leitor/timers |
| Admissões | Contador defensivo quatro; concorrência efetiva máxima um por construção síncrona, não quatro admissões simultâneas demonstradas |
| Bucket global | Burst dez, reposição 60/min; cobrado antes das validações da aplicação |
| Bucket por credential ID | Burst quatro, reposição 20/min; máximo 128 IDs, sem eviction de bucket ainda depletado |
| Desafios no core | Quatro pendentes por credencial, 128 globais; TTL e skew de 30 s |

IDs desconhecidos também gastam orçamento. Buckets totalmente recuperáveis após
12 s podem ser removidos ao inserir outro ID. Clock regressivo nega; não há timer
periódico para rate/cleanup. Leitores usam dois timers canceláveis, com contagem
real de timers ativos e relógio injetável nos testes. O limite de bytes retidos
reporta payload copiado, não memória total do processo ou buffers internos Bun.

`core.admit` e callback SQL são síncronos, sem `await` na seção increment/decrement
do contador. Requisições independentes não se sobrepõem nessa seção no event loop.
**NET-03, quinta admissão concorrente: N/A por construção nesta fixture.** O
contador quatro é defesa em profundidade, não prova de throughput/concurrency.
Não se transforma o core em async nem se inventa thenable concorrente para
simular uma condição impossível. O teste síncrono observa pico um dentro do
callback real; os testes de dezesseis pedidos não provam quatro commits paralelos.

## Respostas nativas e de aplicação

A aplicação usa erro fixo `403` com `{ok:false,error:{code:"forbidden"}}` e
`no-store`, sem exceção/credencial refletida. O Bun pode rejeitar antes de
`fetch`/`error`, retornando `413` próprio: esse resultado **não** promete o envelope
de domínio. Em Bun 1.4.3, os testes HTTP com Content-Length e chunked de 65.537
bytes observaram `413`, zero chamadas ao core e listener operacional depois.
O cap nativo não é relaxado para uniformizar a resposta. Erros de framing HTTP
do runtime também não são certificados como respostas de domínio. Não há promessa
de mapear `413` nativo pelo callback público `error`.

## Índices e limpeza: contrato futuro do dono da persistência

O startup inspeciona `sqlite_master` antes de abrir a porta e falha fechado se
os dois índices não tiverem **nomes e SQL exatamente iguais**:

```sql
CREATE INDEX operator_gateway_quota ON operator_challenges(consumed,expires_at,credential_id);
CREATE INDEX operator_gateway_expiry ON operator_challenges(expires_at);
```

O SQL acima documenta o contrato; não é instrução para aplicar migração real.
Fixtures criam esses índices apenas no banco descartável. O dono da persistência
deverá compor uma migração futura, aprovada separadamente. O gateway não instala
schema, não migra e não modifica `OperatorCore`.

A consulta real de quota no core é:

```sql
SELECT COUNT(*) AS total, COALESCE(SUM(credential_id=?2),0) AS own
FROM operator_challenges WHERE consumed=0 AND expires_at>?1
```

Foi avaliado o parcial `(expires_at,credential_id) WHERE consumed=0`, compatível
com esse predicado e potencialmente menor. Escolheu-se neste incremento o índice
completo `(consumed,expires_at,credential_id)`: prefixo de igualdade `consumed`,
range de expiração e `credential_id` coberto para o SUM, sem depender da prova de
implicação de predicado parcial. `EXPLAIN QUERY PLAN` na fixture confirma uso do
índice escolhido; isso não é benchmark de produção nem prova de custo constante.
O segundo índice cobre o sweep por expiração de linhas consumidas **e** pendentes;
um índice somente `WHERE consumed=0` não serviria a essa limpeza geral.

A igualdade textual do DDL rejeita intencionalmente índices parciais, SQL
equivalente com formatação diferente e outros nomes. Trocar esse contrato exige
revisão e composição coordenada com o dono da persistência, não fallback ou
auto-migração silenciosa.

Em requisição elegível após parse/bindings, o sweep remove no máximo 32 linhas
de `operator_challenges` com `expires_at <= now - 30000`, ordenadas pela expiração,
usando `operator_gateway_expiry`. Linha consumida ainda não expirada não é
removida. Não há cron/background sweep nem garantia de drenagem sob qualquer
carga; quotas limitam pendentes, não todos os tombstones históricos. O sweep
atual ocorre antes de autenticar pelo core e pode ser acionado por bearer inválido
com formato aceito; continua limitado pelo rate e batch. Não se reivindica
ausência de writes em todo negativo de autenticação.

O sweep não toca `operator_ledger`, confirmações ou efeitos locais. O teste cria
uma admissão pelo core real antes da limpeza e compara todos os campos do ledger
(TEXT em representação hex e campos numéricos) e IDs dos efeitos antes/depois.
Não é snapshot byte a byte do arquivo SQLite, que muda legitimamente no sweep.

## Evidência e pendências

Arquivos de teste:
`tests/unit/operator-gateway.test.ts`,
`tests/integration/operator-gateway.test.ts`,
`tests/unit/operator-core.test.ts` e
`tests/integration/operator-core.test.ts`.

| IDs | Evidência sintética e limite |
| --- | --- |
| NET-01 | Config inválida, porta 65535 fora da allowlist negada antes do bind, HTTP Host/Origin/Content-Type/rota/método; conflito de porta e configuração real do plugin pendentes |
| NET-02 | Handler aceita 64 KiB e rejeita +1 antes do parse; tamanho declarado 70000 retém zero bytes; HTTP real aceita JSON `{}` com padding até 65.536 e rejeita 65.537 por Content-Length/chunked; não certifica todo framing malformado nativo |
| NET-03 | Clock determinístico prova 5 s total/2 s idle; headers, oito leitores e abortos em dezesseis pedidos; quinta admissão concorrente N/A por construção síncrona, contador defensivo separado |
| NET-04 | Burst global/de credencial, reposição e churn finito de IDs limitados; quotas de desafios no core; sweep32 e uso do índice em fixture; não prova operação indefinida ou limite de DB histórico |
| REP/RET | Core real, hash dos bytes, replay, desafio novo/mesma intenção e um efeito; sweep preserva ledger real já admitido e efeitos |
| AUD-01 | Negativos e respostas HTTP não refletem credencial/header; capturas completas de stdout/stderr, tracing, RPC e transcripts do plugin real continuam pendentes |
| LIFE-01 | Stop cancela leituras/timers, barra handler posterior e fecha socket HTTP keep-alive TCP real em prazo de fixture de 3 s; setup/unload do plugin, reload, boot epoch e audience antiga no host real continuam pendentes |

Limite observado em Bun 1.4.3: socket TCP conectado **sem enviar nenhum byte
HTTP** não fechou no ensaio inicial de `stop(true)` dentro de 3 s. Esse ensaio
falhou e não é apresentado como aprovado. O teste mantido cobre conexão HTTP
keep-alive estabelecida, não todo socket pre-HTTP. Encerramento de conexão ainda
não reconhecida pelo runtime permanece limitação a investigar antes de certificar
lifecycle/produção; não foi contornado com mudança nativa ou timeout fictício.

Validação usa Bun 1.4.3, `bun run typecheck`, Biome nos arquivos alterados e
`bun test` nos quatro arquivos acima. Resultados numéricos são comunicados com a
execução da rodada; documentação não substitui teste. Revisão independente,
registry/policy de produto, provisioning, bootstrap, emissão e integração de
setup/unload com o host continuam bloqueios separados. Não há promessa de
exactly-once para operação de host; a garantia exercitada é SQL local.
