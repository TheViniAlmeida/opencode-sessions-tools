# Contribuição

O projeto está em especificação. A revisão atual trata de contratos e planejamento;
não existe pacote instalável, configuração de testes ou API implementada.

## Antes de implementar

1. Ler [decisões](.specs/features/session-orchestration/context.md) e
   [spec](.specs/features/session-orchestration/spec.md).
2. Consultar a pesquisa para separar API documentada de capacidade provada.
3. Seguir dependências e gates do plano aprovado; alterações de escopo voltam à spec.
4. Anexar testes derivados dos critérios, sem substituir resultado esperado pelo
   comportamento que a implementação acabou produzindo.

## Paralelismo

Frentes independentes possuem escopos de arquivos separados. Contratos, banco,
entrypoint e arquivos de lock têm um integrador responsável. Nenhum worker deve
relaxar autorização ou alterar contrato compartilhado para fazer seu teste passar.
Revisão independente é obrigatória nos pontos de integração.

## Evidências e publicação

Documentar versão, comando e resultado observado. Não tratar testes de estrutura
Markdown como testes do software. Não incluir credenciais, transcritos reais ou
dados pessoais em fixtures e exemplos.

A política de [licença](docs/licensing-policy.md) permite contribuições abertas,
mas seu instrumento final e os termos de contribuição precisam ser aprovados
antes da distribuição de código. Não inserir licença incompatível por conveniência.

Mudanças entram por branch e PR; mensagens Conventional Commits curtas e sem
atribuição de ferramenta. A aprovação técnica da documentação não autoriza
publicação de uma versão funcional ainda não testada.
