/**
 * 图元管理器：把"AI 画的图只能整体重置"变成"你可以逐个选中、改、删、存"。
 *
 * v9.0 的两个关键缺口被一起补上：
 *   1) 当前 AI 画完后没有编辑可能（只有 remove 整个）；
 *   2) 一切股/换周期旧图全没了。
 *
 * 存储层分离得很干脆：
 *   · **临时**：S.aiShapes（会话级，切股就清）
 *   · **持久**：ShapesManager.saveShapes() 显式保留的结果
 *     落到沙箱 `shapes/<code>_<period>.json`，下次打开同股同周期还在
 *
 * 注：方法内全部走 fs 沙箱。**原生 Java 一行不动**。
 */
(function (global) {
  'use strict';

  // ★ 惰性取 __app：本文件在 index.html 里排在 app.js **之前**（chart.js 依赖
  //   ShapesManager 的常量表，所以只能先加载），顶层直接取会拿到 undefined，
  //   之后所有 app().callNative / app().S 都会炸 —— 表现就是「保存的图元下次打开不恢复」。
  function app() { return global.__app; }
  var DIR = 'shapes';

  function curCode() { return app().currentCode() || '?'; }
  function curPeriod() { return app().currentPeriod() || '?'; }

  /** 这只股票 + 这个周期的图元文件在沙箱里的相对路径 */
  function pathFor(code, period) {
    return DIR + '/' + String(code || '?') + '_' + String(period || '?') + '.json';
  }

  function shapesOf() {
    return (app().S && Array.isArray(app().S.aiShapes)) ? app().S.aiShapes : [];
  }

  function select(idx) {
    selectedIdx = (typeof idx === 'number') ? idx : -1;
    return selectedIdx;
  }

  // 选中的图元索引（-1 = 未选）
  var selectedIdx = -1;

  function selected() { return selectedIdx; }

  /** 删当前选中那条；返回被删掉的图元，没有就 null */
  function removeSelected() {
    if (selectedIdx < 0) return null;
    var arr = shapesOf().slice();
    if (selectedIdx >= arr.length) return null;
    var removed = arr[selectedIdx];
    arr.splice(selectedIdx, 1);
    app().S.aiShapes = arr;
    if (app().chart()) app().chart().setShapes(arr);
    selectedIdx = -1;
    return removed;
  }

  /**
   * 拖某个端点 —— 这是用户最常用的操作（AI 画的线差一点，他微调一下就结束了）。
   * 明确传 which 是哪一端（'x' | 'x1' | 'x2'），不要"猜"。
   *
   * 只更新前端图元，不写盘。要保存用 saveShapes 或持久化级别的 move + save。
   */
  function moveEndpoint(shapeIdx, which, newX, newY) {
    if (['x', 'x1', 'x2'].indexOf(which) < 0) return false;
    var arr = shapesOf().slice();
    var sp = arr[shapeIdx];
    if (!sp || newX == null || newY == null) return false;
    // ★ 不能把不存在的端点硬加上：那会给 hline 这种只有一个 price 的图元
    //   凭空多一个 x1 字段（然后被存进盘里，数据就刚加老毛病脏了）
    if (!(which in sp)) return false;
    sp[which] = newX;
    var yKey = which === 'x' ? 'y' : (which === 'x1' ? 'y1' : 'y2');
    if (yKey in sp) sp[yKey] = newY;
    app().S.aiShapes = arr;
    if (app().chart()) app().chart().setShapes(arr);
    return true;
  }

  // ==================== 持久化 ====================

  /** 把当前图元保存到这只股票的这个周期下 */
  function saveShapes() {
    var arr = shapesOf();
    if (!arr.length) return Promise.resolve(false);
    return app().callNative('fsWrite', pathFor(curCode(), curPeriod()), JSON.stringify(arr))
      .then(function () { return true; })
      .catch(function () { return false; });
  }

  /** 读这只股票的这个周期的图元（不存在 = 空数组，不报错） */
  function loadShapes() {
    return app().callNative('fsRead', pathFor(curCode(), curPeriod()))
      .then(function (txt) {
        try {
          var a = JSON.parse(txt);
          return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
      })
      .catch(function () { return []; });
  }

  /** 清掉这只股票的这个周期的保存 */
  function clearShapes() {
    return app().callNative('fsDelete', pathFor(curCode(), curPeriod()))
      .then(function () { return true; }).catch(function () { return false; });
  }

  global.ShapesManager = {
    DIR: DIR,
    pathFor: pathFor,
    selected: selected,
    select: select,
    removeSelected: removeSelected,
    moveEndpoint: moveEndpoint,
    saveShapes: saveShapes,
    loadShapes: loadShapes,
    clearShapes: clearShapes
  };
})(window);
