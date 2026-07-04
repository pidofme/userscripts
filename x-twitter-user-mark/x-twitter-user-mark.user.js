// ==UserScript==
// @name         Twitter/X 账号备注别名 (Vtag)
// @namespace    http://tampermonkey.net/
// @version      3.1.3
// @description  为 Twitter/X 账号添加备注和标签系统。支持搜索、导入导出、UID 永久追踪、曾用名历史记录，适配 Web3 KOL 场景。
// @author       Vaghr, pidofme
// @license      MIT
// @match        https://twitter.com/*
// @match        https://x.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=twitter.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

/**
 * 功能简介：本项目是一个本地优先的 Twitter 账号管理增强脚本，允许用户为任何账号添加私有的备注和标签。
 */

(function () {
    'use strict';

    // ========================
    // 0) 常量与默认配置
    // ========================
    const VTAG_LOGO = "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2064%2064%27%3E%3Crect%20width%3D%2764%27%20height%3D%2764%27%20rx%3D%2714%27%20fill%3D%27%231d9bf0%27%2F%3E%3Ctext%20x%3D%2732%27%20y%3D%2740%27%20text-anchor%3D%27middle%27%20font-family%3D%27Arial%2CHelvetica%2Csans-serif%27%20font-size%3D%2724%27%20font-weight%3D%27700%27%20fill%3D%27white%27%3EV%3C%2Ftext%3E%3C%2Fsvg%3E";
    const DEBUG = false;
    const STORE_KEY = 'markx_store_v1';
    const DEFAULT_TAGS = ["Project", "Airdrop", "Meme", "Celebrity", "KOL", "VC", "Founder", "Scam", "Dev", "Bot"];

    const DEFAULT_STORE = {
        version: 1,
        updatedAt: Date.now(),
        settings: {
            enableInTimeline: true,
            maxTagsToShow: 3,
            maxNotePreviewLen: 40,
            defaultTags: DEFAULT_TAGS,
            caseRule: "lower"
        },
        users: {},
        index: {
            byHandle: {},
            byTag: {},
            updatedAt: Date.now()
        }
    };

    function cloneDefaultStore() {
        return JSON.parse(JSON.stringify(DEFAULT_STORE));
    }

    function escapeHTML(value) {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return String(value ?? '').replace(/[&<>"']/g, ch => map[ch]);
    }

    function clampNumber(value, min, max, fallback) {
        const num = Number(value);
        if (!Number.isFinite(num)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(num)));
    }

    function boundedString(value, maxLen) {
        if (value === null || value === undefined) return '';
        return String(value).trim().substring(0, maxLen);
    }

    function sanitizeColor(value, fallback = '#1d9bf0') {
        const color = boundedString(value, 16);
        return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(color) ? color : fallback;
    }

    function normalizeHandleValue(value) {
        const text = boundedString(value, 32).replace(/^@/, '');
        const match = text.match(/^([A-Za-z0-9_]{1,15})$/);
        return match ? '@' + match[1].toLowerCase() : '';
    }

    function normalizeTag(tag, fallbackColor = '#ffd400') {
        const rawText = typeof tag === 'string' ? tag : tag?.text;
        const text = boundedString(rawText, 40).toLowerCase();
        if (!text) return null;
        const color = typeof tag === 'string' ? fallbackColor : tag?.color;
        return { text, color: sanitizeColor(color, fallbackColor) };
    }

    function normalizeTags(tags, fallbackColor = '#ffd400') {
        return (Array.isArray(tags) ? tags : [])
            .map(tag => normalizeTag(tag, fallbackColor))
            .filter(Boolean)
            .slice(0, 20);
    }

    function normalizeUserRecord(raw, fallbackKey = '') {
        if (!raw || typeof raw !== 'object') return null;
        const fallbackHandle = String(fallbackKey).startsWith('@') ? fallbackKey : '';
        const handle = normalizeHandleValue(raw.handle || fallbackHandle);
        const uid = boundedString(raw.uid, 64).replace(/[^A-Za-z0-9_-]/g, '');
        const key = boundedString(raw.key || fallbackKey || uid || handle, 80);
        if (!key) return null;
        const tagColor = sanitizeColor(raw.tagColor, '#ffd400');

        return {
            uid,
            key,
            handle,
            handleHistory: (Array.isArray(raw.handleHistory) ? raw.handleHistory : [])
                .map(normalizeHandleValue)
                .filter(Boolean)
                .slice(0, 5),
            displayName: boundedString(raw.displayName, 100),
            alias: boundedString(raw.alias, 50),
            color: sanitizeColor(raw.color, '#1d9bf0'),
            tagColor,
            note: boundedString(raw.note, 1000),
            tags: normalizeTags(raw.tags, tagColor),
            updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now()
        };
    }

    function normalizeSettings(settings = {}) {
        const defaultTags = Array.isArray(settings.defaultTags) ? settings.defaultTags : DEFAULT_TAGS;
        return {
            enableInTimeline: settings.enableInTimeline !== false,
            maxTagsToShow: clampNumber(settings.maxTagsToShow, 1, 10, DEFAULT_STORE.settings.maxTagsToShow),
            maxNotePreviewLen: clampNumber(settings.maxNotePreviewLen, 10, 200, DEFAULT_STORE.settings.maxNotePreviewLen),
            defaultTags: defaultTags.map(tag => boundedString(tag, 40).toLowerCase()).filter(Boolean).slice(0, 50),
            caseRule: settings.caseRule === 'keep' ? 'keep' : 'lower'
        };
    }

    function normalizeStore(raw) {
        const base = cloneDefaultStore();
        const source = raw && typeof raw === 'object' ? raw : {};
        base.version = Number(source.version) || DEFAULT_STORE.version;
        base.updatedAt = Number(source.updatedAt) || Date.now();
        base.settings = normalizeSettings(source.settings || {});
        base.users = {};

        const users = source.users && typeof source.users === 'object' ? source.users : {};
        Object.entries(users).forEach(([key, user]) => {
            const record = normalizeUserRecord(user, key);
            if (record) base.users[record.key] = record;
        });

        return base;
    }

    function debounce(fn, delay = 120) {
        let timer = null;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    // ========================
    // 1) 数据持久化 (Store & Index)
    // ========================
    let store = null;

    function loadStore() {
        try {
            const data = GM_getValue(STORE_KEY, null);
            const parsed = data ? (typeof data === 'string' ? JSON.parse(data) : data) : cloneDefaultStore();
            store = normalizeStore(parsed);
            rebuildIndex();
            return store;
        } catch (e) {
            console.error('[Vtag] Load store failed:', e);
            store = cloneDefaultStore();
            rebuildIndex();
            return store;
        }
    }

    function saveStore() {
        store.updatedAt = Date.now();
        GM_setValue(STORE_KEY, JSON.stringify(store));
    }

    function rebuildIndex() {
        const index = {
            byHandle: {},
            byTag: {},
            updatedAt: Date.now()
        };

        Object.values(store.users).forEach(user => {
            if (!user || !user.key) return;
            user.tags = normalizeTags(user.tags, user.tagColor);
            if (user.handle) index.byHandle[user.handle.toLowerCase()] = user.key;
            user.tags.forEach(tag => {
                const t = tag.text;
                if (!index.byTag[t]) index.byTag[t] = [];
                index.byTag[t].push(user.key);
            });
        });

        // 排序索引中的 key（按 updatedAt 倒序）
        Object.keys(index.byTag).forEach(tag => {
            index.byTag[tag].sort((a, b) => {
                const ua = store.users[a]?.updatedAt || 0;
                const ub = store.users[b]?.updatedAt || 0;
                return ub - ua;
            });
        });

        store.index = index;
    }

    function updateIndexOnUpsert(user) {
        if (!store.index) rebuildIndex();
        // 更新 handle 映射
        if (user.handle) store.index.byHandle[user.handle.toLowerCase()] = user.key;

        // 更新标签索引（这里简单处理：全量刷新该用户的标签索引，或直接触发局部重建）
        // 为了稳定，我们直接清理涉及的旧标签并添加新标签
        rebuildIndex(); // 简单起见，且数据量万级以下性能可接受
    }

    function upsertUser(identity, { alias, color, tagColor, note, tags }) {
        const uid = boundedString(identity.uid, 64).replace(/[^A-Za-z0-9_-]/g, '');
        const handle = normalizeHandleValue(identity.handle);
        const displayName = boundedString(identity.displayName, 100);
        const now = Date.now();

        // V3.0 主键逻辑：优先使用 UID，兜底使用 lowercased handle (针对未捕获 UID 的旧节点)
        const key = uid || handle || normalizeHandleValue(identity.key) || identity.key;
        const existing = store.users[key] || {};

        // 数据迁移补全逻辑：如果当前是用 UID 访问，但数据库里没有，尝试从旧 handle 数据库里捞
        if (uid && !store.users[uid]) {
            const oldKey = handle;
            if (oldKey && store.users[oldKey]) {
                Object.assign(existing, store.users[oldKey]);
                delete store.users[oldKey]; // 迁移后删除旧 key 记录
                if (DEBUG) console.log(`[Vtag] Data migrated from ${oldKey} to UID ${uid}`);
            }
        }

        const safeTagColor = sanitizeColor(tagColor, '#ffd400');
        const formattedTags = normalizeTags(tags, safeTagColor);

        // V3.1 Handle 历史追踪逻辑
        let handleHistory = (Array.isArray(existing.handleHistory) ? existing.handleHistory : [])
            .map(normalizeHandleValue)
            .filter(Boolean)
            .slice(0, 5);
        const existingHandle = normalizeHandleValue(existing.handle);
        if (existingHandle && existingHandle !== handle) {
            // 归档旧 Handle，去重并限制数量 (Max 5)
            if (!handleHistory.includes(existingHandle)) {
                handleHistory.unshift(existingHandle);
                handleHistory = handleHistory.slice(0, 5);
                if (DEBUG) console.log(`[Vtag] Archive old handle: ${existingHandle}`);
            }
        }

        const userRecord = {
            ...existing,
            uid: uid || existing.uid,
            key,
            handle: handle || existing.handle,
            handleHistory, // 存储历史轨迹
            displayName: displayName || existing.displayName,
            alias: boundedString(alias, 50),
            color: sanitizeColor(color, "#1d9bf0"),
            tagColor: safeTagColor,
            note: boundedString(note, 1000),
            tags: formattedTags,
            updatedAt: now
        };

        // 自动自愈更名逻辑：如果记录的 handle 与当前 handle 不同，且当前是 UID 追踪
        if (uid && userRecord.handle !== handle) {
            if (DEBUG) console.log(`[Vtag] User renamed: ${userRecord.handle} -> ${handle}`);
            userRecord.handle = handle;
        }

        store.users[key] = userRecord;
        updateIndexOnUpsert(userRecord);
        saveStore();
        notifyUpdate(key);
    }

    function removeUser(key) {
        if (store.users[key]) {
            delete store.users[key];
            rebuildIndex();
            saveStore();
            notifyUpdate(key);
        }
    }

    function getStoredUser(identity) {
        if (!identity) return null;
        return store.users[identity.key] || store.users[normalizeHandleValue(identity.handle)] || null;
    }

    // ========================
    // 2) DOM 探测与实体识别
    // ========================
    function getUserIdFromReact(node) {
        try {
            const key = Object.keys(node).find(k => k.startsWith('__reactFiber$'));
            if (!key) return null;

            let fiber = node[key];
            while (fiber) {
                // 探测各种可能的路径：Twitter 的 Fiber 结构比较深
                const props = fiber.memoizedProps;
                if (props?.user?.id_str) return props.user.id_str;
                if (props?.userId) return props.userId;
                if (props?.userData?.id_str) return props.userData.id_str;
                fiber = fiber.return;
            }
        } catch (e) { }
        return null;
    }

    function getUserIdentityFromContext(node) {
        try {
            let handle = null;
            let displayName = "";
            let uid = getUserIdFromReact(node);

            // S1: 查找链接模式
            const link = node.querySelector('a[href^="/"]');
            if (link) {
                const href = link.getAttribute('href');
                const match = href.match(/^\/([A-Za-z0-9_]{1,15})$/);
                const blackList = ['/home', '/explore', '/notifications', '/messages', '/i', '/settings', '/about', '/tos', '/privacy'];
                if (match && !blackList.includes(match[0])) {
                    handle = '@' + match[1];
                    const displayNameNode = node.querySelector('[data-testid="User-Name"]') || node;
                    displayName = displayNameNode.textContent?.split('\n')[0] || "";

                    // 尝试在链接元素上再次探测 UID
                    if (!uid) uid = getUserIdFromReact(link);
                }
            }

            // S2: data-testid 辅助
            if (!handle) {
                const userInfo = node.closest('[data-testid="User-Name"]');
                if (userInfo) {
                    const userInfoText = userInfo.textContent || "";
                    const handleMatch = userInfoText.match(/@([A-Za-z0-9_]{1,15})/);
                    if (handleMatch) {
                        handle = handleMatch[0];
                        displayName = userInfoText.split('\n')[0];
                        if (!uid) uid = getUserIdFromReact(userInfo);
                    }
                }
            }

            // S3: 兜底正则
            if (!handle) {
                const fullText = node.textContent || "";
                const lastResort = fullText.match(/@([A-Za-z0-9_]{1,15})/);
                if (lastResort) handle = lastResort[0];
            }

            if (handle) {
                // V3.0 Key 逻辑：主键优先采用 UID，确保改名不丢失
                const normalizedHandle = normalizeHandleValue(handle);
                return {
                    key: uid || normalizedHandle,
                    uid,
                    handle: normalizedHandle,
                    displayName
                };
            }
        } catch (e) {
            if (DEBUG) console.error('[Vtag] Identity extraction failed', e);
        }
        return null;
    }

    // ========================
    // 3) SPA 路由与增量渲染
    // ========================
    const pendingScanRoots = new Set();
    let scanTimer = null;
    let lastFullScan = 0;

    function observeDOM() {
        const target = document.body;
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1) pendingScanRoots.add(node);
                });
            }
            if (pendingScanRoots.size > 0) {
                debounceReScan(false);
            }
        });

        observer.observe(target, { childList: true, subtree: true });
    }

    function debounceReScan(forceFull = false) {
        if (forceFull) lastFullScan = 0;
        if (scanTimer) return;
        scanTimer = setTimeout(() => {
            scanTimer = null;
            const shouldFullScan = forceFull || Date.now() - lastFullScan > 2000;
            if (shouldFullScan) {
                pendingScanRoots.clear();
                reScan();
                lastFullScan = Date.now();
                return;
            }
            const roots = Array.from(pendingScanRoots);
            pendingScanRoots.clear();
            roots.forEach(processScanRoot);
        }, 200);
    }

    function isTimelinePage() {
        return !window.location.pathname.includes('/status/') &&
            (window.location.pathname === '/home' ||
                window.location.pathname.includes('/search') ||
                document.querySelector('[data-testid="primaryColumn"]')?.textContent.includes('What’s happening'));
    }

    function shouldSkipTimelineInjection() {
        return !store.settings.enableInTimeline && isTimelinePage();
    }

    function processArticle(article) {
        if (!article || article.dataset.markxInjected) return;
        const userNameAnchor = article.querySelector('[data-testid="User-Name"]');
        if (userNameAnchor && injectToNode(userNameAnchor)) {
            article.setAttribute('data-markx-injected', '1');
        }
    }

    function processUserHeader(userHeader) {
        if (userHeader && !userHeader.dataset.markxInjected && injectToNode(userHeader)) {
            userHeader.setAttribute('data-markx-injected', '1');
        }
    }

    function processScanRoot(root) {
        if (shouldSkipTimelineInjection() || !(root instanceof Element)) return;

        if (root.matches('article[role="article"]')) processArticle(root);
        root.querySelectorAll?.('article[role="article"]:not([data-markx-injected])').forEach(processArticle);

        if (root.matches('[data-testid="User-Name"]')) {
            const article = root.closest('article[role="article"]');
            if (article) processArticle(article);
            else injectToNode(root);
        }
        if (root.matches('[data-testid="UserName"]')) processUserHeader(root);
        root.querySelectorAll?.('[data-testid="UserName"]:not([data-markx-injected])').forEach(processUserHeader);
    }

    function reScan() {
        if (shouldSkipTimelineInjection()) return;

        // 注入推文列表
        document.querySelectorAll('article[role="article"]:not([data-markx-injected])').forEach(processArticle);

        // 注入个人主页
        processUserHeader(document.querySelector('[data-testid="UserName"]:not([data-markx-injected])'));
        lastFullScan = Date.now();
    }

    function injectToNode(anchor) {
        if (anchor.querySelector('.twk-note-badge-wrap')) return true;
        const identity = getUserIdentityFromContext(anchor);
        if (!identity) return false;

        const badgeContainer = document.createElement('span');
        badgeContainer.className = 'twk-note-badge-wrap';
        badgeContainer.dataset.userKey = identity.key;

        renderBadge(badgeContainer, identity);

        // 寻找合适的插入位置：在名字区块内部
        const nameRow = anchor.querySelector('div[dir="ltr"]');
        if (nameRow) {
            nameRow.style.display = 'flex';
            nameRow.style.alignItems = 'center';
            nameRow.style.flexWrap = 'wrap';
            nameRow.appendChild(badgeContainer);
        } else {
            anchor.appendChild(badgeContainer);
        }
        return true;
    }

    function renderBadge(container, identity) {
        const user = getStoredUser(identity);
        container.textContent = '';

        const link = document.createElement('a');
        link.href = 'javascript:void(0)';
        link.className = 'twk-note-badge-link';

        if (!user || (!user.alias && !user.note && (!user.tags || user.tags.length === 0))) {
            link.innerHTML = `<span class="twk-note-icon">✎</span><span class="twk-note-empty-text">添加备注</span>`;
        } else {
            let html = '';
            // Alias (Primary Display)
            const displayText = user.alias || user.note;
            if (displayText) {
                const maxLen = store.settings.maxNotePreviewLen;
                const preview = displayText.length > maxLen ? displayText.substring(0, maxLen) + '...' : displayText;
                const color = sanitizeColor(user.color, '#1d9bf0');
                const title = (user.alias ? '[' + user.alias + '] ' : '') + (user.note || '');
                html += `<span class="twk-note-text-preview" style="color: ${color};" title="${escapeHTML(title)}">${escapeHTML(preview)}</span>`;
            }

            // Tags (Secondary Display)
            const userTags = normalizeTags(user.tags, user.tagColor);
            if (userTags.length > 0) {
                const max = store.settings.maxTagsToShow;
                const visibleTags = userTags.slice(0, max);
                visibleTags.forEach(tag => {
                    const color = sanitizeColor(tag.color, user.tagColor || '#ffd400');
                    const tagStyle = `style="color: ${color}; border-color: ${color}44; background: ${color}11;"`;
                    html += `<span class="twk-note-tag-pill" ${tagStyle}>${escapeHTML(tag.text)}</span>`;
                });
                if (userTags.length > max) {
                    html += `<span class="twk-note-tag-more" style="font-size:9px; opacity:0.6;">+${userTags.length - max}</span>`;
                }
            }
            link.innerHTML = html;
        }

        link.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEditor(identity);
        };
        container.appendChild(link);
    }

    function notifyUpdate(key) {
        const containers = document.querySelectorAll('.twk-note-badge-wrap');
        containers.forEach(container => {
            if (container.dataset.userKey !== key) return;
            const user = store.users[key];
            renderBadge(container, {
                key,
                uid: user?.uid,
                handle: user?.handle || (String(key).startsWith('@') ? key : ''),
                displayName: user?.displayName || ''
            });
        });
    }

    // ========================
    // 4) UI 组件 (Styles & Shell)
    // ========================
    function injectStyles() {
        GM_addStyle(`
            :root {
                --mx-primary: #1d9bf0;
                --mx-glass-bg: rgba(255, 255, 255, 0.96);
                --mx-glass-border: rgba(0, 0, 0, 0.18);
                --mx-text: #0f1419;
                --mx-text-dim: #536471;
                --mx-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
                --mx-blur: none;
            }

            /* 自动适配暗色模式（基于 Twitter 根元素颜色） */
            [style*="background-color: rgb(21, 32, 43)"], /* Dim */
            [style*="background-color: rgb(0, 0, 0)"],    /* Lights out */
            body.dark-mode {
                --mx-glass-bg: rgba(21, 32, 43, 0.88);
                --mx-glass-border: rgba(255, 255, 255, 0.16);
                --mx-text: #f7f9f9;
                --mx-text-dim: #8b98a5;
            }
            [style*="background-color: rgb(0, 0, 0)"] {
                --mx-glass-bg: rgba(0, 0, 0, 0.88);
            }

            @keyframes mx-fade-in {
                from { opacity: 0; transform: scale(0.95); }
                to { opacity: 1; transform: scale(1); }
            }

            .twk-note-badge-wrap { display: inline-flex; margin-left: 6px; vertical-align: middle; }
            .twk-note-badge-link {
                text-decoration: none !important;
                color: var(--mx-primary) !important;
                font-size: 13px; /* 增大整体字号辨识度 */
                display: flex;
                align-items: center;
                gap: 5px;
                cursor: pointer;
                background: rgba(29, 155, 240, 0.08);
                padding: 2px 10px;
                border-radius: 999px;
                border: 1px solid rgba(29, 155, 240, 0.15);
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                line-height: normal;
            }
            .twk-note-tag-pill {
                padding: 0 6px;
                border-radius: 4px;
                font-size: 10px; /* 标签稍小以区分 */
                font-weight: 700;
                border: 1px solid rgba(128, 128, 128, 0.2);
                background: rgba(128, 128, 128, 0.08);
                display: inline-flex;
                align-items: center;
                height: 16px;
            }
            .twk-note-text-preview {
                font-weight: 800; /* 加粗别名 */
                font-size: 13px;
                max-width: 180px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                height: 20px;
            }
            .twk-note-empty-text { font-weight: 600; }
            .twk-note-icon { font-size: 13px; opacity: 0.6; transition: transform 0.2s; }
            .twk-note-badge-link:hover .twk-note-icon { transform: rotate(15deg) scale(1.1); opacity: 1; color: var(--mx-primary); }

            /* Modal & Overlay */
            .twk-note-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0, 0, 0, 0.42); z-index: 10000;
                display: flex; align-items: center; justify-content: center;
                backdrop-filter: none;
                animation: mx-fade-in 0.2s ease-out;
            }
            .twk-note-modal {
                background: var(--mx-glass-bg);
                backdrop-filter: var(--mx-blur);
                -webkit-backdrop-filter: var(--mx-blur);
                border: 1px solid var(--mx-glass-border);
                border-radius: 20px;
                outline: 1px solid rgba(255, 255, 255, 0.65);
                width: 460px; max-width: 90vw;
                padding: 24px; box-shadow: var(--mx-shadow);
                position: relative;
                color: var(--mx-text);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }

            .twk-note-modal h3 {
                margin: 0 0 20px 0;
                font-size: 18px;
                font-weight: 800;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding-bottom: 12px;
                border-bottom: 1px solid var(--mx-glass-border);
            }
            .twk-note-modal-nav { display: flex; align-items: center; gap: 12px; margin-right: 8px; }
            .twk-note-nav-btn {
                font-size: 12px; font-weight: 600; opacity: 0.6; cursor: pointer;
                display: flex; align-items: center; gap: 4px; padding: 4px 8px;
                border-radius: 6px; transition: all 0.2s; border: 1px solid transparent;
            }
            .twk-note-nav-btn:hover { opacity: 1; background: rgba(128, 128, 128, 0.1); border-color: var(--mx-glass-border); }

            .twk-note-field { margin-bottom: 20px; }
            .twk-note-label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 8px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.5px; }

            .twk-note-input {
                width: 100%; padding: 12px; border-radius: 12px;
                border: 1px solid var(--mx-glass-border);
                background: rgba(128, 128, 128, 0.1);
                color: inherit; font-size: 14px; box-sizing: border-box;
                transition: all 0.2s;
            }
            .twk-note-input:focus { border-color: var(--mx-primary); outline: none; background: rgba(128, 128, 128, 0.14); }

            .twk-note-textarea { min-height: 80px; resize: vertical; }
            .twk-note-tags-container { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }

            .twk-note-tag-editor {
                display: inline-flex; align-items: center;
                background: var(--mx-primary); color: white;
                padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: bold;
                box-shadow: 0 2px 8px rgba(29, 155, 240, 0.3);
            }
            .twk-note-tag-del { margin-left: 6px; cursor: pointer; font-size: 16px; line-height: 1; margin-top: -2px; }

            /* Default Tags */
            .twk-note-default-tags { margin-top: 12px; font-size: 12px; }
            .twk-note-default-tag-btn {
                display: inline-block; margin: 0 6px 6px 0; padding: 3px 8px; border-radius: 6px;
                background: rgba(128, 128, 128, 0.1); cursor: pointer; border: 1px solid var(--mx-glass-border);
                transition: all 0.2s; font-weight: 500;
            }
            .twk-note-default-tag-btn:hover { background: rgba(29, 155, 240, 0.1); border-color: var(--mx-primary); }

            /* Color Picker Compact */
            .mx-color-grid { display: flex; flex-wrap: wrap; gap: 6px; }
            .mx-color-swatch {
                width: 18px; height: 18px; border-radius: 50%; cursor: pointer;
                border: 2px solid transparent; transition: all 0.2s;
                position: relative;
            }
            .mx-color-swatch:hover { transform: scale(1.2); }
            .mx-color-swatch.active { border-color: var(--mx-text); }
            .mx-color-swatch.active::after {
                content: ''; width: 6px; height: 6px; background: white; border-radius: 50%;
                position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
            }

            .twk-note-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--mx-glass-border); }
            .twk-note-btn {
                padding: 10px 24px; border-radius: 999px; font-weight: 800; cursor: pointer;
                border: none; font-size: 14px; transition: all 0.2s;
            }
            .twk-note-btn-primary { background: var(--mx-primary); color: white; }
            .twk-note-btn-secondary { background: rgba(128, 128, 128, 0.2); color: var(--mx-text); }
            .twk-note-btn-danger { background: rgba(244, 33, 46, 0.1); color: #f4212e; border: 1px solid rgba(244, 33, 46, 0.2); }
            .twk-note-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
            .twk-note-btn:active { transform: translateY(0); }

            /* Search Panel */
            /* Search Panel Correction */
            .twk-note-search-panel {
                position: fixed; top: 15%; left: 50%; transform: translateX(-50%);
                width: 600px; max-width: 95vw;
                background: var(--mx-glass-bg);
                backdrop-filter: var(--mx-blur);
                -webkit-backdrop-filter: var(--mx-blur);
                border: 1px solid var(--mx-glass-border);
                border-radius: 16px;
                outline: 1px solid rgba(255, 255, 255, 0.65);
                box-shadow: 0 10px 40px rgba(0,0,0,0.5); z-index: 10001;
                overflow: hidden;
                animation: mx-fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                display: flex; flex-direction: column;
            }
            .twk-note-search-input {
                width: 100%; border: none; padding: 20px; font-size: 18px;
                background: transparent; color: inherit; outline: none; border-bottom: 1px solid var(--mx-glass-border);
            }
            .twk-note-search-results { max-height: 450px; overflow-y: auto; }
            .twk-note-search-item {
                padding: 16px 20px; cursor: pointer; border-bottom: 1px solid var(--mx-glass-border);
                transition: background 0.2s;
            }
            .twk-note-search-item:hover, .twk-note-search-item.active { background: rgba(29, 155, 240, 0.08); }
            .twk-note-search-item-header { display: flex; align-items: center; justify-content: space-between; }
            .twk-note-search-item-title { font-weight: 800; font-size: 15px; display: flex; align-items: center; gap: 8px; }
            .twk-note-search-item-handle { opacity: 0.5; font-size: 13px; font-weight: 500; }
            .twk-note-search-jump {
                width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
                border-radius: 50%; opacity: 0.4; transition: all 0.2s; cursor: pointer;
            }
            .twk-note-search-jump:hover { opacity: 1; background: rgba(29, 155, 240, 0.15); color: var(--mx-primary); }
            .twk-note-search-item-note { font-size: 13px; opacity: 0.7; margin-top: 4px; }
            .twk-note-search-empty { padding: 40px; text-align: center; opacity: 0.5; font-size: 14px; }

            .mx-footer {
                margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--mx-glass-border);
                display: flex; align-items: center; justify-content: center; gap: 6px;
                font-size: 11px; color: var(--mx-text-dim, #536471); opacity: 0.8;
            }
            .mx-footer a {
                color: inherit; text-decoration: none; display: flex; align-items: center; gap: 4px;
                transition: all 0.2s;
            }
            .mx-footer a:hover { color: var(--mx-primary); opacity: 1; }
            .mx-footer-logo {
                width: 14px; height: 14px; border-radius: 3px;
                object-fit: cover; background: rgba(128,128,128,0.2);
                display: inline-block; vertical-align: middle;
            }

            /* Utils */
            .twk-note-settings-btn { opacity: 0.6; }
            .twk-note-settings-btn:hover { opacity: 1; }
        `);
    }

    // ========================
    // 5) 编辑面板 (Editor Modal)
    // ========================
    function openEditor(identity) {
        const user = getStoredUser(identity) || { alias: '', color: '#1d9bf0', tagColor: '#ffd400', note: '', tags: [] };
        let currentTags = normalizeTags(user.tags, user.tagColor);
        let currentColor = sanitizeColor(user.color, '#1d9bf0');
        let currentTagColor = sanitizeColor(user.tagColor, '#ffd400');
        let currentAlias = user.alias || '';
        let currentNote = user.note || '';

        const colors = [
            { name: 'Sky', value: '#1d9bf0' },
            { name: 'Red', value: '#f4212e' },
            { name: 'Orange', value: '#ffad1f' },
            { name: 'Yellow', value: '#ffd400' },
            { name: 'Green', value: '#00ba7c' },
            { name: 'Purple', value: '#7856ff' },
            { name: 'Pink', value: '#f91880' },
            { name: 'Gray', value: '#536471' }
        ];

        const overlay = document.createElement('div');
        overlay.className = 'twk-note-overlay';

        const modal = document.createElement('div');
        modal.className = 'twk-note-modal';

        const render = () => {
            modal.innerHTML = `
                <h3>
                    <div style="display:flex; flex-direction:column;">
                        <span style="font-size:16px;">${escapeHTML(identity.handle || user.handle || '')}</span>
                        ${user.handleHistory && user.handleHistory.length > 0 ?
                    `<span style="font-size:10px; opacity:0.5; font-weight:normal;">历史轨迹: ${user.handleHistory.map(escapeHTML).join(' ← ')}</span>` : ''}
                    </div>
                    <div class="twk-note-modal-nav">
                        <span class="twk-note-nav-btn" id="mx-nav-search">🔍 搜索</span>
                        <span class="twk-note-nav-btn" id="mx-nav-settings">⚙️ 设置</span>
                        <button class="twk-note-btn-close-x" style="background:none; border:none; color:inherit; font-size:20px; cursor:pointer; margin-left:8px;">×</button>
                    </div>
                </h3>

                <div style="display: flex; gap: 24px;">
                    <div class="twk-note-field" style="flex: 1;">
                        <label class="twk-note-label">备注别名</label>
                        <input type="text" class="twk-note-input twk-note-alias-input" value="${escapeHTML(currentAlias)}" placeholder="如：首席科学家" maxlength="50">
                    </div>
                    <div class="twk-note-field" style="width: 160px; flex-shrink: 0;">
                        <label class="twk-note-label">个性化色彩</label>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            <div class="mx-color-grid">
                                <span style="font-size: 10px; width: 24px; opacity: 0.5;">别名</span>
                                ${colors.map(c => `
                                    <div class="mx-color-swatch ${currentColor === c.value ? 'active' : ''}"
                                         style="background: ${c.value};"
                                         data-type="alias" data-color="${c.value}"></div>
                                `).join('')}
                            </div>
                            <div class="mx-color-grid">
                                <span style="font-size: 10px; width: 24px; opacity: 0.5;">标签</span>
                                ${colors.map(c => `
                                    <div class="mx-color-swatch ${currentTagColor === c.value ? 'active' : ''}"
                                         style="background: ${c.value};"
                                         data-type="tag" data-color="${c.value}"></div>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                </div>

                <div class="twk-note-field">
                    <label class="twk-note-label">标签系统</label>
                    <div class="twk-note-tags-container" style="margin-bottom: 8px;">
                        ${currentTags.map((tag, i) => {
                        const text = typeof tag === 'string' ? tag : tag.text;
                        const color = sanitizeColor(typeof tag === 'string' ? currentTagColor : tag.color, currentTagColor);
                        return `<span class="twk-note-tag-editor" style="background:${color}">${escapeHTML(text)}<span class="twk-note-tag-del" data-idx="${i}">×</span></span>`;
                    }).join('')}
                    </div>
                    <input type="text" class="twk-note-input twk-note-tag-input" style="padding: 8px 12px; font-size: 13px;" placeholder="输入标签按回车 (使用上方预选色)...">
                    <div class="twk-note-default-tags" style="opacity: 0.8;">
                        常用: ${store.settings.defaultTags.filter(t => !currentTags.some(ct => (typeof ct === 'string' ? ct : ct.text) === t)).slice(0, 10).map(t => `<span class="twk-note-default-tag-btn" data-tag="${escapeHTML(t)}">${escapeHTML(t)}</span>`).join('')}
                    </div>
                </div>

                <div class="twk-note-field">
                    <label class="twk-note-label">详细备注</label>
                    <textarea class="twk-note-input twk-note-textarea twk-note-note-input" maxlength="1000" placeholder="记录更详细的背景、风险点或跟进事项...">${escapeHTML(currentNote)}</textarea>
                </div>

                <div class="twk-note-actions">
                    ${user.key ? `<button class="twk-note-btn twk-note-btn-danger" id="mx-btn-clear" style="padding: 6px 16px; font-size: 12px; opacity:0.6;">清空数据</button>` : ''}
                    <div style="flex:1"></div>
                    <button class="twk-note-btn twk-note-btn-primary" id="mx-btn-save" style="padding: 8px 32px;">保存更改</button>
                </div>

                <div class="mx-footer">
                    <span>
                        <img src="${VTAG_LOGO}" class="mx-footer-logo">
                        <span>Vtag 3.1.3</span>
                    </span>
                </div>
            `;

            const aliasInput = modal.querySelector('.twk-note-alias-input');
            const noteInput = modal.querySelector('.twk-note-note-input');
            const tagInput = modal.querySelector('.twk-note-tag-input');

            // 实时保持别名/备注，防止编辑标签时重置
            aliasInput.oninput = () => { currentAlias = aliasInput.value; };
            noteInput.oninput = () => { currentNote = noteInput.value; };

            // 颜色选择 (支持别名和标签独立选择)
            modal.querySelectorAll('.mx-color-swatch').forEach(el => {
                el.onclick = () => {
                    const type = el.dataset.type;
                    const color = el.dataset.color;
                    if (type === 'alias') currentColor = color;
                    else currentTagColor = color;
                    render();
                };
            });

            tagInput.onkeydown = (e) => {
                if (e.key === 'Enter') {
                    const normalized = normalizeTag({ text: tagInput.value, color: currentTagColor }, currentTagColor);
                    if (normalized && !currentTags.some(t => (typeof t === 'string' ? t : t.text) === normalized.text) && currentTags.length < 20) {
                        currentTags.push(normalized);
                        tagInput.value = '';
                        render();
                        modal.querySelector('.twk-note-tag-input').focus();
                    }
                }
            };

            modal.querySelectorAll('.twk-note-tag-del').forEach(el => {
                el.onclick = () => {
                    currentTags.splice(parseInt(el.dataset.idx), 1);
                    render();
                };
            });

            modal.querySelectorAll('.twk-note-default-tag-btn').forEach(el => {
                el.onclick = () => {
                    const normalized = normalizeTag({ text: el.dataset.tag, color: currentTagColor }, currentTagColor);
                    if (normalized && !currentTags.some(t => (typeof t === 'string' ? t : t.text) === normalized.text) && currentTags.length < 20) {
                        currentTags.push(normalized);
                        render();
                    }
                };
            });

            modal.querySelector('#mx-btn-save').onclick = () => {
                upsertUser(identity, {
                    alias: currentAlias.trim(),
                    color: currentColor,
                    tagColor: currentTagColor,
                    note: currentNote.trim(),
                    tags: currentTags
                });
                close();
            };

            modal.querySelector('#mx-nav-search').onclick = (e) => {
                e.stopPropagation();
                close();
                setTimeout(openSearchPanel, 50); // 确保第一个模态框彻底关闭
            };

            modal.querySelector('#mx-nav-settings').onclick = (e) => {
                e.stopPropagation();
                openSettings();
            };

            modal.querySelector('.twk-note-btn-close-x').onclick = close;

            const clearBtn = modal.querySelector('#mx-btn-clear');
            if (clearBtn) {
                clearBtn.onclick = () => {
                    if (confirm('确定要清空该账号的所有备注和标签吗？')) {
                        removeUser(user.key || identity.key);
                        close();
                    }
                };
            }
        };

        const onEditorKeydown = (e) => { if (e.key === 'Escape') close(); };
        const close = () => {
            document.removeEventListener('keydown', onEditorKeydown);
            if (overlay.isConnected) document.body.removeChild(overlay);
        };
        overlay.onclick = (e) => { if (e.target === overlay) close(); };
        document.addEventListener('keydown', onEditorKeydown);

        render();
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        modal.querySelector('.twk-note-alias-input').focus();
    }

    // ========================
    // 6) 搜索面板 (Command Palette)
    // ========================
    function openSearchPanel() {
        if (document.querySelector('.twk-note-search-wrapper')) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'twk-note-search-wrapper';

        const overlay = document.createElement('div');
        overlay.className = 'twk-note-overlay';

        const panel = document.createElement('div');
        panel.className = 'twk-note-search-panel';

        panel.innerHTML = `
            <input type="text" class="twk-note-search-input" placeholder="搜索 handle, 备注或 tag:Project... (Vtag)" spellcheck="false" autofocus>
            <div class="twk-note-search-results"></div>
            <div class="twk-note-search-footer">
                <div class="mx-footer" style="margin-top:0; padding-top:0; border-top:none;">
                    <span style="opacity:0.6;">
                        <img src="${VTAG_LOGO}" class="mx-footer-logo" style="width:12px; height:12px;">
                        Vtag 3.1.3
                    </span>
                </div>
                <span><b>↑↓</b> 移动  <b>Enter</b> 编辑  <b>↗</b> 跳转主页  <b>Esc</b> 关闭</span>
            </div>
        `;

        const input = panel.querySelector('.twk-note-search-input');
        const resultsContainer = panel.querySelector('.twk-note-search-results');
        let activeIdx = 0;
        let filteredUsers = [];

        const updateResults = () => {
            const query = input.value.trim().toLowerCase();
            if (!query) {
                // 显示最近更新的 20 条
                filteredUsers = Object.values(store.users).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
            } else {
                // 基于语法的搜索
                const parts = query.split(/\s+/);
                const tagParts = parts.filter(p => p.startsWith('tag:'));
                const keywordParts = parts.filter(p => !p.startsWith('tag:'));

                let candidates = [];
                if (tagParts.length > 0) {
                    const tagName = tagParts[0].replace('tag:', '');
                    const keys = store.index.byTag[tagName] || [];
                    candidates = keys.map(k => store.users[k]).filter(Boolean);
                } else {
                    candidates = Object.values(store.users);
                }

                filteredUsers = candidates.filter(user => {
                    return keywordParts.every(kw => {
                        const kwClean = kw.toLowerCase();
                        return (user.handle && user.handle.toLowerCase().includes(kwClean)) ||
                            (user.displayName && user.displayName.toLowerCase().includes(kwClean)) ||
                            (user.note && user.note.toLowerCase().includes(kwClean)) ||
                            (user.handleHistory && user.handleHistory.some(h => h.toLowerCase().includes(kwClean))) ||
                            (user.alias && user.alias.toLowerCase().includes(kwClean));
                    });
                }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
            }

            renderResults();
        };

        const renderResults = () => {
            if (filteredUsers.length === 0) {
                resultsContainer.innerHTML = `<div class="twk-note-search-empty">没有匹配的账号</div>`;
                return;
            }
            activeIdx = Math.min(activeIdx, filteredUsers.length - 1);
            resultsContainer.innerHTML = filteredUsers.map((user, i) => {
                const handle = normalizeHandleValue(user.handle) || '';
                const color = sanitizeColor(user.color, '#1d9bf0');
                const title = user.alias
                    ? `<span style="color:${color}">${escapeHTML(user.alias)}</span>`
                    : escapeHTML(user.displayName || '未命名');
                const tagHtml = normalizeTags(user.tags, user.tagColor).slice(0, 3).map(t => {
                    const tagColor = sanitizeColor(t.color, user.tagColor || '#ffd400');
                    return `<span class="twk-note-tag-pill" style="border-color:${tagColor}44; color:${tagColor}; background:${tagColor}11;">${escapeHTML(t.text)}</span>`;
                }).join('');
                const note = user.note || '通过 Vtag 管理此账号';
                const history = user.handleHistory && user.handleHistory.length > 0
                    ? `<div style="font-size:10px; opacity:0.4; font-style:italic;">曾用: ${escapeHTML(user.handleHistory[0])}</div>`
                    : '';
                return `
                <div class="twk-note-search-item ${i === activeIdx ? 'active' : ''}" data-idx="${i}">
                    <div class="twk-note-search-item-header">
                        <span class="twk-note-search-item-title">
                            ${title}
                            <span class="twk-note-search-item-handle">${escapeHTML(handle)}</span>
                        </span>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            ${tagHtml}
                            <div class="twk-note-search-jump" data-handle="${escapeHTML(handle.replace('@', ''))}" title="跳转到个人主页">↗</div>
                        </div>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
                        <div class="twk-note-search-item-note">${escapeHTML(note)}</div>
                        ${history}
                    </div>
                </div>
            `;
            }).join('');

            resultsContainer.querySelectorAll('.twk-note-search-item').forEach(el => {
                el.onclick = (e) => {
                    const jumpBtn = e.target.closest('.twk-note-search-jump');
                    if (jumpBtn) {
                        e.stopPropagation();
                        window.location.href = `https://x.com/${jumpBtn.dataset.handle}`;
                    } else {
                        selectItem(parseInt(el.dataset.idx));
                    }
                };
            });
        };

        const selectItem = (idx) => {
            const user = filteredUsers[idx];
            if (user) {
                close();
                openEditor(user);
            }
        };

        const debouncedUpdateResults = debounce(updateResults, 120);
        input.oninput = () => {
            activeIdx = 0;
            debouncedUpdateResults();
        };

        input.onkeydown = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (filteredUsers.length === 0) return;
                activeIdx = (activeIdx + 1) % filteredUsers.length;
                renderResults();
                resultsContainer.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (filteredUsers.length === 0) return;
                activeIdx = (activeIdx - 1 + filteredUsers.length) % filteredUsers.length;
                renderResults();
                resultsContainer.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                selectItem(activeIdx);
            }
        };

        const onSearchKeydown = (e) => { if (e.key === 'Escape') close(); };
        const close = () => {
            window.removeEventListener('keydown', onSearchKeydown);
            if (wrapper.isConnected) document.body.removeChild(wrapper);
        };
        overlay.onclick = close;
        window.addEventListener('keydown', onSearchKeydown);

        updateResults();
        wrapper.appendChild(overlay);
        wrapper.appendChild(panel);
        document.body.appendChild(wrapper);
        input.focus();
    }

    // ========================
    // 7) 设置面板 (Settings)
    // ========================
    function openSettings() {
        const overlay = document.createElement('div');
        overlay.className = 'twk-note-overlay';
        overlay.style.zIndex = '10002';

        const modal = document.createElement('div');
        modal.className = 'twk-note-modal';
        modal.style.width = '550px';

        const render = () => {
            modal.innerHTML = `
                <h3>插件设置</h3>
                <div class="twk-note-field">
                    <label class="twk-note-label">功能开关</label>
                    <label style="font-size:13px"><input type="checkbox" id="markx-toggle-timeline" ${store.settings.enableInTimeline ? 'checked' : ''}> 在时间线中显示备注</label>
                </div>
                <div class="twk-note-field">
                    <label class="twk-note-label">显示限制</label>
                    展示标签数: <input type="number" id="markx-max-tags" value="${store.settings.maxTagsToShow}" min="1" max="10" style="width:50px">
                    备注预览长: <input type="number" id="markx-max-note" value="${store.settings.maxNotePreviewLen}" min="10" max="200" style="width:60px">
                </div>
                <div class="twk-note-field">
                    <label class="twk-note-label">常用标签 (一行一个)</label>
                    <textarea id="markx-default-tags" class="twk-note-input twk-note-textarea" style="min-height:80px">${escapeHTML(store.settings.defaultTags.join('\n'))}</textarea>
                </div>
                <div class="twk-note-field">
                    <label class="twk-note-label">数据管理 (账号总数: ${Object.keys(store.users).length})</label>
                    <div style="display:flex; gap:8px;">
                        <input type="file" id="markx-import-file" accept=".json" style="display:none">
                        <button class="twk-note-btn twk-note-btn-secondary" id="markx-export">导出 JSON</button>
                        <button class="twk-note-btn twk-note-btn-secondary" id="markx-import-trigger">导入 JSON</button>
                        <button class="twk-note-btn twk-note-btn-danger" id="markx-clear-all">清空所有数据</button>
                    </div>
                </div>
                <div class="twk-note-actions">
                    <button class="twk-note-btn twk-note-btn-secondary twk-note-btn-close">关闭</button>
                    <button class="twk-note-btn twk-note-btn-primary twk-note-btn-save">保存配置</button>
                </div>

                <div class="mx-footer">
                    <span>
                        <img src="${VTAG_LOGO}" class="mx-footer-logo">
                        <span>Vtag 3.1.3</span>
                    </span>
                </div>
            `;

            modal.querySelector('.twk-note-btn-save').onclick = () => {
                store.settings.enableInTimeline = modal.querySelector('#markx-toggle-timeline').checked;
                store.settings = normalizeSettings({
                    ...store.settings,
                    maxTagsToShow: modal.querySelector('#markx-max-tags').value,
                    maxNotePreviewLen: modal.querySelector('#markx-max-note').value,
                    defaultTags: modal.querySelector('#markx-default-tags').value.split('\n')
                });
                saveStore();
                alert('配置已保存 (部分 UI 可能需要刷新生效)');
                close();
            };

            modal.querySelector('.twk-note-btn-close').onclick = close;

            modal.querySelector('#markx-export').onclick = () => {
                const data = JSON.stringify(store, null, 2);
                GM_setClipboard(data);

                const blob = new Blob([data], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `Vtag_backup_${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                alert('导出成功！JSON 文件已下载，数据也已复制到剪贴板。');
            };

            const fileInput = modal.querySelector('#markx-import-file');
            modal.querySelector('#markx-import-trigger').onclick = () => fileInput.click();

            fileInput.onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const imported = JSON.parse(event.target.result);
                        if (!imported || typeof imported !== 'object' || !imported.users) throw new Error('无效的格式');
                        const importedStore = normalizeStore(imported);
                        const importCount = Object.keys(importedStore.users).length;
                        if (importCount === 0) throw new Error('未找到可导入的账号数据');
                        if (confirm(`准备导入 ${importCount} 个账号，确定合并并覆盖同名数据吗？\n当前数据会先保存一份本地备份。`)) {
                            GM_setValue(`${STORE_KEY}_pre_import_backup`, JSON.stringify(store));
                            Object.assign(store.users, importedStore.users);
                            store.settings = normalizeSettings({ ...store.settings, ...importedStore.settings });
                            rebuildIndex();
                            saveStore();
                            alert('导入完成！已保存导入前备份。');
                            location.reload();
                        }
                    } catch (err) {
                        alert('导入失败: ' + err.message);
                    }
                };
                reader.readAsText(file);
            };

            modal.querySelector('#markx-clear-all').onclick = () => {
                if (confirm('!!! 警告 !!!\n确定要清空所有数据吗？此操作不可恢复。')) {
                    if (confirm('请再次确认：删除所有已保存的账号备注吗？')) {
                        GM_deleteValue(STORE_KEY);
                        alert('已清空，页面即将刷新');
                        location.reload();
                    }
                }
            };
        };

        const close = () => { if (overlay.isConnected) document.body.removeChild(overlay); };
        render();
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    // ========================
    // 7.1) 导航与快捷键监听
    // ========================
    function observeNavigation() {
        let lastUrl = location.href;
        const onRouteChange = () => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            setTimeout(() => debounceReScan(true), 300); // 路由变化后延迟扫描
        };

        const wrapHistoryMethod = (method) => {
            const original = history[method];
            history[method] = function (...args) {
                const result = original.apply(this, args);
                onRouteChange();
                return result;
            };
        };

        wrapHistoryMethod('pushState');
        wrapHistoryMethod('replaceState');
        window.addEventListener('popstate', onRouteChange);
        window.addEventListener('hashchange', onRouteChange);
    }

    function setupShortcuts() {
        window.addEventListener('keydown', (e) => {
            // Ctrl+Shift+K 或 Cmd+Shift+K
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toUpperCase() === 'K') {
                e.preventDefault();
                openSearchPanel();
            }
            // Esc 关闭弹窗 (如果需要)
        });
    }

    // ========================
    // 8) 初始化
    // ========================
    function init() {
        loadStore();
        injectStyles();
        observeDOM();
        reScan();
        observeNavigation();
        setupShortcuts();
        console.log(`%c [Vtag] %c Initialized - Data version: ${store.version} `, 'background: #ffd400; color: #000; font-weight: bold; border-radius: 4px;', 'background: transparent; color: inherit;');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
