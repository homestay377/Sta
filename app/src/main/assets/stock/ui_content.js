/* 主界面与二级页面的内容重排，保留原有功能 id 与事件契约。 */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function markup(text, icon) { return (window.StockUI ? window.StockUI.icon(icon) : '') + '<span>' + text + '</span>'; }
  function welcomeHtml(app) {
    return '<div class="ai-hint ai-welcome"><div class="welcome-orb">' + window.StockUI.icon('spark') + '</div>'
      + '<div class="welcome-title">看懂走势，先问股问</div><div class="welcome-subtitle">结合行情与技术指标，分析当前个股，<br>也可以在图上标出关键位置。</div>'
      + '<button id="btnStartAnalysis" class="welcome-cta">' + window.StockUI.icon('spark') + '<span>开始全级别分析</span></button>'
      + '<div class="welcome-note">点 K 线选中位置，就能针对那一根继续问。</div></div>';
  }
  function init() {
    try {
      var ms = $('aiMessages');
      if (ms) ms.innerHTML = welcomeHtml(window.__app);
      var cs = $('chartCaption');
      if (cs) cs.innerHTML = window.StockUI.icon('chart') + '<span id="chartCaptionText">K线 · 拖动查看</span>';
      var more = $('btnMore');
      if (more) { more.setAttribute('title', '选择快捷提问'); more.setAttribute('aria-label', '选择快捷提问'); }
      ['drKnowledge', 'btnSettings', 'drClose', 'cfgCancel'].forEach(function (id) {
        var e = $(id); if (e) e.setAttribute('aria-label', e.getAttribute('title') || e.textContent.trim());
      });
      document.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('#btnStartAnalysis');
        if (t) {
          // 使用原发送路径：空输入会走全级别分析，未配置会展示原 API 引导。
          $('aiSend').click();
          return;
        }
        var b = e.target.closest && e.target.closest('[data-chart-action]');
        if (!b || !window.__app) return;
        var a = window.__app;
        if (b.getAttribute('data-chart-action') === 'expand-ai') {
          if (a.toggleSheet) a.toggleSheet(true);
          return;
        }
      });
    } catch (e) { console.error('界面重排失败', e); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 0);
  window.StockUIContent = { markup: markup, welcomeHtml: welcomeHtml };
})();
