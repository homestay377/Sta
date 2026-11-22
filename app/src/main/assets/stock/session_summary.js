/**
 * 会话摘要：**老消息自动压缩成一段摘记**，只留着最近几条原样喂给模型。
 *
 * v9.0 的必要性：
 *   原来是「最近 12 条、每条截断 1500 字」——一只股聊几十轮之后，
 *   模型就再也看不到你早先说过的偏好和结论。
 *   现在改用"旧内容 → 一段摘要；新内容 → 原样"，省下的 token 倍率能做很多次追问。
 *
 * 摘要保存到哪：同一只股票的 json 文件里多一个字段 `summary`（默认 `""`）。
 * 什么时候算压缩：**消息数 > SUMMARY_THRESHOLD（=40）** 时每轮询问前压缩一次。
 * 摘要生成方式（无 LLM 依赖）：
 *   · 把「在早期」的所有 user / assistant 消息按位置拼起来
 *   · user 段保留原文字，assistant 段略截（但结论优先保留）
 *   · 超过 MAX_SUMMARY_CHARS 取前 N 字 + 「（以下略）」
 */
(function (global) {
  'use strict';

  var SUMMARY_THRESHOLD = 40;             // 超过这个条数就压
  var KEEP_RECENT_N = 8;                  // 保留最近原样的条数
  var MAX_SUMMARY_CHARS = 2000;           // courtesy：控制在也把工具食用的范围
  var ONE_MSG_PREVIEW = 360;              // 单条消息最大可见

  /**
   * 把旧片段（开头到 length - KEEP_RECENT_N - 1）压成一段摘要串。
   * 这里不直接调 AI（session 行为要稳定），而是用拼接按规则做：
   *   user: "…" 换行
   *   assistant: "…"（截到 360 字 —— 主要是结论）
   *
   * 结果是带标签的纯文本摘要，模型能直接看懂"这是之前的对话要点"。
   */
  function buildSummary(messages) {
    if (!Array.isArray(messages)) return '';
    var early = messages.slice(0, Math.max(0, messages.length - KEEP_RECENT_N));
    var parts = [];
    early.forEach(function (m) {
      if (!m || !m.content) return;
      var label = m.role === 'assistant' ? '我之前说过' : '用户之前说';
      var text = String(m.content).trim();
      if (text.length > ONE_MSG_PREVIEW) text = text.slice(0, ONE_MSG_PREVIEW) + '…';
      parts.push(label + ': ' + text);
    });
    var s = parts.join('\n');
    if (!s) return '';
    // 超过 2000 字直接砍掉最末（不营养的部分）
    if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS) + '（后略）';
    return '【之前对话的要点（摘要）】\n' + s;
  }

  /**
   * 组装要喂给 agent 的历史：
   *   · 若消息数 > THRESHOLD，就前段用摘要，后 KEEP_RECENT_N 条取原文
   *   · 否则与默认行为一致（取最近 HISTORY_N 条 + 截断）
   *
   * 摘要调用者可以忽略历史里的 summary 字段直接当文本用（见 toAgentHistory）。
   */
  function toAgentHistoryWithSummary(messages) {
    if (!Array.isArray(messages) || messages.length <= 40) return null;   // 不需要摘要
    var summary = buildSummary(messages);
    var recent = messages.slice(-KEEP_RECENT_N);
    return { summary: summary, recent: recent };
  }

  /**
   * 追加/更新摘要到当前消息列表（在 file 里加 summary 字段，但保持原历史）。
   * 实际 app 调用：在每轮对话后、写入会话前对 messages 处理。
   *
   * 用 obj 引用来附加：
   *   先计算当前已有 total 和本次新增的 user / assistant，提前剪去过时字段。
   *   返回更新后的 messages 和 summary。
   */
  function summarizeForStorage(messages, existingSummary) {
    if (!Array.isArray(messages)) return { messages: [], summary: existingSummary || '' };
    // 每过一轮才重算一次。大量保留就行，主体由 recent 充，这里只做"定期清压"。
    if (messages.length <= SUMMARY_THRESHOLD + 2) {
      return { messages: messages, summary: existingSummary || '' };
    }
    return { messages: messages, summary: buildSummary(messages) };
  }

  global.SessionSummary = {
    SUMMARY_THRESHOLD: SUMMARY_THRESHOLD,
    KEEP_RECENT_N: KEEP_RECENT_N,
    MAX_SUMMARY_CHARS: MAX_SUMMARY_CHARS,
    buildSummary: buildSummary,
    toAgentHistoryWithSummary: toAgentHistoryWithSummary,
    summarizeForStorage: summarizeForStorage
  };
})(window);
