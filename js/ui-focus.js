// ui-focus.js —— 加成聚焦展示装饰层。加载顺序：晚于 ui-result.js/score-shared.js/ui-theme.js，早于 persistence.js/app.js。
// 职责（纯增量，仿 ui-theme.js 装饰层模式）：
// 1) 加载期用 TALISMAN_DB.bonusStats + statName 填充 #focusAttr 下拉选项。
// 2) 包装 renderStats：聚焦会话中冻结渲染显示的是聚焦口径 statTotals（非聚焦加成被置 0），
//    基函数执行后由本层用 best.placements（uid 反查全局 inventory 取真实 baseStats/bonusRates）
//    + score-shared 纯函数复算真实全属性数值，回写 #statScore 与 #statBreakdown（聚焦行高亮），
//    并向 statusBox 追加口径说明。全程 try/catch 兜底，失败不影响冻结渲染；不写其它全局。
'use strict';

(function(){
  // 十进制掩码串 → 双 Uint32 数值对（与 scoreMaskToDec 序列化互逆：n = hi*4294967296 + lo）。
  const dec2lohi = s=>{
    const n = Number(s);
    const hi = Math.floor(n / 4294967296);
    return {lo: n - hi * 4294967296, hi};
  };

  // 聚焦选项填充：value=id，文案「X加成最大化」；数据库缺失或控件缺失时静默跳过。
  function populateFocusOptions(){
    const sel = document.getElementById('focusAttr');
    if(!sel) return;
    const stats = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats) || [];
    for(const s of stats){
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${statName(s.id)}加成最大化`;
      sel.appendChild(opt);
    }
  }

  // 复算真实分属性数值并回写展示：
  // - 每 placement 以 uid 反查 inventory 得真实 stats/rates/bonusKind（口径同 solver.js prepareInventoryItems）；
  // - mask/neighborMask 十进制串解析为 lo/hi；相邻对经 scorePairBonusEvents（useBonus 恒真口径）
  //   累加 statBreakdown → 真实 bonus[]；base[]=Σ真实 stats；total=base+bonus；
  // - 真实总分=Σvalue+Σbonus，回写 #statScore 与 #statBreakdown（聚焦行 .focus-row），statusBox 追加口径说明。
  function focusDecorateStats(best){
    const sel = document.getElementById('focusAttr');
    const focus = sel ? sel.value : '';
    if(!focus || !best || !Array.isArray(best.placements)) return;
    const statKeys = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
    if(statKeys.indexOf(focus) < 0) return;
    const K = statKeys.length;
    const invByUid = new Map((Array.isArray(inventory) ? inventory : []).map(x=>[x.uid, x]));
    // 构建评分视图：真实 stats/rates（非聚焦口径的 worker 侧置零值被原始数据覆盖）。
    const views = [];
    for(const p of best.placements){
      const inv = invByUid.get(p.uid);
      if(!inv) continue;
      const stats = statKeys.map(k=>Math.max(0, Number((inv.baseStats || {})[k]) || 0));
      const rates = statKeys.map(k=>Math.max(0, Number((inv.bonusRates || {})[k]) || 0));
      const m = dec2lohi(p.mask), nb = dec2lohi(p.neighborMask);
      views.push({
        no:p.no, itemName:p.itemName, value:Number(p.value) || 0,
        bonusKind:bonusKind(inv),
        sv:stats, rv:rates,
        lo:m.lo, hi:m.hi, nbrLo:nb.lo, nbrHi:nb.hi
      });
    }
    const base = new Array(K).fill(0), bonus = new Array(K).fill(0);
    for(const v of views){ for(let k = 0; k < K; k++) base[k] += v.sv[k]; }
    for(let i = 0; i < views.length; i++){
      for(let j = i + 1; j < views.length; j++){
        const a = views[i], b = views[j];
        if(!scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) continue;
        for(const e of scorePairBonusEvents(a, b)){
          for(let k = 0; k < K; k++) bonus[k] += (e.statBreakdown && e.statBreakdown[k]) || 0;
        }
      }
    }
    let trueTotal = 0;
    for(const v of views) trueTotal += v.value;
    for(let k = 0; k < K; k++) trueTotal += bonus[k];
    // 回写总分横幅与分项统计表（表结构同 ui-result.js renderStats，聚焦行加 .focus-row）。
    const scoreEl = document.getElementById('statScore');
    if(scoreEl) scoreEl.textContent = formatNum(trueTotal);
    const wrap = document.getElementById('statBreakdown');
    if(wrap){
      const rows = statKeys.map((k,i)=>{
        const cls = k === focus ? ' class="focus-row"' : '';
        return `<tr${cls}><td>${escapeHtml(statName(k))}</td><td>${formatNum(base[i])}</td><td>${formatNum(bonus[i])}</td><td>${formatNum(base[i] + bonus[i])}</td></tr>`;
      }).join('');
      wrap.innerHTML = `<table class="stat-breakdown"><thead><tr><th>项目</th><th>基础值</th><th>加成值</th><th>合计</th></tr></thead><tbody>${rows || '<tr><td colspan="4">-</td></tr>'}</tbody></table>`;
    }
    const statusBox = document.getElementById('statusBox');
    if(statusBox) statusBox.textContent += `\n\n加成聚焦：本次优化目标为${statName(focus)}加成最大化（忽略其它属性加成）；上表为真实全属性数值。`;
  }

  populateFocusOptions();
  if(typeof renderStats === 'function'){
    const baseRenderStats = renderStats;
    renderStats = function(...args){
      baseRenderStats(...args);
      try{ focusDecorateStats(args[0]); }catch(e){ /* 装饰失败不影响冻结渲染 */ }
    };
  }
})();
