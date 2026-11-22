/**
 * 知识库：skill（可复用的分析方法）与世界书（关键词触发的设定）。
 *
 * 两者的分工：
 *   · skill   —— "怎么做一件事"。带 frontmatter 的 markdown，正文按需加载。
 *                系统提示里只放 name + description 索引，模型需要时用 read_skill 取正文，
 *                这样塞 20 个 skill 也只占几行 token。
 *   · 世界书  —— "你应该知道的事"。零散设定/偏好/背景，命中关键词才注入。
 *
 * 文件落位（走原生 fs 沙箱）：
 *   skills/<name>.md
 *   worldbook.json
 */
(function () {
  'use strict';

  var app = window.__app;
  var SKILL_DIR = 'skills';
  // ★ v10.25：内存缓存。原来每次提问都要 fsList + 每个 md 一次 fsRead（十几个往返），
  //   而 skill / 世界书只在用户编辑时才变 —— 属于纯固定的桥开销。
  var skillsCache = null;     // 已解析的 skill 数组
  var skillsPending = null;   // 正在加载的 Promise（并发调用搭车，避免重复读）
  var wbCache = null;
  var wbPending = null;
  function dropSkillsCache() { skillsCache = null; skillsPending = null; }
  function dropWorldbookCache() { wbCache = null; wbPending = null; }
  var WB_PATH = 'worldbook.json';
  var WB_MAX_ENTRIES = 8;      // 一次最多注入几条
  var WB_MAX_CHARS = 4000;     // 世界书注入总长上限

  // ==================== frontmatter ====================

  /**
   * 解析 markdown 头部的 frontmatter（只支持 key: value 与 key: [a, b]）。
   * 不引 yaml 库：依赖越少越不容易在 WebView 里出岔子。
   */
  function parseFrontmatter(text) {
    var src = String(text == null ? '' : text);
    var out = { name: '', description: '', tags: [], body: src, ok: false };
    var m = /^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(src);
    if (!m) return out;
    out.ok = true;
    out.body = src.slice(m[0].length);
    m[1].split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i <= 0) return;
      var k = line.slice(0, i).trim().toLowerCase();
      var v = line.slice(i + 1).trim();
      if (k === 'name') out.name = v;
      else if (k === 'description' || k === 'desc') out.description = v;
      else if (k === 'tags') {
        out.tags = v.replace(/^\[|\]$/g, '').split(',').map(function (x) { return x.trim(); })
          .filter(function (x) { return x; });
      }
    });
    return out;
  }

  /** 反过来：把结构化数据拼回 md（编辑界面保存时用） */
  function buildSkillFile(name, description, tags, body) {
    var L = ['---', 'name: ' + name, 'description: ' + (description || '')];
    if (tags && tags.length) L.push('tags: [' + tags.join(', ') + ']');
    L.push('---', '', body || '');
    return L.join('\n');
  }

  function safeName(n) {
    return String(n || '').trim().replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 60);
  }

  // ==================== skill 读写 ====================

  function loadSkills() {
    if (skillsCache) return Promise.resolve(skillsCache);
    if (skillsPending) return skillsPending;
    skillsPending = reallyLoadSkills();
    return skillsPending;
  }

  function reallyLoadSkills() {
    return app.callNative('fsList', SKILL_DIR).then(function (txt) {
      var arr;
      try { arr = JSON.parse(txt || '[]'); } catch (e) { arr = []; }
      var files = arr.filter(function (x) { return x && !x.dir && /\.md$/i.test(x.name || ''); });
      if (!files.length) return [];
      return Promise.all(files.slice(0, 100).map(function (f) {
        var file = f.name.replace(/\.md$/i, '');
        return app.callNative('fsRead', SKILL_DIR + '/' + f.name).then(function (t) {
          var fm = parseFrontmatter(t);
          return {
            file: file,
            name: fm.name || file,
            description: fm.description || '',
            tags: fm.tags,
            body: fm.body,
            raw: t,
            hasFm: fm.ok
          };
        }).catch(function () { return null; });
      })).then(function (rs) {
        var out = rs.filter(Boolean).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        skillsCache = out;
        skillsPending = null;
        return out;
      });
    }).catch(function () { skillsPending = null; return []; });
  }

  function saveSkill(file, name, description, tags, body) {
    dropSkillsCache();
    var f = safeName(file || name);
    if (!f) return Promise.reject(new Error('skill 名不能为空'));
    return app.callNative('fsWrite', SKILL_DIR + '/' + f + '.md',
      buildSkillFile(name || f, description, tags, body)).then(function () { return f; });
  }

  /**
   * 把内置 skill 预置到沙箱。
   *
   * ★ 只在目标文件不存在时写入。
   *   无条件覆盖会把用户在知识库里改过的内容每次启动都冲掉 ——
   *   那比不预置更糟（用户以为自己的修改保存了）。
   */
  function seedBuiltin() {
    dropSkillsCache();
    var list = (window.BUILTIN_SKILLS || []).filter(function (x) {
      return x && x.file && typeof x.text === 'string';
    });
    if (!list.length) return Promise.resolve({ added: 0, kept: 0 });

    return app.callNative('fsList', SKILL_DIR).then(function (txt) {
      var arr = [];
      try { arr = JSON.parse(txt || '[]'); } catch (e) { arr = []; }
      var exist = {};
      (arr || []).forEach(function (x) {
        if (x && x.name) exist[String(x.name).replace(/\.md$/i, '')] = 1;
      });

      var added = 0, kept = 0;
      var jobs = list.map(function (item) {
        if (exist[item.file]) { kept++; return Promise.resolve(false); }
        added++;
        return app.callNative('fsWrite', SKILL_DIR + '/' + safeName(item.file) + '.md', item.text)
          .then(function () { return true; })
          .catch(function (e) {
            console.warn('预置 skill 失败 ' + item.file, e);
            return false;
          });
      });
      return Promise.all(jobs).then(function () {
        return { added: added, kept: kept };
      });
    }).catch(function () {
      return { added: 0, kept: 0 };
    });
  }

  /**
   * 把内置世界书条目合并进沙箱。
   *
   * ★ 与 skill 的预置规则不同：世界书是**一个数组文件**，必须"合并"而不是"覆盖"。
   *   · 文件不存在 → 直接写入内置条目
   *   · 文件已存在 → 只追加 id 不重复的内置条目，用户自己的条目一条不动
   *   · 用户把某条内置条目删了 → 下次启动会加回来（内置规则属于应用自带行为；
   *     想临时关掉请在知识库里把那条设成"关"，而不是删）
   */
  function seedWorldbook() {
    dropWorldbookCache();
    var builtin = (window.BUILTIN_WORLDBOOK || []).filter(function (x) {
      return x && x.id && x.content && Array.isArray(x.keys);
    });
    if (!builtin.length) return Promise.resolve({ added: 0, kept: 0 });

    return app.callNative('fsRead', WB_PATH).then(function (txt) {
      var cur = [];
      try { cur = JSON.parse(txt); } catch (e) { cur = []; }
      if (!Array.isArray(cur)) cur = [];

      var have = {};
      cur.forEach(function (x) { if (x && x.id) have[x.id] = 1; });

      var added = 0, kept = 0;
      builtin.forEach(function (item) {
        if (have[item.id]) { kept++; return; }
        // 深拷贝一份再放进去，避免运行时改动污染常量
        cur.push(JSON.parse(JSON.stringify(item)));
        added++;
      });

      if (!added) return { added: 0, kept: kept };
      return app.callNative('fsWrite', WB_PATH, JSON.stringify(cur, null, 2))
        .then(function () { return { added: added, kept: kept }; })
        .catch(function (e) {
          console.warn('预置世界书失败', e);
          return { added: 0, kept: kept };
        });
    }).catch(function () {
      // 读失败（文件不存在）→ 直接把内置条目写进去
      return app.callNative('fsWrite', WB_PATH, JSON.stringify(builtin, null, 2))
        .then(function () { return { added: builtin.length, kept: 0 }; })
        .catch(function () { return { added: 0, kept: 0 }; });
    });
  }

  function removeSkill(file) {
    dropSkillsCache();
    return app.callNative('fsDelete', SKILL_DIR + '/' + safeName(file) + '.md')
      .catch(function () { return false; });
  }

  // ==================== 世界书 ====================

  function loadWorldbook() {
    if (wbCache) return Promise.resolve(wbCache);
    if (wbPending) return wbPending;
    wbPending = reallyLoadWorldbook();
    return wbPending;
  }

  function reallyLoadWorldbook() {
    return app.callNative('fsRead', WB_PATH).then(function (t) {
      var a;
      try { a = JSON.parse(t); } catch (e) { a = []; }
      if (!Array.isArray(a)) return [];
      var out = a.filter(function (x) { return x && typeof x === 'object'; }).map(function (x, i) {
        return {
          id: x.id || ('w' + i),
          keys: Array.isArray(x.keys) ? x.keys : [],
          regex: !!x.regex,
          content: String(x.content || ''),
          enabled: x.enabled !== false,
          priority: Number(x.priority) || 0
        };
      });
      wbCache = out;
      wbPending = null;
      return out;
    }).catch(function () { wbPending = null; return []; });
  }

  function saveWorldbook(entries) {
    dropWorldbookCache();
    return app.callNative('fsWrite', WB_PATH, JSON.stringify(entries || [], null, 2))
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /**
   * 关键词/正则匹配。
   * 只在**用户输入**上匹配 —— 工具返回里全是数字和日期，拿去匹配很容易误触发。
   */
  function matchWorldbook(text, entries, opts) {
    opts = opts || {};
    var maxN = opts.max || WB_MAX_ENTRIES;
    var maxChars = opts.maxChars || WB_MAX_CHARS;
    var s = String(text == null ? '' : text);
    if (!s) return [];

    var hit = [];
    (entries || []).forEach(function (e) {
      if (!e || e.enabled === false || !e.content) return;
      var matched = false;
      for (var i = 0; i < e.keys.length && !matched; i++) {
        var k = String(e.keys[i] || '').trim();
        if (!k) continue;
        try {
          if (e.regex) matched = new RegExp(k, 'i').test(s);
          else matched = s.toLowerCase().indexOf(k.toLowerCase()) >= 0;
        } catch (err) {
          matched = false;      // 正则写错了不该把整轮对话搞崩
        }
      }
      if (matched) hit.push(e);
    });

    hit.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });

    var out = [], total = 0;
    for (var j = 0; j < hit.length && out.length < maxN; j++) {
      var len = hit[j].content.length;
      if (total + len > maxChars && out.length > 0) break;
      out.push(hit[j]);
      total += len;
    }
    return out;
  }

  /** 拼成给模型看的文本 */
  function worldbookText(entries) {
    if (!entries || !entries.length) return '';
    return entries.map(function (e) { return '· ' + e.content; }).join('\n');
  }

  /** skill 索引：只给名字和用途，正文让模型自己 read_skill */
  function skillsIndexText(skills) {
    if (!skills || !skills.length) return '';
    return skills.map(function (s) {
      return '- ' + s.name + '：' + (s.description || '（无说明）');
    }).join('\n');
  }

  /**
   * 一轮对话开始前调用：拿到该注入的 skill 索引与世界书命中项。
   */
  function prepare(userText) {
    return Promise.all([loadSkills(), loadWorldbook()]).then(function (r) {
      // ★ v10.25：原来 matchWorldbook 对同一批条目跑了两遍（一次取 hits、一次取文本）
      var hits = matchWorldbook(userText, r[1]);
      return {
        skills: r[0],
        skillsIndex: skillsIndexText(r[0]),
        worldbookAll: r[1],
        worldbookHits: hits,
        worldbook: worldbookText(hits)
      };
    }).catch(function () {
      return { skills: [], skillsIndex: '', worldbookAll: [], worldbookHits: [], worldbook: '' };
    });
  }

  window.Knowledge = {
    parseFrontmatter: parseFrontmatter,
    buildSkillFile: buildSkillFile,
    loadSkills: loadSkills,
    saveSkill: saveSkill,
    seedBuiltin: seedBuiltin,
    seedWorldbook: seedWorldbook,
    removeSkill: removeSkill,
    loadWorldbook: loadWorldbook,
    saveWorldbook: saveWorldbook,
    matchWorldbook: matchWorldbook,
    worldbookText: worldbookText,
    skillsIndexText: skillsIndexText,
    prepare: prepare,
    _limits: { WB_MAX_ENTRIES: WB_MAX_ENTRIES, WB_MAX_CHARS: WB_MAX_CHARS }
  };
})();
