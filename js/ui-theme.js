// ui-theme.js —— 期4主题装饰层（《我要当老祖》水墨修仙风）。加载顺序 12/14：位于 solver.js 之后、
// persistence.js/app.js 之前。职责：
// 1) 包装 renderResultGrid：ui-result.js 冻结不可改，渲染完成后按 best.placements 的 cells 坐标
//    反推格子下标（r*W+c）补设 data-attr，供 CSS 属性选择器按法宝属性染色；
//    并把图例各色块 .sw 同步重设为对应 placement 的属性色，保持图例与格子语义一致。
// 2) 包装 setSolverRunning：solver.js 运行态会改写 solveBtn 文本，结束后恢复初始双行结构（运行期快照）。
// 本文件不改变任何求解/存档/消息契约，只做只读查询与 DOM 属性/样式装饰。
'use strict';

// 属性 id → styles.css 中 --attr-* 令牌后缀（与 CSS 令牌镜像对应）。
const THEME_ATTR_TOKEN = {金:'jin',木:'mu',水:'shui',火:'huo',土:'tu',雷:'lei',体:'ti'};

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
      const r = Number(cell[0]), c = Number(cell[1]);
      // 当前网格边界校验：防求解中缩小宽度时旧坐标别名误染。
      if(!(r >= 0 && r < H && c >= 0 && c < W)) continue;
      const div = el.children[r * W + c];
      // 仅对结果项格染色：防锁定格/空格被挂上属性。
      if(div && div.classList.contains('item-cell')) div.setAttribute('data-attr', attr);
    }
  }
}

// 图例 .sw 重设属性色：结果格已按属性染色，图例若仍用品质色会语义脱节。
// 图例 tag 与 placements 的对应关系（只读参考 ui-result.js L53-62）：tag 文本以 "#编号" 开头，
// 按编号升序排序；此处按 no 反查 placement 属性，取其软底色/本色重设 .sw。
function themeRecolorLegend(best){
  const legend = document.getElementById('legend');
  if(!legend || !best || !Array.isArray(best.placements) || !best.placements.length) return;
  const attrByNo = new Map();
  for(const p of best.placements){
    const a = themeAttrOfPlacement(p);
    if(a) attrByNo.set(String(p.no), a);
  }
  if(!attrByNo.size) return;
  const css = getComputedStyle(document.documentElement);
  legend.querySelectorAll('.tag').forEach(tag=>{
    const m = (tag.textContent || '').match(/^#(\d+)/);
    if(!m) return;
    const token = THEME_ATTR_TOKEN[attrByNo.get(m[1]) || ''];
    if(!token) return;
    const sw = tag.querySelector('.sw');
    if(!sw) return;
    const soft = css.getPropertyValue('--attr-' + token + '-soft').trim();
    const hard = css.getPropertyValue('--attr-' + token).trim();
    if(soft) sw.style.background = soft;
    if(hard) sw.style.borderColor = hard;
  });
}

// 推演按钮恢复文案兜底：优先使用包装前对 solveBtn 初始 innerHTML 的运行期快照，
// 快照不可用时退回此硬编码字符串（与 index.html 初始标记一致）。
const THEME_SOLVE_BTN_FLAVOR_HTML = '搜索更优摆放解';

(function(){
  // 运行期快照：在包装 setSolverRunning 之前取 solveBtn 初始 innerHTML，避免与 index.html 双份硬编码。
  const solveBtnEl = document.getElementById('solveBtn');
  const themeSolveBtnSnapshot = solveBtnEl && solveBtnEl.innerHTML.trim() ? solveBtnEl.innerHTML : '';
  if(typeof renderResultGrid === 'function'){
    const baseRenderResultGrid = renderResultGrid;
    renderResultGrid = function(best){
      baseRenderResultGrid(best);
      try{ themeDecorateResultGrid(best); themeRecolorLegend(best); }catch(e){ /* 装饰失败不影响结果渲染 */ }
    };
  }
  if(typeof setSolverRunning === 'function'){
    const baseSetSolverRunning = setSolverRunning;
    setSolverRunning = function(running){
      baseSetSolverRunning(running);
      const btn = document.getElementById('solveBtn');
      if(!btn) return;
      btn.innerHTML = running ? '正在搜索…' : (themeSolveBtnSnapshot || THEME_SOLVE_BTN_FLAVOR_HTML);
    };
  }
})();
