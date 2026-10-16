# language: pt
# Cenários executados por mapeamento em runner local contra API mock de referência; não é execução Cucumber oficial nem teste do sistema real.
# CT08 teve smoke test complementar de 500 clientes por ~30 s no mock; o perfil de 10 min continua pendente e exige JMeter/k6 em ambiente autorizado.
Funcionalidade: Realizar pedido via APP
  Para comprar produtos da unidade escolhida
  Como cliente da Raízes do Nordeste
  Quero autenticar-me e realizar pedidos com segurança

  @autenticacao @positivo
  Cenário: CT01 - Login válido no APP
    Dado que existe um cliente cadastrado e ativo
    E que o cliente informa e-mail e senha corretos
    Quando o cliente solicita o login no APP
    Então o sistema deve autenticar o cliente
    E deve emitir um token de acesso válido
    E deve registrar o evento de autenticação sem expor a senha nos logs

  @pedido @pagamento @positivo
  Cenário: CT03 - Pedido concluído com pagamento aprovado
    Dado que o cliente está autenticado no APP
    E que a unidade selecionada está ativa
    E que os produtos escolhidos estão disponíveis no estoque da unidade
    E que o serviço de pagamento mock está configurado para aprovar a transação
    Quando o cliente confirma o pedido e solicita o pagamento
    Então o sistema deve registrar o pedido com um identificador único
    E deve registrar o pagamento como aprovado
    E deve atualizar o pedido para o status "em preparo"
    E deve manter unidade_id e correlation_id nos registros de auditoria

  @pagamento @negativo
  Cenário: CT04 - Pagamento negado não confirma o pedido
    Dado que o cliente está autenticado no APP
    E que os produtos escolhidos estão disponíveis no estoque da unidade
    E que o serviço de pagamento mock está configurado para negar a transação
    Quando o cliente confirma o pedido e solicita o pagamento
    Então o sistema deve informar que o pagamento não foi aprovado
    E o pedido não deve ser marcado como pago
    E o pedido não deve avançar para o status "em preparo"
    E a tentativa deve ser registrada para rastreabilidade sem armazenar dados sensíveis de pagamento

  @desempenho @carga
  Cenário: CT08 - Atendimento a 500 usuários simultâneos
    Dado que o ambiente de teste está configurado para simular 500 usuários virtuais
    E que o teste de carga terá duração de 10 minutos
    E que os fluxos de consulta de cardápio e realização de pedido estão preparados para teste
    Quando a ferramenta de carga executar as requisições simultâneas
    Então pelo menos 95 por cento das respostas devem ocorrer em menos de 2 segundos
    E a disponibilidade observada durante o teste deve ser de pelo menos 99,5 por cento
    E erros, tempos de resposta e taxa de requisições devem ser registrados no relatório
    # Limitação da evidência atual: smoke test local < 10 min; não substitui execução oficial em JMeter/k6 contra aplicação real.

  @seguranca @sql_injection @negativo
  Cenário: CT10 - Tentativa de SQL Injection no login
    Dado que o cliente está na tela de login do APP
    E que o campo de e-mail recebe o texto "' OR 1=1--"
    E que a senha informada é inválida
    Quando o cliente envia o formulário de login
    Então o sistema deve recusar a autenticação
    E não deve emitir token de acesso
    E não deve revelar detalhes internos do banco de dados na resposta
    E deve registrar o evento de segurança sem incluir credenciais ou outros dados sensíveis no log
