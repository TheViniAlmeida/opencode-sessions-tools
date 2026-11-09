# T7 — Portabilidade (baseline 2.2.5)

## Evidência viva — 07/11/2026

Executado em servidor loopback descartável `opencode v2.2.5`, exclusivamente
com fixtures próprias; `finally` encerra e limpa o harness. Nenhum servidor de
trabalho usado. Harness estendido pelo integrador, não por esta subtarefa.

`bun test tests/contract/portability.test.ts`: **6 pass, 0 fail, 37 assertions**,
incluindo um teste vivo e cinco testes locais/simulados. Observado no host:

- Pai e filho: POST 200; IDs confirmados por `data.id`; export 200 preserva
  mensagens e `parentID`. O host reescreve `/info/location/directory` para seu
  diretório ativo, `/info/projectID` e `/info/time/updated`. A localização em
  `info` não seleciona o destino efetivo neste import.
- Export nativo reimportado com novos IDs próprios: POST/export 200; somente
  `/info/time/updated` difere nessa segunda projeção.
- Colisão real: 409; export antes/depois idêntico, sem alteração observada.
- Pai ausente: 404; export do órfão também 404.
- Mensagem sem ID/time: 400; export desse ID 404. Evidência restrita ao erro
  de validação exercitado, não prova rollback de falhas internas.
- `sanitize=true`: diferenças exatas em `/info/location/directory`,
  `/info/title`, `/messages/0/text`, substituídos por marcadores redacted.
  IDs, tokens e custo permaneceram. Não é anonimização universal comprovada.
- Falha parcial **injetada no cliente**: após pai conhecido, filho realmente
  importado com 200, mas wrapper consome a resposta e lança erro. O ledger
  retorna `unknown_outcome` e mantém ID candidato incerto; repetição da chave
  mantém **1 POST**. GET/export reconcilia com 200 e confirma o ID incerto.
  Não é falha interna real do host nem prova atomicidade entre sessões.

O entrypoint `bun scripts/probes/portability.ts` executa casos vivos e retorna
`observed`, não uma certificação dos requisitos de produto. Exibe apenas fixtures
sintéticas e diferenças, nunca headers, credenciais ou erros de transporte.

## Contrato e correções de premissas

O snapshot T2 (`contracts-baseline.json`, `served.paths` e `served.schemas`) contém:

- `POST /api/experimental/session/import`: corpo `{info, messages, location?}`;
  sucesso `{data: Session.Info}`, portanto ID em `data.id`.
- `GET /api/experimental/session/{sessionID}/export`: retorno
  `{data: SessionTransfer.Data}`; parâmetro `sanitize=true|false`.
- Pai deve existir; importar pais antes de filhos. Colisão não confirma criação
  anterior pela mesma operação: exige reconciliação e journal próprio.
- `SessionTransfer.Data` contém `info` e `messages`, sem versão/hash.
  `Session.Info` admite `permissions`: não usar conteúdo importado como grants.

Presença no schema NÃO prova atomicidade, rollback ou idempotência.
`security: []` não prova acesso sem autenticação. O bloqueio inicial era GET-only
no harness; foi resolvido pelo integrador com request method/body autenticado.

## Envelope candidato — somente lado plugin

Os testes locais exercitam rejeição pré-request de hash/versão/tamanho
adulterados e grants, classificação de respostas ambíguas e retenção de IDs.
Limite de 10 MiB medido em bytes UTF-8 do envelope antes de requests. Hash
SHA-256 dos bytes UTF-8 de `payload` detecta corrupção, não autentica origem.
Allowlist restrita à fixture, não importador geral ou serviço implementado.

## Não provado / requisitos ainda abertos

- CTX-01..04: serviço do plugin, autorização de histórico, seleção do conteúdo,
  envelope definitivo, destino explícito e prevenção geral de grants.
- CTX-07/08: journal persistente e recuperação após restart. Ledger atual vive
  somente em memória; reutilização de chave com outro pacote ainda exige
  rejeição no produto. Não repetir POST automaticamente após resultado incerto.
- Falha interna real após escrita, rollback e atomicidade host: NÃO VALIDADOS.
  400/404 sem sessão observável não comprovam ausência de qualquer outro efeito.
- Mensagens não assentadas, estado native/provider e sanitização de todos os
  tipos de partes: NÃO VALIDADOS. Fixture cobre mensagem synthetic assentada.
- Transcrito não transporta estado de arquivos, processos/PTYs, credenciais
  ou grants externos. Projeção não equivale a clone completo do ambiente.

## Fontes

- Snapshot servido T2 da versão 2.2.5 e execução viva descrita acima.
- https://opencode.ai/v2/docs/api (consulta em 07/11/2026).
- Context7 `/anomalyco/opencode`: `session/transfer.ts`, schema
  `session-transfer.ts` e CLI `session/import.ts`, branch dev. Corrobora
  conflito, pai preexistente e `data.id`, mas não prova versão instalada.
