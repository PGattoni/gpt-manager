// ==UserScript==
// @name         AI Chat Bulk Manager v0.9.2
// @name:zh-CN   AI Chat Bulk Manager v0.9.2
// @namespace    http://tampermonkey.net/
// @version      0.9.2
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
// @updateURL    https://pgattoni.github.io/aicbm/aicbm.meta.js
// @downloadURL  https://pgattoni.github.io/aicbm/aicbm.user.js
// @license      MIT
// ==/UserScript==
