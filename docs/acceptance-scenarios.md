# Cenários de aceite do núcleo

Roteiros para a implementação futura. Nenhum foi executado nesta etapa documental.
Executar apenas em instância isolada com sessões sintéticas; os nomes de comandos
são contratos propostos, não instruções de instalação de um produto existente.

## 1. Trabalho e retorno no mesmo projeto

1. Criar sessões A e B no projeto X.
2. A identifica seu ID e lista B sem receber histórico.
3. Operador concede `task.dispatch` de A para B e capacidade necessária ao retorno.
4. A envia tarefa com chave idempotente e correlação.
5. B retorna resultado final correlacionado.
6. A recebe atualização e lê o resultado autorizado.
7. Repetir a chamada com a mesma chave: mesma operação, sem outra execução.

Aceite: admissão, execução e conclusão são distinguíveis; um evento idle não
conclui a tarefa. Referências: SES-01/02, MSG-03/04/05, TSK-05.

## 2. Outra sessão/projeto exige concessão explícita

1. Criar C no projeto Y.
2. A tenta descobrir/ler C: `not_found`, sem vazamento de título.
3. A solicita acesso: pedido aparece para o operador, acesso permanece negado.
4. Operador executa link direcional A→C apenas com `message`.
5. A envia mensagem; leitura integral e configuração continuam negadas.
6. Operador revoga vínculo; uma mensagem ainda pendente é rejeitada.

Aceite: vínculo não concede acesso inverso, não libera histórico e não promove
mensagem de agente a aprovação. Referências: ACL-01..11.

## 3. Reinício após envio incerto

1. Injetar perda de resposta depois que o host pode ter admitido o prompt.
2. Reiniciar a instância de teste.
3. Consultar a operação: `unknown_outcome` até reconciliação comprovável.
4. Repetir a chave: mesma operação, sem reenvio cego.

Aceite: recuperação prefere estado incerto explícito a duplicar trabalho.
Referências: MSG-06, REL-01/02.

## 4. Job de cinco minutos

1. Configurar intervalo de 300 segundos e limite de execuções.
2. Fazer uma execução durar mais que o intervalo.
3. Verificar no máximo uma pendência coalescida.
4. Desligar a instância de teste por vários vencimentos e reiniciar.
5. Observar registro dos vencimentos perdidos e no máximo uma recuperação.
6. Revogar a capacidade do destino; próximo disparo não é admitido.

Aceite: sem drift por duração, sem avalanche após reinício, sem privilégio retido
por job antigo. Referências: SCH-01..10.

## 5. Exclusão e importação seguras

1. Preparar exclusão de mãe e filha descartáveis.
2. Adicionar descendente entre preview e confirmação.
3. Confirmar token antigo: recusa, nenhum ID novo é excluído.
4. Importar fixture com falha parcial e repetir a chave.
5. Comparar IDs conhecidos: nenhum destino duplicado por retry automático.

Aceite: a prova de exclusão cobre escritores externos ao plugin. Se não há
primitiva nativa suficiente, o gate de compatibilidade falha; não simular garantia
com lock local. Referências: LIF-08..10, CTX-07/08.

## 6. Consumo e interfaces equivalentes

1. Associar a mesma sessão a dois grupos.
2. Solicitar total conjunto: sessão contada uma vez.
3. Omitir preço no fixture: custo nulo, sem zero inventado.
4. Executar chamada autorizada pela ferramenta e pela API externa autenticada.
5. Comparar resultados e erros de domínio.
6. Desconectar consumidor de eventos e retomar pelo cursor persistido.

Aceite: API não ignora autorização, eventos não vazam escopo e qualidade do custo
é explícita. Referências: API-01..06, API-11.
