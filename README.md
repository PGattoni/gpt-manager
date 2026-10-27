# GPT Manager

GPT Manager é uma personalização do [AI Chat Bulk Manager original](https://github.com/learnerLj/ai-chat-bulk-manager), de Luo Jiahao (MIT), com alterações para organização de conversas do ChatGPT.

## Instalar

**Página permanente de instalação:** https://pgattoni.github.io/gpt-manager/instalar.html


Abra **https://pgattoni.github.io/gpt-manager/instalar.html** e clique em **Instalar ou atualizar no Tampermonkey**.

- Script: [gpt-manager.user.js](https://pgattoni.github.io/gpt-manager/gpt-manager.user.js)
- Metadados para atualização: [gpt-manager.meta.js](https://pgattoni.github.io/gpt-manager/gpt-manager.meta.js)
- Código em TXT: [gpt-manager.txt](https://pgattoni.github.io/gpt-manager/gpt-manager.txt)

## Versão publicada

**v0.13.0:** conexão à conta Google por página auxiliar OAuth, cópia e sincronização em `appDataFolder`, união inicial de registros, importação/exportação JSON e sincronização automática opcional.

## Atualização após a renomeação do repositório

O repositório foi renomeado de `aicbm` para `gpt-manager`. O novo endereço oficial é **https://pgattoni.github.io/gpt-manager/**.

As cópias legadas `aicbm.user.js`, `aicbm.meta.js` e `aicbm.txt` permanecem disponíveis dentro **deste repositório** no novo endereço, mas os links do domínio Pages antigo não têm redirecionamento garantido. Quem instalou o script pelo antigo endereço deverá reinstalá-lo pelo novo, desativando a cópia anterior no Tampermonkey.

## Atenção

- Mantenha apenas uma versão do script habilitada no Tampermonkey.
- Este código executa ações de arquivar e excluir na conta, inclusive em lote. Revise suas seleções.
- Tags, cores e proteções podem ser sincronizadas manualmente com Google Drive em uma pasta privada de dados do aplicativo. A sincronização automática é opcional.
- Agrupamento por IA e sincronização são funcionalidades planejadas, não publicadas.
- O código do script é público. Não publique dados privados, tokens ou exportações de conversas neste repositório.

## Créditos

Script original: **Luo Jiahao**, licença MIT. Consulte o [repositório do projeto original](https://github.com/learnerLj/ai-chat-bulk-manager) para os termos e arquivos originais.

## Google Drive

1. Instale o script e abra o ChatGPT.
2. Na barra lateral, clique em **Drive**.
3. Clique em **Conectar Google**. Na janela da página GitHub Pages, clique em **Autorizar Google Drive**.
4. Clique em **Sincronizar agora**. O aplicativo primeiro combina os registros locais e remotos, preservando tags e proteções dos registros antigos.
5. Opcionalmente, habilite sincronização automática. A autorização Google é temporária e pode expirar.

As configurações ficam em `appDataFolder` como `gpt-manager-settings-v1.json`. Não são armazenadas mensagens, conteúdo de anexos, segredo OAuth ou senhas. O cliente OAuth é público e funciona somente nas origens JavaScript autorizadas na Google Cloud. Reinstale o script caso o antigo ainda esteja ativo.

## Grupos na versão 0.11.0

A seção **Grupos** aparece logo abaixo de Explorar. Clique em **+** para criar um grupo e use **⋯** para abrir a janela única de nome, cor e exclusão. A paleta inclui cores claras e um seletor personalizado. Para associar uma conversa, abra seu menu **⋯ > Tags e cor**, marque os grupos e salve. Uma conversa pode pertencer a vários grupos sem duplicar ou mover seu conteúdo. O Google Drive sincroniza também grupos e associações. O backup JSON inclui esses dados.

A IA para sugerir grupos e tags está planejada para a próxima etapa; não está incluída nesta versão. Faça backup JSON antes de atualizar.

### Interface v0.13.0

O título **Grupos** acompanha a tipografia e o alinhamento da seção nativa **Fixados**. O cabeçalho não exibe contagem e não há frase de ajuda quando a lista está vazia. Criação e edição usam uma janela integrada, com campo de nome e paleta visual de cores. A exclusão exige confirmação no mesmo diálogo e não elimina conversas.

### Correção v0.13.0

A caixa de ferramentas e a organização de Explorar funcionam mesmo quando **Recentes** está recolhido. Links da seção **Grupos** não são confundidos com os links nativos do histórico ao escolher o ponto de inserção do painel.

## Interface unificada v0.13.0

Redesenho visual do GPT Manager inspirado no protótipo discutido, adaptado à barra lateral existente do ChatGPT. Ferramentas ganham cabeçalho recolhível e controles padronizados, filtros em chips e ações consistentes. Grupos, diálogos de tags/cores, Drive e menus próprios usam o mesmo sistema de cor, borda e espaçamento.

**Correção do painel rolante:** sempre que possível, a caixa de ferramentas é montada depois da linha fixa de Novo chat, fora do contêiner com rolagem do histórico. Nas variantes de DOM que não exponham essa linha, utiliza posicionamento aderente (sticky). Se o ChatGPT alterar a estrutura de navegação, o comportamento deve ser revalidado no navegador.

As ferramentas permanecem funcionais mesmo recolhidas. As seções nativas de ChatGPT não são substituídas e nenhum dado de conversas é enviado adicionalmente ao Drive.

### Refinamento v0.13.0

A caixa de ferramentas também verifica se a linha de **Novo chat** está em um layout horizontal; nesse caso é inserida abaixo do contêiner de ícones, evitando disputar largura com os botões nativos. As ações **Arquivar**, **Excluir** e **Parar** recebem ícones SVG consistentes, sem modificar os seus eventos ou permissões.

## Interface compacta v0.13.0

- Primeira linha da caixa: **Selecionar todas** e botão **Drive** (ícone).
- Segunda linha: **Arquivar**, **Excluir**, **Parar** somente com ícones. Os nomes e contadores permanecem acessíveis por tooltip e tecnologias assistivas.
- Os filtros Nome, Conteúdo, Tags usam caixas de seleção de mesma aparência das conversas e de Selecionar todas.
- Removido o título e o botão de recolhimento da caixa Ferramentas.
- Quando possível, **Novo chat** e **Explorar** aparecem como ícones no cabeçalho superior. O script aciona os controles originais do ChatGPT, sem removê-los; se o DOM não oferecer a estrutura segura, mantém a navegação original visível.
- O painel continua fora da área rolável quando o cabeçalho Novo chat é reconhecido.

**Teste após atualização:** confirme as operações no Chrome. Mudanças do DOM nativo do ChatGPT podem exigir ajuste dos atalhos compactos. Os dados do Drive, grupos, tags e proteções não foram modificados.
