// ==UserScript==
// @name         小黑盒发布模板助手
// @namespace    https://github.com/KaRuichin/heybox-publish-templates
// @version      2.1.1
// @description  为小黑盒创作发布页注入模板面板，一键填充。支持图文（已完成）/文章（预留）/视频（预留）
// @author       you
// @match        https://www.xiaoheihe.cn/creator/editor/draft/image_text/*
// @match        https://www.xiaoheihe.cn/creator/editor/draft/article/*
// @match        https://www.xiaoheihe.cn/creator/editor/draft/video/*
// @match        https://xiaoheihe.cn/creator/editor/draft/image_text/*
// @match        https://xiaoheihe.cn/creator/editor/draft/article/*
// @match        https://xiaoheihe.cn/creator/editor/draft/video/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* =======================================================================
     *  通用工具函数（与页面类型无关，可被各适配器复用）
     * ===================================================================== */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 轮询直到 fn 返回真值或超时（搜索结果等异步内容用固定等待不可靠）
    async function waitFor(fn, timeout = 5000, interval = 200) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            const v = fn();
            if (v) return v;
            await sleep(interval);
        }
        return null;
    }

    // 填充 ProseMirror 编辑器（标题 / 正文）
    function setEditor(el, text) {
        if (!el) return false;
        el.focus();
        const sel = window.getSelection();
        sel.selectAllChildren(el);
        document.execCommand('delete');
        if (text) document.execCommand('insertText', false, text); // \n 自动分段
        return true;
    }

    // 填充原生 input（触发框架响应）
    function setNativeInput(input, val) {
        if (!input) return false;
        const proto =
            input.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, val);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // 通过 label 文本找到发布设置里的表单行
    function rowByLabel(label) {
        const el = [...document.querySelectorAll('.creator-editor__form-label')].find(
            (e) => e.textContent.trim() === label
        );
        return el ? el.closest('.creator-editor__form-item') : null;
    }

    // 单值下拉选择
    async function selectOption(label, optionText) {
        if (!optionText) return true;
        const row = rowByLabel(label);
        if (!row) return false;
        const active = row.querySelector('.selector__active');
        if (active && active.textContent.trim() === optionText) return true;
        row.querySelector('.selector__box').click();
        await sleep(180);
        const item = [...row.querySelectorAll('.selector__pull-list-item')].find(
            (i) => i.textContent.trim() === optionText
        );
        if (!item) {
            row.querySelector('.selector__box').click();
            return false;
        }
        item.click();
        await sleep(180);
        return true;
    }

    // 多值下拉选择（其他声明）
    async function selectMulti(label, options) {
        if (!options || !options.length) return;
        const row = rowByLabel(label);
        if (!row) return;
        for (const opt of options) {
            row.querySelector('.selector__box').click();
            await sleep(180);
            const item = [...row.querySelectorAll('.selector__pull-list-item')].find(
                (i) => i.textContent.trim() === opt
            );
            if (item) item.click();
            await sleep(180);
        }
        document.body.click();
        await sleep(120);
    }

    // 关联社区 / 关联话题弹窗的选择器（两个弹窗的列表项类名不同）
    const RELATION_KINDS = {
        community: {
            btnText: '添加社区',
            itemSel: '.editor-model__topic-list-item',
            titleSel: '.topic-list-item__title',
        },
        hashtag: {
            btnText: '添加话题',
            itemSel: '.editor-model__hashtag-list-item',
            titleSel: '.hashtag-list-item__title',
        },
    };

    // 关联社区 / 关联话题：打开弹窗→搜索→点匹配项
    async function addRelation(kind, names) {
        if (!names || !names.length) return;
        const { btnText, itemSel, titleSel } = RELATION_KINDS[kind];
        for (const name of names) {
            const btn = [...document.querySelectorAll('.editor__add-btn')].find(
                (b) => b.textContent.trim() === btnText
            );
            if (!btn) return;
            btn.click();
            const input = await waitFor(
                () => document.querySelector('.editor__search-input--input'), 3000, 150
            );
            if (!input) continue;
            setNativeInput(input, name);
            // 等待搜索结果中出现精确匹配项（搜索有防抖+网络延迟）；超时则退回第一项
            const match =
                (await waitFor(() =>
                    [...document.querySelectorAll(itemSel)].find(
                        (i) => i.querySelector(titleSel)?.textContent.trim() === name
                    )
                )) || document.querySelector(itemSel);
            if (match) {
                match.click();
                await sleep(400);
            } else {
                document.querySelector('.editor__model-frame--close')?.click();
                await sleep(200);
            }
        }
    }

    /* =======================================================================
     *  从官方弹窗中拾取社区/话题名称（写入模板字段，不修改当前草稿）
     *  原理：打开小黑盒自带的选择弹窗，在捕获阶段拦截列表项点击，
     *  读取名称写入面板输入框，并阻止事件传给页面（避免真正添加）。
     * ===================================================================== */
    let activePicker = null;

    function stopPick() {
        if (!activePicker) return;
        document.removeEventListener('click', activePicker.onClick, true);
        clearInterval(activePicker.watch);
        activePicker.btn.textContent = activePicker.btnLabel;
        document.querySelector('.editor__model-frame--close')?.click();
        activePicker = null;
    }

    function startPick(kind, inputEl, max, pickBtn) {
        if (activePicker) { stopPick(); return; }
        const { btnText, itemSel, titleSel } = RELATION_KINDS[kind];
        const addBtn = [...document.querySelectorAll('.editor__add-btn')].find(
            (b) => b.textContent.trim() === btnText
        );
        if (!addBtn) {
            alert(`未找到「${btnText}」按钮，可能页面上该项已达上限`);
            return;
        }
        addBtn.click();

        const onClick = (ev) => {
            const item = ev.target.closest(itemSel);
            if (!item) return;
            // 拦截点击：只取名称写入模板，不让页面真正添加到草稿
            ev.preventDefault();
            ev.stopImmediatePropagation();
            const name = item.querySelector(titleSel)?.textContent.trim();
            if (!name) return;
            const cur = inputEl.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
            if (cur.includes(name)) return;
            if (cur.length >= max) {
                alert(`最多选择 ${max} 个`);
                return;
            }
            cur.push(name);
            inputEl.value = cur.join(',');
        };
        document.addEventListener('click', onClick, true);
        // 用户关闭弹窗（点 ×）即结束拾取
        const watch = setInterval(() => {
            if (!document.querySelector('.editor__model-frame')) stopPick();
        }, 300);
        activePicker = { onClick, watch, btn: pickBtn, btnLabel: pickBtn.textContent };
        pickBtn.textContent = '选完点×';
    }

    /* =======================================================================
     *  适配器：每种发布类型定义 fields（面板字段）与 apply（填充逻辑）
     * ===================================================================== */

    const OTHER_OPTS = ['包含AI辅助创作', '包含剧透', '虚构演绎，仅供娱乐'];

    /* ---------- 图文适配器（已完整实现） ---------- */
    const imageTextAdapter = {
        label: '图文',
        // 面板中要渲染的字段（供 UI 构建），保持声明式便于文章/视频复用
        fields: [
            { key: 'title', type: 'text', label: '标题', attr: 'maxlength="30"', ph: '填写标题（≤30字）' },
            { key: 'body', type: 'textarea', label: '正文（换行=分段）', ph: '正文文案' },
            { key: 'communities', type: 'text', label: '关联社区（逗号分隔，≤2）', ph: '如：碧蓝档案,盒友杂谈', pick: 'community', max: 2 },
            { key: 'topics', type: 'text', label: '关联话题（逗号分隔，≤5）', ph: '话题名，逗号分隔', pick: 'hashtag', max: 5 },
            { key: 'contentDecl', type: 'select', label: '内容声明', opts: ['', '原创', '转载'], optLabels: ['不设置', '原创', '转载'] },
            // 转载专属
            { key: 'reprintSource', type: 'select', label: '转载来源', opts: ['站外', '站内'], group: 'reprint' },
            { key: 'reprintInfo', type: 'text', label: '转载信息（媒体名称）', ph: '请输入转载媒体名称', group: 'reprint' },
            { key: 'reprintStatement', type: 'select', label: '转载声明', opts: ['未选择', '已授权', '未授权'], group: 'reprint' },
            // 原创专属
            { key: 'reprintPermission', type: 'select', label: '转载权限', opts: ['未选择', '未经授权禁止转载或摘编', '转载请注明作者及出处'], group: 'original' },
            { key: 'otherDecl', type: 'checkbox', label: '其他声明', opts: OTHER_OPTS },
        ],

        async apply(t) {
            setEditor(document.querySelector('.editor-title__container .ProseMirror'), t.title || '');
            setEditor(document.querySelector('.image-text__edit-content .ProseMirror'), t.body || '');

            if (t.contentDecl) {
                await selectOption('内容声明', t.contentDecl);
                await sleep(200);
            }
            if (t.contentDecl === '转载') {
                await selectOption('转载来源', t.reprintSource);
                const mediaInput = document.querySelector('.declaration__input input');
                if (mediaInput && t.reprintInfo) setNativeInput(mediaInput, t.reprintInfo);
                await selectOption('转载声明', t.reprintStatement);
            } else if (t.contentDecl === '原创') {
                await selectOption('转载权限', t.reprintPermission);
            }
            await selectMulti('其他声明', t.otherDecl);
            await addRelation('community', t.communities);
            await addRelation('hashtag', t.topics);
        },
    };

    /* ---------- 文章适配器（预留，TODO） ---------- */
    const articleAdapter = {
        label: '文章',
        fields: [],          // TODO: 参照 imageTextAdapter.fields 填写文章字段
        apply: null,         // TODO: 参照 imageTextAdapter.apply 实现文章填充
    };

    /* ---------- 视频适配器（预留，TODO） ---------- */
    const videoAdapter = {
        label: '视频',
        fields: [],          // TODO: 视频字段（视频文件需手动上传，模板只填标题/正文/声明等）
        apply: null,         // TODO
    };

    /* =======================================================================
     *  页面类型判断 + 选择适配器
     * ===================================================================== */
    const PAGE_TYPE = location.pathname.includes('/article/') ? 'article'
        : location.pathname.includes('/video/') ? 'video'
            : 'image_text';

    const ADAPTERS = {
        image_text: imageTextAdapter,
        article: articleAdapter,
        video: videoAdapter,
    };
    const adapter = ADAPTERS[PAGE_TYPE];

    if (!adapter || !adapter.apply) {
        console.log(`[发布模板助手] "${adapter?.label || PAGE_TYPE}" 类型暂未支持，敬请期待。`);
        return; // 文章/视频页面不注入面板，避免误操作
    }

    /* =======================================================================
     *  存储（模板按发布类型分开保存，互不干扰）
     * ===================================================================== */
    const STORAGE_KEY = `heybox_templates_${PAGE_TYPE}_v1`;
    const loadTpls = () => {
        try { return JSON.parse(GM_getValue(STORAGE_KEY, '') || '[]'); }
        catch (e) { return []; }
    };
    const saveTpls = (arr) => GM_setValue(STORAGE_KEY, JSON.stringify(arr));

    /* =======================================================================
     *  面板 UI（根据 adapter.fields 动态生成，文章/视频将来自动复用）
     * ===================================================================== */
    function buildPanel() {
        if (document.getElementById('hb-tpl-panel')) return;

        const style = document.createElement('style');
        style.textContent = `
      #hb-tpl-toggle{position:fixed;right:16px;bottom:96px;z-index:99998;background:#222;color:#fff;
        border:none;border-radius:22px;padding:10px 16px;cursor:pointer;font-size:14px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
      #hb-tpl-panel{position:fixed;right:16px;bottom:140px;z-index:99999;width:360px;max-height:78vh;overflow:auto;
        background:#fff;border:1px solid #e5e5e5;border-radius:12px;box-shadow:0 6px 26px rgba(0,0,0,.18);
        padding:14px;font-size:13px;color:#333;display:none}
      #hb-tpl-panel h3{margin:0 0 10px;font-size:15px}
      #hb-tpl-panel label{display:block;margin:8px 0 3px;font-weight:600;color:#555}
      #hb-tpl-panel input,#hb-tpl-panel select,#hb-tpl-panel textarea{width:100%;box-sizing:border-box;
        border:1px solid #ddd;border-radius:6px;padding:6px 8px;font-size:13px}
      #hb-tpl-panel textarea{min-height:80px;resize:vertical}
      #hb-tpl-panel .row{display:flex;gap:8px}
      #hb-tpl-panel .chk{display:inline-flex;align-items:center;gap:4px;font-weight:400;margin-right:10px}
      #hb-tpl-panel .chk input{width:auto}
      #hb-tpl-panel .btns{display:flex;gap:8px;margin-top:12px}
      #hb-tpl-panel button{border:none;border-radius:6px;padding:8px 10px;cursor:pointer;font-size:13px}
      .hb-fill{background:#3b82f6;color:#fff;flex:1}
      .hb-save{background:#10b981;color:#fff}
      .hb-del{background:#ef4444;color:#fff}
      .hb-pick{background:#6366f1;color:#fff;white-space:nowrap}
      #hb-tpl-panel .grp-reprint,#hb-tpl-panel .grp-original{display:none;border-left:2px solid #eee;padding-left:8px;margin-top:6px}
      #hb-tpl-close{position:absolute;right:10px;top:10px;background:transparent;color:#999;font-size:18px;padding:0}
    `;
        document.head.appendChild(style);

        // 根据 fields 生成表单 HTML
        const fieldHTML = (f) => {
            const wrap = (inner) => {
                const cls = f.group ? `grp-${f.group}` : '';
                return `<div class="fld ${cls}" data-key="${f.key}"><label>${f.label}</label>${inner}</div>`;
            };
            if (f.type === 'text') {
                const input = `<input id="fld-${f.key}" ${f.attr || ''} placeholder="${f.ph || ''}">`;
                if (f.pick) return wrap(`<div class="row">${input}<button class="hb-pick" data-key="${f.key}" style="flex:0 0 auto">从列表选</button></div>`);
                return wrap(input);
            }
            if (f.type === 'textarea') return wrap(`<textarea id="fld-${f.key}" placeholder="${f.ph || ''}"></textarea>`);
            if (f.type === 'select') {
                const opts = f.opts.map((o, i) => `<option value="${o}">${(f.optLabels || f.opts)[i]}</option>`).join('');
                return wrap(`<select id="fld-${f.key}">${opts}</select>`);
            }
            if (f.type === 'checkbox') {
                const boxes = f.opts.map((o) => `<label class="chk"><input type="checkbox" value="${o}">${o}</label>`).join('');
                return wrap(`<div id="fld-${f.key}">${boxes}</div>`);
            }
            return '';
        };

        const toggle = document.createElement('button');
        toggle.id = 'hb-tpl-toggle';
        toggle.textContent = `📋 ${adapter.label}模板`;
        document.body.appendChild(toggle);

        const p = document.createElement('div');
        p.id = 'hb-tpl-panel';
        p.innerHTML = `
      <button id="hb-tpl-close">×</button>
      <h3>${adapter.label}发布模板</h3>
      <label>选择已存模板</label>
      <div class="row">
        <select id="tpl-select"><option value="">— 新建 —</option></select>
        <button class="hb-del" id="tpl-del" style="flex:0 0 auto">删除</button>
      </div>
      ${adapter.fields.map(fieldHTML).join('')}
      <div class="btns">
        <button class="hb-fill" id="tpl-fill">⚡ 填入编辑器</button>
        <button class="hb-save" id="tpl-save">💾 保存模板</button>
      </div>
      <div style="margin-top:8px;color:#999;font-size:12px">新建时“选择模板”留空；选中已有模板则覆盖保存。</div>
    `;
        document.body.appendChild(p);

        const $ = (id) => p.querySelector('#' + id);

        // 内容声明联动显示转载/原创分组
        const declSel = $('fld-contentDecl');
        const refreshGroups = () => {
            if (!declSel) return;
            const v = declSel.value;
            p.querySelectorAll('.grp-reprint').forEach((e) => (e.style.display = v === '转载' ? 'block' : 'none'));
            p.querySelectorAll('.grp-original').forEach((e) => (e.style.display = v === '原创' ? 'block' : 'none'));
        };
        if (declSel) declSel.addEventListener('change', refreshGroups);
        refreshGroups();

        // 「从列表选」：打开官方弹窗拾取社区/话题名称
        p.querySelectorAll('.hb-pick').forEach((btn) => {
            const f = adapter.fields.find((x) => x.key === btn.dataset.key);
            btn.addEventListener('click', () => startPick(f.pick, $(`fld-${f.key}`), f.max, btn));
        });

        // 读表单 → 模板对象
        const readForm = () => {
            const t = {};
            adapter.fields.forEach((f) => {
                if (f.type === 'checkbox') {
                    t[f.key] = [...p.querySelectorAll(`#fld-${f.key} input:checked`)].map((c) => c.value);
                } else if (f.pick) {
                    t[f.key] = $(`fld-${f.key}`).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, f.max);
                } else {
                    t[f.key] = $(`fld-${f.key}`).value;
                }
            });
            t.__name = (t.title || '未命名').toString().slice(0, 20);
            return t;
        };

        // 模板对象 → 写回表单
        const writeForm = (t) => {
            adapter.fields.forEach((f) => {
                if (f.type === 'checkbox') {
                    p.querySelectorAll(`#fld-${f.key} input`).forEach((c) => (c.checked = (t[f.key] || []).includes(c.value)));
                } else if (f.pick) {
                    $(`fld-${f.key}`).value = (t[f.key] || []).join(',');
                } else if ($(`fld-${f.key}`)) {
                    $(`fld-${f.key}`).value = t[f.key] || '';
                }
            });
            refreshGroups();
        };

        const refreshSelect = () => {
            const sel = $('tpl-select');
            const cur = sel.value;
            sel.innerHTML = '<option value="">— 新建 —</option>';
            loadTpls().forEach((t, i) => {
                const o = document.createElement('option');
                o.value = i;
                o.textContent = t.__name || `模板${i + 1}`;
                sel.appendChild(o);
            });
            sel.value = cur;
        };
        refreshSelect();

        $('tpl-select').addEventListener('change', (e) => {
            if (e.target.value === '') return;
            writeForm(loadTpls()[e.target.value]);
        });

        $('tpl-save').addEventListener('click', () => {
            const arr = loadTpls();
            const data = readForm();
            const idx = $('tpl-select').value;
            if (idx !== '') arr[idx] = data; else arr.push(data);
            saveTpls(arr);
            refreshSelect();
            alert('已保存模板：' + data.__name);
        });

        $('tpl-del').addEventListener('click', () => {
            const i = $('tpl-select').value;
            if (i === '') return;
            const arr = loadTpls();
            arr.splice(i, 1);
            saveTpls(arr);
            $('tpl-select').value = '';
            refreshSelect();
        });

        $('tpl-fill').addEventListener('click', async () => {
            const btn = $('tpl-fill');
            btn.textContent = '填充中…';
            btn.disabled = true;
            try {
                await adapter.apply(readForm());
                btn.textContent = '✅ 已填入';
            } catch (e) {
                console.error('[发布模板助手]', e);
                btn.textContent = '❌ 出错';
            }
            setTimeout(() => { btn.textContent = '⚡ 填入编辑器'; btn.disabled = false; }, 1500);
        });

        toggle.addEventListener('click', () => {
            p.style.display = p.style.display === 'none' ? 'block' : 'none';
        });
        $('hb-tpl-close').addEventListener('click', () => (p.style.display = 'none'));
    }

    /* =======================================================================
     *  等待编辑器加载后注入面板
     * ===================================================================== */
    const timer = setInterval(() => {
        if (document.querySelector('.creator-editor__form-label') || document.querySelector('.ProseMirror')) {
            clearInterval(timer);
            buildPanel();
        }
    }, 500);
})();
