# GPT Manager

GPT Manager é uma personalização do [AI Chat Bulk Manager original](https://github.com/learnerLj/ai-chat-bulk-manager), de Luo Jiahao (MIT), com alterações para organização de conversas do ChatGPT.

## Instalar

Abra **https://pgattoni.github.io/gpt-manager/** e clique em **Instalar ou atualizar no Tampermonkey**.

- Script: [gpt-manager.user.js](https://pgattoni.github.io/gpt-manager/gpt-manager.user.js)
- Metadados para atualização: [gpt-manager.meta.js](https://pgattoni.github.io/gpt-manager/gpt-manager.meta.js)
- Código em TXT: [gpt-manager.txt](https://pgattoni.github.io/gpt-manager/gpt-manager.txt)

## Versão publicada

**v0.10.0:** conexão à conta Google por página auxiliar OAuth, cópia e sincronização em `appDataFolder`, união inicial de registros, importação/exportação JSON e sincronização automática opcional.

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
