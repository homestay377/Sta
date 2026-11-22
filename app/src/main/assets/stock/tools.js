/**
 * Agent 工具层。
 *
 * 把 App 已有的能力（行情 / K线 / 指标 / 缠论 / 图表标注 / 搜索 / 文件）包装成
 * 模型可以调用的工具。设计原则：
 *
 *   1. 只做包装，不重写算法 —— 指标和缠论都走现有的 Ind / Chan，
 *      保证「AI 看到的数字」和「图上画出来的东西」是同一套。
 *   2. 返回给模型的是**摘要文本**，不是原始 JSON：
 *      K线最多 500 根 CSV，指标只给最新值与形态结论，缠论只给笔/中枢/背驰。
 *      一次工具调用的结果硬上限 8KB，超了截断并说明 —— 防止把上下文烧光。
 *   3. 单个工具失败不抛异常，返回可读的错误文本，让 agent 自己决定要不要换个思路。
 */
(function () {
  'use strict';

  var app = window.__app;
  var RESULT_LIMIT = 8000;

  /** 结果截断：给模型一个明确的"我没看全"信号 */
  function clip(s, max) {
    s = String(s == null ? '' : s);
    max = max || RESULT_LIMIT;
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…（结果被截断，共 ' + s.length + ' 字符。需要更多请缩小范围，例如减少根数或指定区间）';
  }

  /** '600000' / '600000.SH' / 'sh600000' → 'sh600000' */
  /**
   * v10.25 安全修复：工具参数会拼进沙箱路径，必须白名单化。
   * 原来 read_skill 只去掉 .md 后缀就拼 'skills/' + name + '.md'，
   * name='../worldbook' 就能越界读到沙箱里的其它文件；notes 的 title
   * 过滤了非法字符但没挡 '..'，同样可穿越。这里统一拦一层。
   */
  function safeName(s, max) {
    var v = String(s == null ? '' : s).trim();
    if (!v) return '';
    if (v.indexOf('..') >= 0) return '';
    // 允许中英文、数字、下划线、短横线、空格（笔记标题常用）；斜杠等一律非法
    if (!/^[A-Za-z0-9_\-\u4E00-\u9FA5 .]+$/.test(v)) return '';
    if (v.length > (max || 60)) v = v.slice(0, max || 60);
    return v.trim();
  }

  function normCode(code) {
    var s = String(code == null ? '' : code).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return '';
    var m = s.match(/^(sh|sz|bj)?(\d{6})(?:\.(sh|sz|bj))?$/);
    if (!m) return s;
    var prefix = m[1] || m[3];
    if (!prefix) {
      var d = m[2].charAt(0);
      prefix = (d === '6' || d === '9') ? 'sh' : (d === '4' || d === '8') ? 'bj' : 'sz';
    }
    return prefix + m[2];
  }

  // ==================== 回合内 K 线缓存 ====================
  //
  // 为什么需要它（「分析过慢」里最没必要花钱的那部分）：
  //   模型一轮里常见这样的组合 ——
  //       get_kline(day, 120)  →  compute_indicators(day)  →  analyze_chan(day)
  //   三个工具指向的是同一只股票、同一个周期，于是同一份 K 线
  //   **被网络拉了三遍**。每次几百毫秒，一轮下来白等一秒多。
  //
  // 为什么只在一轮分析内生效：
  //   实时行情有时效。跨轮复用会拿到过期数据（用户看到的价格和图上对不上）。
  //   Agent.isRunning() 为真说明正处在一轮分析里，此时用户没机会切股票、
  //   行情也不会在几百毫秒内失真 —— 复用是安全的。
  //   不在回合内（例如单跑测试、或用户手动点按钮）一律直连，不做缓存。
  //
  // 为什么缓存的是**原始文本**而不是解析后的数组：
  //   解析结果会被下游（指标 / 缠论）读，万一有人原地排序或改字段，
  //   共享同一份数组就会互相污染。缓存文本、命中时重新解析，
  //   成本是微秒级，行为与「刚拉回来」完全一致。
  var KL_CACHE_MAX = 12;
  var klCache = {};        // key -> {text, bars}   已完成的请求
  var klInflight = {};     // key -> Promise<entry> 正在飞的请求

  function klCacheOn() {
    return !!(window.Agent && typeof window.Agent.isRunning === 'function'
              && window.Agent.isRunning());
  }

  /** 一轮分析开始时调用：上一轮的数据一律作废 */
  function resetKlCache() { klCache = {}; klInflight = {}; }

  function klCachePut(key, text, bars) {
    if (!text || !bars) return;
    var keys = Object.keys(klCache);
    if (!klCache[key] && keys.length >= KL_CACHE_MAX) delete klCache[keys[0]];
    klCache[key] = { text: text, bars: bars };
  }

  /** 真正打一次网络，并把结果落进缓存 */
  function fetchKlOnce(cc, p, n) {
    var key = cc + '|' + p;
    var pr = app.callNative('kline', cc, p, n).then(function (txt) {
      var entry = { text: txt, bars: app.parseKline(txt, cc, p).length };
      klCachePut(key, entry.text, entry.bars);
      return entry;
    });
    klInflight[key] = pr;
    var clear = function () { if (klInflight[key] === pr) delete klInflight[key]; };
    pr.then(clear, clear);
    return pr;
  }

  /**
   * 取 K 线原始文本（带回合内缓存）。
   *
   * ★ 除了「已完成」的结果，**还在飞的请求也要搭车**。
   *   原因：并发执行之后，「compute_indicators」和「analyze_chan」会在
   *   同一帧里先后发起，两者都是缓存未命中 —— 只看已完成结果的话，
   *   同一只股票同一个周期照样会被拉两遍。把 in-flight 的 Promise 也记下来，
   *   第二个调用直接搭车，这才真正省掉一次网络。
   */
  function getKlText(cc, p, n) {
    var key = cc + '|' + p;
    var hit = klCache[key];
    if (hit && hit.bars >= n) return Promise.resolve({ text: hit.text, bars: hit.bars });
    var fly = klInflight[key];
    if (fly) {
      return fly.then(function (e) {
        // 搭车拿到的不够多（对方请求的根数更少）→ 自己重取
        if (e.bars >= n) return e;
        return fetchKlOnce(cc, p, n);
      });
    }
    return fetchKlOnce(cc, p, n);
  }

  /** 拉 K 线（走原生桥），返回 {code, period, kl} */
  function loadKl(code, period, count) {
    var cc = normCode(code);
    if (!cc) return Promise.reject(new Error('缺少股票代码'));
    var p = period || 'day';
    var n = Math.min(500, Math.max(20, count || 120));

    if (!klCacheOn()) {
      // 不在分析回合里：直连，不缓存（避免把过期行情喂给别处）
      return app.callNative('kline', cc, p, n).then(function (txt) {
        return { code: cc, period: p, kl: app.parseKline(txt, cc, p) };
      });
    }

    return getKlText(cc, p, n).then(function (entry) {
      return {
        code: cc, period: p,
        // 每次重新解析：解析结果会被指标/缠论读，共享数组有被就地改写的风险
        kl: app.parseKline(entry.text, cc, p).slice(-n)
      };
    });
  }

  /** 按显示宽度补空格（中文算 2 格），让多级别表能对齐 */
  function pad(str, width) {
    var s2 = String(str == null ? '' : str);
    var w = 0;
    for (var i = 0; i < s2.length; i++) {
      w += (s2.charCodeAt(i) > 0x2e80) ? 2 : 1;
    }
    while (w < width) { s2 += ' '; w++; }
    return s2;
  }

  function f(v, d) {
    return (v == null || !isFinite(v)) ? '--' : Number(v).toFixed(d == null ? 2 : d);
  }

  // ==================== 指标摘要 ====================

  function summarizeInd(kl, ind, code, period) {
    var n = kl.length, li = n - 1, last = kl[li];
    var L = [];
    L.push('代码 ' + code + ' 周期 ' + app.periodName(period) + ' 共 ' + n + ' 根，最新 ' + last.t + ' 收 ' + f(last.c));
    L.push('时间范围 ' + kl[0].t + ' ~ ' + last.t);

    // 均线
    if (ind.ma) {
      var order = ['MA5', 'MA10', 'MA20', 'MA60', 'MA120', 'MA250'];
      var parts = [], vals = {};
      order.forEach(function (k) {
        var a = ind.ma[k];
        var v = a ? a[li] : null;
        if (v != null && isFinite(v)) { vals[k] = v; parts.push(k + '=' + f(v)); }
      });
      if (parts.length) L.push('均线：' + parts.join(' '));
      if (vals.MA5 != null && vals.MA20 != null && vals.MA60 != null) {
        var align = (vals.MA5 > vals.MA20 && vals.MA20 > vals.MA60) ? '多头排列'
          : (vals.MA5 < vals.MA20 && vals.MA20 < vals.MA60) ? '空头排列' : '纠缠';
        L.push('排列：' + align + '，价格' + (last.c > vals.MA20 ? '站上' : '跌破') + 'MA20'
          + (vals.MA120 != null ? ('，相对MA120 ' + (last.c > vals.MA120 ? '在上' : '在下')) : ''));
      }
    }

    // MACD
    if (ind.macd) {
      var md = ind.macd;
      var dif = md.DIF[li], dea = md.DEA[li], bar = md.BAR[li];
      var prevDif = md.DIF[li - 1], prevDea = md.DEA[li - 1], prevBar = md.BAR[li - 1];
      var cross = '';
      if (isFinite(dif) && isFinite(prevDif)) {
        if (dif > dea && prevDif <= prevDea) cross = '，刚金叉';
        else if (dif < dea && prevDif >= prevDea) cross = '，刚死叉';
        else cross = dif > dea ? '，DIF在DEA上方' : '，DIF在DEA下方';
      }
      var grow = (Math.abs(bar) > Math.abs(prevBar)) ? '放大' : '缩小';
      L.push('MACD：DIF=' + f(dif, 3) + ' DEA=' + f(dea, 3) + ' 柱=' + f(bar, 3)
        + '（' + (bar >= 0 ? '红柱' : '绿柱') + grow + cross + '）');
    }

    // KDJ / RSI
    if (ind.kdj && ind.kdj.K && ind.kdj.K[li] != null) {
      L.push('KDJ：K=' + f(ind.kdj.K[li], 1) + ' D=' + f(ind.kdj.D[li], 1) + ' J=' + f(ind.kdj.J[li], 1));
    }
    if (ind.rsi && ind.rsi.RSI && ind.rsi.RSI[li] != null) {
      L.push('RSI：' + f(ind.rsi.RSI[li], 1));
    }

    // BOLL
    if (ind.boll && ind.boll.UP && ind.boll.UP[li] != null) {
      var up = ind.boll.UP[li], mid = ind.boll.MID[li], low = ind.boll.LOW[li];
      var width = (mid > 0) ? ((up - low) / mid * 100) : 0;
      var pos = last.c > up ? '突破上轨' : last.c < low ? '跌破下轨' : (last.c > mid ? '中轨上方' : '中轨下方');
      L.push('BOLL：上轨 ' + f(up) + ' 中轨 ' + f(mid) + ' 下轨 ' + f(low)
        + '（' + pos + '，带宽 ' + f(width, 1) + '%）');
    }

    // 量能
    var vols = kl.slice(-6).map(function (k) { return k.v; });
    var v5 = 0, cnt = 0;
    for (var i = Math.max(0, n - 6); i < n - 1; i++) { v5 += kl[i].v; cnt++; }
    v5 = cnt ? v5 / cnt : 0;
    L.push('量能：最新 ' + app.fmtVol(last.v) + '，前5日均 ' + app.fmtVol(v5)
      + (v5 > 0 ? '（量比 ' + f(last.v / v5, 2) + '）' : ''));

    return L.join('\n');
  }

  // ==================== 缠论摘要 ====================

  function summarizeChan(kl, ch, code, period) {
    var n = kl.length, li = n - 1, last = kl[li];
    var L = [];
    L.push('代码 ' + code + ' 周期 ' + app.periodName(period) + '，缠论基于最近 ' + n + ' 根（最新 ' + last.t + ' 收 ' + f(last.c) + '）');
    if (ch.errors && ch.errors.length) L.push('公式告警 ' + ch.errors.length + ' 条');
    L.push('笔：共 ' + (ch.pens ? ch.pens.length : 0) + ' 个转折点，'
      + (ch.bi ? ch.bi.length : 0) + ' 段');

    // 最近几笔
    if (ch.bi && ch.bi.length) {
      var tail = ch.bi.slice(-5);
      L.push('最近笔向：' + tail.map(function (b) {
        return (b.dir === 'up' ? '↑' : '↓') + f(b.fromPrice) + '→' + f(b.toPrice) + '(' + b.len + '根)';
      }).join(' '));
    }

    // 中枢
    if (ch.boxes && ch.boxes.length) {
      L.push('中枢：共 ' + ch.boxes.length + ' 个');
      ch.boxes.slice(-3).forEach(function (b) {
        var pos = last.c > b.zg ? '当前价在中枢上方' : last.c < b.zd ? '当前价在中枢下方' : '当前价在中枢内';
        L.push('  [' + kl[b.s].t + ' ~ ' + kl[Math.min(b.e, n - 1)].t + '] ZG=' + f(b.zg) + ' ZD=' + f(b.zd)
          + ' 中轴=' + f(b.mid) + ' — ' + pos);
      });
    } else {
      L.push('中枢：无');
    }

    // 当前价相对最近中枢的位置（结构判断的第一顺位信息）
    if (ch.stats && ch.stats.boxPosition) {
      L.push('位置：当前价在最近中枢的「' + ch.stats.boxPosition + '」'
        + (ch.stats.lastBox ? '（ZG=' + f(ch.stats.lastBox.zg)
           + ' ZD=' + f(ch.stats.lastBox.zd) + '）' : ''));
    } else {
      L.push('位置：当前价不在任何中枢区间内（或尚未形成中枢）');
    }

    // 背驰（只是力度衰减，不等于买卖点）
    if (ch.signals && ch.signals.length) {
      L.push('背驰：共 ' + ch.signals.length + ' 个（注意：背驰 ≠ 买卖点，需结合中枢位置）');
      ch.signals.slice(-4).forEach(function (s) {
        L.push('  ' + kl[Math.min(s.idx, n - 1)].t + ' ' + s.label + '（' + (s.type === 'buy' ? '买' : '卖')
          + '）价位 ' + f(s.price) + ' 力度 ' + s.strength);
      });
    } else {
      L.push('背驰：无');
    }

    // 三类买卖点：带"成立依据"，模型可以核对而不是照抄标签
    if (ch.points && ch.points.length) {
      L.push('三类买卖点：共 ' + ch.points.length + ' 个，最近 ' + Math.min(5, ch.points.length) + ' 个：');
      ch.points.slice(-5).forEach(function (pt) {
        L.push('  ' + kl[Math.min(pt.idx, n - 1)].t + ' ' + pt.label
          + ' 价位 ' + f(pt.price) + ' —— ' + pt.reason);
      });
    } else {
      L.push('三类买卖点：无（这是常见结果，不代表数据有问题）');
    }
    return L.join('\n');
  }

  // ==================== 工具定义 ====================

  var SPECS = [
    {
      name: 'search_symbol',
      description: '按名称/代码/拼音搜索股票，返回候选代码。不确定代码时先用它。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '股票名称、代码或拼音首字母，如 浦发银行 / 600000 / pfyh' } },
        required: ['keyword']
      }
    },
    {
      name: 'get_quote',
      description: '取某只股票的实时行情快照（现价、涨跌幅、开高低、量额、涨跌停）。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '股票代码，如 sh600000 或 600000' } },
        required: ['code']
      }
    },
    {
      name: 'get_kline',
      description: '取 K 线数据（CSV：时间,开,高,低,收,量）。周期支持 minute/m1/m5/m15/m30/m60/day/week/month；最多 500 根，默认 120 根。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '股票代码' },
          period: { type: 'string', description: '周期，默认 day' },
          count: { type: 'number', description: '取最后多少根，默认 120，上限 500' }
        },
        required: ['code']
      }
    },
    {
      name: 'compute_indicators',
      description: '算技术指标并返回摘要（最新值 + 排列/交叉结论）：均线 MA5~MA250、MACD、KDJ、RSI、BOLL、量能。需要具体数字时用它，不要自己算。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '股票代码' },
          period: { type: 'string', description: '周期，默认 day' }
        },
        required: ['code']
      }
    },
    {
      name: 'analyze_chan',
      description: '跑缠论：笔、中枢（ZG/ZD）、背驰买卖点，并给出当前价相对最近中枢的位置。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '股票代码' },
          period: { type: 'string', description: '周期，默认 day' }
        },
        required: ['code']
      }
    },
    {
      name: 'analyze_levels',
      description: '多级别联立：一次跑完周/日/60分（可自定义），输出「方向 + 中枢位置 + 买卖点」对照表，并标出级别冲突。做多级别判断必须先调它，不要自己逐个周期拼。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '股票代码' },
          periods: {
            type: 'array',
            items: { type: 'string' },
            description: '周期列表，从大到小，默认 [week, day, m60]'
          }
        },
        required: ['code']
      }
    },
    {
      name: 'get_fundamental',
      description: '取基本面数据：估值（现价/市盈率/市净率/市值/换手/量比）+ 最近 4 期财务（EPS/BPS/营收/净利/ROE/净利率）。回答「这公司值不值」「估值高不高」「业绩怎么样」时先调它，不要凭印象说。ETF/指数没有财报，reports 会为空。',
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: '股票代码，如 sh600000 或 600000' } },
        required: ['code']
      }
    },
    {
      name: 'compare_fundamental',
      description: '横向比较 2~4 只股票的估值与盈利质量（市盈率、市净率、ROE、净利率、市值），按同一口径排序并给出谁更贵的结论。做「选哪只」类问题用它，不要自己心算。',
      parameters: {
        type: 'object',
        properties: {
          codes: {
            type: 'array',
            items: { type: 'string' },
            description: '要比较的股票代码，2~4 个'
          }
        },
        required: ['codes']
      }
    },
    {
      name: 'annotate_chart',
      description: '把关键价位画到用户当前看的图表上（支撑/压力/止损/目标），并可把光标定位到某根 K 线。用户能直接看到，结论要给价位时都应调用它。',
      parameters: {
        type: 'object',
        properties: {
          levels: {
            type: 'array',
            description: '要标注的价位',
            items: {
              type: 'object',
              properties: {
                price: { type: 'number', description: '价格' },
                type: { type: 'string', description: '类型：支撑 / 压力 / 止损 / 目标' },
                label: { type: 'string', description: '可选，显示文字' }
              },
              required: ['price', 'type']
            }
          },
          focus: { type: 'string', description: '可选：把光标定位到某根 K 线，可传日期片段（如 2026-07-27）' }
        },
        required: ['levels']
      }
    },
    {
      name: 'draw_on_chart',
      description: '在用户当前看的 K 线图上自由绘图。可用图元：hline 水平线、trendline 两点连线、ray 射线、rect 矩形框、arrow 箭头、text 文字、dot 圆点。'
        + '坐标用「时间 + 价格」：x 可以是日期字符串（如 2026-07-27，或省略年份的 07-27）、K 线索引（0 起，-1 表示最后一根）、或 last/first。'
        + '画趋势线就用 trendline 给 x1,y1,x2,y2；框中枢/箱体用 rect；标注文字用 text 给 x,y,text。'
        + '越界的坐标会被拒绝并告诉你可用范围，请按返回的提示修正后重画。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: 'replace（默认，替换之前画的）或 append（在已有基础上追加）或 clear（清空全部）'
          },
          shapes: {
            type: 'array',
            description: '要画的图元列表',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description: 'hline / trendline / ray / rect / arrow / text / dot'
                },
                x1: { type: 'string', description: '起点时间：日期或索引（两点图元必填）' },
                y1: { type: 'number', description: '起点价格（两点图元必填）' },
                x2: { type: 'string', description: '终点时间（两点图元必填）' },
                y2: { type: 'number', description: '终点价格（两点图元必填）' },
                x: { type: 'string', description: '单点图元（text / dot）的时间' },
                y: { type: 'number', description: '单点图元（text / dot）的价格' },
                price: { type: 'number', description: 'hline 的价格' },
                text: { type: 'string', description: 'text 图元的文字内容' },
                label: { type: 'string', description: '可选，显示在图形旁的短标签' },
                color: {
                  type: 'string',
                  description: '颜色：up(红) down(绿) resist(橙) support(蓝) stop(玫红) target(紫) accent(蓝) text(白/黑)'
                },
                width: { type: 'number', description: '线宽，默认 1.2' },
                dash: { type: 'boolean', description: '是否虚线' },
                fill: { type: 'boolean', description: 'rect 是否填充淡色' },
                size: { type: 'number', description: 'text 字号 / dot 半径' }
              },
              required: ['type']
            }
          }
        },
        required: ['shapes']
      }
    },
    {
      name: 'read_skill',
      description: '读取一个 skill 的完整正文。只在你确实需要某个 skill 的详细步骤时调用（系统提示里只有名称和用途）。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'skill 名称（系统提示里列出的 name）' } },
        required: ['name']
      }
    },
    {
      name: 'notes',
      description: '读写分析笔记（跨会话留存）。action=list 列目录，read 读某篇，write 写/覆盖某篇。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'list / read / write' },
          title: { type: 'string', description: '笔记标题（read/write 必填）' },
          content: { type: 'string', description: '写入内容（write 必填）' }
        },
        required: ['action']
      }
    }
  ];

  var RUNNERS = {
    search_symbol: function (a) {
      var kw = String(a.keyword == null ? '' : a.keyword).trim();
      if (!kw) return Promise.resolve('缺少 keyword');
      return app.callNative('search', kw).then(function (txt) {
        var list = app.parseSearch(txt);
        if (!list.length) return '没有匹配「' + kw + '」的股票';
        return '找到 ' + list.length + ' 个，前 ' + Math.min(10, list.length) + ' 个：\n'
          + list.slice(0, 10).map(function (x) { return x.code + ' ' + x.name; }).join('\n');
      });
    },

    get_quote: function (a) {
      var cc = normCode(a.code);
      if (!cc) return Promise.resolve('缺少或无法识别股票代码');
      return app.callNative('quote', cc).then(function (txt) {
        var q = app.parseQuote(txt);
        var k = Object.keys(q)[0];
        if (!k) return '未取到行情：' + cc;
        var x = q[k];
        return [x.name + '（' + x.code + '）',
          '现价 ' + f(x.price) + '  涨跌 ' + f(x.change) + '（' + f(x.pct) + '%）',
          '开 ' + f(x.open) + '  高 ' + f(x.high) + '  低 ' + f(x.low) + '  昨收 ' + f(x.prevClose),
          '量 ' + app.fmtVol(x.vol) + '  额 ' + (isFinite(x.amount) ? (x.amount / 1e4).toFixed(0) + '万' : '--'),
          '涨停 ' + f(x.upLimit) + '  跌停 ' + f(x.downLimit) + '  换手 ' + f(x.turnover) + '%',
          '时间 ' + (x.stamp || '')].join('\n');
      });
    },

    get_fundamental: function (a) {
      var cc = normCode(a.code);
      if (!cc) return Promise.resolve('缺少或无法识别股票代码');
      return app.callNative('fundamental', cc).then(function (txt) {
        var d;
        try { d = JSON.parse(txt); } catch (e) { return '基本面解析失败：' + txt; }
        var q = d.quote || {};
        var L = [];
        L.push((d.name || cc) + '（' + cc + '）基本面');
        L.push('');
        L.push('【估值】');
        L.push('  现价 ' + f(q.price) + '（' + (q.pct > 0 ? '+' : '') + f(q.pct) + '%）');
        L.push('  市盈率 ' + (q.pe ? f(q.pe) : '亏损/无')
          + '　市盈率TTM ' + (q.peTtm ? f(q.peTtm) : '--')
          + '　市净率 ' + (q.pb ? f(q.pb) : '--'));
        L.push('  总市值 ' + f(q.totalCap) + ' 亿　流通市值 ' + f(q.cirCap) + ' 亿');
        L.push('  换手 ' + f(q.turnover) + '%　量比 ' + f(q.volRatio)
          + '　最高 ' + f(q.high) + '　最低 ' + f(q.low));

        var reps = d.reports || [];
        if (reps.length) {
          L.push('');
          L.push('【财务（按报告期倒序，营收/净利单位亿元）】');
          L.push('  报告期      营收      净利      同比(EPS)  ROE    净利率');
          reps.forEach(function (r) {
            L.push('  ' + pad(r.date, 11)
              + pad(f(r.revenue), 10) + pad(f(r.netProfit), 10)
              + pad(f(r.eps), 10) + pad(f(r.roe) + '%', 8) + f(r.netMargin) + '%');
          });
          // 算一个同比：首尾 EPS 比（只有当期间跨度是年对年时才有意义）
          if (reps.length >= 2) {
            var a1 = reps[0].eps, a2 = reps[reps.length - 1].eps;
            if (a1 && a2) {
              L.push('');
              L.push('  EPS ' + f(a2) + ' → ' + f(a1) + '，'
                + (a1 > a2 ? '增长' : (a1 < a2 ? '下滑' : '持平'))
                + '（注意：不同报告期不可直接当同比，同比要看去年同期）');
            }
          }
        } else {
          L.push('');
          L.push('【财务】无（指数/ETF 或未披露财报）');
        }

        if (d.errors && d.errors.length) {
          L.push('');
          L.push('注意：' + d.errors.join('；'));
        }
        return L.join('\n');
      }).catch(function (e) {
        return '基本面获取失败：' + (e && e.message ? e.message : e);
      });
    },

    compare_fundamental: function (a) {
      var arr = (a.codes || []).map(normCode).filter(Boolean).slice(0, 4);
      if (arr.length < 2) return Promise.resolve('至少需要 2 个有效代码');
      var rows = [];
      var chain = Promise.resolve();
      arr.forEach(function (cc) {
        chain = chain.then(function () {
          return app.callNative('fundamental', cc).then(function (txt) {
            try { rows.push(JSON.parse(txt)); } catch (e) { rows.push({ code: cc, errors: ['解析失败'] }); }
          }).catch(function () { rows.push({ code: cc, errors: ['请求失败'] }); });
        });
      });
      return chain.then(function () {
        var L = ['横向比较（同一口径，数据来自东财）', ''];
        L.push('  代码        名称        PE     PB      ROE    净利率   总市值(亿)');
        var valid = [];
        rows.forEach(function (r) {
          var q = r.quote || {};
          var reps = r.reports || [];
          var roe = reps.length ? reps[0].roe : null;
          var nm = reps.length ? reps[0].netMargin : null;
          L.push('  ' + pad(r.code || '', 12) + pad(r.name || '--', 11)
            + pad(q.pe ? f(q.pe) : '--', 7) + pad(q.pb ? f(q.pb) : '--', 7)
            + pad(roe != null ? f(roe) + '%' : '--', 8)
            + pad(nm != null ? f(nm) + '%' : '--', 8)
            + f(q.totalCap));
          if (q.pe) valid.push({ code: r.code, name: r.name, pe: q.pe, pb: q.pb, roe: roe });
        });
        L.push('');
        if (valid.length >= 2) {
          valid.sort(function (x, y) { return x.pe - y.pe; });
          L.push('按市盈率从低到高：'
            + valid.map(function (v) { return v.name + '(' + f(v.pe) + ')'; }).join(' > '));
          L.push('注意：PE 低不等于便宜 —— 银行/周期股天然低 PE，'
            + '成长股高 PE 可能合理。要结合 ROE 与行业看，不要只凭 PE 排序下结论。');
        }
        var errs = rows.filter(function (r) { return r.errors && r.errors.length; });
        if (errs.length) {
          L.push('');
          L.push('部分数据缺失：' + errs.map(function (r) {
            return r.code + '(' + r.errors.join(',') + ')';
          }).join('；'));
        }
        return L.join('\n');
      });
    },

    get_kline: function (a) {
      var count = a.count || 120;
      return loadKl(a.code, a.period, count).then(function (r) {
        if (!r.kl.length) return '未取到 K 线：' + r.code + ' ' + r.period + '（代码或周期可能不对）';
        var rows = r.kl.map(function (k) {
          return k.t + ',' + f(k.o, 3) + ',' + f(k.h, 3) + ',' + f(k.l, 3) + ',' + f(k.c, 3) + ',' + k.v;
        });
        return '代码 ' + r.code + ' 周期 ' + r.period + ' 共 ' + r.kl.length + ' 根（旧→新）\n'
          + '时间,开,高,低,收,量\n' + rows.join('\n');
      });
    },

    compute_indicators: function (a) {
      return loadKl(a.code, a.period, 300).then(function (r) {
        if (!r.kl.length) return '未取到数据：' + r.code;
        var ind = window.Ind.computeAll(r.kl, {
          maPeriods: [5, 10, 20, 60, 120, 250],
          ind: { MA: true, BOLL: true, MACD: true, KDJ: true, RSI: true, VOLMA: true }
        });
        return summarizeInd(r.kl, ind, r.code, r.period);
      });
    },

    analyze_chan: function (a) {
      return loadKl(a.code, a.period, 300).then(function (r) {
        if (!r.kl.length) return '未取到数据：' + r.code;
        if (!window.CHAN_FORMULA) return '缠论公式未加载，无法计算';
        var ch = window.Chan.analyze(r.kl, window.CHAN_FORMULA);
        return summarizeChan(r.kl, ch, r.code, r.period);
      });
    },

    /**
     * 多级别联立。
     *
     * ★ 为什么要做成一个工具而不是让模型自己连调 3 次 analyze_chan：
     *   1) 跨周期必须**串行**——并发会让原生层排队、返回顺序不确定，
     *      级别顺序错一位，整个判断就反了
     *   2) 每级返回的都是长文本，模型自己拼要读 3 遍、还容易串级
     *   3) "级别冲突"这件事必须由代码算，不能指望模型每次都不漏
     *   这里一次取完，只回一张紧凑的表 + 冲突结论。
     */
    analyze_levels: function (a) {
      var periods = (a.periods && a.periods.length) ? a.periods.slice(0, 4)
                                                    : ['week', 'day', 'm60'];
      var rows = [];
      var errs = [];

      // 串行链，保证顺序与 periods 一致
      var chain = Promise.resolve();
      periods.forEach(function (p) {
        chain = chain.then(function () {
          return loadKl(a.code, p, 300).then(function (r) {
            if (!r.kl.length) {
              errs.push(app.periodName(p) + ' 无数据');
              rows.push({ period: p, name: app.periodName(p), bars: 0 });
              return;
            }
            if (!window.CHAN_FORMULA) {
              errs.push('缠论公式未加载');
              rows.push({ period: p, name: app.periodName(p), bars: r.kl.length });
              return;
            }
            var ch = window.Chan.analyze(r.kl, window.CHAN_FORMULA);
            var n = r.kl.length;

            // 方向判定：用「笔的高低点是否递进」判断趋势，不是数笔的涨跌根数。
            //
            // ★ 这里踩过一次坑：最初用「最近 3 笔里 up 的个数」判方向，
            //   结果一个从 14 跌到 6 的周线被判成"上涨" —— 因为下跌趋势里
            //   的反弹笔同样会让 up 计数占多数（笔本来就是交替的）。
            //   正确的读法是看结构：
            //     顶在抬高 + 底在抬高 → 上涨
            //     顶在降低 + 底在降低 → 下跌
            //     否则 → 震荡
            var bis = ch.bi || [];
            var dir = '震荡';
            if (bis.length >= 4) {
              var tail = bis.slice(-4);
              var tops = [], bots = [];
              for (var ti = 0; ti < tail.length; ti++) {
                if (tail[ti].dir === 'up') tops.push(tail[ti].toPrice);
                else bots.push(tail[ti].toPrice);
              }
              // 相邻两个顶/底比较
              if (tops.length >= 2 && bots.length >= 1) {
                var topUp = tops[tops.length - 1] > tops[tops.length - 2];
                var botUp = bots.length >= 2
                  ? bots[bots.length - 1] > bots[bots.length - 2]
                  : (tops[tops.length - 1] > tops[tops.length - 2]);
                if (topUp && botUp) dir = '上涨';
                else if (!topUp && !botUp) dir = '下跌';
              } else if (tops.length >= 1 && bots.length >= 2) {
                var bUp = bots[bots.length - 1] > bots[bots.length - 2];
                var tUp = bots[bots.length - 1] > bots[bots.length - 2];
                if (bUp) dir = '上涨'; else dir = '下跌';
              }
            }
            // 兜底：笔太少时用首尾收盘价判断，总比一律写"震荡"有用
            if (dir === '震荡' && n >= 20) {
              var firstC = r.kl[n - 20].c, lastC = r.kl[n - 1].c;
              var chg = (lastC - firstC) / (firstC || 1);
              if (chg > 0.08) dir = '上涨';
              else if (chg < -0.08) dir = '下跌';
            }
            var lastBox = ch.stats && ch.stats.lastBox;
            var lastPt = (ch.points && ch.points.length)
              ? ch.points[ch.points.length - 1] : null;
            // 最近一个背驰的力度，给 chan-divergence 分档用（strength 只在本级别内有意义）
            var lastSg = (ch.signals && ch.signals.length)
              ? ch.signals[ch.signals.length - 1] : null;
            rows.push({
              period: p,
              name: app.periodName(p),
              bars: n,
              dir: dir,
              position: (ch.stats && ch.stats.boxPosition) || '无中枢',
              zg: lastBox ? +lastBox.zg.toFixed(2) : null,
              zd: lastBox ? +lastBox.zd.toFixed(2) : null,
              pens: (ch.pens || []).length,
              boxes: (ch.boxes || []).length,
              point: lastPt ? { label: lastPt.label, price: +lastPt.price.toFixed(2) } : null,
              div: lastSg ? {
                label: lastSg.label,
                price: +lastSg.price.toFixed(2),
                strength: +lastSg.strength
              } : null,
              chanErr: (ch.errors || []).length
            });
          }).catch(function (e) {
            errs.push(app.periodName(p) + ' 取数失败');
            rows.push({ period: p, name: app.periodName(p), bars: 0 });
          });
        });
      });

      return chain.then(function () {
        var L = [];
        L.push('多级别联立 ' + (rows[0] ? rows[0].name.split(' ')[0] : '') + ' · ' + normCode(a.code));

        // 对照表
        L.push('');
        L.push(pad('级别', 8) + pad('方向', 6) + pad('位置', 10) + pad('中枢', 24) + '信号');
        var valid = [];
        rows.forEach(function (r) {
          if (!r.bars) {
            L.push(pad(r.name, 6) + '　数据不足，无法判断');
            return;
          }
          valid.push(r);
          var box = (r.zg != null) ? ('ZG ' + r.zg + ' / ZD ' + r.zd) : '—';
          var sig = r.point ? (r.point.label + ' ' + r.point.price) : '无';
          L.push(pad(r.name, 8) + pad(r.dir, 6) + pad(r.position, 10)
            + pad(box, 24) + sig
            + (r.div ? ('　背驰 ' + r.div.label + '@' + r.div.price
                        + ' 力度 ' + r.div.strength.toFixed(2)) : ''));
        });

        // 数据量提醒：周线根数太少时级别判断不可靠
        var thin = valid.filter(function (r) { return r.bars < 40; });
        if (thin.length) {
          L.push('');
          L.push('注意：' + thin.map(function (r) {
            return r.name + ' 仅 ' + r.bars + ' 根';
          }).join('、') + '，该级别结论可靠性下降。');
        }

        // 级别冲突判定：只比相邻两级
        L.push('');
        var conflicts = [];
        var same = [];
        for (var i = 0; i + 1 < valid.length; i++) {
          var big = valid[i], small = valid[i + 1];
          if (big.dir === small.dir && big.dir !== '震荡') {
            same.push(big.name + '↔' + small.name + ' 同向' + big.dir);
          } else if (big.dir !== '震荡' && small.dir !== '震荡' && big.dir !== small.dir) {
            conflicts.push(big.name + big.dir + '，但' + small.name + small.dir);
          }
        }
        if (conflicts.length) {
          L.push('级别冲突：' + conflicts.join('；'));
          L.push('含义：小级别方向与大级别相反，小级别的买卖点只能当**反弹**做，');
          L.push('　　　不能按趋势买点重仓。仓位必须按大级别方向降级。');
        } else if (same.length) {
          L.push('级别一致：' + same.join('；'));
        } else if (valid.length) {
          L.push('级别关系：' + valid.map(function (r) { return r.name + r.dir; }).join(' → ')
            + '（无明确冲突，也无共振）');
        }

        if (errs.length) {
          L.push('');
          L.push('数据问题：' + errs.join('；'));
        }
        return L.join('\n');
      });
    },

    annotate_chart: function (a) {
      var ch = app.chart();
      if (!ch) return Promise.resolve('图表还没准备好');
      var typeMap = {
        '压力': 'resist', '阻力': 'resist', 'resist': 'resist',
        '支撑': 'support', 'support': 'support', '买入': 'support',
        '止损': 'stop', 'stop': 'stop', 'stop_loss': 'stop',
        '目标': 'target', '止盈': 'target', 'target': 'target',
        '卖出': 'resist'
      };
      var levels = (a.levels || []).map(function (x) {
        var price = Number(x.price);
        var type = typeMap[String(x.type || '').trim()] || 'support';
        var label = String(x.label || x.type || '').trim();
        return { price: price, type: type, label: label + ' ' + f(price) };
      }).filter(function (x) { return isFinite(x.price) && x.price > 0; });

      if (!levels.length) return Promise.resolve('没有有效价位（price 必须是正数，type 用 支撑/压力/止损/目标）');

      ch.setAiMarks(levels, []);
      app.S.aiLevels = levels;

      var msg = '已在图上标注 ' + levels.length + ' 个价位：'
        + levels.map(function (x) { return x.label; }).join('、');

      // 可选：把光标定位到某根 K 线（让用户看到 AI 指的是那根）
      if (a.focus) {
        var kl = app.S.kl || [];
        var target = String(a.focus);
        var idx = -1;
        for (var i = kl.length - 1; i >= 0; i--) {
          if (String(kl[i].t).indexOf(target) === 0) { idx = i; break; }
        }
        if (idx >= 0) {
          ch.crossIdx = idx;
          ch.selIdx = idx;
          ch.render();
          try { app.showCursorInfo(idx); } catch (e) {}
          msg += '\n光标已定位到 ' + kl[idx].t;
        } else {
          msg += '\n（没找到日期含「' + target + '」的 K 线，未定位）';
        }
      }
      return Promise.resolve(msg);
    },

    draw_on_chart: function (a) {
      var ch = app.chart();
      if (!ch) return Promise.resolve('图表还没准备好');
      var kl = app.S.kl || [];
      if (!kl.length) return Promise.resolve('还没有 K 线数据，无法绘图');

      var mode = String(a.mode || 'replace').toLowerCase();
      if (mode === 'clear') {
        ch.clearShapes();
        app.S.aiShapes = [];
        return Promise.resolve('已清空图上的绘图');
      }

      var list = Array.isArray(a.shapes) ? a.shapes : [];
      if (!list.length) return Promise.resolve('shapes 为空，没有可画的内容');

      // 逐条校验：非法整条丢弃，原因回给模型让它自己改
      var res = window.ChartShapes
        ? window.ChartShapes.normalizeAll(list, kl)
        : { shapes: [], errors: ['绘图模块未加载'] };

      if (!res.shapes.length) {
        return Promise.resolve('没有任何图元被画上，原因：\n' + res.errors.join('\n')
          + '\n请按上面的范围修正坐标后重试。');
      }

      if (mode === 'append') {
        ch.addShapes(res.shapes);
        app.S.aiShapes = (app.S.aiShapes || []).concat(res.shapes);
      } else {
        ch.setShapes(res.shapes);
        app.S.aiShapes = res.shapes.slice();
      }

      // 回给模型：画了什么 + 哪些失败（这样它能自己修正）
      var ok = '已在图上画了 ' + res.shapes.length + ' 个图元：'
        + res.shapes.map(function (x) { return x.type; }).join('、');
      if (res.errors.length) {
        ok += '\n以下 ' + res.errors.length + ' 条未画上（请修正后重试）：\n' + res.errors.join('\n');
      }
      return Promise.resolve(ok);
    },

    read_skill: function (a) {
      var name = safeName(String(a.name == null ? '' : a.name).replace(/\.md$/i, ''));
      if (!name) return Promise.resolve('缺少或非法的 skill 名称');
      return app.callNative('fsRead', 'skills/' + name + '.md').then(function (t) {
        return clip(t, 12000);
      }).catch(function (e) {
        return '读取 skill「' + name + '」失败：' + (e && e.message ? e.message : e);
      });
    },

    notes: function (a) {
      var action = String(a.action || 'list').toLowerCase();
      if (action === 'list') {
        return app.callNative('fsList', 'notes').then(function (t) {
          var arr = [];
          try { arr = JSON.parse(t || '[]'); } catch (e) {}
          if (!arr.length) return '（notes 目录为空）';
          return '笔记 ' + arr.length + ' 篇：\n' + arr.map(function (x) {
            return '  ' + x.name + '  ' + x.size + ' 字节  ' + new Date(x.mtime).toLocaleString();
          }).join('\n');
        });
      }
      var title = safeName(String(a.title == null ? '' : a.title));
      if (!title) return Promise.resolve('read/write 需要合法的 title');
      var path = 'notes/' + title + '.md';
      if (action === 'read') {
        return app.callNative('fsRead', path).then(function (t) { return clip(t, 12000); })
          .catch(function (e) { return '读取失败：' + (e && e.message ? e.message : e); });
      }
      if (action === 'write') {
        var content = String(a.content == null ? '' : a.content);
        return app.callNative('fsWrite', path, content).then(function () {
          return '已写入笔记「' + title + '」（' + content.length + ' 字符）';
        }).catch(function (e) { return '写入失败：' + (e && e.message ? e.message : e); });
      }
      return Promise.resolve('未知 action：' + action + '（可用 list / read / write）');
    }
  };

  /** 执行工具：永不 reject，错误也变成模型可读的文本 */
  function run(name, args) {
    var off = (app.S && app.S.cfg && app.S.cfg.disabledTools) || [];
    if (off.indexOf(name) >= 0) {
      return Promise.resolve('工具「' + name + '」已被用户在设置里关闭，本次不执行。');
    }
    var fn = RUNNERS[name];
    if (!fn) return Promise.resolve('未知工具：' + name);
    var a = args || {};
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch (e) { a = {}; }
    }
    return new Promise(function (resolve) {
      var p;
      try {
        p = fn(a);
      } catch (e) {
        resolve('工具 ' + name + ' 执行异常：' + (e && e.message ? e.message : e));
        return;
      }
      if (!p || typeof p.then !== 'function') { resolve(clip(p)); return; }
      p.then(function (r) { resolve(clip(r)); })
        .catch(function (e) { resolve('工具 ' + name + ' 失败：' + (e && e.message ? e.message : e)); });
    });
  }

  window.AgentTools = {
    /** OpenAI tools 数组（每次返回副本，调用方可随意改） */
    specs: function () {
      return SPECS.map(function (s) {
        return {
          type: 'function',
          function: {
            name: s.name,
            description: s.description,
            parameters: JSON.parse(JSON.stringify(s.parameters))
          }
        };
      });
    },
    names: function () { return SPECS.map(function (s) { return s.name; }); },
    has: function (name) { return !!RUNNERS[name]; },
    run: run,
    /** 一轮分析开始时清空 K 线缓存（agent.js 调用） */
    _resetKlCache: resetKlCache,
    /** 供测试使用 */
    _klCacheOn: klCacheOn,
    _klCacheSize: function () { return Object.keys(klCache).length; },
    _normCode: normCode,
    _clip: clip
  };
})();
