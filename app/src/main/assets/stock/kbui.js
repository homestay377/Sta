/**
 * 知识库界面：skill 与世界书的增删改。
 *
 * 刻意不做成富文本/表单生成器 —— 用最朴素的 textarea 直接编辑，
 * 因为 skill 本来就是给模型看的 markdown，所见即所得最好维护。
 */
(function () {
  'use strict';

  var app = window.__app;
  var K = window.Knowledge;

  var tab = 'skill';        // skill | wb
  var skills = [];
  var wb = [];
  var editing = null;       // {type, ...}
  var loaded = false;

  function esc(s) { return app.esc(s); }
  function $(id) { return document.getElementById(id); }

  /**
   * v5.0：知识库从弹窗改成全屏二级页。
   * 弹窗的问题是「关它得找 ✕ 或点空白」，页面只要一个 ← 加横移返回，
   * 而且同一套页面栈让返回键的行为可预测。
   */
  function open() {
    if (app.openPage) app.openPage('kbModal');
    else $('kbModal').classList.remove('hidden');
    if (!loaded) reload(); else render();
  }
  function close() {
    if (app.closePage) app.closePage('kbModal');
    else $('kbModal').classList.add('hidden');
    editing = null;
  }

  function reload() {
    $('kbBody').innerHTML = '<div class="kb-loading">读取中…</div>';
    Promise.all([K.loadSkills(), K.loadWorldbook()]).then(function (r) {
      skills = r[0]; wb = r[1]; loaded = true;
      render();
    });
  }

  // ==================== 渲染 ====================

  function render() {
    if (editing) return renderEditor();
    renderList();
  }

  function renderList() {
    var body = $('kbBody');
    if (tab === 'skill') {
      body.innerHTML =
        '<div class="kb-intro"><div class="kb-intro-title">按需加载的能力</div><div class="kb-intro-note">skill 是操作指南；模型需要时才读取正文。</div></div>'
        + '<div class="kb-actions">'
        + '<span class="kb-count">' + skills.length + ' 个 skill</span>'
        + '<button class="mini-btn" data-act="new-skill">+ 新建</button>'
        + '<button class="mini-btn" data-act="export-kb">导出</button>'
        + '<label class="mini-btn btn-file">导入<input id="kbImportFile" type="file" accept=".json" hidden></label>'
        + '</div>'
        + (skills.length ? skills.map(function (s, i) {
          return '<div class="kb-item">'
            + '<div class="kb-item-main" data-act="edit-skill" data-i="' + i + '">'
            + '<div class="kb-item-title">' + esc(s.name) + '</div>'
            + '<div class="kb-item-desc">' + esc(s.description || '（没有说明，模型不会知道该什么时候用它）') + '</div>'
            + (s.hasFm ? '' : '<div class="kb-item-warn">缺少 frontmatter，name/description 取不到</div>')
            + '</div>'
            + '<button class="kb-del" data-act="del-skill" data-i="' + i + '">✕</button>'
            + '</div>';
        }).join('') : emptyHint('还没有 skill', 'skill 是「怎么做一件事」的说明书：写清步骤、判据、输出格式，模型需要时会自己读。'))
        + '<div class="kb-tip">系统提示里只放名称和用途，正文由模型按需读取 —— 所以 skill 写多长都不挤上下文。</div>';
    } else {
      body.innerHTML =
        '<div class="kb-intro"><div class="kb-intro-title">只在命中时注入</div><div class="kb-intro-note">让每只股票的背景和你的偏好成为 AI 的上下文。</div></div>'
        + '<div class="kb-actions">'
        + '<span class="kb-count">' + wb.length + ' 条 · 启用 ' + wb.filter(function (e) { return e.enabled; }).length + '</span>'
        + '<button class="mini-btn" data-act="new-wb">+ 新建</button>'
        + '<button class="mini-btn" data-act="export-kb">导出</button>'
        + '<label class="mini-btn btn-file">导入<input id="kbImportFile2" type="file" accept=".json" hidden></label>'
        + '</div>'
        + (wb.length ? wb.map(function (e, i) {
          return '<div class="kb-item' + (e.enabled ? '' : ' off') + '">'
            + '<div class="kb-item-main" data-act="edit-wb" data-i="' + i + '">'
            + '<div class="kb-item-title">' + esc(e.keys.join(' / ') || '（没设关键词）')
            + (e.regex ? ' <span class="kb-tag">正则</span>' : '')
            + (e.priority ? ' <span class="kb-tag">P' + e.priority + '</span>' : '') + '</div>'
            + '<div class="kb-item-desc">' + esc(e.content.slice(0, 70)) + (e.content.length > 70 ? '…' : '') + '</div>'
            + '</div>'
            + '<button class="kb-toggle" data-act="tog-wb" data-i="' + i + '">' + (e.enabled ? '开' : '关') + '</button>'
            + '<button class="kb-del" data-act="del-wb" data-i="' + i + '">✕</button>'
            + '</div>';
        }).join('') : emptyHint('还没有世界书条目', '世界书是「你应该知道的事」：命中关键词才注入，比如你的分析偏好、某只股的背景。'))
        + '<div class="kb-tip">只在你的输入里匹配关键词（工具返回的数字不参与匹配，避免误触发）。一次最多注入 '
        + K._limits.WB_MAX_ENTRIES + ' 条 / ' + K._limits.WB_MAX_CHARS + ' 字符。</div>';
    }
  }

  function emptyHint(title, desc) {
    return '<div class="kb-empty"><div class="kb-empty-t">' + esc(title) + '</div>'
      + '<div class="kb-empty-d">' + esc(desc) + '</div></div>';
  }

  function renderEditor() {
    var e = editing;
    if (e.type === 'skill') {
      $('kbBody').innerHTML =
        '<div class="kb-form">'
        + '<label class="kb-f"><span>名称（英文/数字，作为文件名）</span>'
        + '<input id="kbSName" value="' + esc(e.file || '') + '" placeholder="chan-analysis"></label>'
        + '<label class="kb-f"><span>用途说明（写给模型看：什么时候该用这个 skill）</span>'
        + '<input id="kbSDesc" value="' + esc(e.description || '') + '" placeholder="缠论标准化分析流程：用户要看笔/中枢/背驰时使用"></label>'
        + '<label class="kb-f"><span>标签（逗号分隔，可留空）</span>'
        + '<input id="kbSTags" value="' + esc((e.tags || []).join(', ')) + '"></label>'
        + '<label class="kb-f"><span>正文（markdown）</span>'
        + '<textarea id="kbSBody" rows="12" placeholder="1. 先取日线 300 根…&#10;2. 判断当前价与最近中枢的关系…&#10;3. 输出格式：结论 / 关键价位 / 触发条件 / 风险">' + esc(e.body || '') + '</textarea></label>'
        + '<div class="kb-form-actions">'
        + '<button class="btn-ghost" data-act="cancel">取消</button>'
        + '<button class="btn-primary" data-act="save-skill">保存</button>'
        + '</div></div>';
    } else {
      $('kbBody').innerHTML =
        '<div class="kb-form">'
        + '<label class="kb-f"><span>关键词（逗号分隔；命中任意一个就注入）</span>'
        + '<input id="kbWKeys" value="' + esc((e.keys || []).join(', ')) + '" placeholder="缠论, 中枢, 背驰"></label>'
        + '<label class="kb-f kb-inline"><input type="checkbox" id="kbWRegex"' + (e.regex ? ' checked' : '') + '>'
        + '<span>用正则匹配（上面填的是正则表达式）</span></label>'
        + '<label class="kb-f"><span>优先级（数字大的先注入，可留空）</span>'
        + '<input id="kbWPri" type="number" value="' + (e.priority || 0) + '"></label>'
        + '<label class="kb-f"><span>内容（命中后注入给模型的话）</span>'
        + '<textarea id="kbWContent" rows="8" placeholder="我是做波段的，看日线和 60 分钟，持仓周期 3~10 天。给建议时优先给区间而不是单点。">' + esc(e.content || '') + '</textarea></label>'
        + '<div class="kb-form-actions">'
        + '<button class="btn-ghost" data-act="cancel">取消</button>'
        + '<button class="btn-primary" data-act="save-wb">保存</button>'
        + '</div></div>';
    }
  }

  // ==================== 交互 ====================

  function onClick(e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    var i = parseInt(t.getAttribute('data-i'), 10);
    var s;

    if (act === 'tab') { tab = t.getAttribute('data-tab'); editing = null; syncTabs(); render(); return; }
    if (act === 'new-skill') { editing = { type: 'skill', file: '', description: '', tags: [], body: '' }; render(); return; }
    if (act === 'edit-skill') { s = skills[i]; if (s) { editing = { type: 'skill', file: s.file, description: s.description, tags: s.tags, body: s.body }; render(); } return; }
    if (act === 'del-skill') {
      s = skills[i];
      if (!s) return;
      if (t.textContent !== '?') {
        t.textContent = '?'; t.style.color = '#ff8080';
        setTimeout(function () { if (t.textContent === '?') { t.textContent = '✕'; t.style.color = ''; } }, 2600);
        return;
      }
      K.removeSkill(s.file).then(reload);
      return;
    }
    if (act === 'new-wb') { editing = { type: 'wb', keys: [], content: '', regex: false, priority: 0, enabled: true }; render(); return; }
    if (act === 'edit-wb') { s = wb[i]; if (s) { editing = { type: 'wb', id: s.id, keys: s.keys, content: s.content, regex: s.regex, priority: s.priority, enabled: s.enabled }; render(); } return; }
    if (act === 'tog-wb') {
      s = wb[i]; if (!s) return;
      s.enabled = !s.enabled;
      K.saveWorldbook(wb).then(render);
      return;
    }
    if (act === 'del-wb') {
      s = wb[i]; if (!s) return;
      if (t.textContent !== '?') {
        t.textContent = '?'; t.style.color = '#ff8080';
        setTimeout(function () { if (t.textContent === '?') { t.textContent = '✕'; t.style.color = ''; } }, 2600);
        return;
      }
      wb.splice(i, 1);
      K.saveWorldbook(wb).then(render);
      return;
    }
    if (act === 'cancel') { editing = null; render(); return; }

    if (act === 'save-skill') {
      var name = ($('kbSName').value || '').trim();
      var desc = ($('kbSDesc').value || '').trim();
      var tags = ($('kbSTags').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var body = $('kbSBody').value || '';
      if (!name) { flash('名称不能为空'); return; }
      K.saveSkill(name, name, desc, tags, body).then(function () {
        editing = null;
        flash('已保存 skill：' + name);
        reload();
      });
      return;
    }
    if (act === 'save-wb') {
      var keys = ($('kbWKeys').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      var content = $('kbWContent').value || '';
      var isRe = $('kbWRegex').checked;
      var pri = parseFloat($('kbWPri').value) || 0;
      if (!keys.length) { flash('至少要有一个关键词'); return; }
      if (!content.trim()) { flash('内容不能为空'); return; }
      var entry = {
        id: editing.id || ('w' + Date.now().toString(36)),
        keys: keys, content: content, regex: isRe,
        priority: pri, enabled: editing.enabled !== false
      };
      var idx = -1;
      for (var k = 0; k < wb.length; k++) if (wb[k].id === entry.id) { idx = k; break; }
      if (idx >= 0) wb[idx] = entry; else wb.push(entry);
      K.saveWorldbook(wb).then(function () {
        editing = null;
        flash('已保存条目');
        reload();
      });
      return;
    }
  }

  function flash(t) {
    var el = $('kbFlash');
    if (!el) return;
    el.textContent = t;
    el.classList.remove('hidden');
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { el.classList.add('hidden'); }, 2200);
  }

  function syncTabs() {
    var ts = document.querySelectorAll ? document.querySelectorAll('#kbModal .kb-tab') : [];
    for (var i = 0; i < ts.length; i++) {
      var on = ts[i].getAttribute('data-tab') === tab;
      if (on) ts[i].classList.add('on'); else ts[i].classList.remove('on');
    }
  }

  function bind() {
    var m = $('kbModal');
    if (!m) return;

    // ------------------------------------------
    // 导入与导出：只读写 skills/ + worldbook.json
    // 用 js 的 FileReader / Blob，无需原生新能力
    // ------------------------------------------
    var exportHandler = m.querySelector
      ? m.querySelector.bind(m)
      : function () { return null; };

    // 导出：先问目录，再交给原生写盘
    m.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-act="export-kb"]');
      if (!btn) return;
      if (!window.KnowledgeIO) { flash('导出模块未加载'); return; }

      // 目录可选：留空就用上次记住的（默认 Download/股问AI）。
      // 用 window.prompt 而不是新做一个弹窗 —— 这一个输入框不值得
      // 再占一层 UI，而且 WebView 的 prompt 是原生弹的，不会被软键盘顶飞。
      var saved = window.KnowledgeIO.getSavedDir();
      var input = window.prompt(
        '导出到哪个目录？\n（相对下载目录，例如 股问AI 或 股问AI/备份；留空＝默认）',
        saved
      );
      if (input === null) return;              // 用户点了取消
      var dir = String(input).trim() || saved;

      window.KnowledgeIO.exportAll().then(function (txt) {
        var d = new Date();
        var name = 'stock-kb-' + d.getFullYear() + '-'
          + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + '.json';
        return window.KnowledgeIO.saveAs(name, txt, dir).then(function (r) {
          if (r.via === 'native' && !r.error) {
            flash('已导出到 ' + r.path);
          } else if (r.error) {
            flash('原生写入失败（' + r.error + '），已改用浏览器下载');
          } else {
            flash('已通过浏览器下载 ' + name);
          }
        });
      }).catch(function (err) { flash('导出失败: ' + (err && err.message)); });
    }, true);

    // 导入：读文件 → 合并。
    //
    // ★ 这里必须用 document 级委派，不能像原来那样直接给
    //   getElementById('kbImportFile') 挂 change。
    //   renderList() 每次刷新都会整段重写 kbBody.innerHTML，
    //   input 被替换成新元素，旧监听器跟着旧元素一起消失 ——
    //   表现就是"点导入没反应 / 选了文件也不导入"。
    //   委托在 document 上，节点换了照样能收到。
    if (!document.__kbImportBound) {
      document.__kbImportBound = true;
      document.addEventListener('change', function (e) {
        var t = e.target;
        if (!t || t.type !== 'file' || t.id.indexOf('kbImportFile') !== 0) return;
        var file = t.files && t.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          if (!window.KnowledgeIO) { flash('导入模块未加载'); return; }
          window.KnowledgeIO.importAll(String(reader.result)).then(function (r) {
            flash('已导入 skill ' + r.skillAdded + ' / 世界书 ' + r.worldbookAdded
              + (r.errors && r.errors.length ? '（' + r.errors[0] + '）' : ''));
            if (window.KnowledgeUI) window.KnowledgeUI.refresh();
          }).catch(function (err) { flash('导入失败: ' + (err && err.message)); });
        };
        reader.onerror = function () { flash('读取文件失败'); };
        reader.readAsText(file);
        // 清空 value：否则再选同一个文件不会触发 change
        try { t.value = ''; } catch (err) {}
      });
    }

    // 返回交给 pages.js 的路由（← 按钮带 data-back），这里只管页内交互
    m.addEventListener('click', function (e) {
      var tb = e.target.closest && e.target.closest('.kb-tab');
      if (tb) { tab = tb.getAttribute('data-tab'); editing = null; syncTabs(); render(); return; }
      onClick(e);
    });
  }

  // 挂到 Knowledge 上（drawer 里按这个入口打开）
  K.open = open;
  K.close = close;
  K.init = bind;
  K.isOpen = function () { return !$('kbModal').classList.contains('hidden'); };

  window.KnowledgeUI = {
    refresh: reload,
    _render: render,
    _setTab: function (t) { tab = t; },
    _getTab: function () { return tab; },
    _setData: function (s, w) { skills = s || []; wb = w || []; loaded = true; }
  };
})();
