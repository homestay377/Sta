/**
 * 会话存储：一只股票一个长期会话。
 *
 * 落盘位置：<filesDir>/agent/sessions/<code>.json（走原生 fs 沙箱桥）
 * 结构：{ code, name, updatedAt, messages: [{role, content, ts}] }
 *
 * 为什么一只股票一个文件：翻回某只股票时要能立刻看到"上次我怎么说的"，
 * 而按日期分文件反而要跨文件拼。一只股票一份，读写都是常数次 IO。
 */
(function () {
  'use strict';

  var app = window.__app;
  var DIR = 'sessions';
  var MAX_MSG = 200;          // 单会话消息上限，超了丢最旧（P4 再做摘要压缩）
  var HISTORY_N = 12;         // 喂给 agent 的历史条数
  var HISTORY_CHARS = 1500;   // 单条历史截断长度

  function safeCode(code) {
    return String(code || '').replace(/[^A-Za-z0-9_\-]/g, '') || 'unknown';
  }

  function path(code) {
    return DIR + '/' + safeCode(code) + '.json';
  }

  /** 裁剪：只留最近 MAX_MSG 条 */
  function trim(messages) {
    var a = Array.isArray(messages) ? messages : [];
    if (a.length <= MAX_MSG) return a;
    return a.slice(a.length - MAX_MSG);
  }

  function empty(code, name) {
    return { code: code || '', name: name || '', updatedAt: 0, messages: [] };
  }

  /** 读一只股票的会话；不存在返回空结构（不报错） */
  function load(code, name) {
    if (!code) return Promise.resolve(empty(code, name));
    return app.callNative('fsRead', path(code)).then(function (txt) {
      var o;
      try { o = JSON.parse(txt); } catch (e) { return empty(code, name); }
      if (!o || !Array.isArray(o.messages)) return empty(code, name);
      o.code = o.code || code;
      o.name = o.name || name || '';
      return o;
    }).catch(function () {
      return empty(code, name);     // 文件不存在 = 新会话
    });
  }

  /** 写会话（自动裁到 MAX_MSG、刷新 updatedAt） */
  function save(code, name, messages) {
    if (!code) return Promise.resolve(false);
    var o = {
      code: code,
      name: name || '',
      updatedAt: Date.now(),
      messages: trim(messages)
    };
    return app.callNative('fsWrite', path(code), JSON.stringify(o))
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /** 列出所有会话（按最后活动倒序）。返回 [{code,name,updatedAt,count}] */
  function list() {
    return app.callNative('fsList', DIR).then(function (txt) {
      var arr;
      try { arr = JSON.parse(txt || '[]'); } catch (e) { arr = []; }
      var files = arr.filter(function (x) {
        return x && !x.dir && /\.json$/.test(x.name);
      });
      if (!files.length) return [];
      // 并行读各文件取元数据（一般就几十只，够用）
      return Promise.all(files.slice(0, 80).map(function (f) {
        return app.callNative('fsRead', DIR + '/' + f.name).then(function (t) {
          var o;
          try { o = JSON.parse(t); } catch (e) { return null; }
          if (!o) return null;
          return {
            code: o.code || f.name.replace(/\.json$/, ''),
            name: o.name || '',
            updatedAt: o.updatedAt || f.mtime || 0,
            count: (o.messages || []).length
          };
        }).catch(function () { return null; });
      })).then(function (rs) {
        return rs.filter(Boolean).sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      });
    }).catch(function () { return []; });
  }

  function remove(code) {
    if (!code) return Promise.resolve(false);
    return app.callNative('fsDelete', path(code)).then(function () { return true; })
      .catch(function () { return false; });
  }

  /**
   * 组装喂给 agent 的历史：最近 HISTORY_N 条，逐条截断。
   * 只保留 user / assistant 两种角色 —— tool 消息是上一轮的中间产物，
   * 重开会话时带上它们反而会让模型以为工具刚调过。
   */
  /**
 * 带"必要摘要"的完整 history。超过 40 条时用摘要替换前段，后 8 条原文。
 */
function toFullHistory(messages) {
  var a = Array.isArray(messages) ? messages : [];
  if (window.SessionSummary) {
    var pair = window.SessionSummary.toAgentHistoryWithSummary(a);
    if (pair) {
      var out = [{ role: 'user', content: pair.summary }];
      pair.recent.forEach(function (m) {
        out.push({ role: m.role, content: String(m.content).slice(0, HISTORY_CHARS) });
      });
      return out;
    }
  }
  return toAgentHistory(a);
}

function toAgentHistory(messages) {
    var a = Array.isArray(messages) ? messages : [];
    var picked = a.filter(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') && m.content;
    }).slice(-HISTORY_N);
    return picked.map(function (m) {
      return { role: m.role, content: String(m.content).slice(0, HISTORY_CHARS) };
    });
  }

  /**
   * 重命名会话（只改显示名，不动消息）。
   * 只对已经存过盘的会话生效 —— 否则会为一只还没聊过的股票建出空文件。
   */
  function rename(code, name) {
    var nm = String(name || '').trim().slice(0, 24);
    if (!code || !nm) return Promise.resolve(false);
    return load(code, '').then(function (o) {
      if (!o || !o.messages || !o.messages.length) return false;
      return app.callNative('fsWrite', path(code), JSON.stringify({
        code: code, name: nm, updatedAt: o.updatedAt || Date.now(), messages: o.messages
      })).then(function () { return true; }).catch(function () { return false; });
    });
  }

  /** 把删掉的会话原样写回去（会话页的「撤销删除」用） */
  function restore(code, obj) {
    if (!code || !obj) return Promise.resolve(false);
    return app.callNative('fsWrite', path(code), JSON.stringify(obj))
      .then(function () { return true; }).catch(function () { return false; });
  }

  window.Sessions = {
    load: load,
    save: save,
    list: list,
    remove: remove,
    toFullHistory: toFullHistory,
    rename: rename,
    restore: restore,
    trim: trim,
    toAgentHistory: toAgentHistory,
    _limits: { MAX_MSG: MAX_MSG, HISTORY_N: HISTORY_N },
    _path: path
  };

  // 与 app.js 调用约束的稳定签名；不做文件改写，只返回 summary＋消息。
  window.Sessions.summarizeForStorage = function (messages, existing) {
    return window.SessionSummary
      ? window.SessionSummary.summarizeForStorage(messages, existing)
      : { messages: messages, summary: existing || '' };
  };
})();
