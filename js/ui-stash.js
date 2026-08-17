// ui-stash.js —— 三槽方案暂存（任务 #53）：位置图 + 分项统计暂存与重放。
// 加载顺序：ui-focus.js 之后、persistence.js/app.js 之前；依赖 state.js 全局（W/H/active/inventory/
// lastResult/solverWorker）、ui-result.js 的 renderResultGrid/renderStats、utils.js 的 formatNum。
//
// 重放原理（冻结文件 ui-result.js 不可改，渲染入口直吃全局 W/H/active/inventory）：
// 渲染前临时换入暂存数据（W/H/active/inventory/lastResult + #focusAttr/#weightMode DOM），
// 调同一 renderResultGrid/renderStats 路径渲染，finally 中逐项恢复，实时状态零污染、不触发求解。
// 口径行链路：renderStats 被 ui-focus.js 包装，装饰层读 #focusAttr 与 window.lastResult.settings.weightMul——
// 重放时二者分别置为暂存快照值与暂存 lastResult，口径与暂存时刻一致。
// 总分横幅/分项表/状态区在 renderStats 之后按暂存 DOM 快照逐字节恢复（含聚焦装饰、权重口径行、
// SA 终态摘要），避免装饰重算的任何偏差。
// 回归机制：包装 renderResultGrid——任何非重放渲染调用（新求解/清空间/读档/换聚焦口径等）自动
// 退出重放态回到当前；重放期间禁止暂存/清空操作。
// 持久化：独立键 laozu_stash_v1，与 bagSolverConfig（schemaVersion 2）完全隔离；
// QuotaExceeded 时 alert 提示且不落盘该状态（内存槽位仍可用）。
'use strict';

(function(){
  const STASH_KEY = 'laozu_stash_v1';
  const SLOT_COUNT = 3;
  let slots = [null, null, null];   // 内存槽位：entry 或 null
  let activeSlot = null;            // 当前重放中的槽位下标；null = 正在看实时状态
  let replaying = false;            // 重放渲染进行中（包装器免误判退出）
  let liveSnapshot = null;          // 进入重放前捕获的实时 DOM 快照（供「回到当前结果」恢复）

  // ============ 工具 ============

  // 深拷贝：优先 structuredClone（兼容 bigint），回退 JSON 往返（lastResult 全为 JSON 安全数据）。
  function stashClone(x){
    if(typeof structuredClone === 'function') return structuredClone(x);
    return JSON.parse(JSON.stringify(x));
  }
  // 布尔矩阵真格计数（renderStats 的 activeCells 参数口径）。
  function countActiveCells(matrix){
    let n = 0;
    for(const row of (Array.isArray(matrix) ? matrix : [])) for(const v of (Array.isArray(row) ? row : [])) if(v) n++;
    return n;
  }
  // 当前展示总分（ui-focus 聚焦装饰后的真实总分横幅文本，无则回退 worker 侧 totalScore）。
  function captureTrueTotal(best){
    const el = document.getElementById('statScore');
    if(el && el.textContent && el.textContent.trim() !== '-' && el.textContent.trim() !== '') return el.textContent.trim();
    return (best && typeof formatNum === 'function') ? formatNum(best.totalScore) : String((best && best.totalScore) ?? '');
  }
  // 捕获结果区三件装饰后 DOM：总分横幅/分项表/状态区（暂存与「回到当前结果」共用的快照口径）。
  function captureResultDom(){
    const score = document.getElementById('statScore');
    const breakdown = document.getElementById('statBreakdown');
    const status = document.getElementById('statusBox');
    return {
      scoreText: score ? score.textContent : '',
      breakdownHTML: breakdown ? breakdown.innerHTML : '',
      statusText: status ? status.textContent : ''
    };
  }
  function applyResultDom(snap){
    if(!snap) return;
    const score = document.getElementById('statScore');
    const breakdown = document.getElementById('statBreakdown');
    const status = document.getElementById('statusBox');
    if(score) score.textContent = snap.scoreText;
    if(breakdown) breakdown.innerHTML = snap.breakdownHTML;
    if(status) status.textContent = snap.statusText;
  }
  // 未计算初始态的分项表占位（与 index.html 静态初始一致）。
  function resetStatsPanel(){
    const ids = ['statScore','statPriority','statAdjacency','statArea','statItems','statNodes'];
    for(const id of ids){ const el = document.getElementById(id); if(el) el.textContent = '-'; }
    const breakdown = document.getElementById('statBreakdown');
    if(breakdown) breakdown.innerHTML = '<div class="hint">尚未计算。</div>';
    const status = document.getElementById('statusBox');
    if(status) status.textContent = '尚未计算。';
  }
  function formatStashTime(ts){
    try{ return new Date(ts).toLocaleString('zh-CN', {hour12:false}); }catch(e){ return ''; }
  }

  // ============ 持久化 ============

  function loadStash(){
    let raw = null;
    try{ raw = localStorage.getItem(STASH_KEY); }catch(e){ return; }
    if(!raw) return;
    let data;
    try{ data = JSON.parse(raw); }catch(e){ return; }
    if(!data || !Array.isArray(data.slots)) return;
    for(let i = 0; i < SLOT_COUNT; i++){
      const s = data.slots[i];
      // 形状校验：result.best.placements 为渲染入口最低消费面；缺失视为坏槽丢弃。
      slots[i] = (s && s.result && s.result.best && Array.isArray(s.result.best.placements)) ? s : null;
    }
  }
  function persistStash(){
    try{
      localStorage.setItem(STASH_KEY, JSON.stringify({schema:1, slots}));
    }catch(e){
      // 超配额/不可写：本次状态不落盘，内存槽位仍可用；刷新后将回到上一次成功落盘的状态。
      alert('方案暂存写入本地存储失败（空间不足或不可用）。该暂存仅在本次会话内存中有效，刷新页面后将丢失。');
    }
  }

  // ============ 槽位条 UI ============

  function renderBar(){
    for(let i = 0; i < SLOT_COUNT; i++){
      const btn = document.getElementById('stashSlot' + (i + 1));
      if(!btn) continue;
      const entry = slots[i];
      if(entry){
        const score = entry.trueTotal ?? ((typeof formatNum === 'function') ? formatNum(entry.result.best.totalScore) : entry.result.best.totalScore);
        const ts = formatStashTime(entry.ts);
        const safeScore = (typeof escapeHtml === 'function') ? escapeHtml(String(score)) : String(score);
        btn.innerHTML = `<span class="stash-slot-label">暂存${i + 1}·总分${safeScore}</span><span class="stash-clear" data-clear="1" role="button" title="清空暂存${i + 1}">×</span>`;
        btn.title = `重放暂存${i + 1}（${ts} 存入）`;
        btn.classList.add('filled');
      }else{
        btn.innerHTML = `<span class="stash-slot-label">暂存${i + 1}·空</span>`;
        btn.title = `点击把当前求解结果存入暂存${i + 1}`;
        btn.classList.remove('filled');
      }
      btn.classList.toggle('active', activeSlot === i);
    }
    const back = document.getElementById('stashBackBtn');
    if(back) back.hidden = activeSlot === null;
  }

  // ============ 存入 / 重放 / 清空 / 回归 ============

  function stashToSlot(i){
    if(window.solverWorker){ alert('求解进行中，请等待完成或停止后再暂存。'); return; }
    if(!window.lastResult || !lastResult.best){ alert('当前没有可暂存的求解结果，请先完成一次求解。'); return; }
    if(activeSlot !== null){ alert('正在查看暂存方案，请先点击“回到当前结果”再存入。'); return; }
    const dom = captureResultDom();
    slots[i] = {
      ts: Date.now(),
      trueTotal: captureTrueTotal(lastResult.best),
      // result 整体深拷贝：含 best（placements/items/各分数/邻接对/坐标）、nodes/elapsed/stopped、
      // width/height/active、inventory 快照、settings（focusAttr/weightMul 口径快照）、skipped、solverMeta。
      result: stashClone(lastResult),
      scoreText: dom.scoreText, breakdownHTML: dom.breakdownHTML, statusText: dom.statusText
    };
    persistStash();
    renderBar();
  }

  function clearSlot(i){
    slots[i] = null;
    if(activeSlot === i){ activeSlot = null; renderCurrent(); }
    persistStash();
    renderBar();
  }

  function replaySlot(i){
    const entry = slots[i];
    if(!entry) return;
    if(window.solverWorker){ alert('求解进行中，请等待完成或停止后再查看暂存。'); return; }
    // 从实时态首次进入重放：捕获实时 DOM 快照供回归恢复；重放之间切换槽位沿用原快照。
    if(activeSlot === null && window.lastResult && lastResult.best) liveSnapshot = captureResultDom();
    if(activeSlot === null && (!window.lastResult || !lastResult.best)) liveSnapshot = null;
    const res = entry.result;
    // 备份实时全局与相关 DOM（重放渲染直接消费这些全局，必须先备份后换入）。
    const bk = {
      W, H, active, inventory, lastResult: window.lastResult,
      gridW: document.getElementById('gridW') ? document.getElementById('gridW').value : null,
      gridH: document.getElementById('gridH') ? document.getElementById('gridH').value : null,
      focus: document.getElementById('focusAttr') ? document.getElementById('focusAttr').value : null,
      weightMode: document.getElementById('weightMode') ? document.getElementById('weightMode').value : null,
      weightWrapHidden: document.getElementById('weightCustomWrap') ? document.getElementById('weightCustomWrap').hidden : null
    };
    replaying = true;
    try{
      // 换入暂存数据（共享只读引用：渲染链路对 best/settings 只读，无写入）。
      W = Number(res.width) || 7;
      H = Number(res.height) || 6;
      active = Array.isArray(res.active) ? res.active.map(r=>r.slice()) : Array.from({length:H},()=>Array(W).fill(true));
      inventory = Array.isArray(res.inventory) ? stashClone(res.inventory) : [];
      window.lastResult = res; // ui-focus 权重口径行读 window.lastResult.settings.weightMul
      const gw = document.getElementById('gridW'), gh = document.getElementById('gridH');
      if(gw) gw.value = String(W);
      if(gh) gh.value = String(H);
      // 口径控件同步为暂存快照：ui-focus 装饰层读 #focusAttr 决定是否聚焦重算。
      const settings = res.settings || {};
      const focusSel = document.getElementById('focusAttr');
      if(focusSel) focusSel.value = settings.focusAttr || '';
      const weightSel = document.getElementById('weightMode');
      if(weightSel) weightSel.value = settings.weightMul ? 'custom' : 'default';
      const weightWrap = document.getElementById('weightCustomWrap');
      if(weightWrap) weightWrap.hidden = !settings.weightMul;
      // 与实时渲染完全相同的函数路径：位置图 + 图例 + 统计 + 分项表 + 状态区。
      renderResultGrid(res.best);
      renderStats(res.best, res.nodes, res.elapsed, res.stopped, countActiveCells(active), res.skipped || [], res.solverMeta || {});
      // 装饰后三件按暂存快照逐字节恢复（聚焦重算/权重行/SA 摘要与暂存时刻一致）。
      applyResultDom({scoreText:entry.scoreText, breakdownHTML:entry.breakdownHTML, statusText:entry.statusText});
    }finally{
      // 恢复实时全局与 DOM：重放不污染 inventory/lastResult/空间与口径控件。
      W = bk.W; H = bk.H; active = bk.active; inventory = bk.inventory;
      window.lastResult = bk.lastResult;
      const gwR = document.getElementById('gridW'), ghR = document.getElementById('gridH');
      if(bk.gridW !== null && gwR) gwR.value = bk.gridW;
      if(bk.gridH !== null && ghR) ghR.value = bk.gridH;
      const focusR = document.getElementById('focusAttr');
      if(bk.focus !== null && focusR) focusR.value = bk.focus;
      const weightR = document.getElementById('weightMode');
      if(bk.weightMode !== null && weightR) weightR.value = bk.weightMode;
      const weightWrapR = document.getElementById('weightCustomWrap');
      if(bk.weightWrapHidden !== null && weightWrapR) weightWrapR.hidden = bk.weightWrapHidden;
      replaying = false;
    }
    activeSlot = i;
    renderBar();
  }

  // 渲染实时状态（退出重放时调用）：有结果走同一渲染路径，无结果回到未计算初始态。
  function renderCurrent(){
    if(window.lastResult && lastResult.best){
      renderResultGrid(lastResult.best);
      renderStats(lastResult.best, lastResult.nodes, lastResult.elapsed, lastResult.stopped, countActiveCells(active), lastResult.skipped || [], lastResult.solverMeta || {});
      applyResultDom(liveSnapshot);
    }else{
      renderResultGrid(null);
      resetStatsPanel();
    }
    liveSnapshot = null;
  }

  // 全局函数（「回到当前结果」钮调用；solver.js/app.js/persistence.js 无需改动）：
  // 新求解等其余退出路径由下方 renderResultGrid 包装器自动覆盖（一切实时渲染均自动退出重放）。
  window.exitStashReplay = function(){
    if(activeSlot === null) return;
    activeSlot = null;
    renderCurrent();
    renderBar();
  };

  // ============ 包装与初始化 ============

  // 包装 renderResultGrid（链在 ui-theme.js 包装之上）：非重放期间的任何渲染调用
  // 意味着实时状态已变化，自动退出重放态（本次调用即渲染实时内容）。
  if(typeof renderResultGrid === 'function'){
    const baseRenderResultGrid = renderResultGrid;
    renderResultGrid = function(...args){
      if(!replaying && activeSlot !== null){
        activeSlot = null;
        liveSnapshot = null;
        renderBar();
      }
      return baseRenderResultGrid(...args);
    };
  }

  function initStashUI(){
    loadStash();
    renderBar();
    const bar = document.getElementById('stashBar');
    if(bar){
      bar.addEventListener('click', e=>{
        const clear = e.target.closest('.stash-clear');
        const btn = e.target.closest('button.stash-slot');
        if(!btn) return;
        const i = Number(btn.dataset.slot);
        if(!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) return;
        if(clear){
          if(confirm(`确定清空暂存${i + 1}？`)) clearSlot(i);
          return;
        }
        if(!slots[i]) stashToSlot(i);
        else replaySlot(i);
      });
    }
    const back = document.getElementById('stashBackBtn');
    if(back) back.addEventListener('click', ()=>window.exitStashReplay());
  }
  initStashUI();
})();
