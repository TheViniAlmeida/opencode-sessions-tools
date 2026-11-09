# T4 — admissão e recuperação (P0 parcial)

Baseline executada em 07/11/2026: `opencode v2.2.5`; dependências locais do
bootstrap, sem instalação. Não é implementação do produto nem certificação T4.

## Fontes

- [API V2](https://opencode.ai/v2/docs/api), consultada nesta execução.
- [SDK V2](https://opencode.ai/v2/docs/build/sdk).
- Context7 `/websites/opencode_ai/v2`: prompt/synthetic, `delivery` e `resume`.
- Contrato efetivo `/openapi.json` do servidor descartável. A documentação
  consultada descreve synthetic como 204; este binário responde 200 com recibo.
- [MSG](../../.specs/features/session-orchestration/spec.md) e
  [T4/design](../../.specs/features/session-orchestration/design.md).

## Reprodução e resultado real

```sh
bun scripts/probes/delivery.ts
bun test tests/contract/delivery.test.ts
```

Admissão retorna `state: partial`; o comando também executa a prova runtime local.
O runner compartilhado não foi alterado: executar diretamente o arquivo acima.

| Experimento HTTP isolado | Resultado observado | Não comprova |
| --- | --- | --- |
| Idle: dois prompts queue e um steer, todos resume:false | 200, recibos com IDs solicitados; correlação em payload.metadata preservada | Execução/inferência e consumo FIFO |
| Synthetic queue resume:false | 200, ID disponível na inbox; histórico vazio, sem execution.started e sem time.busy | Comportamento em sessão busy |
| Ordem da inbox | Mesma ordem das três admissões sequenciais | Ordenação concorrente, prioridade steer ou FIFO do futuro dispatcher |
| Resposta perdida após encaminhamento | Proxy loopback envia uma vez e retém resposta; cliente aborta por timeout injetado | Timeout de provider ou perda antes da admissão |
| Reconciliação sem reenvio | unknown → admitted por sessionID + ID conhecido na inbox, uma ocorrência e correlação preservada | completed, leitura pelo modelo ou retry idempotente do produto |
| Reinício do host descartável | Mesmo ID permanece exatamente uma vez na inbox | Recuperação de execução ativa ou leases/listeners do plugin |

Cada request tem teto de 5 segundos pelo harness; o proxy tem teto adicional de
4,5 segundos e é fechado em finally. O timeout é injetado imediatamente após
o encaminhamento; não é necessário aguardar seu teto. Não há polling de modelo,
provider externo, credenciais reais nem leitura do banco interno. O host e suas
sessões sintéticas são removidos pelo cleanup do harness.

Os limites de ausência de provider da tabela acima se referem à prova de admissão;
a prova runtime abaixo usa exclusivamente provider determinístico loopback.

O ponto comprovado de não retorno é a existência durável do item na inbox do
host. Após perder a resposta, o chamador permanece unknown até obter evidência
por identidade. Não há reenvio no teste. Se a identidade não for encontrada,
isso não demonstra rejeição: manter unknown_outcome, sem retry cego.

`admitted`, `completed`, `failed` e `unknown` são distintos. O classificador é
apenas auxiliar da prova. Runtime comprova unknown/admitted pela inbox e
sucesso/falha por mensagens terminais explícitas, não pela mera ausência de busy.

## Runtime local após integração do harness

O integrador disponibilizou `deliveryProvider: { baseURL: fixture.baseURL }`.
O worker T4 não alterou o harness. `runDeliveryRuntimeProbe()` cria provider
determinístico com barreira e usa HTTP real do host 2.2.5, sem inferência externa.

Resultados positivos:

- Prompt inicial com resume default inicia execução. Busy é confirmado por
  `GET /api/session/{id}` (`time.busy`), não por request recebido no mock.
- Durante busy, dois prompts queue, um steer e uma notificação queue são admitidos
  com `resume:false`. Permanecem na inbox enquanto a barreira segura a resposta;
  o histórico contém apenas o prompt inicial, sem materialização prematura.
- Após liberar a barreira, o histórico (endpoint retorna newest-first) mostra:
  inicial → steer → queue 1 → queue 2 → notificação. Inbox termina vazia.
  Cinco mensagens assistant têm `time.completed` e `finish: stop`; mensagem
  terminal idle traz `outcome: succeeded`.
- **resume:false não significa nunca consumir**: durante execução ativa, os itens
  podem ser consumidos pelo loop existente. Não solicitar novo despertar é distinto
  de impedir execução em loop já ativo.
- Em outra sessão idle, synthetic resume:false não produz histórico nem busy nem
  chamada ao provider. Um prompt posterior resume:true permite consumir também
  essa notificação; observa-se terminal succeeded.
- Fixture injeta HTTP 400 determinístico, sem retry transitório: assistant tem
  `finish: error`, `provider.invalid-request`; idle terminal tem `outcome: failed`.
  Isso prova falha de execução separada da admissão HTTP bem-sucedida.

Polling somente de estado do host, limitado a 4 segundos por observação; cada
request tem teto do harness de 5 segundos. Barreira do provider tem teto de
4 segundos e é liberada logo após as admissões e leituras de busy. Cleanup fecha
host e provider. Conteúdo e tokens são sintéticos, sem custo real comprovado.

## Limites remanescentes

**Provas nativas ampliadas; produto continua não implementado.** Queue preservou
ordem relativa neste cenário sequencial, mas steer ultrapassou queue. Portanto
FIFO global do dispatcher do produto não pode ser delegado cegamente ao host:
serializar entregas por destino e aplicar política própria de modos/prioridade.
Não foram provados concorrência de produtores, starvation, leases/outbox,
repetição de chave com payload divergente nem correlação causal de resposta
entre sessões do plugin. Não se infere delivery individual de mero idle.

Semântica observada por inbox + histórico/IDs; log follow:false retorna frame
de sincronização nesta versão e não constitui prova de replay de eventos.
T4 P0 do produto permanece parcial, mesmo com busy/conclusão/falha nativos provados.
