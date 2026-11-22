/**
 * Agent 循环控制器。
 *
 * 职责：把「用户一句话」变成「模型 + 工具」的多步执行，直到模型给出不带工具调用的回答。
 *
 *   user → 模型 → [tool_calls…] → 执行工具 → 结果回填 → 模型 → … → 最终回答
 *
 * 几条硬约束（都踩过坑，别删）：
 *   · 步数上限 12、总时长 300s —— 防止模型钻牛角尖把 token 烧光
 *   · 同一工具 + 同一参数连续出现 2 次即判定死循环并中止
 *   · 随时可中断：调 abortAi() 真断 TCP，再用 seq 作废所有在途回调
 *   · 模型不支持 tools 时，回退解析正文里的 ```json {"tool":…}``` 指令
 *   · 工具失败不抛异常，把错误文本喂回模型，让它自己换路子
 *
 * 提速（v10.21）：
 *   · **同一轮里的多个工具并发执行**。模型一次要 4 个数据工具时，
 *     原来是排队等 4 个网络来回，现在一起发出去，只等最慢的那个。
 *     这就是「多子 agent」在单机上的可行形态：一个模型，多个并行的取数子任务。
 *   · 改图表的工具（annotate_chart / draw_on_chart）例外：它们动的是同一张图，
 *     并发会互相覆盖，必须串行且放在数据工具之后。
 *   · 结果按模型给出的**下标顺序**回填 messages，与并发完成顺序无关 ——
 *     OpenAI 协议要求每个 tool_call_id 都有应答，顺序错乱会让上下文语义变味。
 *   · K 线在同一轮内复用（tools.js 的回合内缓存），同一份数据不再拉三遍。
 */
(function () {
  'use strict';

  var app = window.__app;

  var MAX_STEPS = 12;
  var TOTAL_TIMEOUT_MS = 300000;
  /** 运行期可覆盖的总时限（测试要能把 300s 压到 1ms 才能验证看门狗） */
  var totalTimeoutMs = TOTAL_TIMEOUT_MS;
  var MAX_REPEAT = 2;
  /** 同一轮里最多同时跑几个工具。原生侧取数线程池是 8，留余量取 4 */
  var TOOL_CONCURRENCY = 4;
  /** 改动图表状态的工具：必须串行，且排在数据类工具之后 */
  var CHART_TOOLS = { annotate_chart: true, draw_on_chart: true };

  var state = { running: false, aborted: false, seq: 0, startedAt: 0, current: null };

  // ==================== 模型交互 ====================

  function parseModelReply(raw) {
    try {
      var o = JSON.parse(raw);
      var tcs = [];
      (o.toolCalls || []).forEach(function (t) {
        var args = t.args;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch (e) { args = {}; }
        }
        if (!t.name) return;
        tcs.push({
          id: t.id || ('call_' + Math.random().toString(36).slice(2, 8)),
          name: t.name,
          args: args || {}
        });
      });
      return {
        text: o.text || '',
        reasoning: o.reasoning || '',
        finish: o.finish || '',
        toolCalls: tcs
      };
    } catch (e) {
      // 不是 JSON（老原生层 / 异常）→ 当纯文本
      return { text: String(raw == null ? '' : raw), reasoning: '', finish: '', toolCalls: [] };
    }
  }

  /** 模型不支持 tools 时：从正文里找最后一段 ```json {"tool":…,"args":…}``` */
  function extractTextTool(text) {
    if (!text) return null;
    var cand = null;
    var re = /```(?:json)?\s*([\s\S]*?)```/g, m;
    while ((m = re.exec(text)) !== null) cand = m[1];
    if (!cand) {
      var i = text.lastIndexOf('{"');
      if (i >= 0) cand = text.slice(i);
    }
    if (!cand) return null;
    try {
      var o = JSON.parse(cand.trim());
      var name = o.tool || o.name || (o.function && o.function.name);
      if (!name || !window.AgentTools.has(name)) return null;
      var args = o.args || o.arguments || (o.function && o.function.arguments) || {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch (e) { args = {}; } }
      return { id: 'txt_' + Date.now().toString(36), name: name, args: args };
    } catch (e) {
      return null;
    }
  }

  /**
   * 调一次模型。
   *
   * ★ 优先走**流式**（aiChatToolsStream）：原生层边读 SSE 边把增量回调过来，
   *   用户能看着字往外冒，不用等整段生成完再一次性出现。
   *   原生层没有这个能力时（老 APK / 测试基座没提供）自动退回整段式，
   *   行为与以前完全一致 —— 所以这个改动是「有则更好，无则不变」。
   *
   * onDelta(kind, text)：kind = 'text' | 'reasoning'
   */
  function callModel(messages, tools, seq, onDelta) {
    var cfg = app.S.cfg || {};
    var cfgJson = JSON.stringify(cfg);
    var msgsJson = JSON.stringify(messages);
    var toolsJson = JSON.stringify(tools);

    var p;
    if (app.hasNative && app.hasNative('aiChatToolsStream')) {
      p = app.callNativeEx({
        onStream: function (kind, text) {
          if (state.aborted || seq !== state.seq) return;
          if (onDelta) { try { onDelta(kind, text); } catch (e) {} }
        }
      }, 'aiChatToolsStream', cfgJson, msgsJson, toolsJson);
    } else {
      p = app.callNative('aiChatTools', cfgJson, msgsJson, toolsJson);
    }

    return p.then(function (raw) {
      return parseModelReply(raw);
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (msg === '__aborted__' || state.aborted || seq !== state.seq) return null;
      throw new Error(msg);
    });
  }

  // ==================== 失败诊断 ====================
  //
  // 用户的原话：「有的分析会失败，不知道是超时了还是报错了」。
  // 所以失败不能只回一句原始异常 —— 要能一眼看出是哪一类。
  // 分档依据是错误文本本身的特征，不依赖调用方额外传参。

  function errText(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    return (e && e.message) ? e.message : String(e);
  }

  function classifyError(msg) {
    var s = String(msg == null ? '' : msg);
    if (!s) return 'unknown';
    if (/超时|timeout|Timeout/i.test(s)) return 'timeout';
    if (/未配置 API|未配置 API Key|未选择模型/.test(s)) return 'config';
    if (/HTTP 401|HTTP 403|invalid.*key|unauthorized|鉴权/i.test(s)) return 'auth';
    if (/HTTP 429|rate ?limit|too many requests|限流/i.test(s)) return 'rate_limit';
    if (/^HTTP \d|^AI 返回错误/.test(s)) return 'server';
    if (/(网络|连接|Socket|UnknownHost|ECONNRESET|ECONNREFUSED|拒绝|reset|SSL|DNS)/i.test(s)) return 'network';
    return 'unknown';
  }

  /** 给用户看的短标签 */
  function errorKindLabel(kind) {
    return ({
      timeout: '超时',
      network: '网络',
      config: '配置',
      auth: '鉴权',
      rate_limit: '限流',
      server: '服务端',
      unknown: '未知'
    })[kind] || '未知';
  }

  /** 针对不同类别的可执行建议 —— 不写这句，用户只能干瞪眼 */
  function errorKindHint(kind) {
    return ({
      timeout: '模型或中转站响应太慢。可换更快的模型（非推理模型），或把问题问窄一点。',
      network: '网络不通或中转站失联。检查网络后重试。',
      config: '设置里的 API 地址 / Key / 模型名不完整，去设置页补齐。',
      auth: 'API Key 无效或没有该模型的权限。',
      rate_limit: '请求太频繁被限流，等几十秒再试。',
      server: '中转站或模型服务端报错，把上面的原文发给服务方。',
      unknown: '把上面的原文留着，便于定位。'
    })[kind] || '';
  }

  // ==================== system prompt ====================

  /**
   * 组装系统提示。P2 会在这里插入 skill 索引与命中的世界书条目。
   * @param {Object} o {context, skills, worldbook}
   */
  function buildSystem(o) {
    var L = [];
    L.push('你是一个 A 股个股分析 agent，通过调用工具获取真实数据后给出判断。');
    L.push('');
    L.push('【铁律】');
    L.push('1. 所有价格、指标数值必须来自工具返回；不许凭印象编造，也不要用训练数据里的旧价格。');
    L.push('2. 要多个周期的信息时，用工具取，不要假设。');
    L.push('3. 给出支撑/压力/止损/目标价位时，必须调用 annotate_chart 画到图上 —— 用户只有在图上看到才认。');
    L.push('4. 工具返回被截断时（会标注"结果被截断"），需要更细的数据就用更小的范围重查。');
    L.push('5. 同一个工具同样的参数不要重复调用，结果不会变。');
    L.push('6. 结论要落地：方向 + 关键价位 + 触发条件 + 风险。不要免责声明式的空话。');
    L.push('7. 中文回答，简洁，不要复述工具返回的原始表格。');
    L.push('8. ★ 一次把该取的都取了：你可以在同一轮里同时给出多个工具调用，它们会被并行执行。');
    L.push('   需要「行情 + 指标 + 缠论 + 多级别」时，请在**同一轮**里一次性全部调出，不要一个一个试。');
    L.push('   只有后一个工具的参数依赖前一个工具的返回值时，才分成多轮。');
    L.push('   串行多轮会让用户等很久，这是最需要避免的事。');
    L.push('9. 优先用「算好的摘要」工具（compute_indicators / analyze_chan / analyze_levels），');
    L.push('   确实要看原始 K 线时才用 get_kline —— 原始 CSV 很占上下文，会把后续每一步都拖慢。');
    if (o && o.skills) {
      L.push('');
      L.push('【可用 skill】需要详细步骤时用 read_skill 读取正文：');
      L.push(o.skills);
    }
    if (o && o.worldbook) {
      L.push('');
      L.push('【用户设定（优先遵循）】');
      L.push(o.worldbook);
    }
    if (o && o.context) {
      L.push('');
      L.push('【当前上下文】');
      L.push(o.context);
    }
    return L.join('\n');
  }

  /**
   * 并发闸门。同时最多跑 limit 个任务，全部完成后按原下标返回结果数组。
   *
   * 为什么要限流而不是 Promise.all 一把梭：
   *   原生侧的取数线程池是 8 个线程，行情源（腾讯/东财/新浪）也有各自的
   *   频率脾气。模型一轮丢 6、7 个工具过来时无脑全开，容易触发对端限流，
   *   反而更慢。4 是「不空转」和「不把源打毛」之间的平衡点。
   */
  function runBounded(tasks, limit) {
    limit = Math.max(1, Math.floor(limit) || 1);   // 防 0 / undefined 造成死循环
    var out = new Array(tasks.length);
    var next = 0, active = 0, settled = 0;
    return new Promise(function (resolve) {
      if (!tasks.length) { resolve(out); return; }
      function pump() {
        while (active < limit && next < tasks.length) {
          var i = next++;
          active++;
          Promise.resolve().then(tasks[i]).catch(function (e) {
            return { __error__: e };
          }).then(function (v) {
            out[i] = v;
            active--; settled++;
            if (settled === tasks.length) resolve(out);
            else pump();
          });
        }
      }
      pump();
    });
  }

  // ==================== 主循环 ====================

  /**
   * @param {Object} opt
   *   system        自定义 system 前缀（可选）
   *   context       当前股票/光标上下文文本
   *   skills        skill 索引文本（可选）
   *   worldbook     命中的世界书文本（可选）
   *   history       之前的对话 [{role, content}]（可选）
   *   input         本轮用户输入
   *   onToolCall    (toolCall, resultText, index) => void   UI 展示用
   *   onStep        (step, info) => void
   *   onStream      (kind, text) => void   流式增量（可选）
   *                   kind = 'step'       新的一轮开始，请清空实时缓冲
   *                        | 'text'       正文增量
   *                        | 'reasoning'  思考过程增量
   * @returns Promise<{text, reasoning, steps, toolCalls, aborted, timeout, overStep, error,
   *                   errorKind, elapsedMs, stepTimings, slowestStepMs, toolFailures, timeoutKind}>
   */
  function run(opt) {
    opt = opt || {};
    if (state.running) {
      return Promise.resolve({ error: '已有分析在进行中', text: '', steps: 0, toolCalls: 0 });
    }

    var seq = ++state.seq;
    state.running = true;
    state.aborted = false;
    var t0 = Date.now();
    state.startedAt = t0;
    // 一轮分析开始 → 清掉上一轮的 K 线缓存，避免跨轮拿到过期行情
    try {
      if (window.AgentTools && window.AgentTools._resetKlCache) window.AgentTools._resetKlCache();
    } catch (e) {}

    /** 距总时限还剩多少毫秒 */
    function remainMs() { return totalTimeoutMs - (Date.now() - t0); }

    /**
     * 总时限看门狗。
     *
     * 原来只在每轮开头查一次 `Date.now() - startedAt > TOTAL_TIMEOUT_MS`：
     * 最后一步可以在第 299 秒开始，然后再跑满一个模型请求（最坏 200s），
     * 用户在界面上干等 8 分钟才看到「已达时限」。
     * 现在把「剩余时间」做成赛跑：到点就立刻判超时并收尾。
     */
    function guard(p) {
      var left = remainMs();
      if (left <= 0) return Promise.resolve({ __timeout__: true });
      return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
          if (done) return;
          done = true;
          resolve({ __timeout__: true });
        }, left);
        Promise.resolve(p).then(function (v) {
          if (done) return;
          done = true;
          try { clearTimeout(timer); } catch (e) {}
          resolve(v);
        }, function (e) {
          if (done) return;
          done = true;
          try { clearTimeout(timer); } catch (e) {}
          resolve({ __error__: e });
        });
      });
    }
    // ★ 本轮的身份令牌。
    //   收尾时不能用 `seq === state.seq` 判断「我是不是最后一轮」：
    //   用户点「停止」时 stop() 会 seq++，条件永远不成立，
    //   state.running 就一直是 true —— 之后每次提问都被
    //   「已有分析在进行中」挡回去，只能杀进程重进。
    //   改成比对令牌：只要没有更新的 run 顶上来，本轮就有资格复位。
    var myRun = {};
    state.current = myRun;

    var tools = window.AgentTools.specs();
    var system = (opt.system ? opt.system + '\n\n' : '') + buildSystem(opt);
    var messages = [{ role: 'system', content: system }];
    (opt.history || []).forEach(function (m) { messages.push(m); });
    messages.push({ role: 'user', content: String(opt.input || '') });

    var steps = 0, toolCount = 0, lastSig = '', repeat = 0, deadLoop = false;
    var finalText = '', finalReasoning = '', finalFinish = '';
    // 诊断用：每一步模型耗时、失败的工具、最慢的一步
    var stepTimings = [];
    var toolFailures = [];
    var slowestStepMs = 0;

    function finish(extra) {
      var r = {
        text: finalText,
        reasoning: finalReasoning,
        finish: finalFinish,
        steps: steps,
        toolCalls: toolCount,
        aborted: false,
        elapsedMs: Date.now() - t0,
        stepTimings: stepTimings.slice(),
        toolFailures: toolFailures.slice(),
        slowestStepMs: slowestStepMs
      };
      for (var k in extra) r[k] = extra[k];
      // 有错就带上分类，UI 才能说清「是超时还是报错」
      if (r.error && !r.errorKind) r.errorKind = classifyError(r.error);
      return r;
    }

    function loop() {
      if (state.aborted || seq !== state.seq) {
        return Promise.resolve(finish({ aborted: true }));
      }
      if (steps >= MAX_STEPS) {
        return Promise.resolve(finish({ overStep: true }));
      }
      if (remainMs() <= 0) {
        return Promise.resolve(finish({ timeout: true, timeoutKind: 'total' }));
      }
      // ★ steps 在这里就 +1，语义是「第几次问模型」。
      //   原来是工具执行完才 +1，于是模型直接给结论时 steps 恒为 0，
      //   界面上写「完成 · 0 步」，用户以为出错了。
      steps++;
      // 最后一步之前提醒它收尾 —— 否则模型可能一路调工具到步数用光，
      // 用户看到的全是工具卡片、一条结论都没有
      if (steps === MAX_STEPS - 1) {
        messages.push({
          role: 'user',
          content: '（系统：这是最后一次机会，请立刻基于已取得的数据给出结论。不要再调用任何工具。）'
        });
      }

      var stepT0 = Date.now();
      // 新一轮开始：先让 UI 把上一轮的实时缓冲清掉，否则两轮的正文会粘在一起
      if (opt.onStream) { try { opt.onStream('step', ''); } catch (e) {} }
      var sawDelta = false;
      function onDelta(kind, text) {
        sawDelta = true;
        if (opt.onStream) { try { opt.onStream(kind, text); } catch (e) {} }
      }
      return guard(callModel(messages, tools, seq, onDelta)).then(function (reply) {
        // 被看门狗判超时：明确告诉调用方「是时间到，不是模型报错」
        if (reply && reply.__timeout__) {
          return finish({ timeout: true, timeoutKind: 'total' });
        }
        if (reply && reply.__error__) throw reply.__error__;
        var stepMs = Date.now() - stepT0;
        stepTimings.push(stepMs);
        if (stepMs > slowestStepMs) slowestStepMs = stepMs;
        if (reply === null) return finish({ aborted: true });   // 被中断

        if (reply.text) finalText = reply.text;
        // 没走流式（原生不支持）时，把整段正文当成一次增量补发 ——
        // 这样 UI 只有一条渲染路径，不必为「流式/非流式」写两套
        if (reply.text && !sawDelta && opt.onStream) {
          try { opt.onStream('text', reply.text); } catch (e) {}
        }
        if (reply.reasoning) finalReasoning = reply.reasoning;
        finalFinish = reply.finish;

        var tcs = reply.toolCalls.slice();
        if (!tcs.length) {
          var fb = extractTextTool(reply.text);
          if (fb) tcs = [fb];
        }
        if (!tcs.length) return finish({});      // 模型给出最终回答，收工

        // 把 assistant 这一步（含 tool_calls）写回历史，否则服务端会拒绝后续 tool 消息
        messages.push({
          role: 'assistant',
          content: reply.text || '',
          tool_calls: tcs.map(function (t) {
            return {
              id: t.id,
              type: 'function',
              function: { name: t.name, arguments: JSON.stringify(t.args || {}) }
            };
          })
        });

        // ---- 工具执行 ----
        //
        // ★ v10.21 的关键提速：同一轮里互不依赖的工具**并发执行**。
        //   以前是一个接一个 await，模型一轮要 4 个工具就得排 4 个网络来回；
        //   现在一起发出去，总耗时≈最慢的那一个。
        //
        //   两个例外必须串行：
        //     · annotate_chart / draw_on_chart 改的是同一张图表，并发会互相覆盖
        //     · 它们统一排在数据类工具**之后**（模型常在一批里既取数又标注）
        //
        //   结果一律按模型给出的下标顺序回填 messages —— 并发完成顺序是不可控的，
        //   但协议要求每个 tool_call_id 都要有对应应答，且上下文顺序要稳定。
        var entries = new Array(tcs.length);   // [{tc, content}]
        var dataJobs = [], chartJobs = [];

        tcs.forEach(function (tc, i) {
          // 死循环判定按「模型给出的顺序」串行推演，不能用并发结果
          var sig = tc.name + '|' + JSON.stringify(tc.args || {});
          if (sig === lastSig) repeat++; else { repeat = 0; lastSig = sig; }
          if (repeat >= MAX_REPEAT) {
            // 第一次重复：提醒它换思路；提醒过还来 → 判定死循环，收工
            if (repeat > MAX_REPEAT) { deadLoop = true; entries[i] = null; return; }
            entries[i] = {
              tc: tc,
              content: '（系统：你刚刚用同样的参数调过这个工具，结果不会变。请换工具、换参数，或直接给出结论。）'
            };
            return;
          }
          var job = { i: i, tc: tc };
          if (CHART_TOOLS[tc.name]) chartJobs.push(job); else dataJobs.push(job);
        });

        /** 把一个工具任务包成「永不 reject、结果写回 entries[i]」的函数 */
        function makeJob(job) {
          return function () {
            var tc = job.tc;
            if (state.aborted || seq !== state.seq) return Promise.resolve();
            if (opt.onStep) { try { opt.onStep(steps, { name: tc.name, args: tc.args }); } catch (e) {} }

            // ★ 双保险：tools.js 内部已经把异常转成「工具 X 失败：…」文本，
            //   但这里是 agent 的契约边界 —— 注释里写的是「工具失败不抛异常，
            //   把错误文本喂回模型让它换路子」，那就得自己再兜一层。
            //   漏了这层，任何一个工具的意外 reject 都会让整轮直接判失败，
            //   用户看到「分析失败：xxx」而不是模型换个方法继续回答。
            var runP;
            try {
              runP = window.AgentTools.run(tc.name, tc.args);
            } catch (e) {
              runP = Promise.resolve('工具 ' + tc.name + ' 执行异常：' + errText(e));
            }
            return Promise.resolve(runP).then(function (result) {
              toolCount++;
              if (opt.onToolCall) {
                try { opt.onToolCall(tc, result, toolCount); } catch (e) {}
              }
              entries[job.i] = { tc: tc, content: result };
            }, function (e) {
              var msg = '工具 ' + tc.name + ' 失败：' + errText(e);
              toolCount++;
              toolFailures.push({ name: tc.name, reason: errText(e) });
              if (opt.onToolCall) {
                try { opt.onToolCall(tc, msg, toolCount); } catch (e2) {}
              }
              entries[job.i] = { tc: tc, content: msg };
            });
          };
        }

        // 数据类并发（限流 4）→ 图表类串行（保持调用顺序）
        var work = runBounded(dataJobs.map(makeJob), TOOL_CONCURRENCY);
        if (chartJobs.length) {
          work = work.then(function () {
            return runBounded(chartJobs.map(makeJob), 1);
          });
        }

        return guard(work).then(function (wr) {
          // 取数超时：也要明确收尾，不能让用户无限等
          if (wr && wr.__timeout__) {
            return finish({ timeout: true, timeoutKind: 'tools' });
          }
          // 按原下标回填，保证 messages 里 tool 应答的顺序与模型请求一致
          entries.forEach(function (en) {
            if (en) messages.push({ role: 'tool', tool_call_id: en.tc.id, content: en.content });
          });
          if (deadLoop) return finish({ loop: true });
          if (state.aborted || seq !== state.seq) return finish({ aborted: true });
          return loop();
        });
      });
    }

    return loop().catch(function (e) {
      // errorKind 由 finish() 统一分类，UI 据此说清「超时还是报错」
      return finish({ error: errText(e) || '未知错误' });
    }).then(function (r) {
      // 只有「本轮仍是最新的一轮」才复位；被新 run 顶掉时由新 run 负责
      if (state.current === myRun) {
        state.running = false;
        state.aborted = false;
        state.current = null;
      }
      return r;
    });
  }

  /** 中断：掐连接 + 作废在途回调 */
  function stop() {
    if (!state.running) return;
    state.aborted = true;
    state.seq++;
    // ★ 立即复位，不等在途请求回来。
    //   abortAi 只是断开 TCP，原生层的回调有可能永远不回来（连接已半死、
    //   服务端卡在生成中）。那种情况下 state.running 会一直挂着 true，
    //   用户再点发送就只看到「已有分析在进行中」，功能等于废了。
    //   这里直接把本轮作废：后续回调回来时因为 current 已清空，
    //   收尾逻辑不会再动状态。
    state.running = false;
    state.current = null;
    try {
      if (window.NativeBridge && window.NativeBridge.abortAi) window.NativeBridge.abortAi();
    } catch (e) {}
  }

  window.Agent = {
    run: run,
    stop: stop,
    isRunning: function () { return state.running; },
    buildSystem: buildSystem,
    // 供测试
    _parseModelReply: parseModelReply,
    _extractTextTool: extractTextTool,
    _classifyError: classifyError,
    _errorKindLabel: errorKindLabel,
    _errorKindHint: errorKindHint,
    _runBounded: runBounded,
    /** 测试专用：压缩总时限以验证看门狗；传 0 恢复默认 */
    _setTotalTimeout: function (ms) { totalTimeoutMs = (ms && ms > 0) ? ms : TOTAL_TIMEOUT_MS; },
    _limits: {
      MAX_STEPS: MAX_STEPS,
      TOTAL_TIMEOUT_MS: TOTAL_TIMEOUT_MS,
      MAX_REPEAT: MAX_REPEAT,
      TOOL_CONCURRENCY: TOOL_CONCURRENCY
    }
  };
})();
