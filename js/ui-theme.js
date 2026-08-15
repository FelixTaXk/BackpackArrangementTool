// ui-theme.js —— 期4主题装饰层（《我要当老祖》水墨修仙风）。加载顺序 12/14：位于 solver.js 之后、
// persistence.js/app.js 之前。职责：
// 1) 包装 renderResultGrid：ui-result.js 冻结不可改，渲染完成后按 best.placements 的 cells 坐标
//    反推格子下标（r*W+c）补设 data-attr，供 CSS 属性选择器按法宝属性染色。
// 2) 包装 setSolverRunning：solver.js 运行态会改写 solveBtn 文本，结束后恢复“推演”双行风味结构。
// 本文件不改变任何求解/存档/消息契约，只做只读查询与 DOM 属性/样式装饰。
'use strict';

// placement → 属性反查：uid/no 命中当前随身法宝清单（lastResult 恒与清单同步，读档会清空结果），
// 兜底按 itemName 在 itemDefs 查库（库中名称不跨属性冲突）。查不到则不染色（保留品质内联底色）。
function themeAttrOfPlacement(p){
  if(!p) return '';
  const list = Array.isArray(inventory) ? inventory : [];
  const inv = list.find(x=>x.uid === p.uid) || list.find(x=>x.no === p.no && x.name === p.itemName);
  if(inv && inv.attribute) return inv.attribute;
  if(inv && inv.id){
    const def = talismanById(inv.id);
    if(def && def.attribute) return def.attribute;
  }
  const defs = Array.isArray(itemDefs) ? itemDefs : [];
  const byName = defs.find(d=>d.name === p.itemName);
  return byName && byName.attribute ? byName.attribute : '';
}

// 结果格补 data-attr：#resultGrid 子元素按行优先（r*W+c）排布，与 renderResultGrid 生成顺序一致。
function themeDecorateResultGrid(best){
  const el = document.getElementById('resultGrid');
  if(!el || !best || !Array.isArray(best.placements)) return;
  for(const p of best.placements){
    const attr = themeAttrOfPlacement(p);
    if(!attr || !Array.isArray(p.cells)) continue;
    for(const cell of p.cells){
      if(!Array.isArray(cell) || cell.length < 2) continue;
      const idx = Number(cell[0]) * W + Number(cell[1]);
      const div = el.children[idx];
      if(div) div.setAttribute('data-attr', attr);
    }
  }
}

// 推演按钮风味结构（与 index.html 初始标记一致）；求解运行中 solver.js 会改写为纯文本进度语。
const THEME_SOLVE_BTN_FLAVOR_HTML = '<span class="btn-flavor">推演</span><span class="btn-sub">搜索更优摆放解</span>';

(function(){
  if(typeof renderResultGrid === 'function'){
    const baseRenderResultGrid = renderResultGrid;
    renderResultGrid = function(best){
      baseRenderResultGrid(best);
      try{ themeDecorateResultGrid(best); }catch(e){ /* 装饰失败不影响结果渲染 */ }
    };
  }
  if(typeof setSolverRunning === 'function'){
    const baseSetSolverRunning = setSolverRunning;
    setSolverRunning = function(running){
      baseSetSolverRunning(running);
      const btn = document.getElementById('solveBtn');
      if(!btn) return;
      btn.innerHTML = running ? '推演 · 正在搜索…' : THEME_SOLVE_BTN_FLAVOR_HTML;
    };
  }
})();
