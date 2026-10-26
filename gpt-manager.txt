// ==UserScript==
// @name         GPT Manager v0.9.3
// @name:zh-CN   GPT Manager v0.9.3
// @namespace    http://tampermonkey.net/
// @version      0.9.3
// @description  Bulk archive or delete ChatGPT and Gemini conversations
// @description:zh-CN 批量归档或删除 ChatGPT 和 Gemini 的历史会话
// @author       Luo Jiahao
// @homepageURL  https://github.com/PGattoni/aicbm
// @supportURL   https://github.com/PGattoni/aicbm/issues
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @match        https://*.oaiusercontent.com/*
// @match        https://oaiusercontent.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      chatgpt.com
// @updateURL    https://pgattoni.github.io/aicbm/gpt-manager.meta.js
// @downloadURL  https://pgattoni.github.io/aicbm/gpt-manager.user.js
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // Ponte local para visualizadores isolados em iframes da OpenAI.
    // Não envia conteúdo a terceiros; somente responde a um clique no botão
    // Copiar, e somente ao documento-pai legítimo de chatgpt.com.
    const CBM_FRAME_REQ = 'cbm-text-bridge-request-v080';
    const CBM_FRAME_REPLY = 'cbm-text-bridge-reply-v080';
    const isOpenAIContentHost = h => h === 'oaiusercontent.com' || h.endsWith('.oaiusercontent.com');
    if (isOpenAIContentHost(window.location.hostname)) {
        const frameReadText = () => {
            const candidates = Array.from(document.querySelectorAll(
                '.cm-editor .cm-content, .cm-content, .monaco-editor .view-lines, '+
                'textarea[readonly], pre, code, .shiki, [role="document"]'
            ));
            for (const element of candidates) {
                const editor = element.closest('.cm-editor');
                if (editor && editor.querySelector('.cm-gap,.cm-virtual-gap,.cm-placeholder')) continue;
                if (element.matches('.view-lines')) continue; // Monaco virtualiza linhas
                let data = '';
                if (element.matches('textarea')) data = element.value || '';
                else if (element.matches('.cm-content')) {
                    const lines = Array.from(element.querySelectorAll('.cm-line'));
                    data = lines.length ? lines.map(n => n.textContent).join('\n') : (element.innerText || element.textContent || '');
                } else data = element.innerText || element.textContent || '';
                if (data.trim()) return data;
            }
            // Arquivos text/plain podem ter corpo só com nó de texto.
            const body = document.body;
            if (body && body.children.length === 0 && body.textContent?.trim()) return body.textContent;
            return '';
        };
        window.addEventListener('message', event => {
            if (event.source !== window.parent || event.origin !== 'https://chatgpt.com') return;
            if (event.data?.type !== CBM_FRAME_REQ) return;
            const token = event.data.token;
            if (typeof token !== 'string' || token.length < 12 || token.length > 100) return;
            const text = frameReadText();
            window.parent.postMessage({type: CBM_FRAME_REPLY, token,
                ok: !!text, text: text || '', method: text ? 'iframe-dom' : 'iframe-sem-texto'}, event.origin);
        });
        return;
    }
    // Não criar o gerenciador de histórico em outros iframes.
    if (window.self !== window.top) return;

    const LOG_PREFIX = '[GPT Manager]';
    const CONVERSATION_LINK_SELECTOR = 'a[href*="/c/"]';
    const GEMINI_BOOT_DELAY_MS = 3500;
    const BULK_DELETE_INTERVAL_MS = 100;
    const CHATGPT_BULK_CONCURRENCY = 3;
    const CHATGPT_BULK_START_GAP_MS = 140;
    const GEMINI_DELETE_POLL_MS = 150;
    const MESSAGES = {
        zh: {
            archiveSelected: 'Arquivar',
            deleteSelected: 'Excluir',
            stop: '停止',
            ready: '就绪',
            stopping: '停止中',
            cancelled: '已取消',
            done: '完成',
            stopped: '已停止',
            noSelection: '未选择会话',
            archiveAction: '归档',
            deleteAction: '删除',
            detectedConversations: ({ count }) => `检测到 ${count} 条会话`,
            processing: ({ current, total }) => `正在处理 ${current}/${total}`,
            runningAction: ({ actionLabel, current, total }) => `正在${actionLabel} (${current}/${total})`,
            failed: ({ message }) => `失败：${message}`,
            confirmAction: ({ actionLabel, count }) => `确认${actionLabel}选中的 ${count} 条会话？`
        },
        en: {
            archiveSelected: 'Arquivar',
            deleteSelected: 'Excluir',
            stop: 'Stop',
            ready: 'Ready',
            stopping: 'Stopping',
            cancelled: 'Cancelled',
            done: 'Done',
            stopped: 'Stopped',
            noSelection: 'No conversations selected',
            archiveAction: 'archive',
            deleteAction: 'delete',
            detectedConversations: ({ count }) => `Detected ${count} conversations`,
            processing: ({ current, total }) => `Processing ${current}/${total}`,
            runningAction: ({ actionLabel, current, total }) => `${actionLabel} (${current}/${total})`,
            failed: ({ message }) => `Failed: ${message}`,
            confirmAction: ({ actionLabel, count }) => `Confirm ${actionLabel} for ${count} selected conversations?`
        }
    };
    const GEMINI_SELECTORS = {
        conversation: [
            'gem-nav-list-item[data-test-id="conversation"]',
            'div[data-test-id="conversation"]',
            '.chat-history-list gem-nav-list-item',
            '.chat-history-list a.mat-mdc-list-item'
        ].join(', '),
        historyRoot: [
            '.chat-history',
            'bard-sidenav',
            'side-navigation',
            'mat-sidenav',
            '[role="navigation"]'
        ].join(', '),
        menuButton: [
            'button[data-test-id="actions-menu-button"]',
            'button[aria-label*="更多选项"]',
            'button[aria-label*="More options"]',
            'button[aria-label*="More"]',
            'button[aria-label*="更多"]',
            'button:has(mat-icon[data-mat-icon-name="more_vert"])',
            'button:has(mat-icon[fonticon="more_vert"])',
            'button:has(mat-icon)'
        ].join(', '),
        deleteItem: [
            'button[data-test-id="delete-button"]',
            '[role="menu"] button:has-text("删除")',
            '[role="menu"] button:has-text("Delete")',
            '.mat-mdc-menu-panel button:has-text("删除")',
            '.mat-mdc-menu-panel button:has-text("Delete")',
            'div[role="menu"] button:has(mat-icon[data-mat-icon-name="delete"])',
            'div[role="menu"] button:has(mat-icon[fonticon="delete"])',
            'div[role="menu"] [role="menuitem"]:has(mat-icon[data-mat-icon-name="delete"])',
            'div[role="menu"] [role="menuitem"]:has(mat-icon[fonticon="delete"])',
            'button:has(mat-icon[data-mat-icon-name="delete"])',
            'button:has(mat-icon[fonticon="delete"])'
        ].join(', '),
        confirmButton: [
            'mat-dialog-container gem-button[data-test-id="confirm-button"]',
            '.cdk-overlay-pane gem-button[data-test-id="confirm-button"]',
            'gem-button[data-test-id="confirm-button"]',
            'mat-dialog-container gem-button[data-test-id="confirm-button"] button',
            '.cdk-overlay-pane gem-button[data-test-id="confirm-button"] button',
            'gem-button[data-test-id="confirm-button"] button',
            'mat-dialog-container button[data-test-id="confirm-button"]',
            'mat-dialog-container button:has-text("Delete")',
            'mat-dialog-container button:has-text("删除")',
            '.cdk-overlay-pane button:has-text("Delete")',
            '.cdk-overlay-pane button:has-text("删除")',
            'button[data-test-id="confirm-button"]'
        ].join(', ')
    };

    const log = (...args) => console.log(LOG_PREFIX, ...args);
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const getPreferredLanguage = () => {
        const languages = [
            document.documentElement.lang,
            ...Array.from(navigator.languages || []),
            navigator.language
        ];
        const hasChinese = languages.some(language => String(language || '').toLowerCase().startsWith('zh'));
        if (hasChinese) return 'zh';
        const hasEnglish = languages.some(language => String(language || '').toLowerCase().startsWith('en'));
        if (hasEnglish) return 'en';
        return 'zh';
    };

    const CURRENT_LANGUAGE = getPreferredLanguage();

    const formatMessage = (key, params = {}) => {
        const message = (MESSAGES[CURRENT_LANGUAGE] || MESSAGES.zh)[key] || MESSAGES.zh[key];
        return typeof message === 'function' ? message(params) : message;
    };

    const getText = (node) => (node && node.textContent ? node.textContent.trim() : '');

    const clickElement = (node) => {
        const nodeWindow = node.ownerDocument.defaultView || window;
        const mouseEventInit = { bubbles: true, cancelable: true, view: nodeWindow };
        node.dispatchEvent(new nodeWindow.MouseEvent('pointerdown', mouseEventInit));
        node.dispatchEvent(new nodeWindow.MouseEvent('mousedown', mouseEventInit));
        node.dispatchEvent(new nodeWindow.MouseEvent('pointerup', mouseEventInit));
        node.dispatchEvent(new nodeWindow.MouseEvent('mouseup', mouseEventInit));
        node.click();
    };

    const getConversationIdFromHref = (href) => {
        if (!href) return '';
        const match = href.match(/\/c\/([a-f0-9-]{36})/i);
        return match ? match[1] : '';
    };

    const queryTextSelector = (root, selector) => {
        const hasTextMatch = selector.match(/^(.*):has-text\("(.+)"\)$/);
        if (!hasTextMatch) return root.querySelector(selector);

        const [, baseSelector, expectedText] = hasTextMatch;
        return Array.from(root.querySelectorAll(baseSelector))
            .find(node => getText(node).includes(expectedText)) || null;
    };

    const queryFirst = (selector, root = document) => {
        const selectors = selector.split(',').map(item => item.trim()).filter(Boolean);
        for (const item of selectors) {
            try {
                const node = queryTextSelector(root, item);
                if (node) return node;
            } catch (error) {
                warn('Selector failed', item, error);
            }
        }
        return null;
    };

    const waitForElement = async (selector, root = document, timeoutMs = 1500) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const node = queryFirst(selector, root);
            if (node) return node;
            await delay(100);
        }
        throw new Error(`Element not found: ${selector}`);
    };

    const isVisible = (node) => {
        if (!node || !node.isConnected) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const waitForNodeRemoval = async (node, timeoutMs = 8000) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            if (!node || !node.isConnected) return;
            await delay(150);
        }
        throw new Error('Conversation node was not removed after delete confirmation');
    };

    const sendRequest = (details) => {
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    ...details,
                    onload: resolve,
                    onerror: reject
                });
            });
        }

        return fetch(details.url, {
            method: details.method,
            headers: details.headers,
            body: details.data,
            credentials: 'include'
        }).then(async response => ({
            status: response.status,
            responseText: await response.text()
        }));
    };

    const addStyle = (css) => {
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
            return;
        }
        const style = document.createElement('style');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    };

    class BaseAdapter {
        getConversations() { throw new Error('Not implemented'); }
        injectCheckbox(node, callback) { throw new Error('Not implemented'); }
        deleteConversation(node) { throw new Error('Not implemented'); }
        archiveConversation(node) { return this.deleteConversation(node); }
        getSidebarHeader() { throw new Error('Not implemented'); }
        getNodeId(node) { return getText(node); }
        findConversationById(id) {
            return this.getConversations().find(node => this.getNodeId(node) === id) || null;
        }
    }

    class OpenAIAdapter extends BaseAdapter {
        constructor() {
            super();
            this.accessToken = '';
            this.fetchAccessToken();
        }

        fetchAccessToken() {
            return sendRequest({
                method: 'GET',
                url: 'https://chatgpt.com/api/auth/session',
            }).then((res) => {
                try {
                    const data = JSON.parse(res.responseText);
                    this.accessToken = data.accessToken || '';
                    log('ChatGPT token loaded', Boolean(this.accessToken));
                } catch(e) {
                    console.error(LOG_PREFIX, 'Failed to parse ChatGPT token', e);
                }
            }).catch((error) => {
                console.error(LOG_PREFIX, 'Failed to load ChatGPT token', error);
            });
        }

        getConversations() {
            const links = Array.from(document.querySelectorAll(`nav ${CONVERSATION_LINK_SELECTOR}`))
                .filter(link => !link.closest('#cbm-filter-results') && getConversationIdFromHref(link.getAttribute('href')));
            const seen = new Set();
            return links.filter(link => {
                const id = getConversationIdFromHref(link.getAttribute('href'));
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });
        }

        getNodeId(node) {
            return getConversationIdFromHref(node.getAttribute('href'));
        }

        injectCheckbox(node, onSelectChange) {
            if (node.querySelector('.bulk-delete-checkbox')) return;
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'bulk-delete-checkbox';
            checkbox.addEventListener('click', (event) => event.stopPropagation());
            checkbox.addEventListener('change', (e) => onSelectChange(node, e.target.checked, e));
            node.insertBefore(checkbox, node.firstChild);
        }

        async deleteConversation(node) {
            const href = node.getAttribute('href');
            const id = getConversationIdFromHref(href);
            if (!id) return Promise.reject('No conversation ID found');
            if (!this.accessToken) {
                await this.fetchAccessToken();
            }
            if (!this.accessToken) return Promise.reject('No Access Token');

            const res = await sendRequest({
                method: 'PATCH',
                url: `https://chatgpt.com/backend-api/conversation/${id}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.accessToken}`
                },
                data: JSON.stringify({ is_visible: false })
            });

            if (res.status >= 200 && res.status < 300) {
                node.remove();
                log('ChatGPT hidden', id, res.status);
                return;
            }

            throw new Error(`HTTP error ${res.status}`);
        }

        async archiveConversation(node) {
            const href = node.getAttribute('href');
            const id = getConversationIdFromHref(href);
            if (!id) return Promise.reject('No conversation ID found');
            if (!this.accessToken) {
                await this.fetchAccessToken();
            }
            if (!this.accessToken) return Promise.reject('No Access Token');

            const res = await sendRequest({
                method: 'PATCH',
                url: `https://chatgpt.com/backend-api/conversation/${id}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.accessToken}`
                },
                data: JSON.stringify({ is_archived: true })
            });

            if (res.status >= 200 && res.status < 300) {
                node.remove();
                log('ChatGPT archived', id, res.status);
                return;
            }

            throw new Error(`HTTP error ${res.status}`);
        }

        getSidebarHeader() {
            const firstConversation = this.getConversations()[0];
            const historyNav = firstConversation?.closest('nav');
            if (!historyNav) return null;
            const scroll = Array.from(historyNav.children).find((node) => {
                const overflowY = getComputedStyle(node).overflowY;
                return overflowY === 'auto' || overflowY === 'scroll';
            });
            return scroll || historyNav.firstElementChild;
        }
    }

    class GoogleAdapter extends BaseAdapter {
        getConversations() {
            const nodes = Array.from(document.querySelectorAll(GEMINI_SELECTORS.conversation))
                .map(node => node.closest('gem-nav-list-item[data-test-id="conversation"]') || node)
                .filter(node => !node.closest('#bulk-controls-panel'));
            return Array.from(new Set(nodes));
        }

        getNodeId(node) {
            const href = node.querySelector('a[href^="/app/"]')?.getAttribute('href');
            return href || getText(node);
        }

        injectCheckbox(node, onSelectChange) {
            if (node.querySelector('.bulk-delete-checkbox')) return;
            node.classList.add('gemini-bulk-delete-row');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'bulk-delete-checkbox';
            checkbox.addEventListener('click', (event) => event.stopPropagation());
            checkbox.addEventListener('change', (e) => onSelectChange(node, e.target.checked, e));
            const anchor = node.querySelector('a.mat-mdc-list-item') || node.firstChild;
            node.insertBefore(checkbox, anchor);
        }

        async deleteConversation(node) {
            const nodeId = this.getNodeId(node);
            node.scrollIntoView({ block: 'center' });
            node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            const menuBtn = await waitForElement(GEMINI_SELECTORS.menuButton, node, 1500);
            clickElement(menuBtn);

            const deleteItem = await waitForElement(GEMINI_SELECTORS.deleteItem, document, 1500);
            clickElement(deleteItem);

            const confirmBtn = await this.waitForConfirmButton();
            clickElement(confirmBtn);
            await this.waitForDeletedNode(node, nodeId);
            log('Gemini delete clicked', getText(node).slice(0, 80));
        }

        isConversationDeleted(node, nodeId) {
            return !node || !node.isConnected || Boolean(nodeId && !this.findConversationById(nodeId));
        }

        async waitForDeletedNode(node, nodeId) {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 10000) {
                const confirmBtn = await this.findConfirmButton();
                const isDeleted = this.isConversationDeleted(node, nodeId);
                if (isDeleted && confirmBtn) {
                    const cancelBtn = await this.findCancelButton();
                    if (cancelBtn) {
                        clickElement(cancelBtn);
                        await delay(GEMINI_DELETE_POLL_MS);
                        if (!await this.findConfirmButton()) return;
                    }
                }
                if (isDeleted && !confirmBtn) return;
                if (confirmBtn) {
                    clickElement(confirmBtn);
                }
                await delay(GEMINI_DELETE_POLL_MS);
            }
            if (!this.isConversationDeleted(node, nodeId)) {
                await waitForNodeRemoval(node, 1);
            }
        }

        async findConfirmButton() {
            const confirmHosts = Array.from(document.querySelectorAll([
                'mat-dialog-container gem-button[data-test-id="confirm-button"]',
                '.cdk-overlay-pane gem-button[data-test-id="confirm-button"]'
            ].join(', '))).filter(isVisible);
            if (confirmHosts.length > 0) {
                const host = confirmHosts[confirmHosts.length - 1];
                return host.querySelector('button') || host;
            }

            const buttons = Array.from(document.querySelectorAll([
                'mat-dialog-container gem-button[data-test-id="confirm-button"] button',
                '.cdk-overlay-pane gem-button[data-test-id="confirm-button"] button',
                'mat-dialog-container button',
                '.cdk-overlay-pane button',
                'button[data-test-id="confirm-button"]'
            ].join(', '))).filter(isVisible);
            const confirmButtons = buttons.filter(button => {
                const text = getText(button);
                return text === '删除'
                    || text === 'Delete'
                    || button.matches('[data-test-id="confirm-button"]')
                    || Boolean(button.closest('gem-button[data-test-id="confirm-button"]'));
            });
            return confirmButtons.length > 0 ? confirmButtons[confirmButtons.length - 1] : null;
        }

        async findCancelButton() {
            const cancelHosts = Array.from(document.querySelectorAll([
                'mat-dialog-container gem-button[data-test-id="cancel-button"]',
                '.cdk-overlay-pane gem-button[data-test-id="cancel-button"]'
            ].join(', '))).filter(isVisible);
            if (cancelHosts.length > 0) {
                const host = cancelHosts[cancelHosts.length - 1];
                return host.querySelector('button') || host;
            }

            const buttons = Array.from(document.querySelectorAll([
                'mat-dialog-container button',
                '.cdk-overlay-pane button'
            ].join(', '))).filter(isVisible);
            return buttons.find(button => ['取消', 'Cancel'].includes(getText(button))) || null;
        }

        async waitForConfirmButton() {
            const startedAt = Date.now();
            while (Date.now() - startedAt < 3000) {
                const confirmButton = await this.findConfirmButton();
                if (confirmButton) {
                    return confirmButton;
                }
                await delay(100);
            }
            throw new Error(`Element not found: ${GEMINI_SELECTORS.confirmButton}`);
        }

        getSidebarHeader() {
            return queryFirst(GEMINI_SELECTORS.historyRoot) || document.querySelector('nav');
        }
    }

    const getAdapter = () => {
        const host = window.location.hostname;
        if (host.includes('chatgpt.com')) {
            return new OpenAIAdapter();
        } else if (host.includes('gemini.google.com')) {
            return new GoogleAdapter();
        }
        return null;
    };

    // Diagnóstico local sob demanda. Nunca armazena conteúdo de conversas,
    // tokens, endereços de arquivos, nomes de documentos ou IDs de conversas.
    class CBMDiagnostics {
        constructor() {
            this.events = [];
            this.lastError = '';
            this.reportPanel = null;
            try { this.enabled = Boolean(typeof GM_getValue === 'function' && GM_getValue('cbm_detailed_logs_080', false)); }
            catch (_) { this.enabled = false; }
            addStyle(`
                #cbm-diag-modal {position:fixed!important;z-index:2147483647!important;top:54px;right:14px;
                    width:min(630px,calc(100vw - 28px));height:min(670px,calc(100vh - 70px));
                    box-sizing:border-box;padding:15px;border:1px solid rgba(128,128,128,.35);border-radius:13px;
                    color:var(--text-primary,#171717);background:var(--main-surface-primary,#fff);
                    box-shadow:0 8px 36px rgba(0,0,0,.26);display:flex;flex-direction:column;gap:10px;
                    font:13px/1.45 Arial, sans-serif;}
                #cbm-diag-modal .cbm-diag-top {display:flex;justify-content:space-between;align-items:center;gap:12px;}
                #cbm-diag-modal h2 {font:600 17px/1.4 Arial,sans-serif;margin:0;}
                #cbm-diag-modal p {font-size:12px;margin:0;line-height:1.45;color:var(--text-secondary,#666);}
                #cbm-diag-modal .cbm-diag-actions {display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
                #cbm-diag-modal button {border:1px solid rgba(128,128,128,.45);background:transparent;
                    color:inherit;padding:6px 9px;border-radius:6px;cursor:pointer;}
                #cbm-diag-modal button:hover {background:rgba(128,128,128,.1);}
                #cbm-diag-modal textarea {flex:1;min-height:130px;resize:none;box-sizing:border-box;
                    width:100%;padding:10px;font:12px/1.42 Consolas,Monaco,monospace;
                    color:var(--text-primary,#222);background:var(--main-surface-secondary,#f7f7f7);
                    border:1px solid rgba(128,128,128,.3);border-radius:6px;white-space:pre;}
                #cbm-diag-modal .cbm-diag-check {display:flex;gap:6px;align-items:center;cursor:pointer;}
            `);
            this.registerMenu();
            this.add('diagnostico-inicializado', {versao:'0.8.3', detalhado:this.enabled}, true);
        }
        add(type, details={}, always=false) {
            if(!always && !this.enabled)return;
            const clean={};
            for(const [key, value] of Object.entries(details)) {
                if(value==null || ['number','boolean'].includes(typeof value))clean[key]=value;
                else if (typeof value==='string')clean[key]=String(value).replace(/[\r\n\t]+/g,' ').slice(0,110);
            }
            const entry={hora:new Date().toLocaleTimeString('pt-BR'), evento:type, ...clean};
            this.events.push(entry);
            if(this.events.length>130)this.events.shift();
            if(this.enabled) console.debug('[CBM DEBUG]',entry);
        }
        fail(operation, error) {
            const message=String(error?.message||'Erro desconhecido').slice(0,140);
            this.lastError=operation+': '+message;
            this.add('falha',{operacao:operation,motivo:message},true);
        }
        toggle(enabled) {
            this.enabled=!!enabled;
            try { if(typeof GM_setValue==='function')GM_setValue('cbm_detailed_logs_080',this.enabled); }
            catch(e) { console.warn('[CBM DEBUG] Preferência de log não pôde ser salva'); }
            this.add('logs-detalhados',{ativos:this.enabled},true);
            this.refresh();
        }
        registerMenu() {
            if(typeof GM_registerMenuCommand!=='function') {
                console.warn('[CBM DEBUG] GM_registerMenuCommand indisponível');
                return;
            }
            try {
                GM_registerMenuCommand('🛠 Diagnóstico: abrir painel',()=>this.open());
                GM_registerMenuCommand('📋 Diagnóstico: copiar relatório',()=>{void this.copyReport();});
                GM_registerMenuCommand('🔍 Diagnóstico: ativar/desativar logs detalhados',()=>{
                    this.toggle(!this.enabled);this.toast(this.enabled?'Logs detalhados ativados':'Logs detalhados desativados');
                });
                GM_registerMenuCommand('🧹 Diagnóstico: limpar eventos',()=>{
                    this.events=[];this.lastError='';this.add('eventos-limpos',{},true);this.refresh();this.toast('Eventos de diagnóstico limpos');
                });
            }catch(e){console.warn('[CBM DEBUG] Falha ao registrar comandos de menu',e);}
        }
        toast(message){
            let el=document.getElementById('cbm-diag-toast');
            if(!el){el=document.createElement('div');el.id='cbm-diag-toast';
                Object.assign(el.style,{position:'fixed',bottom:'30px',right:'20px',zIndex:'2147483647',
                    background:'#222',color:'#fff',padding:'10px 14px',borderRadius:'8px',font:'13px Arial'});
                document.body.appendChild(el);}
            el.textContent=message; clearTimeout(this.toastTimer);
            this.toastTimer=setTimeout(()=>{el.remove();},2800);
        }
        safeShape(n) {
            if(!n)return null;
            const r=n.getBoundingClientRect();
            let classNames=[];
            try {classNames=Array.from(n.classList).filter(v=>/^[A-Za-z][\w-]{0,39}$/.test(v)&&!/[0-9]{4}/.test(v)).slice(0,4);}
            catch(_){}
            return {
                tag:n.tagName?.toLowerCase()||'outro',classes:classNames.join('.'),
                visivel:r.width>0 && r.height>0,
                x:Math.round(r.x),y:Math.round(r.y),largura:Math.round(r.width),altura:Math.round(r.height),
                caracteres:Number(n.textContent?.length)||0,
                linhas:n.querySelectorAll?.('.cm-line,.view-line')?.length||0,
                editable:!!n.isContentEditable,
                virtualizado:!!n.closest?.('.cm-editor')?.querySelector('.cm-gap,.cm-virtual-gap,.cm-placeholder')
            };
        }
        snapshot() {
            const viewer=window.__aiChatPreviewCopy;
            const out={
                versao:'0.8.3',dominio:location.hostname,
                janela:{largura:innerWidth,altura:innerHeight},
                botaoCopiar:{presente:!!viewer?.button?.isConnected,visivel:!!viewer?.button&&getComputedStyle(viewer.button).display!=='none'},
                downloadDetectado:!!viewer?.source?.isConnected,
                ultimoErro:this.lastError||'nenhum',
                logsDetalhados:this.enabled
            };
            const kinds={
                codeMirror:'.cm-editor',conteudoCM:'.cm-content',linhasCM:'.cm-line',
                monaco:'.monaco-editor',linhasMonaco:'.view-lines',pre:'pre',code:'pre code',
                shiki:'.shiki',textareas:'textarea',textbox:'[role="textbox"]',
                arquivoWalnut:'[id^="walnut-sandbox-text-preview-"]',
                filePreview:'[data-testid*="file-preview"]',
                flyOut:'[data-testid="screen-threadFlyOut"]',
                iframes:'iframe'
            };
            out.contagensDOM={};
            for(const [name,selector] of Object.entries(kinds)){
                try{out.contagensDOM[name]=document.querySelectorAll(selector).length;}catch(_){out.contagensDOM[name]='erro';}
            }
            try{
                out.raizesDaPrevia=(viewer?.viewerRoots?.()||[]).slice(0,8).map(n=>this.safeShape(n));
                out.fontesDetectadas=(viewer?.sources?.()||[]).slice(0,14).map(n=>this.safeShape(n));
                out.botaoDownload=viewer?.source?.isConnected?this.safeShape(viewer.source):null;
                out.candidatosDOMDaPrevia=viewer?.geometryDiagnostics?.()||[];
                // Elementos sob três pontos do painel, com classes e tamanhos,
                // nunca com os textos; útil quando a seleção por CSS falha.
                const bar=viewer?.source?.getBoundingClientRect();
                if(bar){
                    const x=Math.round((Math.max(innerWidth*.38,bar.left-650)+bar.left)/2);
                    out.pontosDaPrevia=[140,300,Math.round(innerHeight*.68)].map(y=>{
                        const el=document.elementFromPoint(x,y);
                        return {x,y,elemento:el?this.safeShape(el):null};
                    });
                }
            }catch(e){out.erroNaInspecao=String(e?.message||e).slice(0,100);}
            const iframes=Array.from(document.querySelectorAll('iframe'));
            out.iframes=iframes.slice(0,8).map(frame=>{
                let sameOrigin=false,hasBody=false;
                try{sameOrigin=!!frame.contentDocument;hasBody=!!frame.contentDocument?.body;}
                catch(_){}
                let host='sem-src',protocolo='indisponivel',sandbox='sem-atributo';
                try {
                    const raw=frame.getAttribute('src')||'';
                    if(raw){const parsed=new URL(raw,document.baseURI);
                        host=parsed.hostname||'(sem-host)';protocolo=parsed.protocol;}
                    else if(frame.hasAttribute('srcdoc'))host='srcdoc';
                    sandbox=frame.getAttribute('sandbox') ?? 'sem-atributo';
                } catch (_) { host='erro-de-parsing'; }
                const r=frame.getBoundingClientRect();
                return {mesmaOrigem:sameOrigin,carregado:hasBody,
                    dominioIframe:host,protocoloIframe:protocolo,
                    permissoesSandbox:sandbox,
                    naMetadeDireita: r.width > 100 && r.right > innerWidth*.50 && r.height>60};
            });
            const bulk=window.__aiChatBulkManager;
            if(bulk){out.operacoes={carregandoHistorico:!!bulk.historyLoading,emLote:!!bulk.isDeleting,
                filtroAtivo:!!bulk.filterActive,interacoesDetectadas:bulk.records?.size||0,
                selecionadas:bulk.selectedIds?.size||0};}
            return out;
        }
        report() {
            const snap=this.snapshot();
            return 'GPT MANAGER - DIAGNÓSTICO v0.9.3\n'+
                'Sem conteúdo de conversas, tokens, nomes de arquivos ou URLs.\n\n'+
                '[AMBIENTE E PRÉVIA]\n'+JSON.stringify(snap,null,2)+'\n\n'+
                '[EVENTOS RECENTES]\n'+this.events.map(e=>JSON.stringify(e)).join('\n')+'\n';
        }
        async copyReport() {
            const report=this.report();
            try {
                if(typeof GM_setClipboard==='function')GM_setClipboard(report,'text');
                else await navigator.clipboard.writeText(report);
                this.toast('Relatório copiado. Cole-o no ChatGPT para análise.');
            }catch(err){this.fail('copiar-relatorio',err);this.toast('Falha ao copiar relatório. Abra o painel e copie manualmente.');}
        }
        refresh(){
            if(!this.reportPanel?.isConnected)return;
            const textarea=this.reportPanel.querySelector('#cbm-diag-report');
            if(textarea)textarea.value=this.report();
            const cb=this.reportPanel.querySelector('#cbm-diag-toggle');if(cb)cb.checked=this.enabled;
        }
        open(){
            if(this.reportPanel?.isConnected){this.refresh();return;}
            const el=document.createElement('div');el.id='cbm-diag-modal';
            el.innerHTML=`
                <div class="cbm-diag-top"><h2>GPT Manager v0.9.3 | Diagnóstico</h2>
                    <button type="button" id="cbm-diag-close" aria-label="Fechar diagnóstico">Fechar ×</button></div>
                <p>Abra a janela lateral do TXT, tente copiar o texto e, após a falha, clique em Atualizar.
                   O relatório contém apenas estruturas e contagens, não o texto ou dados de autenticação.</p>
                <label class="cbm-diag-check"><input type="checkbox" id="cbm-diag-toggle"> Ativar logs detalhados no console (F12)</label>
                <div class="cbm-diag-actions"><button type="button" id="cbm-diag-refresh">Atualizar</button>
                    <button type="button" id="cbm-diag-copy">Copiar relatório</button>
                    <button type="button" id="cbm-diag-try">Testar leitura (sem copiar)</button>
                    <button type="button" id="cbm-diag-clear">Limpar eventos</button></div>
                <textarea id="cbm-diag-report" spellcheck="false" readonly aria-label="Relatório técnico"></textarea>`;
            document.body.appendChild(el);this.reportPanel=el;
            el.querySelector('#cbm-diag-close').addEventListener('click',()=>{el.remove();this.reportPanel=null;});
            el.querySelector('#cbm-diag-refresh').addEventListener('click',()=>this.refresh());
            el.querySelector('#cbm-diag-copy').addEventListener('click',()=>{void this.copyReport();});
            el.querySelector('#cbm-diag-clear').addEventListener('click',()=>{this.events=[];this.lastError='';this.refresh();});
            el.querySelector('#cbm-diag-toggle').addEventListener('change',e=>this.toggle(e.target.checked));
            el.querySelector('#cbm-diag-try').addEventListener('click',async()=>{
                const btn=el.querySelector('#cbm-diag-try');btn.disabled=true;
                try{
                    const txt=await window.__aiChatPreviewCopy?.findCompleteText();
                    if(typeof txt==='string'&&txt.length){this.add('teste-leitura-ok',{caracteres:txt.length},true);this.toast('Leitura concluída ('+txt.length+' caracteres)');}
                    else{this.fail('teste-leitura',new Error('Nenhum texto completo encontrado'));this.toast('Teste falhou. Copie o relatório para análise.');}
                }catch(err){this.fail('teste-leitura',err);this.toast('Teste falhou. Copie o relatório para análise.');}
                finally{btn.disabled=false;this.refresh();}
            });
            this.refresh();
        }
    }

    // Metadados pessoais guardados apenas no Tampermonkey, neste navegador.
    // Nenhum texto de conversa é salvo no armazenamento persistente.
    class CBMConversationMetadata {
        constructor(){
            this.key='cbm-user-tags-colors-v1';
            try{
                const saved=localStorage.getItem(this.key);
                const raw=saved!==null?saved:(typeof GM_getValue==='function'?GM_getValue(this.key,'{}'):'{}');
                this.data=typeof raw==='string'?JSON.parse(raw):raw;
                if(!this.data || typeof this.data!=='object' || Array.isArray(this.data))this.data={};
            }catch(error){warn('Não foi possível carregar tags e cores',error);this.data={};}
        }
        get(id){return this.data[id]||{tags:[],color:'',protected:false};}
        isProtected(id){return Boolean(id && this.get(id).protected===true);}
        setProtected(id,value){
            if(!id)return;
            const existing=this.get(id);
            const tags=Array.isArray(existing.tags)?existing.tags:[];
            const color=existing.color||'';
            if(!value && !tags.length && !color)delete this.data[id];
            else this.data[id]={...existing,tags,color,protected:Boolean(value)};
            this.save();
        }
        set(id,tags,color){
            const unique=[...new Set(tags.map(x=>String(x).trim()).filter(Boolean))].slice(0,30);
            const wasProtected=this.isProtected(id);
            if(!unique.length&&!color&&!wasProtected)delete this.data[id];
            else this.data[id]={tags:unique,color,protected:wasProtected};
            this.save();
        }
        delete(id){if(this.data[id]){delete this.data[id];this.save();}}
        save(){
            try{const payload=JSON.stringify(this.data);
                localStorage.setItem(this.key,payload);
            }catch(error){warn('Não foi possível salvar tags e cores',error);}
        }
    }

    const CBM_COLORS=[
        ['', 'Sem cor'],['#fff1b8','Amarelo'],['#ffdedc','Rosa'],
        ['#dff2d8','Verde'],['#dceeff','Azul'],['#eee2ff','Lilás'],
        ['#ffe8d1','Pêssego'],['#d8f3ef','Turquesa'],['#f0ebdf','Areia']
    ];
    const cbmLightColor = raw => {
        if(!/^#[a-f0-9]{6}$/i.test(String(raw||'')))return '';
        const channels=[1,3,5].map(i=>parseInt(raw.slice(i,i+2),16));
        const lum=(.2126*channels[0]+.7152*channels[1]+.0722*channels[2]);
        const mixed=lum<205?channels.map(n=>Math.round(n*.18+255*.82)):channels;
        return '#'+mixed.map(n=>n.toString(16).padStart(2,'0')).join('');
    };

    class BulkManager {
        constructor() {
            this.adapter = getAdapter();
            if (!this.adapter) return;
            this.isChatGPT = window.location.hostname === 'chatgpt.com';
            this.selectedIds = new Set();
            this.records = new Map();
            this.filterTerm = '';
            this.filterActive = false;
            this.filterModes = new Set(['name']);
            this.metadata = new CBMConversationMetadata();
            this.contentCache = new Map(); // Só memória da aba; nunca persiste mensagens.
            this.contentMatched = new Set();
            this.contentSearchJob = 0;
            this.contentSearchRunning = false;
            this.contentSearchDone = 0;
            this.contentSearchTotal = 0;
            this.contentSearchErrors = 0;
            this.contentSearchAuthError = false;
            this.historyComplete = false;
            this.historyLoading = this.isChatGPT;
            this.loadError = null;
            this.isDeleting = false;
            this.stopRequested = false;
            this.renderPending = false;
            this.grouping = false;
            this.currentAction = null;
            this.init();
        }

        init() {
            addStyle(`
                .bulk-delete-checkbox, #bulk-select-all { appearance:none; -webkit-appearance:none; box-sizing:border-box; width:16px; height:16px; min-width:16px; min-height:16px; padding:0; margin:0 7px 0 0; cursor:pointer; flex:0 0 16px; border:1.5px solid #777; border-radius:4px; background:transparent; background-repeat:no-repeat; background-position:center; background-size:12px; }
                .bulk-delete-checkbox:checked, #bulk-select-all:checked {border-color:currentColor; background-color:#333; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3 8l3 3 7-7' stroke='%23fff' fill='none' stroke-width='2'/%3E%3C/svg%3E");}
                #bulk-controls-panel { padding:8px; display:flex; flex-direction:column; align-items:stretch; gap:7px; background:var(--main-surface-primary,#fff); color:var(--text-primary,#111); position:relative; z-index:10; font-size:12px; box-sizing:border-box; }
                #bulk-controls-panel.bulk-controls-panel-chatgpt {margin:4px 8px 8px; border:1px solid var(--border-default,rgba(0,0,0,.18)); border-radius:10px; max-width:100%; min-width:0; flex:0 0 auto;}
                #bulk-controls-panel.bulk-controls-panel-gemini {margin:4px 0 8px; border:1px solid #888; border-radius:9px; background:#222; color:white;}
                #bulk-controls-panel .cbm-select-line {display:flex;align-items:center; min-height:19px;cursor:pointer; user-select:none;}
                #bulk-controls-panel .cbm-actions {display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
                #bulk-controls-panel .bulk-btn {border:1px solid var(--border-default,#ccc); border-radius:5px; padding:5px 8px; background:var(--main-surface-primary,#fff); color:inherit; cursor:pointer; line-height:16px;}
                #bulk-controls-panel .bulk-btn:disabled {opacity:.46;cursor:not-allowed;}
                #bulk-controls-panel .bulk-status {white-space:normal;line-height:16px;font-size:12px;}
                #bulk-controls-panel .cbm-status-line {display:flex;align-items:flex-start;gap:7px;min-height:17px;}
                #bulk-controls-panel .cbm-work-spinner {flex:0 0 15px;width:15px;height:15px;margin-top:1px;
                    border:2px solid var(--text-tertiary,#aaa);border-top-color:var(--text-primary,#333);
                    border-radius:50%;animation:cbm-spin 0.8s linear infinite;box-sizing:border-box;}
                #bulk-controls-panel .cbm-work-spinner[hidden] {display:none !important;}
                @keyframes cbm-spin {to{transform:rotate(360deg)}}
                @media (prefers-reduced-motion: reduce) {#bulk-controls-panel .cbm-work-spinner {animation-duration:2.5s}}
                .cbm-native-protection-action {min-width:0 !important;}
                .cbm-native-protection-action .cbm-meta-label {font-size:inherit !important;}
                /* Esmaecer texto e ícone dos comandos nativos bloqueados, sem alterar o menu. */
                .cbm-native-action-disabled {opacity:.36 !important;filter:grayscale(1) !important;cursor:not-allowed !important;}
                .cbm-native-action-disabled svg,.cbm-native-action-disabled [data-slot*="icon"] {opacity:.65 !important;}
                .cbm-native-action-disabled * {cursor:not-allowed !important;}
                nav .bulk-delete-checkbox:disabled,#cbm-filter-results .bulk-delete-checkbox:disabled {opacity:.35;cursor:not-allowed;}

                #bulk-controls-panel .cbm-search-row {display:flex;align-items:center;gap:4px;width:100%;min-width:0;}
                #bulk-controls-panel #cbm-filter-input {flex:1;min-width:0; height:28px; border:1px solid var(--border-default,#ccc); border-radius:7px; background:var(--main-surface-primary,#fff); color:inherit; outline-offset:1px; padding:3px 6px;font-size:12px;}
                #bulk-controls-panel .cbm-icon-btn {height:27px;width:27px;display:flex;align-items:center;justify-content:center;border:0; border-radius:6px; background:transparent; color:inherit;cursor:pointer;padding:3px;}
                #bulk-controls-panel .cbm-icon-btn:hover {background:var(--token-surface-hover,rgba(128,128,128,.15));}
                #bulk-controls-panel .cbm-icon-btn svg {height:17px;width:17px;}
                #bulk-controls-panel #cbm-clear-filter[hidden] {display:none !important;}
                /* Modos de busca abaixo do campo. */
                #cbm-search-modes {display:flex;align-items:center;flex-wrap:wrap;gap:9px;
                    line-height:16px;font-size:12px;padding:0 2px;}
                #cbm-search-modes .cbm-mode-option {display:inline-flex !important;position:relative !important;
                    align-items:center !important;gap:5px !important;cursor:pointer;white-space:nowrap;
                    margin:0 !important;padding:1px 2px !important;min-height:20px;}
                /* O ChatGPT pode ocultar inputs por CSS global. A caixa visível é um glifo próprio;
                   o input real permanece acessível ao teclado e ao leitor de tela. */
                #cbm-search-modes .cbm-mode-input {position:absolute !important; width:16px !important;
                    height:16px !important;left:1px !important;top:2px !important;opacity:0 !important;
                    margin:0 !important;padding:0 !important;z-index:1;cursor:pointer;}
                #cbm-search-modes .cbm-mode-indicator {font-family:Arial,sans-serif !important;
                    display:inline-flex !important;align-items:center;justify-content:center;
                    font-size:17px !important;line-height:18px !important;width:17px;height:18px;
                    font-weight:400;color:var(--text-primary,#333);pointer-events:none;}
                #cbm-search-modes .cbm-mode-input:focus-visible + .cbm-mode-indicator {
                    outline:2px solid #2563eb;outline-offset:1px;border-radius:3px;}
                nav a.cbm-colored-title,#cbm-filter-results a.cbm-colored-title {border-radius:7px !important;color:#202830 !important;}
                /* Reaproveitar o estilo EXTERNO da opção Renomear, mas nunca seus
                   filhos: o ícone original pode estar em um wrapper/pseudo-elemento. */
                .cbm-native-meta-action {cursor:pointer !important;white-space:nowrap !important;
                    display:flex !important;flex-direction:row !important;align-items:center !important;
                    gap:8px !important;box-sizing:border-box !important;background-image:none !important;}
                .cbm-native-meta-action::before,.cbm-native-meta-action::after {
                    content:none !important;display:none !important;}
                .cbm-native-meta-action > svg.cbm-meta-tag-icon {
                    display:block !important;position:static !important;width:16px !important;
                    height:16px !important;min-width:16px !important;flex:0 0 16px !important;
                    margin:0 !important;padding:0 !important;background:none !important;}
                .cbm-native-meta-action > span.cbm-meta-label {
                    display:inline !important;white-space:nowrap !important;
                    margin:0 !important;padding:0 !important;}
                .cbm-native-meta-action:hover,
                .cbm-native-meta-action:focus-visible {
                    background-color:var(--token-surface-hover,rgba(128,128,128,.10)) !important;
                }
                #cbm-meta-overlay {position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.30);
                    display:flex;align-items:center;justify-content:center;padding:15px;box-sizing:border-box;}
                #cbm-meta-dialog {box-sizing:border-box;width:min(390px,96vw);padding:17px;border-radius:12px;
                    background:var(--main-surface-primary,#fff);color:var(--text-primary,#111);
                    box-shadow:0 8px 35px rgba(0,0,0,.30);display:flex;flex-direction:column;gap:12px;
                    border:1px solid var(--border-default,#ddd);font:13px Arial,sans-serif;}
                #cbm-meta-dialog h3 {font-size:16px;font-weight:600;margin:0;}
                #cbm-meta-dialog .cbm-meta-title {white-space:nowrap;text-overflow:ellipsis;overflow:hidden;
                    color:var(--text-secondary,#666);}
                #cbm-meta-dialog label {display:flex;flex-direction:column;gap:5px;}
                #cbm-meta-dialog input[type=text] {width:100%;height:33px;padding:5px 8px;border:1px solid #aaa;
                    border-radius:6px;background:var(--main-surface-primary,#fff);color:inherit;box-sizing:border-box;}
                #cbm-meta-dialog .cbm-swatches {display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
                #cbm-meta-dialog .cbm-swatch {width:29px;height:29px;cursor:pointer;box-sizing:border-box;
                    border-radius:6px;border:1px solid rgba(0,0,0,.22);display:flex;align-items:center;
                    justify-content:center;color:#222;font-size:11px;}
                #cbm-meta-dialog .cbm-swatch[aria-pressed=true] {outline:2px solid #155dde;outline-offset:1px;}
                #cbm-meta-dialog .cbm-custom-color {display:flex;flex-direction:row;align-items:center;gap:8px;}
                #cbm-meta-dialog input[type=color] {width:35px;height:27px;cursor:pointer;border:0;background:transparent;padding:0;}
                #cbm-meta-dialog .cbm-meta-buttons {display:flex;justify-content:flex-end;gap:8px;}
                #cbm-meta-dialog .cbm-meta-buttons button {border:1px solid #aaa;background:transparent;color:inherit;
                    border-radius:6px;padding:6px 13px;cursor:pointer;}
                #cbm-meta-dialog .cbm-meta-buttons button[type=submit] {font-weight:600;}
                .gemini-bulk-delete-row {display:flex !important;align-items:center !important;}
                /* Seção própria entre Explorar e Fixados, sem depender da estrutura de Recentes. */
                #cbm-filter-section {display:block !important;position:relative !important;box-sizing:border-box !important;
                    width:100% !important;min-width:0 !important;max-width:100% !important;margin:3px 0 8px !important;
                    overflow:visible !important;visibility:visible !important;opacity:1 !important;}
                #cbm-filter-section[hidden] {display:none !important;}
                #cbm-filter-heading {display:flex !important;align-items:center !important;justify-content:space-between !important;
                    box-sizing:border-box !important;width:100% !important;min-height:29px !important;
                    padding:3px 12px !important;margin:0 !important;border:0 !important;border-radius:7px !important;
                    text-align:left !important;background:transparent !important;color:var(--text-secondary,#737373) !important;
                    font-size:12px !important;font-weight:600 !important;cursor:pointer !important;}
                #cbm-filter-heading:hover {background:var(--token-surface-hover,rgba(128,128,128,.08)) !important;}
                #cbm-filter-heading .cbm-chevron {font-size:16px;line-height:1;}
                #cbm-filter-results {padding:0 4px 2px;min-width:0;display:flex;flex-direction:column;gap:0;
                    max-height:none !important;height:auto !important;overflow-y:visible !important;
                    overscroll-behavior:auto;}
                #cbm-filter-results[hidden] {display:none !important;}
                #cbm-filter-results .cbm-result-row {box-sizing:border-box;width:100%;min-height:29px;display:flex;align-items:center;gap:0;padding:0 4px;border-radius:8px;}
                #cbm-filter-results .cbm-result-row:hover {background:var(--token-surface-hover,rgba(128,128,128,.09));}
                #cbm-filter-results .cbm-result-row a {min-width:0; flex:1; overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:none;color:inherit;font-size:13px;padding:4px 2px;}
                #cbm-filter-results .cbm-empty {padding:9px;color:var(--text-secondary,#777);font-size:12px;}
                body.cbm-filter-active nav .cbm-filter-hide {display:none !important;}
                /* Ocultar o item INTEIRO (e não só seu <a>) evita lacunas no histórico após exclusões por API. */
                nav .cbm-deleted-row, .cbm-deleted-row {display:none !important; height:0 !important;
                    min-height:0 !important; max-height:0 !important;
                    margin:0 !important; padding:0 !important; overflow:hidden !important;}
            `);
            this.startObserver();
            this.injectPanel();
            if (this.isChatGPT) this.historyPromise=this.loadHistory();
        }

        injectPanel() {
            if (document.getElementById('bulk-controls-panel')) return;
            const header = this.isChatGPT ? this.adapter.getSidebarHeader() : document.querySelector('.chat-history-list');
            if (!header) return;
            const panel=document.createElement('div');
            panel.id='bulk-controls-panel';
            panel.className=this.isChatGPT ? 'bulk-controls-panel-chatgpt' : 'bulk-controls-panel-gemini';
            const selectRow=document.createElement('label');
            selectRow.className='cbm-select-line';
            const selectAll=document.createElement('input');
            selectAll.type='checkbox'; selectAll.id='bulk-select-all';
            selectRow.append(selectAll,document.createTextNode('Selecionar todas'));
            const actions=document.createElement('div');actions.className='cbm-actions';
            const archiveBtn=this.createActionButton('bulk-archive-btn','Arquivar (0)');
            const deleteBtn=this.createActionButton('bulk-delete-btn','Excluir (0)');
            const stopBtn=this.createActionButton('bulk-stop-btn','Parar'); stopBtn.disabled=true;
            if(this.isChatGPT)actions.append(archiveBtn,deleteBtn,stopBtn);
            else actions.append(deleteBtn,stopBtn);
            const status=document.createElement('span');status.className='bulk-status';status.id='bulk-status';
            status.textContent='Carregando interações…';            const statusRow=document.createElement('div');statusRow.className='cbm-status-line';
            const spinner=document.createElement('span');spinner.id='cbm-work-spinner';spinner.className='cbm-work-spinner';
            spinner.setAttribute('role','img');spinner.setAttribute('aria-label','Operação em andamento');spinner.hidden=true;
            statusRow.append(spinner,status);
            panel.append(selectRow,actions);
            if(this.isChatGPT) {
                const searchRow=document.createElement('form');searchRow.className='cbm-search-row';
                searchRow.setAttribute('role','search');
                const input=document.createElement('input');input.type='text';input.id='cbm-filter-input';
                input.setAttribute('aria-label','Filtrar interações por palavras-chave');
                input.placeholder='Filtrar interações';input.autocomplete='off';
                const searchBtn=document.createElement('button');searchBtn.type='submit';searchBtn.className='cbm-icon-btn';searchBtn.title='Filtrar';
                searchBtn.setAttribute('aria-label','Aplicar filtro');
                searchBtn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
                const clear=document.createElement('button');clear.type='button';clear.id='cbm-clear-filter';clear.className='cbm-icon-btn';clear.title='Limpar filtro';clear.setAttribute('aria-label','Limpar filtro');clear.hidden=true;
                clear.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>';
                searchRow.append(input,searchBtn,clear);
                searchRow.addEventListener('submit',e=>{e.preventDefault();this.applyFilter(input.value);});
                clear.addEventListener('click',()=>{input.value='';this.applyFilter('');input.focus();});
                panel.append(searchRow);
                const modes=document.createElement('div');modes.id='cbm-search-modes';
                for(const [key,name] of [['name','Nome'],['content','Conteúdo'],['tags','Tags']]){
                    const label=document.createElement('label');label.className='cbm-mode-option';
                    const check=document.createElement('input');check.type='checkbox';
                    check.className='cbm-mode-input';check.dataset.mode=key;
                    check.setAttribute('aria-label',`Buscar em ${name.toLowerCase()}`);
                    check.checked=this.filterModes.has(key);
                    const indicator=document.createElement('span');indicator.className='cbm-mode-indicator';
                    indicator.setAttribute('aria-hidden','true');
                    const updateIndicator=()=>{indicator.textContent=check.checked?'☑':'☐';};
                    check.addEventListener('change',()=>{
                        if(check.checked)this.filterModes.add(key);
                        else this.filterModes.delete(key);
                        if(!this.filterModes.size){check.checked=true;this.filterModes.add(key);}
                        updateIndicator();
                        if(this.filterActive)this.applyFilter(input.value);
                    });
                    updateIndicator();
                    label.append(check,indicator,document.createTextNode(name));modes.appendChild(label);
                }
                panel.append(modes);
            }
            panel.append(statusRow);
            if(this.isChatGPT && header.parentElement) {
                const direction=getComputedStyle(header.parentElement).flexDirection;
                if(direction==='row'||direction==='row-reverse')header.insertBefore(panel,header.firstChild);
                else header.parentElement.insertBefore(panel,header);
            } else if(header.parentElement) header.parentElement.insertBefore(panel,header);
            else header.prepend(panel);
            selectAll.addEventListener('change',e=>{
                const ids=this.visibleIds();
                for(const id of ids){if(this.metadata.isProtected(id))continue;
                    if(e.target.checked)this.selectedIds.add(id);else this.selectedIds.delete(id);}
                this.refreshSelectedState();
            });
            archiveBtn.addEventListener('click',()=>this.runBulkAction('archive'));
            deleteBtn.addEventListener('click',()=>this.runBulkAction('delete'));
            stopBtn.addEventListener('click',()=>{this.stopRequested=true;this.setStatus('Parando…');});
            this.updateBusyIndicator();
            this.scheduleRender();
        }

        createActionButton(id,label){
            const btn=document.createElement('button');btn.type='button';btn.id=id;btn.className='bulk-btn';btn.textContent=label;
            return btn;
        }
        recordFromNode(node){
            const id=this.adapter.getNodeId(node);
            if(!id)return null;
            let title=(node.querySelector('[title]')?.getAttribute('title')||node.textContent||'').trim();
            title=title.replace(/\s+/g,' ').trim() || 'Sem título';
            return {id,title};
        }
        scanAndInject(){
            const nodes=this.adapter.getConversations();
            for(const node of nodes){
                this.adapter.injectCheckbox(node,(n,s)=>this.onSelectChange(n,s));
                if(this.isChatGPT)this.decorateConversation(node);
                if(this.isChatGPT){
                    const record=this.recordFromNode(node);
                    if(record && !this.records.has(record.id))this.records.set(record.id,record);
                }
            }
            this.injectPanel();
            if(this.filterActive){
                this.hideNativeRows(nodes);
                if(!document.getElementById('cbm-filter-section'))this.scheduleRender();
            }
            if(!this.isDeleting)this.updateStatus();
            this.refreshSelectedState(false);
        }
        startObserver(){
            this.scanAndInject();
            this.observer=new MutationObserver(()=>{
                clearTimeout(this.scanTimer);
                this.scanTimer=setTimeout(()=>this.scanAndInject(),190);
            });
            this.observer.observe(document.body,{childList:true,subtree:true});
        }
        onSelectChange(node,isSelected){
            const id=this.adapter.getNodeId(node);
            if(!id)return;
            if(this.metadata.isProtected(id)){
                this.selectedIds.delete(id);
                const cb=node.querySelector('.bulk-delete-checkbox');
                if(cb){cb.checked=false;cb.disabled=true;cb.title='Protegida contra exclusão e arquivamento';}
                this.setStatus('Interação protegida: não é possível selecioná-la para excluir ou arquivar.');
                this.refreshSelectedState();return;
            }
            if(isSelected)this.selectedIds.add(id);else this.selectedIds.delete(id);
            this.refreshSelectedState();
        }
        searchTokens(){return this.filterTerm.toLocaleLowerCase('pt-BR').split(/\s+/).filter(Boolean);}
        matchesTokens(text,tokens){
            const normalized=String(text||'').toLocaleLowerCase('pt-BR');
            return tokens.every(token=>normalized.includes(token));
        }
        visibleRecords(){
            const all=Array.from(this.records.values());
            if(!this.filterActive)return all;
            const tokens=this.searchTokens();
            return all.filter(record=>
                (this.filterModes.has('name')&&this.matchesTokens(record.title,tokens)) ||
                (this.filterModes.has('tags')&&this.matchesTokens(this.metadata.get(record.id).tags.join(' '),tokens)) ||
                (this.filterModes.has('content')&&this.contentMatched.has(record.id))
            ).sort((a,b)=>(b.updated||0)-(a.updated||0));
        }
        visibleIds(){
            if(!this.isChatGPT)return this.adapter.getConversations().map(n=>this.adapter.getNodeId(n)).filter(Boolean);
            return this.visibleRecords().map(x=>x.id);
        }
        refreshSelectedState(updateResults=true){
            const ids=this.visibleIds().filter(id=>!this.metadata.isProtected(id));
            const selected=ids.filter(id=>this.selectedIds.has(id)).length;
            const count=Array.from(this.selectedIds).filter(id=>!this.metadata.isProtected(id)).length;
            const archiveBtn=document.getElementById('bulk-archive-btn');
            const deleteBtn=document.getElementById('bulk-delete-btn');
            if(archiveBtn&&!this.isDeleting)archiveBtn.textContent=`Arquivar (${count})`;
            if(deleteBtn&&!this.isDeleting)deleteBtn.textContent=`Excluir (${count})`;
            const all=document.getElementById('bulk-select-all');
            if(all){all.checked=ids.length>0&&selected===ids.length;all.indeterminate=selected>0&&selected<ids.length;}
            for(const n of this.adapter.getConversations()){
                const cb=n.querySelector('.bulk-delete-checkbox');
                if(cb){
                    const id=this.adapter.getNodeId(n);const protectedRow=this.metadata.isProtected(id);
                    cb.disabled=protectedRow;
                    cb.title=protectedRow?'Protegida contra exclusão e arquivamento':'';
                    cb.checked=!protectedRow&&this.selectedIds.has(id);
                }
            }
            if(updateResults&&this.filterActive){
                document.querySelectorAll('#cbm-filter-results .cbm-result-row').forEach(row=>{
                    const cb=row.querySelector('input[type=checkbox]');
                    if(cb){const protectedRow=this.metadata.isProtected(row.dataset.id);
                        cb.disabled=protectedRow;cb.title=protectedRow?'Protegida contra exclusão e arquivamento':'';
                        cb.checked=!protectedRow&&this.selectedIds.has(row.dataset.id);}
                });
            }
        }
        setStatus(text){
            const el=document.getElementById('bulk-status');if(el&&el.textContent!==text)el.textContent=text;
            this.updateBusyIndicator();
        }
        updateBusyIndicator(){
            const indicator=document.getElementById('cbm-work-spinner');
            if(!indicator)return;
            const activity=this.isDeleting
                ? (this.currentAction==='archive'?'Arquivando interações':'Excluindo interações')
                :this.contentSearchRunning?'Verificando o conteúdo das interações'
                :this.historyLoading?'Carregando histórico'
                :this.grouping?'Organizando resultados':' ';
            indicator.hidden=activity===' ';
            indicator.title=activity.trim();
            indicator.setAttribute('aria-label',activity.trim()||'Sem operação em andamento');
        }
        setProtected(id,protectedState){
            if(!id || !this.isChatGPT)return;
            this.metadata.setProtected(id,protectedState);
            if(protectedState)this.selectedIds.delete(id);
            this.refreshSelectedState();
            if(this.filterActive)this.scheduleRender();
            const record=this.records.get(id);
            this.setStatus(`${record?.title||'Interação'}: ${protectedState?'proteção ativada':'proteção desativada'}.`);
            window.__cbmDiagnostics?.add('protecao-alterada',{protegida:!!protectedState},true);
        }
        updateStatus(){
            if(this.isDeleting)return;
            let text;
            if(this.filterActive){
                text=`${this.visibleRecords().length} interações filtradas de um total de ${this.records.size}`;
            }else{
                text=`${this.records.size} interações detectadas`;
            }
            if(this.historyLoading)text+=' (carregando histórico…)';
            if(this.filterActive&&this.filterModes.has('content')){
                if(this.contentSearchRunning)text+=` (conteúdo: ${this.contentSearchDone}/${this.contentSearchTotal} verificadas…)`;
                else if(this.contentSearchTotal>0)text+=` (conteúdo: ${this.contentSearchDone}/${this.contentSearchTotal} verificadas)`;
                if(this.contentSearchErrors)text+=` (${this.contentSearchErrors} falhas na leitura)`;
            }
            if(this.loadError)text+=' (histórico incompleto)';
            this.setStatus(text);
        }
        async loadHistory(){
            this.historyLoading=true;this.updateStatus();
            const limit=100;
            let offset=0;
            try{
                if(!this.adapter.accessToken)await this.adapter.fetchAccessToken();
                for(let page=0;page<500;page++){
                    const url=`https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated&is_archived=false`;
                    let payload=null;
                    for(let attempt=0;attempt<3;attempt++){
                        const res=await sendRequest({method:'GET',url,headers:{'Authorization':`Bearer ${this.adapter.accessToken}`,'Accept':'application/json'}});
                        if(res.status===429||res.status>=500){await delay(500*(attempt+1));continue;}
                        if(res.status<200||res.status>=300)throw new Error('HTTP '+res.status);
                        payload=JSON.parse(res.responseText);break;
                    }
                    if(!payload||!Array.isArray(payload.items))throw new Error('Formato de resposta inesperado');
                    const items=payload.items;
                    for(const item of items){
                        if(!item?.id)continue;
                        if(item.is_archived===true)continue;
                        this.records.set(item.id,{id:item.id,title:String(item.title||'Sem título'),updated:item.update_time||0});
                    }
                    offset+=items.length;
                    this.updateStatus();
                    if(this.filterActive)this.scheduleRender();
                    if(items.length===0)break;
                    if(items.length<limit && !(typeof payload.total==='number'&&offset<payload.total))break;
                    if(page===499)throw new Error('Limite de páginas de histórico atingido');
                    await delay(80);
                }
                this.historyComplete=true;
            }catch(error){
                this.loadError=error;
                window.__cbmDiagnostics?.fail('carregar-historico',error);
                warn('Não foi possível completar a detecção automática:',error);
            }finally{
                this.historyLoading=false;
                this.updateStatus();
                this.scheduleRender();
            }
        }
        applyFilter(value){
            const currentJob=++this.contentSearchJob; // Cancela a busca anterior (sem novas requisições).
            this.contentMatched=new Set();
            this.contentSearchRunning=false;
            this.contentSearchDone=0;this.contentSearchTotal=0;this.contentSearchErrors=0;
            this.filterTerm=String(value||'').trim();
            this.filterActive=Boolean(this.filterTerm);
            // Alterar ou remover o filtro não deve selecionar conversas de outra pesquisa.
            this.selectedIds.clear();
            const clear=document.getElementById('cbm-clear-filter');
            if(clear)clear.hidden=!this.filterActive;
            document.body.classList.toggle('cbm-filter-active',this.filterActive);
            if(!this.filterActive){
                document.querySelectorAll('.cbm-filter-hide').forEach(el=>el.classList.remove('cbm-filter-hide'));
                document.getElementById('cbm-filter-section')?.remove();
            }else{
                // A lista Filtradas é independente da seção Recentes.
                this.ensureFilterSection();
                this.hideNativeRows(this.adapter.getConversations());
            }
            this.scheduleRender();
            this.refreshSelectedState();
            this.updateStatus();
            if(this.filterActive&&this.filterModes.has('content')){
                this.searchConversationBodies(currentJob).catch(error=>{
                    if(currentJob!==this.contentSearchJob)return;
                    this.contentSearchRunning=false;
                    this.contentSearchErrors++;
                    warn('Falha na busca de conteúdo:',error);
                    this.updateStatus();
                });
            }
        }
        hideNativeRows(nodes){
            for(const a of nodes){
                if(a.closest('#cbm-filter-section'))continue;
                let row=a;
                for(let i=0;i<3;i++){
                    const p=row.parentElement;
                    if(!p||p.tagName==='NAV'||p.tagName==='ASIDE'||p.id==='cbm-filter-section')break;
                    const count=p.querySelectorAll('a[href*="/c/"]').length;
                    if(count!==1||p.getBoundingClientRect().height>85)break;
                    row=p;
                }
                row.classList.add('cbm-filter-hide');
            }
        }
        normalizedText(el){return (el?.textContent||'').replace(/\s+/g,' ').trim();}
        findSidebarHeading(regex){
            const items=Array.from(document.querySelectorAll('aside button,aside a,aside span,aside h2,aside h3,nav button,nav a,nav span,nav h2,nav h3,[role="navigation"] button,[role="navigation"] span'));
            return items.find(el=>{
                if(el.closest('#bulk-controls-panel,#cbm-filter-section,[data-cbm-explore-menu="true"]'))return false;
                const txt=this.normalizedText(el).replace(/[›>]/g,'').trim();
                const rect=el.getBoundingClientRect();
                return regex.test(txt)&&rect.left<420&&rect.width>0&&rect.height>0&&rect.height<85;
            })||null;
        }
        outerHeadingRow(el){
            if(!el)return null;
            let row=el.closest('button,a,[role="button"],h2,h3')||el;
            // Expandir só pelos wrappers da mesma linha, sem engolir grupos inteiros.
            for(let i=0;i<5;i++){
                const p=row.parentElement;
                if(!p||['ASIDE','NAV','BODY','MAIN'].includes(p.tagName)||p.id==='bulk-controls-panel')break;
                const r=p.getBoundingClientRect();
                if(r.height>89||r.width>520||p.querySelector('a[href*="/c/"]'))break;
                const current=this.normalizedText(row).replace(/[›>]/g,'').trim();
                const parent=this.normalizedText(p).replace(/[›>]/g,'').trim();
                if(parent!==current)break;
                row=p;
            }
            return row;
        }
        ensureFilterSection(){
            if(!this.filterActive)return null;
            let section=document.getElementById('cbm-filter-section');
            if(!section){
                section=document.createElement('section');
                section.id='cbm-filter-section';
                section.setAttribute('aria-label','Interações filtradas');
                const heading=document.createElement('button');
                heading.type='button';heading.id='cbm-filter-heading';
                heading.setAttribute('aria-expanded','true');
                heading.innerHTML='<span class="cbm-filter-caption">Filtradas</span><span class="cbm-chevron" aria-hidden="true">⌄</span>';
                const results=document.createElement('div');results.id='cbm-filter-results';
                section.append(heading,results);
                heading.addEventListener('click',()=>{
                    const expanded=heading.getAttribute('aria-expanded')!=='true';
                    heading.setAttribute('aria-expanded',String(expanded));
                    results.hidden=!expanded;
                    heading.querySelector('.cbm-chevron').textContent=expanded?'⌄':'›';
                });
            }
            // Insere a seção imediatamente antes de Fixados; se a seção foi retirada
            // pelo React, reconstrói-a após cada mudança relevante do DOM.
            const fixed=this.outerHeadingRow(this.findSidebarHeading(/^Fixados$/i));
            if(fixed && !section.contains(fixed) && fixed.parentElement && fixed!==section){
                if(section.parentElement!==fixed.parentElement||section.nextElementSibling!==fixed)
                    fixed.before(section);
                return section;
            }
            // Fallback: logo após Explorar, nunca dentro da linha de Recentes.
            const explore=this.outerHeadingRow(this.findSidebarHeading(/^(?:\.{3}\s*)?Explorar$/i));
            if(explore?.parentElement && !section.contains(explore)){
                if(section.previousElementSibling!==explore)explore.after(section);
                return section;
            }
            // Último recurso, no painel de ferramentas: a lista ainda fica acessível.
            const panel=document.getElementById('bulk-controls-panel');
            if(panel && !section.isConnected)panel.after(section);
            return section;
        }
        scheduleRender(){
            if(this.renderPending)return;
            this.renderPending=true;
            if(this.filterActive){this.grouping=true;this.updateBusyIndicator();}
            setTimeout(()=>{
                try{this.renderResults();}
                finally{this.renderPending=false;this.grouping=false;this.updateBusyIndicator();}
            },90);
        }
        renderResults(){
            if(!this.filterActive)return;
            const section=this.ensureFilterSection();
            if(!section)return;
            const results=section.querySelector('#cbm-filter-results');
            const records=this.visibleRecords();
            const caption=section.querySelector('.cbm-filter-caption');
            if(caption)caption.textContent=`Filtradas (${records.length})`;
            const fragment=document.createDocumentFragment();
            if(!records.length){
                const empty=document.createElement('div');empty.className='cbm-empty';
                empty.textContent='Nenhuma interação encontrada';fragment.appendChild(empty);
            }
            for(const record of records){
                const row=document.createElement('div');row.className='cbm-result-row';row.dataset.id=record.id;
                const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.className='bulk-delete-checkbox';
                const protectedRow=this.metadata.isProtected(record.id);
                checkbox.checked=!protectedRow&&this.selectedIds.has(record.id);
                checkbox.disabled=protectedRow;
                if(protectedRow)checkbox.title='Protegida contra exclusão e arquivamento';
                checkbox.setAttribute('aria-label',`Selecionar ${record.title}`);
                checkbox.addEventListener('change',e=>{
                    if(this.metadata.isProtected(record.id)){e.target.checked=false;return;}
                    if(e.target.checked)this.selectedIds.add(record.id);else this.selectedIds.delete(record.id);
                    this.refreshSelectedState();
                });
                const anchor=document.createElement('a');anchor.href=`/c/${encodeURIComponent(record.id)}`;
                anchor.textContent=record.title;anchor.title=record.title;
                row.append(checkbox,anchor);
                this.decorateConversation(anchor,record.id);
                fragment.appendChild(row);
            }
            results.replaceChildren(fragment);
            this.hideNativeRows(this.adapter.getConversations());
            this.refreshSelectedState();
        }
        // Recupera somente texto de mensagens na ramificação ativa da conversa.
        // A API da interface do ChatGPT é interna e pode mudar; falhas são exibidas.
        extractConversationText(data){
            const mapping=data?.mapping;
            if(!mapping || typeof mapping!=='object')return null;
            let nodes=[];
            if(data.current_node && mapping[data.current_node]){
                const visited=new Set();let id=data.current_node;
                while(id&&mapping[id]&&!visited.has(id)){
                    visited.add(id);nodes.push(mapping[id]);id=mapping[id].parent;
                }
                nodes.reverse();
            }else nodes=Object.values(mapping);
            const parts=[];
            for(const n of nodes){
                const message=n?.message;
                if(!message || !['user','assistant'].includes(message?.author?.role))continue;
                const content=message.content||{};
                for(const p of (Array.isArray(content.parts)?content.parts:[])){
                    if(typeof p==='string')parts.push(p);
                    else if(p&&typeof p==='object'&&typeof p.text==='string')parts.push(p.text);
                }
                if(typeof content.text==='string')parts.push(content.text);
            }
            return parts.join('\n');
        }
        async fetchBodyForSearch(id){
            if(this.contentCache.has(id))return this.contentCache.get(id);
            if(!this.adapter.accessToken)await this.adapter.fetchAccessToken();
            if(!this.adapter.accessToken)throw new Error('Sem autenticação');
            for(let attempt=0;attempt<3;attempt++){
                const res=await sendRequest({method:'GET',
                    url:`https://chatgpt.com/backend-api/conversation/${encodeURIComponent(id)}`,
                    headers:{'Authorization':`Bearer ${this.adapter.accessToken}`,'Accept':'application/json'}});
                if(res.status===401 && attempt===0){
                    this.adapter.accessToken='';await this.adapter.fetchAccessToken();
                    if(this.adapter.accessToken)continue;
                }
                if((res.status===429||res.status>=500)&&attempt<2){
                    await delay(700*Math.pow(2,attempt));continue;
                }
                if(res.status<200||res.status>=300)throw new Error(`HTTP ${res.status}`);
                let data;
                try{data=JSON.parse(res.responseText);}catch(_){throw new Error('Resposta inválida');}
                const text=this.extractConversationText(data);
                if(text===null)throw new Error('Formato do histórico de mensagens inesperado');
                this.contentCache.set(id,text);
                return text;
            }
            throw new Error('Tentativas esgotadas');
        }
        async searchConversationBodies(job){
            this.contentSearchRunning=true;
            this.updateStatus();
            // Aguarda conclusão do carregamento de títulos (inclui itens fora da barra lateral).
            try{if(this.historyPromise)await this.historyPromise;}catch(_){}
            if(job!==this.contentSearchJob)return;
            const ids=Array.from(this.records.keys());
            this.contentSearchTotal=ids.length;
            const tokens=this.searchTokens();
            let next=0;
            let errorExample='';
            const worker=async()=>{
                while(job===this.contentSearchJob){
                    const position=next++;
                    if(position>=ids.length)return;
                    const id=ids[position];
                    try{
                        const text=await this.fetchBodyForSearch(id);
                        if(job!==this.contentSearchJob)return;
                        if(this.matchesTokens(text,tokens))this.contentMatched.add(id);
                    }catch(error){
                        if(job!==this.contentSearchJob)return;
                        this.contentSearchErrors++;
                        errorExample=error.message||String(error);
                    }finally{
                        if(job===this.contentSearchJob){
                            this.contentSearchDone++;
                            if(this.contentSearchDone%5===0 || this.contentSearchDone===ids.length){
                                this.updateStatus();this.scheduleRender();
                            }
                        }
                    }
                    await delay(180);
                    // Falhas reiteradas, como API indisponível, interrompem a varredura.
                    if(this.contentSearchErrors>=12 && this.contentSearchDone<=30)return;
                }
            };
            await Promise.all(Array.from({length:Math.min(3,ids.length)},()=>worker()));
            if(job!==this.contentSearchJob)return;
            this.contentSearchRunning=false;
            if(this.contentSearchErrors>=12 && this.contentSearchDone<=30){
                this.setStatus(`Busca por conteúdo interrompida: ${errorExample||'erro de leitura'}. ${this.contentSearchDone}/${ids.length} verificadas.`);
                window.__cbmDiagnostics?.add('busca-conteudo-interrompida',{verificadas:this.contentSearchDone,erros:this.contentSearchErrors},true);
            }else this.updateStatus();
            this.scheduleRender();
        }
        decorateConversation(anchor,id){
            if(!this.isChatGPT)return;
            id=id||this.adapter.getNodeId(anchor);
            if(!id)return;
            // A versão 0.8.5 usa o menu nativo "...". Não adicionar um segundo ícone.
            anchor.querySelectorAll('.cbm-tag-edit').forEach(control=>control.remove());
            const meta=this.metadata.get(id);
            if(meta.color){
                anchor.classList.add('cbm-colored-title');
                anchor.style.setProperty('background-color',meta.color,'important');
            }else{
                anchor.classList.remove('cbm-colored-title');
                anchor.style.removeProperty('background-color');
            }
        }
        updateDecorations(){
            for(const a of this.adapter.getConversations())this.decorateConversation(a);
            for(const a of document.querySelectorAll('#cbm-filter-results a[href*="/c/"]'))this.decorateConversation(a);
        }
        openMetaDialog(id){
            if(!this.isChatGPT)return;
            document.getElementById('cbm-meta-overlay')?.remove();
            const meta=this.metadata.get(id);
            const record=this.records.get(id);
            const overlay=document.createElement('div');overlay.id='cbm-meta-overlay';
            const dialog=document.createElement('form');dialog.id='cbm-meta-dialog';
            dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');
            dialog.setAttribute('aria-label','Editar tags e cor');
            const title=document.createElement('h3');title.textContent='Tags e cor da interação';
            const subtitle=document.createElement('div');subtitle.className='cbm-meta-title';
            subtitle.textContent=record?.title||'Interação';subtitle.title=record?.title||'';
            const tagLabel=document.createElement('label');tagLabel.textContent='Tags (separe por vírgulas)';
            const tagInput=document.createElement('input');tagInput.type='text';tagInput.placeholder='Ex.: trabalho, UFBA, pesquisa';
            tagInput.value=(meta.tags||[]).join(', ');tagInput.autocomplete='off';
            tagLabel.appendChild(tagInput);
            const colorLabel=document.createElement('div');colorLabel.textContent='Cor de fundo (cores claras)';
            const swatches=document.createElement('div');swatches.className='cbm-swatches';
            let chosen=meta.color||'';
            const controls=[];
            const updateChoice=()=>{
                for(const [button,value] of controls)button.setAttribute('aria-pressed',String(chosen===value));
            };
            for(const [value,name] of CBM_COLORS){
                const button=document.createElement('button');button.type='button';button.className='cbm-swatch';
                button.title=name;button.setAttribute('aria-label',name);button.style.backgroundColor=value||'#fff';
                if(!value)button.textContent='×';
                button.addEventListener('click',()=>{chosen=value;updateChoice();});
                swatches.appendChild(button);controls.push([button,value]);
            }
            updateChoice();
            const customLabel=document.createElement('label');customLabel.className='cbm-custom-color';
            customLabel.textContent='Personalizar:';
            const custom=document.createElement('input');custom.type='color';custom.value=chosen||'#e3efff';
            custom.addEventListener('input',()=>{chosen=cbmLightColor(custom.value);updateChoice();});
            customLabel.appendChild(custom);
            const small=document.createElement('small');small.textContent='Cores escuras são clareadas automaticamente.';
            const buttons=document.createElement('div');buttons.className='cbm-meta-buttons';
            const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancelar';
            const save=document.createElement('button');save.type='submit';save.textContent='Salvar';
            buttons.append(cancel,save);
            dialog.append(title,subtitle,tagLabel,colorLabel,swatches,customLabel,small,buttons);
            overlay.appendChild(dialog);document.body.appendChild(overlay);
            const close=()=>{overlay.remove();document.removeEventListener('keydown',escape);};
            const escape=e=>{if(e.key==='Escape')close();};
            document.addEventListener('keydown',escape);
            overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
            cancel.addEventListener('click',close);
            dialog.addEventListener('submit',e=>{
                e.preventDefault();
                const tags=tagInput.value.split(',').map(x=>x.trim()).filter(Boolean);
                this.metadata.set(id,tags,chosen);
                close();
                this.updateDecorations();
                if(this.filterActive){this.scheduleRender();this.updateStatus();this.refreshSelectedState();}
            });
            tagInput.focus();
        }
        async requestChatGPTAction(id, action){
            if(this.metadata.isProtected(id))throw new Error('CBM_PROTECTED');
            if(!this.adapter.accessToken)await this.adapter.fetchAccessToken();
            if(!this.adapter.accessToken)throw new Error('Não foi possível autenticar');
            const url=`https://chatgpt.com/backend-api/conversation/${id}`;
            let lastStatus=0;
            for(let attempt=0;attempt<4;attempt++){
                if(this.stopRequested && attempt>0)throw new Error('Interrompido');
                if(this.metadata.isProtected(id))throw new Error('CBM_PROTECTED');
                const res=await sendRequest({method:'PATCH',url,
                    headers:{'Content-Type':'application/json','Authorization':`Bearer ${this.adapter.accessToken}`},
                    data:JSON.stringify(action==='archive'?{is_archived:true}:{is_visible:false})});
                lastStatus=res.status;
                if(res.status>=200&&res.status<300)return;
                if(res.status===401&&attempt===0){
                    this.adapter.accessToken='';
                    await this.adapter.fetchAccessToken();
                    if(this.adapter.accessToken)continue;
                }
                // O servidor pode limitar o número de solicitações. Reduzir a
                // velocidade progressivamente sem repetir erros definitivos.
                if(res.status===429 || res.status===503 || res.status>=500){
                    if(attempt===3)break;
                    const retryHeader=/^retry-after:\s*([^\r\n]+)/im.exec(res.responseHeaders||'');
                    const retrySecs=retryHeader?Number(retryHeader[1]):NaN;
                    const backoff=Number.isFinite(retrySecs)&&retrySecs>0
                        ? Math.min(15000,retrySecs*1000)
                        : Math.min(8000,700*Math.pow(2,attempt));
                    await delay(backoff);
                    continue;
                }
                throw new Error(`HTTP ${res.status}`);
            }
            throw new Error(`HTTP ${lastStatus} após tentativas`);
        }
        collapseDeletedRow(id){
            // O ChatGPT utiliza wrappers (às vezes virtualizados). Remover apenas
            // a âncora deixa o slot vazio. Ocultar o wrapper de um único item
            // evita esses buracos sem recarregar a conversa em uso.
            const node=this.adapter.findConversationById(id);
            if(!node)return;
            let wrapper=node;
            for(let p=node.parentElement,depth=0;p&&depth<6;p=p.parentElement,depth++){
                if(p.matches('nav,aside,main,[role="navigation"]')||
                    p.closest('#cbm-filter-section,#bulk-controls-panel'))break;
                if(p.querySelectorAll('a[href*="/c/"]').length!==1)break;
                const r=p.getBoundingClientRect();
                if(r.width>540||r.height>130||r.height<1)break;
                // Nunca colapsar estruturas que contenham um título de seção.
                if(p.querySelector('h1,h2,h3,[role="heading"]'))break;
                wrapper=p;
            }
            wrapper.classList.add('cbm-deleted-row');
            wrapper.setAttribute('aria-hidden','true');
            window.__cbmDiagnostics?.add('linha-excluida-ocultada',{
                nivel:wrapper===node?0:1,
                alturaAntes:Math.round(wrapper.getBoundingClientRect().height)
            },true);
        }
        async runBulkAction(action){
            if(this.isDeleting)return;
            const allowed=new Set(this.visibleIds());
            const allSelected=Array.from(this.selectedIds).filter(id=>allowed.has(id));
            const ids=allSelected.filter(id=>!this.metadata.isProtected(id));
            const ignoredProtected=allSelected.length-ids.length;
            for(const id of allSelected)if(this.metadata.isProtected(id))this.selectedIds.delete(id);
            if(!ids.length){this.setStatus(ignoredProtected
                ?`${ignoredProtected} interações protegidas: nenhuma será excluída ou arquivada.`
                :'Nenhuma interação selecionada');this.refreshSelectedState();return;}
            if(action==='delete'&&!window.confirm(`Confirma a exclusão de ${ids.length} interações selecionadas?`)){
                this.updateStatus();return;
            }
            window.__cbmDiagnostics?.add('lote-iniciado',{acao:action,quantidade:ids.length},true);
            this.isDeleting=true;this.currentAction=action;this.stopRequested=false;this.updateBusyIndicator();
            const archive=document.getElementById('bulk-archive-btn'),del=document.getElementById('bulk-delete-btn'),stop=document.getElementById('bulk-stop-btn');
            if(archive)archive.disabled=true;if(del)del.disabled=true;if(stop)stop.disabled=false;
            let successes=0, failures=0, started=0, active=0, skippedProtected=ignoredProtected;
            const total=ids.length;
            const word=action==='archive'?'Arquivando':'Excluindo';
            const refreshProgress=()=>this.setStatus(`${word}: ${successes+failures+skippedProtected-ignoredProtected}/${total} verificadas (${active} em andamento, ${failures} falhas, ${skippedProtected} protegidas ignoradas)`);
            try{
                if(this.isChatGPT){
                    // Obter a credencial antes de iniciar. Máximo de 3 chamadas
                    // simultâneas, espaçadas para evitar rajadas desnecessárias.
                    if(!this.adapter.accessToken)await this.adapter.fetchAccessToken();
                    if(!this.adapter.accessToken)throw new Error('Não foi possível autenticar');
                    let index=0;
                    let lastStart=0;
                    let startQueue=Promise.resolve();
                    const nextId=async()=>{
                        if(this.stopRequested||index>=total)return null;
                        const i=index++;
                        return ids[i];
                    };
                    const worker=async()=>{
                        while(!this.stopRequested){
                            // Serializar apenas a retirada da fila, não a resposta HTTP.
                            const id=await nextId();
                            if(!id)return;
                            let release;
                            const prior=startQueue;
                            startQueue=new Promise(resolve=>{release=resolve;});
                            await prior;
                            const wait=Math.max(0,CHATGPT_BULK_START_GAP_MS-(Date.now()-lastStart));
                            if(wait)await delay(wait);
                            if(this.stopRequested){release();return;}
                            if(this.metadata.isProtected(id)){
                                skippedProtected++;this.selectedIds.delete(id);release();refreshProgress();continue;
                            }
                            lastStart=Date.now();started++;active++;release();
                            refreshProgress();
                            try{
                                await this.requestChatGPTAction(id,action);
                                this.records.delete(id);
                                if(action==='delete')this.metadata.delete(id);
                                this.collapseDeletedRow(id);
                                this.selectedIds.delete(id);
                                successes++;
                            }catch(error){
                                if(error.message==='CBM_PROTECTED'){
                                    skippedProtected++;this.selectedIds.delete(id);
                                }else if(!this.stopRequested||error.message!=='Interrompido'){
                                    failures++;warn('Falha ao processar',id,error);
                                }
                            }finally{active--;refreshProgress();}
                        }
                    };
                    await Promise.all(Array.from({length:Math.min(CHATGPT_BULK_CONCURRENCY,total)},()=>worker()));
                }else{
                    // Gemini depende de menus e caixas de diálogo: manter em série.
                    for(let i=0;i<ids.length;i++){
                        if(this.stopRequested)break;
                        const id=ids[i];active=1;refreshProgress();
                        try{
                            const node=this.adapter.findConversationById(id);
                            if(!node)throw new Error('Interação não encontrada');
                            if(action==='archive')await this.adapter.archiveConversation(node);
                            else await this.adapter.deleteConversation(node);
                            this.selectedIds.delete(id);successes++;
                        }catch(error){failures++;warn('Falha ao processar',id,error);}
                        active=0;await delay(BULK_DELETE_INTERVAL_MS);
                    }
                }
            }catch(error){
                warn('Falha geral no lote',error);
                failures += Math.max(1,Math.min(total-successes-failures,1));
            }finally{
                this.isDeleting=false;this.currentAction=null;this.updateBusyIndicator();
                if(archive)archive.disabled=false;if(del)del.disabled=false;if(stop)stop.disabled=true;
                this.refreshSelectedState();
                if(this.filterActive)this.scheduleRender();
                this.updateStatus();
                window.__cbmDiagnostics?.add('lote-concluido',{acao:action,concluidas:successes,falhas:failures,interrompido:!!this.stopRequested},true);
                if(failures||this.stopRequested||skippedProtected){
                    this.setStatus(`${successes} concluídas, ${failures} falhas, ${skippedProtected} protegidas ignoradas${this.stopRequested?' (interrompido)':''}`);
                }
            }
        }
    }

    // Acrescenta "Tags e cor" ao menu nativo "..." de uma conversa, inclusive
    // quando o React cria o menu num portal fora da barra lateral.
    class ChatGPTNativeTagsMenu {
        constructor(manager){
            this.manager=manager;
            this.contextId='';this.contextTime=0;this.scanTimer=0;
            document.addEventListener('pointerdown',e=>this.rememberTrigger(e.target),true);
            // O bloqueio ocorre ainda na captura, antes dos handlers React.
            for(const type of ['pointerdown','mousedown','click','keydown']){
                document.addEventListener(type,e=>this.guardNativeAction(e),true);
            }
            document.addEventListener('click',e=>this.rememberTrigger(e.target),true);
            document.addEventListener('keydown',e=>{
                if((e.key==='Enter'||e.key===' ') &&
                   e.target?.closest?.('nav button,nav [role="button"]'))this.rememberTrigger(e.target);
            },true);
            this.observer=new MutationObserver(()=>this.schedule());
            this.observer.observe(document.body,{childList:true,subtree:true});
            this.scan();
        }
        guardNativeAction(event){
            if(event.type==='keydown' && !['Enter',' '].includes(event.key))return;
            if(!this.contextId || !this.manager.metadata.isProtected(this.contextId))return;
            const menu=this.findMenu();
            if(!menu || !menu.contains(event.target))return;
            const item=event.target.closest?.('button,[role="menuitem"],[data-slot*="menu-item"]');
            if(!item || item.closest('.cbm-native-meta-action'))return;
            const caption=this.normalize(item.textContent);
            if(!/^(Arquivar|Archive|Excluir|Delete)$/i.test(caption))return;
            event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
            this.manager.setStatus('Interação protegida: escolha "Permitir excluir ou arquivar" antes de continuar.');
        }
        normalize(text){return String(text||'').replace(/\s+/g,' ').trim();}
        visible(node){
            if(!node?.isConnected)return false;
            const r=node.getBoundingClientRect();
            return r.width>0&&r.height>0 && getComputedStyle(node).visibility!=='hidden';
        }
        getIdFromTrigger(target){
            const ctrl=target?.closest?.('button,[role="button"],a')||target;
            if(!ctrl || ctrl.closest?.('[role="menu"],#cbm-meta-overlay,#bulk-controls-panel'))return '';
            const direct=ctrl.closest?.('a[href*="/c/"]');
            if(direct){return getConversationIdFromHref(direct.getAttribute('href'));}
            // O botão "..." normalmente é irmão do link, no mesmo bloco da linha.
            for(let p=ctrl,n=0;p&&n<7;p=p.parentElement,n++){
                if(['BODY','NAV','ASIDE','MAIN'].includes(p.tagName))break;
                const rect=p.getBoundingClientRect();
                if(rect.height>96||rect.width>470)break;
                const links=Array.from(p.querySelectorAll('a[href*="/c/"]'));
                if(links.length===1)return getConversationIdFromHref(links[0].getAttribute('href'));
                if(links.length>1)break;
            }
            // Alternativa para botões posicionados por cima do link (sem ancestral comum).
            if(!ctrl.closest?.('nav,aside'))return '';
            const r=ctrl.getBoundingClientRect();
            if(r.left>490||r.width<=0||r.height<=0)return '';
            const mid=(r.top+r.bottom)/2;
            const nearby=Array.from(document.querySelectorAll('nav a[href*="/c/"]'))
                .filter(a=>{const b=a.getBoundingClientRect();return b.width>0&&Math.abs((b.top+b.bottom)/2-mid)<17;});
            return nearby.length===1?getConversationIdFromHref(nearby[0].getAttribute('href')):'';
        }
        rememberTrigger(target){
            if(!target?.closest)return;
            if(target.closest('.cbm-native-meta-action,#cbm-meta-overlay'))return;
            const ctrl=target.closest('button,[role="button"]');
            if(!ctrl)return;
            const id=this.getIdFromTrigger(ctrl);
            if(id){this.contextId=id;this.contextTime=Date.now();this.schedule();}
            else if(ctrl.closest('nav,aside')){this.contextId='';this.contextTime=0;}
        }
        schedule(){
            clearTimeout(this.scanTimer);
            this.scanTimer=setTimeout(()=>this.scan(),70);
        }
        findMenu(){
            const known=Array.from(document.querySelectorAll(
                '[role="menu"],[data-radix-menu-content],[data-slot="dropdown-menu-content"]'
            ));
            const valid=node=>{
                if(!this.visible(node))return false;
                const rect=node.getBoundingClientRect();
                if(rect.width>490||rect.height>650)return false;
                const t=this.normalize(node.textContent);
                return /Renomear|Rename/i.test(t)&&/Arquivar|Archive|Excluir|Delete/i.test(t);
            };
            const direct=known.find(valid);
            if(direct)return direct;
            // Alguns menus não expõem role="menu": localizar o menor popup com os comandos.
            const entries=Array.from(document.querySelectorAll('button,[role="menuitem"],div[data-slot*="menu-item"]'))
                .filter(node=>this.visible(node)&&/^(Renomear|Rename)$/i.test(this.normalize(node.textContent)));
            for(const el of entries){
                for(let p=el.parentElement,n=0;p&&n<5;p=p.parentElement,n++){
                    if(p===document.body)break;
                    if(valid(p))return p;
                }
            }
            return null;
        }
        alignWithNativeItem(template,item){
            // O menu nativo pode reservar espaço à esquerda para um ícone que fica
            // posicionado dentro de um wrapper. Quando criamos nossos próprios filhos,
            // essa reserva desloca ícone e texto. Medir a linha Renomear REAL evita
            // depender de valores fixos de padding que mudam conforme o ChatGPT.
            if(!template?.isConnected||!item?.isConnected)return;
            const targetIcon=item.querySelector('svg.cbm-meta-tag-icon');
            const targetLabel=item.querySelector('span.cbm-meta-label');
            if(!targetIcon||!targetLabel)return;
            const walker=document.createTreeWalker(template,NodeFilter.SHOW_TEXT);
            let sourceText=null;
            while(walker.nextNode()){
                if(/^(Renomear|Rename)$/i.test(this.normalize(walker.currentNode.nodeValue))){
                    sourceText=walker.currentNode;break;
                }
            }
            if(!sourceText)return;
            const range=document.createRange();
            range.selectNodeContents(sourceText);
            const sourceTextRect=range.getBoundingClientRect();
            const targetTextRect=targetLabel.getBoundingClientRect();
            const targetIconRect=targetIcon.getBoundingClientRect();
            if(sourceTextRect.width<=0||targetTextRect.width<=0||targetIconRect.width<=0)return;
            const sourceIcons=Array.from(template.querySelectorAll('svg'))
                .map(node=>node.getBoundingClientRect())
                .filter(rect=>rect.width>=9&&rect.width<=32&&rect.height>=9&&rect.height<=32
                    &&rect.left<sourceTextRect.left&&rect.right>0)
                .sort((a,b)=>b.left-a.left);
            // Sem SVG nativo legível, usar a coluna imediatamente antes do texto.
            const sourceIconLeft=sourceIcons.length?sourceIcons[0].left
                :sourceTextRect.left-targetIconRect.width-8;
            const iconDelta=sourceIconLeft-targetIconRect.left;
            const labelDelta=sourceTextRect.left-targetTextRect.left;
            if(Math.abs(iconDelta)>140||Math.abs(labelDelta)>140)return;
            targetIcon.style.setProperty('transform',`translateX(${iconDelta.toFixed(2)}px)`,'important');
            targetLabel.style.setProperty('transform',`translateX(${labelDelta.toFixed(2)}px)`,'important');
            item.dataset.cbmAligned='true';
        }
        scan(){
            if(!this.contextId || Date.now()-this.contextTime>16000)return;
            const menu=this.findMenu();
            if(!menu)return;
            const existing=menu.querySelector('.cbm-native-meta-action:not(.cbm-native-protection-action)');
            if(existing){
                existing.dataset.conversationId=this.contextId;
                const guard=menu.querySelector('.cbm-native-protection-action');
                if(guard){
                    guard.dataset.conversationId=this.contextId;
                    this.updateProtectionMenuAction(guard,this.contextId);
                    this.positionProtectionAboveArchive(menu,guard);
                    this.refreshNativeDestructiveActions(menu,this.contextId);
                    return;
                }
            }
            const options=Array.from(menu.querySelectorAll('[role="menuitem"],button,[data-slot*="menu-item"]'));
            const template=options.find(n=>/^(Renomear|Rename)$/i.test(this.normalize(n.textContent)));
            if(!template)return;
            // Clonar SOMENTE a linha externa. Clonar os filhos traz também o lápis
            // original, que alguns menus desenham por CSS ou em wrappers internos.
            // Construir ícone de etiqueta + texto novos garante exatamente um ícone.
            const item=template.cloneNode(false);
            item.classList.add('cbm-native-meta-action');
            item.setAttribute('role','menuitem');
            item.setAttribute('aria-label','Tags e cor');
            item.tabIndex=0;
            for(const attr of ['id','data-testid','data-state','data-highlighted',
                'data-disabled','disabled','aria-disabled','aria-labelledby','aria-describedby']){
                item.removeAttribute(attr);
            }
            item.removeAttribute('title');
            const ns='http://www.w3.org/2000/svg';
            const tagSvg=document.createElementNS(ns,'svg');
            tagSvg.classList.add('cbm-meta-tag-icon');
            tagSvg.setAttribute('viewBox','0 0 24 24');
            tagSvg.setAttribute('width','16');
            tagSvg.setAttribute('height','16');
            tagSvg.setAttribute('fill','none');
            tagSvg.setAttribute('stroke','currentColor');
            tagSvg.setAttribute('stroke-width','1.8');
            tagSvg.setAttribute('stroke-linecap','round');
            tagSvg.setAttribute('stroke-linejoin','round');
            tagSvg.setAttribute('aria-hidden','true');
            const outline=document.createElementNS(ns,'path');
            outline.setAttribute('d','M2.5 3h9l9.2 9.2a2 2 0 0 1 0 2.8l-5.7 5.7a2 2 0 0 1-2.8 0L3 11.5V3Z');
            const hole=document.createElementNS(ns,'circle');
            hole.setAttribute('cx','7.5');
            hole.setAttribute('cy','7.5');
            hole.setAttribute('r','1.5');
            tagSvg.append(outline,hole);
            const label=document.createElement('span');
            label.className='cbm-meta-label';
            label.textContent='Tags e cor';
            item.replaceChildren(tagSvg,label);
            item.dataset.conversationId=this.contextId;
            const open=e=>{
                e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
                // Fechar o popup do ChatGPT antes de abrir o editor próprio.
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
                const id=item.dataset.conversationId;
                if(id)this.manager.openMetaDialog(id);
            };
            item.addEventListener('click',open,true);
            item.addEventListener('keydown',e=>{
                if(e.key==='Enter'||e.key===' '){e.preventDefault();item.click();}
            });
            if(!existing)template.after(item);
            this.insertProtectionMenuAction(menu,template,existing||item);
            this.refreshNativeDestructiveActions(menu,this.contextId);
            // A posição é medida após inserir a linha, com o layout calculado.
            this.alignWithNativeItem(template,item);
            if(item.dataset.cbmAligned!=='true'){
                requestAnimationFrame(()=>this.alignWithNativeItem(template,item));
            }
        }
        findDestructiveMenuItems(menu){
            const entries=Array.from(menu.querySelectorAll('[role="menuitem"],button,[data-slot*="menu-item"]'));
            return entries.filter(item=>{
                if(item.classList.contains('cbm-native-meta-action'))return false;
                if(!/^(Arquivar|Archive|Excluir|Delete)$/i.test(this.normalize(item.textContent)))return false;
                // Não marcar wrappers pai quando há um item filho real.
                return !entries.some(child=>child!==item && item.contains(child) &&
                    /^(Arquivar|Archive|Excluir|Delete)$/i.test(this.normalize(child.textContent)));
            });
        }
        positionProtectionAboveArchive(menu,guard){
            const archive=this.findDestructiveMenuItems(menu).find(item=>
                /^(Arquivar|Archive)$/i.test(this.normalize(item.textContent)));
            // A linha separadora imediatamente anterior a Arquivar permanece no lugar.
            if(archive && guard!==archive.previousElementSibling){archive.before(guard);}
        }
        refreshNativeDestructiveActions(menu,id){
            const blocked=this.manager.metadata.isProtected(id);
            for(const item of this.findDestructiveMenuItems(menu)){
                if(blocked){
                    if(!item.classList.contains('cbm-native-action-disabled')){
                        item.dataset.cbmPreviousAriaDisabled=item.getAttribute('aria-disabled')??'__absent__';
                        item.dataset.cbmPreviousTitle=item.getAttribute('title')??'__absent__';
                    }
                    item.classList.add('cbm-native-action-disabled');
                    item.setAttribute('aria-disabled','true');
                    item.title='Interação protegida contra exclusão e arquivamento';
                }else if(item.classList.contains('cbm-native-action-disabled')){
                    item.classList.remove('cbm-native-action-disabled');
                    const previous=item.dataset.cbmPreviousAriaDisabled;
                    if(previous==='__absent__')item.removeAttribute('aria-disabled');
                    else if(previous!==undefined)item.setAttribute('aria-disabled',previous);
                    const oldTitle=item.dataset.cbmPreviousTitle;
                    if(oldTitle==='__absent__')item.removeAttribute('title');
                    else if(oldTitle!==undefined)item.setAttribute('title',oldTitle);
                    delete item.dataset.cbmPreviousAriaDisabled;
                    delete item.dataset.cbmPreviousTitle;
                }
            }
        }
        updateProtectionMenuAction(item,id){
            const blocked=this.manager.metadata.isProtected(id);
            const label=blocked?'Permitir excluir ou arquivar':'Impedir excluir ou arquivar';
            item.querySelector('.cbm-meta-label').textContent=label;
            item.setAttribute('aria-label',label);
            const svg=item.querySelector('svg.cbm-meta-tag-icon');
            // Cadeado fechado = impedir; cadeado aberto = permitir.
            if(svg)svg.innerHTML=blocked
                ?'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 6.8-2.8"/>'
                :'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>';
            item.dataset.protected=String(blocked);
        }
        insertProtectionMenuAction(menu,template,after){
            let item=menu.querySelector('.cbm-native-protection-action');            if(item){
                item.dataset.conversationId=this.contextId;
                this.updateProtectionMenuAction(item,this.contextId);
                this.positionProtectionAboveArchive(menu,item);
                return;
            }
            item=template.cloneNode(false);
            item.classList.add('cbm-native-meta-action','cbm-native-protection-action');
            item.setAttribute('role','menuitem');item.tabIndex=0;
            for(const attr of ['id','data-testid','data-state','data-highlighted','data-disabled',
                'disabled','aria-disabled','aria-labelledby','aria-describedby'])item.removeAttribute(attr);
            item.removeAttribute('title');
            const ns='http://www.w3.org/2000/svg';
            const svg=document.createElementNS(ns,'svg');
            svg.classList.add('cbm-meta-tag-icon');
            for(const [k,v] of Object.entries({'viewBox':'0 0 24 24','width':'16','height':'16',
                'fill':'none','stroke':'currentColor','stroke-width':'1.8','stroke-linecap':'round',
                'stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(k,v);
            const label=document.createElement('span');label.className='cbm-meta-label';
            item.append(svg,label);item.dataset.conversationId=this.contextId;
            this.updateProtectionMenuAction(item,this.contextId);
            const toggle=e=>{
                e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
                document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));
                const id=item.dataset.conversationId;
                if(id){
                    this.manager.setProtected(id,!this.manager.metadata.isProtected(id));
                    this.updateProtectionMenuAction(item,id);
                    this.refreshNativeDestructiveActions(menu,id);
                }
            };
            item.addEventListener('click',toggle,true);
            item.addEventListener('keydown',e=>{
                if(e.key==='Enter'||e.key===' '){e.preventDefault();item.click();}
            });
            after.after(item);
            this.positionProtectionAboveArchive(menu,item);
            // Espaço para o rótulo completo, sem quebrar a linha do menu nativo.
            menu.style.minWidth='min(280px, calc(100vw - 20px))';
            this.alignWithNativeItem(template,item);
            if(item.dataset.cbmAligned!=='true')requestAnimationFrame(()=>this.alignWithNativeItem(template,item));
        }
    }

    // Botão global que acompanha o download das janelas laterais de texto.
    // É fixado por coordenadas para não depender do layout interno React.
    // Cópia na visualização lateral. Encontra os ícones do cabeçalho
    // mesmo quando o ChatGPT usa elementos sem rótulos ou wrappers não-botão.
    class ChatGPTPreviewCopy {
        constructor(){
            this.button=null;this.source=null;this.pending=false;this.lastFileLink=null;
            document.addEventListener('click', event => {
                const link=event.target?.closest?.('a[href]');
                if(!link)return;
                const href=link.getAttribute('href')||'';
                if(/^(sandbox:|blob:)|\/backend-api\/(?:estuary\/content|files\/download)|\.(?:txt|user\.js|js|json|md|csv|xml)(?:[?#]|$)/i.test(href)){
                    this.lastFileLink={href,time:Date.now()};
                }
            },true);
            addStyle(`
                #cbm-global-preview-copy {position:fixed !important;display:flex;align-items:center;justify-content:center;
                    box-sizing:border-box;width:36px;height:36px;border:0;border-radius:999px;padding:0 !important;
                    background:var(--main-surface-primary,#fff) !important;color:var(--text-primary,#222) !important;
                    box-shadow:0 1px 6px rgba(0,0,0,.08) !important;z-index:2147483647 !important;cursor:pointer !important;}
                #cbm-global-preview-copy:hover {background:var(--token-surface-hover,#eee) !important;}
                #cbm-global-preview-copy svg{height:19px;width:19px;stroke:currentColor;}
                #cbm-global-preview-copy[data-state="ok"]{color:#078153 !important;}
                #cbm-global-preview-copy[data-state="error"]{color:#bc3434 !important;}
            `);
            this.scan();
            this.observer=new MutationObserver(()=>this.schedule());
            this.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-label','title','data-state']});
            window.addEventListener('resize',()=>this.schedule());
            this.timer=setInterval(()=>this.scan(),800);
        }
        icon(){return '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';}
        check(){return '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>';}
        schedule(){if(this.pending)return;this.pending=true;setTimeout(()=>{this.pending=false;this.scan();},130);}
        visible(el){if(!el?.isConnected)return false;const r=el.getBoundingClientRect();return r.width>9&&r.height>9&&r.top>=-5&&r.top<128&&r.left>=innerWidth*.36&&r.right<=innerWidth+8;}
        metadata(el){return ['aria-label','title','data-testid','data-tooltip'].map(k=>el?.getAttribute?.(k)||'').join(' ').toLowerCase();}
        svgPaths(svg){return Array.from(svg?.querySelectorAll('path,polyline,line')||[]).map(n=>n.getAttribute('d')||n.getAttribute('points')||'').join(' ').toLowerCase();}
        isDownload(el){
            const svg=el?.matches?.('svg')?el:el?.querySelector?.('svg');
            const attrs=this.metadata(el)+' '+this.metadata(svg);
            if(/download|baixar|descargar|arrow.down.to.line/.test(attrs))return true;
            const paths=this.svgPaths(svg);
            return /m12\s*[, ]\s*(?:2|3|4)\s*v(?:1[01234])/.test(paths)&&/m(?:4|5|19|20|21)\s*[, ]\s*(?:18|20|21)/.test(paths)
                || /m7\s*[, ]\s*10l5\s*[, ]\s*5l5\s*[, ]\s*-5/.test(paths);
        }
        isClose(el){
            const svg=el?.matches?.('svg')?el:el?.querySelector?.('svg');
            const attrs=this.metadata(el)+' '+this.metadata(svg);
            if(/close|fechar|dismiss|lucide-x/.test(attrs))return true;
            const d=this.svgPaths(svg);
            return /m18\s*6\s*6\s*18/.test(d) || /m18\s*[, ]\s*6l6\s*[, ]\s*18/.test(d);
        }
        // Coleta os ícones SVG por posição, além dos botões. Não pressupõe
        // que o elemento clicável do React seja um <button>.
        headerIcons(){
            const found=[];
            const roots=[document];
            for(let i=0;i<roots.length&&i<35;i++){
                const root=roots[i];
                try{
                    for(const node of root.querySelectorAll('*')){
                        if(node.shadowRoot && roots.length<35)roots.push(node.shadowRoot);
                    }
                    // Captura os elementos clicáveis primeiro; muitos ícones SVG não
                    // têm tamanho CSS próprio e só o botão possui geometria confiável.
                    for(const el of root.querySelectorAll('button,[role="button"],a[download]')){
                        if(el.closest('#cbm-global-preview-copy,#bulk-controls-panel'))continue;
                        if(!this.visible(el))continue;
                        const r=el.getBoundingClientRect();
                        if(r.width>75||r.height>75||r.width<15)continue;
                        found.push({el,svg:el.querySelector('svg'),r,rect:r});
                    }
                    // Ícones não contidos em um controle semântico.
                    for(const svg of root.querySelectorAll('svg')){
                        if(svg.closest('#cbm-global-preview-copy,#bulk-controls-panel')||svg.closest('button,[role="button"],a[download]'))continue;
                        if(!this.visible(svg))continue;
                        const r=svg.getBoundingClientRect();
                        if(r.width>31||r.height>31)continue;
                        const clickable=svg.closest('[tabindex="0"],a')||svg.parentElement;
                        if(!clickable||clickable.closest('#bulk-controls-panel'))continue;
                        const rect=clickable.getBoundingClientRect();
                        if(rect.width>100||rect.height>85||rect.width<13)continue;
                        found.push({el:clickable,svg,r,rect});
                    }
                }catch(_){/* Shadow DOM protegido */}
            }
            return found.sort((a,b)=>a.r.left-b.r.left);
        }
        identifyToolbar(){
            const icons=this.headerIcons();
            const align=(a,b)=>Math.abs(a.r.top-b.r.top)<18;
            // Prioriza um botão explicitamente rotulado ou desenhado como download.
            for(const a of icons.filter(x=>this.isDownload(x.el)||this.isDownload(x.svg))){
                const later=icons.filter(x=>x!==a&&x.r.left>a.r.left+13&&x.r.left-a.r.left<150&&align(x,a));
                if(later.length>=1 && later.some(x=>this.isClose(x.el)||this.isClose(x.svg)||x.r.right>innerWidth-65)){
                    return {left:a.rect.left,top:a.rect.top,height:a.rect.height,source:a.el};
                }
            }
            // O visor lateral sempre tem trio alinhado: baixar, expandir, fechar.
            // O alvo é o primeiro ícone à esquerda nesse trio, perto da margem direita.
            for(let i=icons.length-1;i>=2;i--){
                const c=icons[i];if(c.r.right<innerWidth-100)continue;
                for(let j=i-1;j>=1;j--){
                    const b=icons[j];const dx=c.r.left-b.r.left;
                    if(dx>100)break;
                    if(dx<18||dx>78||!align(b,c))continue;
                    for(let k=j-1;k>=0;k--){
                        const a=icons[k];const dx2=b.r.left-a.r.left;
                        if(dx2>100)break;
                        if(dx2<18||dx2>78||!align(a,b))continue;
                        if(a.r.top>99||Math.abs(dx-dx2)>28)continue;
                        return {left:a.rect.left,top:a.rect.top,height:a.rect.height,source:a.el};
                    }
                }
            }
            return null;
        }
        hasViewer(toolbar){
            if(!toolbar)return false;
            // Com um botão de download inequivocamente identificado, o grupo
            // de controles no canto superior direito já identifica a prévia.
            const source=toolbar.source;
            if(this.isDownload(source))return true;
            const selectors='[data-testid*="preview"],[data-testid*="artifact"],.cm-editor,.monaco-editor,[data-language],pre code,pre,.shiki';
            return Array.from(document.querySelectorAll(selectors)).some(el=>{
                const r=el.getBoundingClientRect();
                return r.width>140 && r.left>innerWidth*.28 && r.height>15 && r.bottom>90 && r.top<innerHeight;
            }) || Boolean(document.querySelector('[data-testid*="file-viewer"],[data-testid*="file-preview"]'));
        }
        ensureButton(){
            if(this.button?.isConnected)return this.button;
            const b=document.createElement('button');b.type='button';b.id='cbm-global-preview-copy';
            b.title='Copiar todo o texto';b.setAttribute('aria-label','Copiar todo o texto');b.innerHTML=this.icon();
            b.addEventListener('click',async e=>{
                e.preventDefault();e.stopPropagation();if(b.disabled)return;
                b.disabled=true;
                try{
                    window.__cbmDiagnostics?.add('copia-iniciada',{fontes:this.sources().length,raizes:this.viewerRoots().length},true);
                    const text=await this.findCompleteText();
                    if(typeof text!=='string'||!text.length)throw new Error('Conteúdo completo não encontrado');
                    if(typeof GM_setClipboard==='function')GM_setClipboard(text,'text');
                    else await navigator.clipboard.writeText(text);
                    window.__cbmDiagnostics?.add('copia-realizada',{caracteres:text.length},true);
                    b.dataset.state='ok';b.title='Texto copiado';b.innerHTML=this.check();
                }catch(err){
                    window.__cbmDiagnostics?.fail('copiar-texto',err);
                    warn('Não foi possível copiar o conteúdo completo:',err);
                    b.dataset.state='error';b.title='Não foi possível acessar o texto completo';b.innerHTML=this.icon();
                }
                setTimeout(()=>{if(!b.isConnected)return;b.disabled=false;b.dataset.state='';b.innerHTML=this.icon();b.title='Copiar todo o texto';},1900);
            });
            document.body.appendChild(b);this.button=b;return b;
        }
        scan(){
            const toolbar=this.identifyToolbar();
            if(!this.hasViewer(toolbar)){
                if(this.button)this.button.style.display='none';this.source=null;return;
            }
            const b=this.ensureButton();
            // Deixa exatamente uma casa de 38px à esquerda do download.
            b.style.left=`${Math.max(0,toolbar.left-40)}px`;
            b.style.top=`${Math.max(0,toolbar.top+(toolbar.height-36)/2)}px`;
            b.style.display='flex';this.source=toolbar.source;
        }
        // Encontra o visor em vez de depender de que o texto esteja em <pre>.
        // O ChatGPT usa tanto a janela "screen-threadFlyOut" quanto visualizadores
        // "walnut-sandbox-text-preview" para arquivos de texto anexados.
        viewerRoots(){
            const all=Array.from(document.querySelectorAll(
                '[data-testid="screen-threadFlyOut"],[id^="walnut-sandbox-text-preview-"],'+
                '[data-testid*="file-preview"],[data-testid*="artifact-preview"],'+
                '[data-testid*="file-viewer"]'));
            // Evitar selecionar um card da conversa atrás da janela lateral.
            return all.filter(n=>{
                const r=n.getBoundingClientRect();
                return r.width>120 && r.height>60 && r.right>innerWidth*.52 && r.top<innerHeight && r.bottom>70;
            }).sort((a,b)=>b.getBoundingClientRect().right-a.getBoundingClientRect().right);
        }
        sources(){
            const selector=[
                '.cm-editor .cm-content', '.cm-content', '.monaco-editor .view-lines',
                '.view-lines', 'pre code','pre','.shiki','[data-language] code',
                'textarea[readonly]', '[role="textbox"]',
                '[data-testid*="file-preview"] code', '[id^="walnut-sandbox-text-preview-"] code'
            ].join(',');
            const roots=this.viewerRoots();
            const nodes=[];const seen=new Set();
            for(const root of roots){
                for(const n of root.querySelectorAll(selector)){
                    if(seen.has(n))continue;
                    seen.add(n);nodes.push(n);
                }
            }
            // Também aceita visualizações sem wrapper reconhecido, mas só
            // quando o texto está claramente na metade da tela do arquivo.
            if(!nodes.length){
                for(const n of document.querySelectorAll(selector)){
                    const r=n.getBoundingClientRect();
                    if(r.width>20 && r.left>innerWidth*.38 && r.right>innerWidth*.52 && r.bottom>70){
                        if(!seen.has(n)){seen.add(n);nodes.push(n);}
                    }
                }
            }
            // O texto de código pode ter várias linhas em spans; priorizar CM.
            return nodes.sort((a,b)=>{
                const rank=n=>n.matches('.cm-content')?0:n.matches('.view-lines')?1:n.matches('pre code')?2:n.matches('pre')?3:4;
                return rank(a)-rank(b);
            });
        }
        extractCM(n){
            const editor=n.closest('.cm-editor');
            const testCandidates=[n,editor,editor?.querySelector('.cm-content')].filter(Boolean);
            for(const candidate of testCandidates){
                for(const obj of [candidate.cmView,candidate.view,candidate.editorView,candidate.CodeMirror]){
                    const doc=obj?.view?.state?.doc || obj?.rootView?.view?.state?.doc ||
                              obj?.state?.doc || obj?.doc;
                    if(doc?.toString){const value=doc.toString();if(value)return value;}
                }
            }
            // Não copiar apenas as linhas visíveis em editores virtualizados.
            if(editor?.querySelector('.cm-gap,.cm-virtual-gap,.cm-placeholder'))return null;
            const lines=Array.from(editor?.querySelectorAll('.cm-line')||[]);
            if(lines.length)return lines.map(x=>x.textContent).join('\n');
            // Alguns visualizadores utilizam spans para sintaxe, sem .cm-line.
            return n.innerText || n.textContent || null;
        }
        async readInIframe(){
            const frames=Array.from(document.querySelectorAll('iframe')).filter(frame=>{
                const r=frame.getBoundingClientRect();
                return r.width>100 && r.height>50 && r.right>innerWidth*.50;
            });
            const diagnostics=window.__cbmDiagnostics;
            if(!frames.length)return '';
            diagnostics?.add('ponte-iframe-iniciada',{quantidade:frames.length},true);
            for(const frame of frames){
                const token=(crypto.randomUUID?.()||`${Date.now()}-${Math.random()}`).replaceAll('-', '');
                const reply=await new Promise(resolve=>{
                    let finished=false;
                    const finish=data=>{
                        if(finished)return;finished=true;
                        clearTimeout(timeout);window.removeEventListener('message',onReply);
                        resolve(data);
                    };
                    const onReply=event=>{
                        if(event.source !== frame.contentWindow)return;
                        const payload=event.data;
                        if(!payload||payload.type!==CBM_FRAME_REPLY||payload.token!==token)return;
                        // Conteúdo só vem do iframe endereçado. Origem sandboxada pode ser 'null'.
                        if(event.origin!=='null' && !/^https:\/\/(?:[a-z0-9-]+\.)*oaiusercontent\.com$/i.test(event.origin))return;
                        finish(payload);
                    };
                    window.addEventListener('message',onReply);
                    const timeout=setTimeout(()=>finish(null),900);
                    try{frame.contentWindow?.postMessage({type:CBM_FRAME_REQ,token},'*');}
                    catch(_){finish(null);}
                });
                if(reply?.ok && typeof reply.text==='string' && reply.text.trim()){
                    diagnostics?.add('ponte-iframe-respondeu',{caracteres:reply.text.length},true);
                    return reply.text;
                }
                diagnostics?.add('ponte-iframe-sem-texto',{respondeu:!!reply},true);
            }
            return '';
        }
        async fetchClickedFile(){
            const candidate=this.lastFileLink;
            if(!candidate || Date.now()-candidate.time>180000)return '';
            let url;
            try{url=new URL(candidate.href,location.href);}catch(_){return '';}
            if(url.protocol!=='http:'&&url.protocol!=='https:' && url.protocol!=='blob:')return '';
            if(url.protocol!=='blob:' && url.origin!==location.origin)return '';
            const diag=window.__cbmDiagnostics;
            diag?.add('arquivo-clicado-candidato',{urlElegivel:true},true);
            try{
                const ctrl=new AbortController();
                const timer=setTimeout(()=>ctrl.abort(),6500);
                let response;
                try{response=await fetch(url.href,{credentials:'include',signal:ctrl.signal});}
                finally{clearTimeout(timer);}
                const type=(response.headers.get('content-type')||'').toLowerCase();
                const size=Number(response.headers.get('content-length')||0);
                if(!response.ok || size>5_000_000 || /text\/html/.test(type))return '';
                if(!/(text|javascript|json|xml|octet-stream)/.test(type) && !/\.(txt|js|json|md|csv|xml)/i.test(url.pathname))return '';
                const bytes=await response.arrayBuffer();
                if(bytes.byteLength>5_000_000)return '';
                const txt=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
                if(txt.includes('\0'))return '';
                if(txt.trim())diag?.add('arquivo-recuperado-completo',{caracteres:txt.length},true);
                return txt;
            }catch(error){
                diag?.add('arquivo-clicado-inacessivel',{tipoErro:error.name||'erro'},true);
                return '';
            }
        }
        // Descoberto pelo diagnóstico real v0.8.1: o ChatGPT mostra arquivos TXT
        // num DIV .text-base.leading-7.wrap-anywhere.whitespace-pre-wrap, com todo
        // o texto num nó DOM de altura muito grande. Os seletores anteriores não
        // reconheciam este elemento, apesar de ele ter 110.060 caracteres.
        readNativePlainTextPreview(){
            const diag=window.__cbmDiagnostics;
            const buttonRect=this.source?.getBoundingClientRect();
            if(!buttonRect || buttonRect.width<10)return '';
            const candidates=Array.from(document.querySelectorAll(
                'div.text-base.leading-7.wrap-anywhere.whitespace-pre-wrap,div.whitespace-pre-wrap'
            ));
            const matches=[];
            for(const el of candidates){
                if(el.closest('nav,#bulk-controls-panel,#cbm-diag-panel,#cbm-filter-section'))continue;
                if(el.contains(this.source))continue;
                const r=el.getBoundingClientRect();
                // A prévia deve estar abaixo dos ícones de download, na zona
                // direita da tela. Assim evitamos copiar texto do chat principal.
                const minLeft=Math.max(innerWidth*.42,buttonRect.left-1000);
                const minRight=Math.max(innerWidth*.68,buttonRect.left-300);
                if(r.left<minLeft||r.right<minRight||r.width<120||
                    r.top<35||r.top>innerHeight-55||r.bottom<110)continue;
                const cls=el.classList;
                const strongMatch=cls.contains('leading-7')&&cls.contains('wrap-anywhere');
                const len=el.textContent?.length||0;
                if(!strongMatch && len<35)continue;
                if(!len||len>5_000_000)continue;
                // Uma área de texto virtualizada tende a ter poucas linhas no DOM
                // e um espaçador alto; não alegar cópia completa nesse caso.
                if(el.querySelector('.cm-gap,.cm-virtual-gap,[data-virtualizer],[data-virtualized]'))continue;
                matches.push({el,len,r,strongMatch});
            }
            matches.sort((a,b)=>Number(b.strongMatch)-Number(a.strongMatch)||
                b.len-a.len||a.r.width-b.r.width);
            diag?.add('previsualizacao-html-simples',{
                candidatas:candidates.length,elegiveis:matches.length,
                maiorFonte:matches[0]?.len||0
            },true);
            if(!matches.length)return '';
            const item=matches[0],el=item.el;
            // Para texto dentro de um nó pré-formatado, textContent preserva
            // inclusive espaços, tabs e quebras de linha fora da parte visível.
            // Se houver elementos filhos renderizados como linhas, innerText
            // preserva as quebras visuais entre esses elementos.
            const text=el.children.length>0 ? (el.innerText||el.textContent||'') : (el.textContent||'');
            if(!text.trim())return '';
            diag?.add('copia-fonte-texto-html-identificada',{
                caracteres:text.length,alturaTotal:Math.round(item.r.height),
                via:'div-whitespace-pre-wrap'
            },true);
            return text.replace(/\r\n/g,'\n');
        }
        // Explora diretamente a parte visível da janela lateral. Na interface
        // mais recente, um arquivo TXT pode estar em DIVs comuns, não em
        // <pre>, <code>, CodeMirror, Monaco ou iframe. Nunca inspeciona o
        // conteúdo do chat à esquerda ou da caixa de mensagens.
        geometryCandidates(){
            const bar=this.source?.getBoundingClientRect();
            if(!bar||bar.width<10)return [];
            const minLeft=Math.max(innerWidth*.27,Math.min(innerWidth*.48,bar.left-1050));
            const xs=[minLeft+95,(minLeft+bar.left)/2,bar.left-125]
                .map(v=>Math.round(Math.min(bar.left-45,Math.max(minLeft+25,v))));
            const ys=[120,185,260,Math.round(innerHeight*.45),Math.round(innerHeight*.72)]
                .filter(y=>y>70 && y<innerHeight-35);
            const visited=new Set();const arr=[];
            const accept=el=>{
                if(!(el instanceof Element)||visited.has(el))return;
                visited.add(el);
                if(el.closest('#cbm-global-preview-copy,#bulk-controls-panel,#cbm-diag-panel,nav,aside'))return;
                const r=el.getBoundingClientRect();
                if(r.left<minLeft-80||r.right<bar.left-60||r.width<155||r.height<10||r.top>innerHeight-65||r.bottom<90)return;
                if(el===document.documentElement||el===document.body)return;
                const len=el.textContent?.length||0;
                if(!len||len>3000000)return;
                const style=getComputedStyle(el);
                const classes=(typeof el.className==='string'?el.className:'').toLowerCase();
                const mono=/mono|consolas|courier|code|source/i.test(style.fontFamily+' '+classes);
                const whitespace=/(pre|break-spaces)/.test(style.whiteSpace)||/whitespace-pre|text-preview|code-view|file-content/.test(classes);
                if(r.height<65 && !mono && !whitespace)return;
                if(len<80 && !mono && !whitespace)return;
                const scroll=el.scrollHeight>el.clientHeight+35 && /(auto|scroll)/.test(style.overflowY);
                const toolbar=el.contains(this.source);
                const numButtons=el.querySelectorAll('button,[role="button"]').length;
                const widthRange=Math.max(0,r.right-Math.max(minLeft,r.left));
                const nearTop=r.top>48;
                let score=(mono?16:0)+(whitespace?23:0)+(scroll?10:0)+(nearTop?6:0)
                    +(len>=250?8:0)+(len>=700?5:0)+(r.left>minLeft?4:0)
                    +(widthRange>240?4:0)-(toolbar?27:0)-Math.min(25,numButtons*4);
                if(r.width>innerWidth*.80)score-=18;
                if(r.height<90)score-=3;
                arr.push({el,score,caracteres:len,mono,whitespace,scroll,toolbar});
            };
            for(const x of xs)for(const y of ys){
                let hit=document.elementFromPoint(x,y);
                // Penetra apenas Shadow DOM abertos, sem acessar frames remotos.
                for(let depth=0;hit&&depth<4;depth++){
                    for(let cur=hit,parents=0;cur&&parents<15;cur=cur.parentElement,parents++)accept(cur);
                    if(!hit.shadowRoot)break;
                    hit=hit.shadowRoot.elementFromPoint(x,y);
                }
            }
            // Inclui contêineres semânticos e de fonte monoespaçada que podem
            // ficar parcialmente cobertos por uma camada transparente.
            const selectors='[class*="whitespace-pre"],[class*="font-mono"],'+
                '[class*="overflow-y-auto"],[class*="text-preview"],'+
                '[class*="code-view"],[class*="file-content"],'+
                '[style*="white-space: pre"],[role="document"]';
            for(const el of document.querySelectorAll(selectors))accept(el);
            return arr.sort((a,b)=>b.score-a.score||b.caracteres-a.caracteres).slice(0,35);
        }
        geometryDiagnostics(){
            return this.geometryCandidates().slice(0,8).map(c=>({
                ...window.__cbmDiagnostics?.safeShape(c.el),
                pontuacao:c.score,monoespacado:c.mono,preFormatado:c.whitespace,
                rolagem:c.scroll,contemBarraFerramentas:c.toolbar,
                totalFilhos:c.el.children.length
            }));
        }
        readFromVisiblePreview(){
            const list=this.geometryCandidates();
            const diag=window.__cbmDiagnostics;
            diag?.add('inspecao-geometrica',{candidatos:list.length,melhorPontuacao:list[0]?.score??0},true);
            for(const c of list){
                // Não pegar o chat à esquerda ou o wrapper do painel inteiro.
                if(c.score<16||c.toolbar)continue;
                const el=c.el;
                if(el.querySelector('.cm-gap,.cm-virtual-gap,[data-virtualizer],[data-virtualized]'))continue;
                const text=el.innerText||el.textContent||'';
                if(!text.trim() || (text.trim().length<100 && !c.whitespace && !c.mono))continue;
                // Se a área rolável é enorme mas só existem poucas linhas
                // representadas, pode ser um editor virtualizado: não copiar
                // um fragmento alegando que está completo.
                const lines=text.split(/\r?\n/).length;
                if(c.scroll && el.scrollHeight>el.clientHeight*4 && lines<6)continue;
                // Proteção adicional contra prévias virtualizadas: se o bloco
                // com texto ocupa apenas uma pequena parte da área de rolagem,
                // não presumir que representa o arquivo inteiro.
                let scrollParent=el.parentElement;
                while(scrollParent && scrollParent!==document.body && scrollParent!==document.documentElement){
                    const sty=getComputedStyle(scrollParent);
                    if(scrollParent.scrollHeight>scrollParent.clientHeight+80 && /(auto|scroll)/.test(sty.overflowY))break;
                    scrollParent=scrollParent.parentElement;
                }
                if(scrollParent && scrollParent!==document.body && scrollParent!==document.documentElement &&
                    scrollParent.scrollHeight>Math.max(800,el.scrollHeight)*2.2 &&
                    scrollParent.scrollHeight>scrollParent.clientHeight*2.5){
                    diag?.add('texto-potencialmente-virtualizado',{linhas:lines,alturaScroll:scrollParent.scrollHeight},true);
                    continue;
                }
                diag?.add('texto-da-previsualizacao-encontrado',{caracteres:text.length,linhas:lines,via:'DOM-geometrico'},true);
                return text.replace(/\r\n/g,'\n');
            }
            return '';
        }
        async findCompleteText(){
            // Preferir a fonte confirmada pelo relatório da interface real.
            // Evita tentativas ineficazes em um iframe que não contém o TXT.
            const nativeText=this.readNativePlainTextPreview();
            if(nativeText)return nativeText;
            const diagnostic=window.__cbmDiagnostics;
            const sourceNodes=this.sources();
            diagnostic?.add('avaliando-fontes-de-texto',{fontes:sourceNodes.length,raizes:this.viewerRoots().length,iframes:document.querySelectorAll('iframe').length},true);
            for(const n of sourceNodes){
                if(n.matches('.cm-content')){
                    const txt=this.extractCM(n);if(txt?.trim())return txt;
                    continue;
                }
                if(n.matches('textarea')){if(n.value?.trim())return n.value;continue;}
                if(n.matches('.view-lines')){
                    // Monaco pode ter uma janela com apenas as linhas visíveis.
                    const models=window.monaco?.editor?.getModels?.()||[];
                    if(models.length===1)return models[0].getValue();
                    continue;
                }
                if(n.closest('.cm-editor')?.querySelector('.cm-gap,.cm-virtual-gap,.cm-placeholder'))continue;
                const txt=n.matches('[role="textbox"]')?n.innerText:n.innerText||n.textContent;
                if(txt?.trim())return txt.replace(/\r\n/g,'\n');
            }
            // Tenta o DOM do painel por geometria, pois o visualizador TXT
            // do ChatGPT pode renderizar texto com DIVs e SPANs genéricos.
            const genericText=this.readFromVisiblePreview();
            if(genericText)return genericText;
            // Algumas implementações carregam a prévia em iframe da mesma origem.
            for(const frame of document.querySelectorAll('iframe')){
                try{
                    const d=frame.contentDocument;
                    const el=d?.querySelector('.cm-content,pre,textarea');
                    if(!el)continue;
                    const txt=el.matches('textarea')?el.value:el.innerText||el.textContent;
                    if(txt?.trim())return txt;
                }catch(_){ /* iframe com origem diferente */ }
            }
            // Quando o download é um link direto, ler o arquivo original
            // preserva até o conteúdo não renderizado na tela.
            const anchor=this.source?.closest?.('a[href]')||this.source?.querySelector?.('a[href]');
            if(anchor?.href&&/^(https?:|blob:)/.test(anchor.href)){
                try {
                    const res=await fetch(anchor.href,{credentials:'include'});
                    if(res.ok&&/text|json|javascript|xml|octet-stream/.test(res.headers.get('content-type')||''))
                        return res.text();
                } catch(_) { /* Próximas opções podem funcionar. */ }
            }
            // Ponte com um possível iframe da OpenAI. Não requer acesso ao DOM
            // de outra origem, pois o iframe responde por postMessage.
            const iframeText=await this.readInIframe();
            if(iframeText)return iframeText;
            // Alternativa: buscar o arquivo original a partir de link de arquivo
            // que o usuário abriu, sem disparar download no Chrome.
            const originalText=await this.fetchClickedFile();
            if(originalText)return originalText;
            // Cópia fiel não é possível quando a implementação do site oculta
            // o documento ou mostra apenas um trecho; não sinalizar falso sucesso.
            diagnostic?.add('sem-fonte-de-texto-integral',{
                fontes:sourceNodes.length,
                cm:document.querySelectorAll('.cm-content').length,
                pre:document.querySelectorAll('pre').length,
                sandbox:document.querySelectorAll('[id^="walnut-sandbox-text-preview-"]').length
            },true);
            throw new Error('Conteúdo integral indisponível nesta visualização');
        }
    }

    class ChatGPTSidebarLayout {
        constructor() {
            this.toolLabels=['Agendado','Biblioteca','Plugins','Mapas'];
            this.toolElements=new Map();
            this.pending=false;
            addStyle(`
                .cbm-tool-hidden {display:none !important;}
                /* v0.8.3: NÃO definir altura em wrappers de seções expansíveis.
                   Quando Fixados, Projetos ou Filtradas crescem, o layout React
                   precisa calcular livremente a altura dos seus contêineres. */
                nav a[href*="/c/"] {
                    box-sizing:border-box !important;
                    min-height:26px !important;
                    height:26px !important;
                    max-height:26px !important;
                    padding-top:0 !important;
                    padding-bottom:0 !important;
                    margin-top:0 !important;
                    margin-bottom:0 !important;
                    display:flex !important;
                    align-items:center !important;
                    line-height:20px !important;
                }
                nav a[href*="/c/"] .bulk-delete-checkbox {margin-block:0 !important;}
                /* Compactar SOMENTE o botão/título, nunca o ancestral que
                   hospeda uma lista. Nada de min/max-height em section/wrappers. */
                nav .cbm-compact-heading {
                    box-sizing:border-box !important;
                    height:28px !important;
                    min-height:28px !important;
                    max-height:28px !important;
                    margin-block:0 !important;
                    padding-block:2px !important;
                    display:flex !important;
                    align-items:center !important;
                }
                /* A lista filtrada é um bloco real no fluxo vertical, com altura
                   correspondente ao número de itens, sem sobreposição de seções. */
                #cbm-filter-section {
                    position:static !important;
                    display:block !important;
                    flex-shrink:0 !important;
                    height:auto !important;
                    min-height:0 !important;
                    max-height:none !important;
                    overflow:visible !important;
                    clear:both !important;
                }
                #cbm-filter-section[hidden] {display:none !important;}
                #cbm-filter-results {
                    position:static !important;
                    height:auto !important;
                    max-height:none !important;
                    overflow:visible !important;
                }
                #cbm-filter-heading {min-height:27px !important;padding-block:2px !important;}
                #cbm-filter-results .cbm-result-row {
                    height:27px !important;
                    min-height:27px !important;
                    max-height:none !important;
                    flex-shrink:0 !important;
                }
                #cbm-filter-results .cbm-result-row a {padding-block:2px !important;}
                .cbm-explore-tool {
                    width:100%; display:flex !important; align-items:center;
                    gap:12px; box-sizing:border-box; min-height:34px;
                    border:0; border-radius:8px; padding:7px 11px;
                    text-align:left; font:inherit; color:inherit;
                    background:transparent; cursor:pointer;
                }
                .cbm-explore-tool:hover, .cbm-explore-tool:focus-visible {
                    background:var(--token-surface-hover,rgba(128,128,128,.13));
                    outline:none;
                }
                .cbm-explore-tool svg {width:18px;height:18px;flex:0 0 18px;}
                /* Não incluir barra divisória entre Mapas e Imagens. */
                .cbm-explore-group-separator { display:none !important; }
            `);
            this.scan();
            this.observer=new MutationObserver(()=>this.scheduleScan());
            this.observer.observe(document.body,{childList:true,subtree:true});
            this.timer=setInterval(()=>this.scan(),2100);
        }

        scheduleScan() {
            if(this.pending) return;
            this.pending=true;
            setTimeout(()=>{this.pending=false;this.scan();},160);
        }

        normalize(t) {return String(t||'').replace(/\s+/g,' ').trim();}
        isVisible(el) {
            if(!el?.isConnected) return false;
            const r=el.getBoundingClientRect();return r.width>0 && r.height>0;
        }

        getSidebar() {
            const link=document.querySelector('nav a[href*="/c/"]');
            if(!link) return document.querySelector('aside nav')||null;
            let candidate=link.closest('nav');
            for(let p=candidate,n=0;p&&n<8;p=p.parentElement,n++){
                const r=p.getBoundingClientRect();
                if(r.width>Math.min(470,innerWidth*.63)) break;
                const text=this.normalize(p.textContent);
                if(this.toolLabels.filter(x=>text.includes(x)).length>=3 && /Explorar|Explore/i.test(text))return p;
            }
            return candidate;
        }

        compactRows() {
            // v0.8.3: as linhas individuais são compactadas pelo CSS acima.
            // Não adicionar classes a divs ancestrais: quando a seção estiver
            // inicialmente fechada, o ancestral pode parecer uma linha; após
            // a expansão ele passa a conter várias conversas. Fixar sua altura
            // era a causa da sobreposição de Fixados e Filtradas.
        }

        compactHeadings(nav) {
            const labels=['Explorar','Fixados','Projetos','Recentes'];
            const normalized=el=>this.normalize(el.textContent)
                .replace(/^(?:\.\.\.|…)[\s]*/,'').replace(/\s*[>›]$/,'');
            const candidates=Array.from(nav.querySelectorAll('button,[role="button"],h2,h3,span'));
            for(const label of labels){
                const hit=candidates.find(el=>normalized(el)===label && this.isVisible(el) &&
                    !el.closest('#cbm-filter-section,#bulk-controls-panel') &&
                    el.getBoundingClientRect().height<=55);
                if(!hit)continue;
                const target=hit.closest('button,[role="button"]')||hit;
                // Somente o próprio botão/título; o contêiner expansível e os
                // espaçadores nativos ficam com o tamanho gerenciado pelo site.
                if(target.getBoundingClientRect().height<=55 &&
                   !target.querySelector('a[href*="/c/"]') &&
                   !target.querySelector('#cbm-filter-results')){
                    target.classList.add('cbm-compact-heading');
                }
            }
            // Limpar classes deixadas por uma varredura anterior (caso a página
            // tenha mudado o DOM sem um reload completo).
            nav.querySelectorAll('.cbm-compact-row,.cbm-compact-heading-wrap,.cbm-compact-section-spacer,.cbm-conversation-list')
                .forEach(el=>el.classList.remove('cbm-compact-row','cbm-compact-heading-wrap',
                    'cbm-compact-section-spacer','cbm-conversation-list'));
        }

        findTool(nav,label) {
            const matches=Array.from(nav.querySelectorAll('a,button,[role="button"]'))
                .filter(el=>!el.closest('#bulk-controls-panel,[data-cbm-explore-menu="true"]')&&
                    this.normalize(el.textContent)===label);
            return matches.find(el=>el.tagName==='A')||matches[0]||null;
        }

        scan() {
            try {
                this.compactRows();
                const nav=this.getSidebar();
                if(!nav)return;
                this.compactHeadings(nav);
                if(!Array.from(nav.querySelectorAll('a,button,[role="button"]'))
                    .some(el=>/^(?:\.\.\.\s*)?(Explorar|Explore)$/.test(this.normalize(el.textContent))))return;
                for(const label of this.toolLabels){
                    const old=this.toolElements.get(label);
                    const row=(old&&old.isConnected)?old:this.findTool(nav,label);
                    if(!row)continue;
                    this.toolElements.set(label,row);
                    let hide=row;
                    for(let i=0;i<2;i++){
                        const p=hide.parentElement;
                        if(!p || this.normalize(p.textContent)!==label ||
                            p.tagName==='NAV'||p.tagName==='ASIDE')break;
                        hide=p;
                    }
                    hide.classList.add('cbm-tool-hidden');
                    row.setAttribute('data-cbm-original-tool',label);
                }
                this.populateExploreMenu();
            } catch(e){warn('Erro ao adaptar menu lateral:',e);}
        }

        findExploreMenu() {
            const groups=[['Imagens','Images'],['GPTs'],['Sites','Websites']];
            const controls=Array.from(document.querySelectorAll('a,button,[role="menuitem"],[role="option"]'))
                .filter(el=>this.isVisible(el)&&!el.closest('[data-cbm-explore-menu="true"]'));
            const items=groups.map(g=>controls.find(el=>g.includes(this.normalize(el.textContent))));
            const found=items.filter(Boolean);
            if(found.length<2)return null;
            for(let p=found[0].parentElement;p&&p!==document.body;p=p.parentElement){
                const r=p.getBoundingClientRect();
                if(found.every(x=>p.contains(x))&&r.width<=470&&r.height<=600&&r.height>50)
                    return {container:p,first:found[0]};
            }
            return null;
        }

        directChildOf(container,descendant) {
            let node=descendant;
            while(node.parentElement&&node.parentElement!==container)node=node.parentElement;
            return node;
        }

        populateExploreMenu() {
            const target=this.findExploreMenu();
            if(!target)return;
            const {container,first}=target;
            if(container.querySelector('[data-cbm-explore-menu="true"]'))return;
            const group=document.createElement('div');
            group.setAttribute('data-cbm-explore-menu','true');
            group.setAttribute('aria-label','Ferramentas');
            for(const label of this.toolLabels){
                const source=this.toolElements.get(label);
                if(!source?.isConnected)continue;
                const row=document.createElement('button');
                row.type='button';row.className='cbm-explore-tool';
                row.setAttribute('aria-label',label);
                const ico=source.querySelector('svg');
                if(ico)row.appendChild(ico.cloneNode(true));
                const span=document.createElement('span');
                span.textContent=label;row.appendChild(span);
                row.addEventListener('click',event=>{
                    event.stopPropagation();source.click();
                    document.dispatchEvent(new KeyboardEvent('keydown',
                        {key:'Escape',bubbles:true,cancelable:true}));
                });
                group.appendChild(row);
            }
            if(!group.children.length)return;
            // Sem elemento separador: grupos contíguos.
            container.insertBefore(group,this.directChildOf(container,first));
            log('Ferramentas reunidas no menu Explorar sem divisória.');
        }
    }

    const boot = () => {
        if (window.__aiChatBulkManager) return;
        if (!document.body || !document.documentElement) {
            window.setTimeout(boot, 100);
            return;
        }
        window.__cbmDiagnostics = new CBMDiagnostics();
        window.__aiChatBulkManager = new BulkManager();
        if (window.location.hostname.includes('chatgpt.com')) {
            window.__aiChatNativeTagsMenu = new ChatGPTNativeTagsMenu(window.__aiChatBulkManager);
            window.__aiChatPreviewCopy = new ChatGPTPreviewCopy();
            window.__aiChatSidebarLayout = new ChatGPTSidebarLayout();
        }
        log('initialized');
    };

    if (window.location.hostname.includes('gemini.google.com')) {
        window.setTimeout(boot, GEMINI_BOOT_DELAY_MS);
    } else {
        boot();
    }
})();