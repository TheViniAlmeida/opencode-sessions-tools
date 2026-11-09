# Baseline candidata de contratos — T2

Captura em 07/11/2026. **Não certifica P0, T1 ou compatibilidade funcional.**
Servidor descartável criado exclusivamente por `createHarness`, HTTP autenticado,
loopback e ambiente sintético. Encerramento e remoção da fixture em `finally`.
Nenhuma chamada de mutação de sessão, inferência, descoberta do serviço de trabalho,
leitura de banco interno ou instalação de dependência.

## Identidade e reprodução

- `/api/info` observado: `version = 2.2.5`. Somente esse campo é preservado;
  PID, hostname, URLs e caminhos retornados não são persistidos.
- CLI: `opencode v2.2.5`, registrado separadamente, não usado como prova da versão HTTP.
- SHA256 dos bytes de `/openapi.json`:
  `f5c4571bf7e9afc22a440875a746f593f988c4c31bf824f602601c04b20e6c8e`.
- `contracts-baseline.json` preserva subset de rotas, operation IDs e fechamento
  transitivo de schemas públicos; não contém o documento OpenAPI completo.
- Execute `bun test tests/contract/contracts.test.ts`. O teste sobe outra fixture,
  captura novamente e compara versão, hash, rotas e schemas; também consulta a
  publicação via HTTPS. Rede indisponível é falha explícita, não skip ou sucesso.
- `probeContracts()` é exportado em `scripts/probes/contracts.ts`, sem escrita nem
  logging implícitos. O integrador deve registrar `contracts` em `scripts/probe.ts`;
  este lote não modifica runner, package ou harness.

## T3–T8: inventário não é prova semântica

| Prova posterior | Subset registrado |
| --- | --- |
| T3 identidade/permissão | RPC, plugin, forms, permission; contextos in-process não são descritos pelo OpenAPI |
| T4 admissão/reconciliação | prompt, synthetic, inbox, wait, interrupt, eventos e log |
| T5 ciclo de vida/exclusão | create/get/update/delete, fork, agent/model/move/compact |
| T6 agenda | create/list/get/delete/pause/resume experimental |
| T7 contexto | export/import/context/message |
| T8 consumo | stats, Session.Info, TokenUsage e schemas transitivos |

Ausências explícitas: rotas nativas reset, reparent e delete-preview selecionadas
retornam `unsupported` pelo detector. Isso significa ausência **no contrato**,
não que uma chamada arbitrária foi executada ou que nenhuma alternativa existe.
`present` significa operation ID declarado, não capability funcional aprovada.

## Documentação publicada versus servido

Fontes oficiais consultadas: https://opencode.ai/v2/docs/api e
https://opencode.ai/v2/openapi.json. Context7 `/websites/opencode_ai/v2` consultado
sobre info, prompt/delivery/resume e exclusão; corroborou essas rotas, sem prova
de runtime. Hash e identidade da publicação estão no JSON, separados do servidor.
`info.version` do OpenAPI é versão do documento, não versão do processo.

Comparação estrutural: **66 operações**, nenhuma ausente entre os dois subsets;
**17 operações diferentes**, com os mesmos operation IDs. O JSON registra cada
diferença de operação por caminho estrutural e valores público/servido, além dos
nomes de schemas transitivos divergentes. Não normaliza diferenças silenciosamente.

- O servido inclui alternativas `null` adicionais em parâmetros de listagens,
  stats, export, log, interrupt, RPC e outros. Não concluir equivalência semântica
  de parâmetros HTTP a partir de diferenças de geração de schema.
- `session.compact` e `session.synthetic`: servido inclui
  `LocationNotFoundErrorEncoded` no 404; publicação só SessionNotFoundError.
- `Event.SeqEncoded`, schemas de eventos/forms e aliases diferem; consumidores
  devem usar o schema servido, não importar tipos publicados por suposição.
- A referência classifica a superfície HTTP/sessões como experimental.

## Gate de exclusão: NO-GO sem CAS/equivalente

`session.remove` declara exclusão da sessão **e filhas**; aceita somente
`sessionID` no path. Não declara body, revisão esperada, digest, seleção fechada,
If-Match ou resposta de conflito 409. Não há delete-preview no subset.
Logo o contrato não oferece prova de exclusão atômica do conjunto aprovado diante
de escritores externos. **LIF-09/10 permanecem NO-GO até T5 demonstrar equivalente
seguro ou revisão explícita de design.** Lock só do plugin não resolve essa lacuna.
Nenhuma exclusão de sessão foi realizada por T2.

`security: []` presente nas operações não dispensa autenticação: a captura usa o
request autenticado do harness. OpenAPI não prova identidade de sessão/RPC,
reconciliação idempotente, autorização, persistência da agenda ou CAS.
