# Pesquisa: gestão de sessões no OpenCode V2

Consulta em **06/11/2026**, fuso America/Belem. Escopo: documentação e
contratos publicados, sem implementação ou teste de sessões. Este documento
subsidia decisões, especificação e fase 0; não constitui prova de funcionamento.

## Resultado principal

A documentação V2 atual sustenta um **plugin de servidor nativo**: registro de
ferramentas, contexto da chamada, permissões por ação/recurso, sessões,
armazenamento e eventos. Um servidor MCP separado não é pré-requisito.

O contrato publicado já contém criação com `parentID`, atualização de título e
arquivamento, permissões de sessão e agendamentos experimentais. As premissas
contrárias das referências anteriores estão superadas **para a documentação
publicada**, mas a compatibilidade dessas capacidades com o servidor local
continua pendente.

### Camadas de evidência

| Camada | Evidência nesta pesquisa | Limite |
|---|---|---|
| CLI local | `opencode --version` executado: `opencode v2.2.5` | Não identifica a versão de um servidor remoto ou já iniciado; não prova API/plugin compatível. |
| Documentação oficial V2 | Páginas de plugins, servidor, RPC, API e OpenAPI lidas em 06/11/2026 | Documentação contínua, não um snapshot explicitamente vinculado a 2.2.5. |
| OpenAPI publicada | `info.title = opencode HttpApi`, `info.version = 0.0.1` | `0.0.1` é versão do documento, não versão do binário. |
| Context7 | `/websites/opencode_ai/v2`, consulta sobre sessões, ferramentas e permissões | Corrobora `parentID`; trouxe também exemplos divergentes. Não prevalece sobre OpenAPI/página atual. |
| Servidor local | Não consultado | `/api/info`, `/openapi.json`, carregamento do plugin e chamadas reais: **NÃO VALIDADO**. |
| Repositórios externos | README e commit mais recente da branch padrão consultados pela API GitHub | Declarações dos projetos, sem auditoria do código ou execução. |

Não executar `opencode api` indiscriminadamente nesta etapa: a descoberta pode
iniciar o serviço. A fase 0 deve usar uma instância de teste explicitamente
autorizada e seu contexto de autenticação.

## Fontes oficiais

Todas as URLs abaixo foram consultadas em **06/11/2026**:

| ID | Fonte | URL |
|---|---|---|
| S1 | Índice V2 | https://opencode.ai/v2/llms.txt |
| S2 | Estrutura e carregamento de plugins | https://opencode.ai/v2/docs/build/plugins |
| S3 | Plugin de servidor: ferramentas, permissões, sessões, eventos e storage | https://opencode.ai/v2/docs/build/plugins/server |
| S4 | Contrato RPC de plugins | https://opencode.ai/v2/docs/build/plugins/rpc |
| S5 | Referência HTTP | https://opencode.ai/v2/docs/api |
| S6 | Contrato OpenAPI publicado, lido e filtrado programaticamente | https://opencode.ai/v2/openapi.json |

As referências de outros produtos fornecidas ao projeto serviram para extrair
conceitos: descoberta, identidade confiável, correlação de pedidos, separação
entre entrega e execução, limites de autoridade e recuperação após desconexão.
Elas não especificam o contrato OpenCode e seus dados pessoais não são
reproduzidos aqui.

## Matriz de capacidades

Legenda: **documentado** significa presente na fonte consultada, não testado.
**Experimental** não se limita ao prefixo da URL: S5/S6 descrevem a superfície
HTTP como experimental e o grupo de sessões como “Experimental session routes”.
Não há base para anunciar estabilidade semântica de todas as rotas `/api/session`.
As APIs comuns de plugins aparecem sem rótulo experimental em S3, o que também
não é garantia de compatibilidade entre versões.

| Capacidade | Contrato publicado | Classificação e restrição | Fonte |
|---|---|---|---|
| Registrar ferramentas | `Plugin.define({ id, setup })`, `ctx.tool.transform`, `editor.add` | Documentado no plugin nativo; não depende de MCP. Nome efetivo inclui namespace normalizado. | S2, S3 |
| Identificar chamador da ferramenta | Executor recebe contexto; exemplo de permissão usa `context.sessionID`, `context.agent`, `context.messageID`, `context.id` | Identidade vem do runtime; não aceitar `caller_session_id` do argumento como autoridade. Provar disponibilidade no pacote instalado. | S3 |
| Expor métodos externos | `Rpc.define`, `ctx.rpc.register`, `client.rpc`; `POST /api/rpc/{rpcID}/{method}` | RPC é outra entrada. Contexto documentado do handler oferece `signal` e `error`, não identidade autenticada de uma sessão chamadora. | S4, S6 |
| Listar sessões | `GET /api/session`: `limit`, `order`, `search`, `parentID`, `archived`, `directory`, `project`, `subpath`, `cursor` | Cursor mantém filtros; padrão de 50 mais recentes. `parentID=null` filtra raízes. Busca textual no corpo do histórico não está comprovada. | S3, S6 |
| Consultar estado | `GET /api/session/{sessionID}`, `GET /api/session/active` | `Session.Info` inclui `outcome`, tempos, modelo/agente, tokens e custo; ausência em active não basta para concluir tarefa. | S5, S6 |
| Criar raiz/filha | `POST /api/session`: `id`, `parentID`, `title`, `agent`, `model`, `location`, `metadata`, `permissions` | `parentID` cria filha vinculada na localização da mãe. Não pressupor diretório independente com essa mesma chamada. | S6 |
| Fork | `POST /api/session/{sessionID}/fork`, `before` opcional | Copia histórico projetado anterior à mensagem; omitir copia tudo. Não cria isolamento de filesystem por si só. | S6 |
| Renomear e arquivar | `PATCH /api/session/{sessionID}`: `title`, `metadata`, `permissions`, `archived` | `archived=true/false`; repetir estado é no-op. `time.archived` é leitura, não o payload de atualização. Resposta 204. | S6 |
| Trocar agente | `POST /api/session/{sessionID}/agent`, `{ agent }`; `ctx.session.switchAgent` | Afeta turnos posteriores do provedor. Não equivale a mencionar agente no prompt. | S3, S6 |
| Trocar modelo/esforço | `POST /api/session/{sessionID}/model`, `{ model }`; `Model.Ref={providerID,id,variant?}` | Não inventar campo `effort` nessa rota. Resolver variante no catálogo; ordenação de custo/capacidade não é universal. | S3, S6 |
| Permissões da sessão | Create/update aceitam `Permission.Ruleset`; `ctx.permission.assert` avalia ação e recursos | Regras de sessão são avaliadas após as do agente; última regra correspondente vence. Filhas herdam regras em vigor na criação. Isso não prova teto anti-escalada permanente. | S3, S6 |
| Permissões pendentes | List/get/reply sob `/api/session/{sessionID}/permission`; reply `once`, `always`, `reject` | Superfície experimental. Aprovar automaticamente pelo coordenador não é consequência da existência da API. | S3, S5, S6 |
| Enviar trabalho | `POST /api/session/{sessionID}/prompt`: `text` obrigatório, `id`, anexos, `metadata`, `delivery`, `resume` | Retorna `Session.Inbox.User` admitido, não a resposta final do modelo. | S3, S6 |
| Fila e steering | `delivery: "queue" \| "steer"` | São políticas de entrega, não recibos “queued/delivered”. Hook de prompt tem `steer` como padrão. Fronteiras precisas devem ser testadas. | S3, S6 |
| Depositar sem iniciar loop | `resume:false` em prompt ou synthetic | Desabilita o agendamento do loop por essa admissão; não prova que uma execução já ativa não consumirá a entrada. | S6 |
| Mensagem sintética | `POST /api/session/{sessionID}/synthetic`: `text`, `description`, `metadata`, `delivery`, `resume`, `id` | Admissão durável; não passa pelo hook de prompt. Não tratar esse hook como barreira universal de autorização. | S3, S6 |
| Interromper | `POST /api/session/{sessionID}/interrupt`, query `resume` | Atua em execução pertencente ao processo; retorna `interrupted`. Com resume true, steering/controles podem continuar, prompts enfileirados ficam estacionados. | S6 |
| Esperar | `POST /api/experimental/session/{sessionID}/wait` | Espera loop ocioso; 204 não é atestado de sucesso da tarefa nem resposta correlacionada. | S6 |
| Ler conversa/contexto | `GET /api/session/{sessionID}/message`, `/context`, `/message/{messageID}` | Histórico projetado e contexto são visões diferentes; não prometer transcrito integral a partir do contexto. | S3, S5 |
| Eventos ao vivo | `GET /api/event`, `ctx.event.subscribe` | Abrange todas as localizações; volátil, perde eventos na desconexão e pode falhar por consumidor lento. Filtrar escopo explicitamente. | S3, S6 |
| Recuperar eventos | `GET /api/experimental/session/{sessionID}/log?after=...&follow=...` | Log durável; `after` é sequência agregada exclusiva; `follow=true` continua ao vivo. Não confundir com eventos RPC voláteis. | S4, S6 |
| Exportar/importar | `GET /api/experimental/session/{sessionID}/export`; `POST /api/experimental/session/import` | Transcrito projetado; export aceita `sanitize`. Import aceita `info`, `messages`, `location`; pais precisam existir antes das filhas; conflito 409 previsto. Não é backup completo do host. | S6 |
| Estatísticas | `GET /api/experimental/session/stats` | Agrega por intervalo/projeto/fuso, `tools=none/summary/detail`; sessões, subagentes, prompts, passos, tokens, custo, atividade e modelos. Não é medidor garantido da janela atual nem orçamento rígido. | S6 |
| Agendamento | `/api/experimental/schedule`, get/delete por ID, pause/resume | Exige `experimental.schedules` na configuração da sessão. `when` admite `in`, `at`, `every`, `cron`, com `tz`. Não anunciar disponibilidade por padrão. | S6 |
| Condições de agenda | `if`, `until`, `ends`; condições shell ou Code Mode | Condição pode executar código: não é mero temporizador. Code Mode documenta autorização na criação para execução unattended; políticas precisam cobrir isso. | S6 |
| Mover sessão | `POST /api/session/{sessionID}/move`: `directory`, `delivery` | Muda diretório na fronteira de entrega. Não é migração entre hosts, nem API documentada de reparent/detach. | S6 |
| Excluir | `DELETE /api/session/{sessionID}`, `ctx.session.remove` | Interrompe execução e exclui recursivamente filhas. Não equiparar à cascata de outro produto. | S3, S6 |
| Persistência do plugin | `ctx.storage.get/set/remove/scan` | JSON durável por plugin. Sem contrato transacional/CAS demonstrado nessa documentação; não presumir exclusão mútua entre instâncias. | S3 |

## Identidade e fronteira de autoridade

A entrada por ferramenta e a entrada por RPC não devem compartilhar uma
suposição implícita de identidade:

- **Ferramenta:** extrair origem do contexto fornecido ao executor. Resolver
  sessão/localização e política no servidor antes da operação. Texto, metadata
  ou argumentos do modelo não comprovam autoria humana.
- **RPC externo:** autenticar o cliente não comprova qual sessão o originou.
  A documentação não promete `sessionID` autenticado no contexto RPC. Exigir um
  mecanismo verificável próprio ou restringir a superfície externa; não
  promover um campo `source` a identidade confiável.
- **Localização:** `ctx.location` descreve a instância do plugin, não todos os
  eventos/sessões alcançados por ela. O stream e clientes externos podem observar
  mais de uma localização; isolamento precisa ser aplicado antes de retornar
  títulos, histórico, custo ou resultados.
- **Permissão:** `assert` usa ação/recursos e pode resolver por regra allow ou
  aprovação salva. “Sempre perguntar” exige mais que chamar assert com uma ação
  já liberada. Definir e provar o mecanismo de consentimento pretendido.
- **Parentesco:** `parentID` modela vínculo, não delegação irrestrita de autoridade.
  Políticas como teto de modelos, proibição de autoalteração e orçamento de
  família continuam requisitos do produto, não garantias demonstradas do core.

## Correções das premissas anteriores

| Premissa a retirar ou restringir | Conclusão apoiada nas fontes atuais |
|---|---|
| “Plugin V2 não registra ferramentas nem observa eventos; precisa de MCP.” | S3 documenta `ctx.tool.transform`, `ctx.event.subscribe` e hooks. Tipos de pacote antigo não estabelecem limite da V2 publicada. |
| “Create V2 não aceita parentID.” | S6 aceita `parentID` e descreve vínculo e localização herdada. Compatibilidade 2.2.5 ainda deve ser medida. |
| “Não há renomeação/arquivamento documentado.” | PATCH contém `title` e `archived`; não usar `time.archived` como entrada. |
| “Permissão só casa o nome da ferramenta.” | `ctx.permission.assert` recebe `action`, `resources`, `save`, metadata e origem da chamada. Ferramentas separadas por risco são uma escolha, não limitação inevitável. |
| “queue/steer significa enfileirado/entregue.” | São políticas de admissão/entrega. Retorno de prompt é item de inbox; conclusão é outro fato. |
| “Resume false é equivalente comprovado a mensagem invisível/noReply.” | Só está demonstrado que não agenda execução por essa chamada. Visibilidade e consumo durante execução precisam de prova. |
| “GET /api/session/{id}/wait e /history são as rotas atuais.” | O wait publicado é POST em `/api/experimental/session/{sessionID}/wait`; recuperação usa mensagens/contexto/log documentados. |
| “Todo stream é live-only, sem replay disponível.” | `/api/event` e eventos RPC são voláteis; `/api/experimental/session/{sessionID}/log` é durável e admite `after`. |
| “Não existe agendador interno.” | Há API experimental, condicionada a flag. Durabilidade após reinício, atrasos e execução com alvo ocupado continuam a provar. |
| “Usar /session, prompt_async, abort e /doc como contrato V2.” | Esses caminhos da referência antiga não são a base atual: usar S6 e o OpenAPI do servidor alvo. |
| “Arquivar a mãe limpa worktree; excluir só arquiva filhas.” | Não transferir semântica de outro aplicativo. Exclusão OpenCode documenta exclusão recursiva das filhas; efeitos completos de archive devem ser testados. |
| “Metadados/envelope fornecem origem incontestável.” | Conteúdo pode ser forjado; autenticação de proveniência precisa vir do canal/contexto e do registro controlado pelo servidor. |

O Context7 confirmou create com `parentID`, mas retornou também exemplos com
`interrupt({ continue:false })`, command com `command/arguments` e move
“to another project directory or parent”. S3/S6 atuais usam `resume`,
`name/text` no exemplo de command e `directory/delivery` em move.
Logo, nem a seleção de uma biblioteca V2 elimina divergências de indexação.

## Referências de projetos existentes

READMEs consultados em **06/11/2026** pela API GitHub. Os SHAs abaixo são os
commits mais recentes retornados pela API da branch padrão na mesma consulta;
não são certificação de release, compatibilidade ou segurança. Nenhum código
foi copiado, instalado ou executado.

| Projeto e commit observado | O que aproveitar conceitualmente | Limites relevantes |
|---|---|---|
| [divisionseven/opencode-mesh](https://github.com/divisionseven/opencode-mesh), [d75b9a99eecb8d2e26c9681ca31debcbac217ce5](https://github.com/divisionseven/opencode-mesh/commit/d75b9a99eecb8d2e26c9681ca31debcbac217ce5), 13/10/2026 UTC | Descoberta, recibos, outbox, validade e dead-letter; distinguir admissão de entrega. | README declara últimos testes 1.18.35 e 2.0.26. “No loops” no resumo convive com claimer a cada 2 s na arquitetura; baseia descoberta também em SQLite/heartbeat. Não adotar escrita/leitura de banco interno como contrato V2. Trecho lido: primeiros 20 mil caracteres. |
| [5739n4/opencode-session-tools](https://github.com/5739n4/opencode-session-tools), [ff9d254a88cee051b8365fd76cebffa7992b2f7d](https://github.com/5739n4/opencode-session-tools/commit/ff9d254a88cee051b8365fd76cebffa7992b2f7d), 01/05/2026 UTC | Recorte pequeno: sessão atual e renomeação. | README só anuncia `session_current` e `session_rename`, com config `plugin` singular. Não comprova API nativa V2 nem gestão completa de famílias. Nome npm é próximo ao deste projeto: evitar confusão na publicação. |
| [hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble), [e984b5f1c90ccfc62d09ed12b30adb71854e2b75](https://github.com/hueyexe/opencode-ensemble/commit/e984b5f1c90ccfc62d09ed12b30adb71854e2b75), 19/10/2026 UTC | Equipes, dependências, claim atômico, recuperação, mensagens e contexto após compactação. | README mistura suporte V1/V2 e menciona `promptAsync`; merge automático, dashboard e cleanup expandem escopo e risco. Primeiro trecho de 20 mil caracteres consultado, não auditoria integral. |
| [panwar-stack/opencode-agent-team](https://github.com/panwar-stack/opencode-agent-team), [89f9a9cb2047e45ecbaa297397b5b412af3823a3](https://github.com/panwar-stack/opencode-agent-team/commit/89f9a9cb2047e45ecbaa297397b5b412af3823a3), 05/05/2026 UTC | Caixa de mensagens, aprovação de plano e grafo de tarefas. | Usa nomenclatura de hooks antigos e `noReply`; lista limitações de TUI/rotas que não estabelecem limites atuais de V2/RPC. Persistência JSON com mutex descrito não prova coordenação multiprocesso. |
| [co-l/opencode-tools](https://github.com/co-l/opencode-tools), [d7a56eaf6b00fe40ba21875f1750ea6dbe840eaf](https://github.com/co-l/opencode-tools/commit/d7a56eaf6b00fe40ba21875f1750ea6dbe840eaf), 28/02/2026 UTC | Exibição de tempo e tokens pelo utilitário timer. | README raiz não oferece gerenciador de sessões, mensageria ou prova de suporte V2. Não inferir algoritmo de medição sem examinar timer. |

## Riscos e provas necessárias na fase 0

Todos os itens abaixo estão **NÃO VALIDADOS** nesta pesquisa. Executá-los exige
escopo de teste autorizado, sem sessões de trabalho reais ou dados pessoais.

| Prova | Evidência/critério esperado | Decisão que desbloqueia |
|---|---|---|
| Contrato da instalação | Registrar versão do CLI, `/api/info`, hash do `/openapi.json` servido e versões efetivas de `@opencode/plugin`/cliente; comparar operações e schemas utilizados. | Baseline suportada; não inferir API pelo número 2.2.5. |
| Plugin mínimo | Carregar ferramenta em ambiente isolado e observar contexto real da chamada, cancelamento e reload, sem registrar prompts completos. | Plugin nativo viável; origem verificável e cleanup. |
| RPC e origem | Tentar chamadas com sessão inventada, sessão de outra localização e caller ausente; impedir impersonação e acesso fora do escopo. | Exposição externa segura ou restrição explícita. |
| Parentesco e localização | Criar raiz/filha de teste; conferir parentID e localização; observar herança de agente/modelo/permissões, fork e tentativa de diretório divergente. | Uso do parentesco nativo versus metadados complementares. |
| Permissões | Matriz allow/ask/deny, aprovações salvas, agente trocado, regras da filha e alterações posteriores da mãe; recusa unattended quando exigido pelo produto. | Política de autoridade sem escalada por outra sessão. |
| Admissão e correlação | Mesmo message ID repetido e concorrente; timeout após aceite; verificar uma admissão e nenhum reenvio cego. Correlacionar inbox, execução e resposta. | Garantia real de idempotência e estados do pedido. |
| Fila/steering/resume | Alvo idle/busy/aguardando permissão, queue/steer e resume false; interromper ferramenta longa e verificar o que de fato foi cancelado. | Semântica de envio e depósito sem despertar. |
| Recuperação | Desconectar stream, consumir log com sequência exclusiva, reiniciar instância isolada e reconciliar; verificar sequência e ausência de duplicação. | Observação durável sem prometer replay do canal volátil. |
| Arquivamento e exclusão | Ensaiar archive/unarchive com alvo ocupado; exclusão somente de família descartável, com autorização própria e verificação de cascata. | Ciclo de vida sem perda de trabalho ou interpretação importada de outro produto. |
| Agenda | Flag ausente/presente; fuso explícito; pausa/resume; disparo atrasado; reinício; alvo ocupado/arquivado; limites e condições shell/Code Mode autorizadas. | Usar agenda nativa ou adiar recurso; não prometer durabilidade/jitter sem prova. |
| Export/import | Round-trip em fixtures sintéticas, pais antes de filhas, conflito de ID, anexos e sanitização; comparar projeção e metadados. | Portabilidade do transcrito, sem alegar backup completo. |
| Estatísticas e orçamento | Comparar tokens/custo de fixtures com agregação; intervalo/fuso, cache, ausência de preços e execução concorrente. | Métricas descritivas e eventual orçamento próprio confiável. |
| Persistência e concorrência | Reload/duas localizações concorrentes sobre registro do plugin; falha entre criar sessão e gravar vínculo; recuperação sem duplicação. | Necessidade de storage transacional próprio, sem decidir por hábito. |

### Orientação para a especificação

1. Definir capacidades do plugin por versão detectada; recurso ausente deve
   produzir erro explícito, sem fallback silencioso para API V1.
2. Separar estados de admissão, entrega, execução e conclusão do pedido.
   `idle` e HTTP 2xx não comprovam êxito da tarefa.
3. Preferir primitivas nativas comprovadas; acrescentar correlação, autorização,
   limites de despertar e persistência somente onde o contrato não atende.
4. Tratar agendamento, export/import, log e stats como capacidades condicionais;
   preservar a classificação experimental na interface e nos testes.
5. Manter o primeiro escopo em uma instância autorizada. Multi-host, isolamento
   por worktree, UI própria e integração Git são problemas adicionais, não
   consequências automáticas de criar outra sessão.

## Verificação desta entrega

- Fontes oficiais V2 e Context7 consultados; OpenAPI pública inspecionada.
- READMEs dos cinco projetos e seus commits de referência recuperados.
- Única verificação do executável: `opencode --version` → `opencode v2.2.5`.
- Nenhuma sessão criada, modificada, exportada, importada ou executada.
- Nenhum agendamento criado; nenhum serviço iniciado para teste.
- Compatibilidade de runtime e semântica operacional permanecem na fase 0.
