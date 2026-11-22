/**
 * 知识库导出 / 导入（v9.0）。
 *
 * 之前 skill 和世界书只能逐条在 UI 里编辑，换了手机、或者想一套配置多用，就没选项。
 * 现在这么做：
 *   · 导出：打包 skill 目录（fsList + 逐个读正文）+ worldbook.json → JSON 文件下载
 *   · 导入：读一个 JSON，把里面的 skill 写进 skills/、世界书合并进 worldbook.json
 *     合并规则与 seedWorldbook 一样：只加不重复的 id
 *
 * 全部走前端原生能力：FileReader / Blob / URL.createObjectURL —— 不需要原生桥接。
 */
(function (global) {
  'use strict';

  var app = global.__app;

  // ==================== 导出 ====================

  async function exportAll() {
    // 1) 列 skills 并逐个读正文
    var skills = [];
    var skillFiles = [];
    try {
      var list = await app.callNative('fsList', 'skills');
      var files = JSON.parse(list || '[]').filter(function (x) {
        return x && x.name && /\.md$/i.test(x.name);
      });
      skillFiles = files.map(function (x) { return x.name; });
    } catch (e) {
      skillFiles = [];
    }
    for (var i = 0; i < skillFiles.length; i++) {
      try {
        var t = await app.callNative('fsRead', 'skills/' + skillFiles[i]);
        skills.push({ file: skillFiles[i], text: t });
      } catch (e) { /* 跳过 */ }
    }

    // 2) 读 worldbook
    var wb = [];
    try {
      var t = await app.callNative('fsRead', 'worldbook.json');
      wb = JSON.parse(t || '[]');
    } catch (e) {
      wb = [];
    }

    // 3) 打包返回
    return JSON.stringify({
      __v: 'stock-kb',
      exportedAt: new Date().toISOString(),
      skills: skills,
      worldbook: wb
    }, null, 2);
  }

  /**
   * 用户自定义导出路径。
   *
   * 为什么要存这个：WebView 里的 a.download 落盘位置不可控（要么进私有目录、
   * 要么弹一次下载管理器），而"导出知识库"本质是用户想把文件放到自己选的地方。
   * 所以记一个上次用过的相对目录，下次预填；真正的写入交给原生 exportFile()。
   */
  var DIR_KEY = 'kb_export_dir';
  var DEFAULT_DIR = '股问AI';

  function getSavedDir() {
    try {
      var v = app.S && app.S.cfg ? app.S.cfg.kbExportDir : '';
      return v || DEFAULT_DIR;
    } catch (e) { return DEFAULT_DIR; }
  }

  function setSavedDir(dir) {
    var d = String(dir || '').trim() || DEFAULT_DIR;
    try {
      if (app.S && app.S.cfg) {
        app.S.cfg.kbExportDir = d;
        if (window.NativeBridge && NativeBridge.saveConfig) {
          NativeBridge.saveConfig(JSON.stringify(app.S.cfg));
        }
      }
    } catch (e) {}
    return d;
  }

  /**
   * 把导出文本写进指定目录。
   *
   * 优先走原生 exportFile()（能指定目录、Android 10+ 不需要存储权限、
   * 写完能被文件管理器看到）。原生不可用时退回浏览器下载 —— 至少不丢数据。
   *
   * @returns Promise<{path,via}>
   */
  function saveAs(filename, text, dir) {
    var d = setSavedDir(dir);
    if (window.NativeBridge && NativeBridge.exportFile) {
      return app.callNative('exportFile', d, filename, text).then(function (raw) {
        var o = {};
        try { o = JSON.parse(raw); } catch (e) {}
        return { path: o.path || (d + '/' + filename), via: 'native', legacy: !!o.legacy };
      }).catch(function (err) {
        // 原生失败（比如系统拒绝）也别把内容扔掉，退回下载
        browserDownload(filename, text);
        return { path: filename, via: 'browser', error: err && err.message };
      });
    }
    browserDownload(filename, text);
    return Promise.resolve({ path: filename, via: 'browser' });
  }

  /** 原生不可用时的兜底：浏览器下载 */
  function browserDownload(filename, text) {
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
  }

  /** 兼容旧调用名 */
  var download = browserDownload;

  // ==================== 导入 ====================

  /**
   * 导入一个 JSON。所有 skill 都会写入 skills/ 沙箱；
   * worldbook.json 采用合并语义，只追加新 id。
   *
   * 返回 {skillAdded, worldbookAdded, errors}
   */
  async function importAll(jsonText) {
    var obj;
    try { obj = JSON.parse(jsonText); } catch (e) {
      return { skillAdded: 0, worldbookAdded: 0, errors: ['JSON 解析失败'] };
    }
    if (!obj || obj.__v !== 'stock-kb') {
      return { skillAdded: 0, worldbookAdded: 0, errors: ['不是知识库导出文件'] };
    }

    var errors = [];

    // 1) skill
    var skillAdded = 0;
    if (Array.isArray(obj.skills)) {
      for (var i = 0; i < obj.skills.length; i++) {
        var s = obj.skills[i];
        if (!s || !s.file || !s.text) continue;
        try {
          var fn = String(s.file);
          if (fn.indexOf('/') !== -1) fn = fn.split('/').pop();
          if (!/\.md$/i.test(fn)) fn = fn + '.md';
          await app.callNative('fsWrite', 'skills/' + fn, String(s.text));
          skillAdded++;
        } catch (e) {
          errors.push('skill ' + s.file + ': ' + e.message);
        }
      }
    }

    // 2) worldbook 合并：读已有条目，只追加不重复 id
    var wbAdded = 0;
    try {
      var t = await app.callNative('fsRead', 'worldbook.json');
      var cur = [];
      try { cur = JSON.parse(t) || []; } catch (e) { cur = []; }
      if (!Array.isArray(cur)) cur = [];

      // 现有 id
      var have = {};
      cur.forEach(function (x) { if (x && x.id) have[x.id] = 1; });

      var incoming = Array.isArray(obj.worldbook) ? obj.worldbook : [];
      var added = 0;
      incoming.forEach(function (e) {
        if (!e || !e.id || have[e.id]) return;
        cur.push(e);
        added++;
      });
      if (added > 0) {
        await app.callNative('fsWrite', 'worldbook.json', JSON.stringify(cur, null, 2));
        wbAdded = added;
      }
    } catch (e) {
      errors.push('worldbook: ' + e.message);
    }

    // 3) 通知 UI 刷新（可选）
    try {
      if (app.Drawer && app.Drawer.refresh) app.Drawer.refresh();
      if (app.KnowledgeUI && app.KnowledgeUI.refresh) app.KnowledgeUI.refresh();
    } catch (e) {}

    return { skillAdded: skillAdded, worldbookAdded: wbAdded, errors: errors };
  }

  global.KnowledgeIO = {
    getSavedDir: getSavedDir,
    setSavedDir: setSavedDir,
    saveAs: saveAs,
    DEFAULT_DIR: DEFAULT_DIR,
    exportAll: exportAll,
    download: download,
    importAll: importAll
  };
})(window);
