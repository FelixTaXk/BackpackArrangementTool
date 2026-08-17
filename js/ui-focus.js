// ui-focus.js —— 加成聚焦展示装饰层。加载顺序：晚于 ui-result.js/score-shared.js/ui-theme.js，早于 persistence.js/app.js。
// 职责（纯增量，仿 ui-theme.js 装饰层模式）：
// 1) 加载期用 TALISMAN_DB.bonusStats + statName 填充 #focusAttr 下拉选项。
// 2) 包装 renderStats：聚焦会话中冻结渲染显示的是聚焦口径 statTotals（非聚焦加成被置 0），
//    基函数执行后由本层用 best.placements（uid 反查全局 inventory 取真实 baseStats/bonusRates）
//    + score-shared 纯函数复算真实全属性数值，回写 #statScore 与 #statBreakdown（聚焦行高亮），
//    并按锚点重组 statusBox 的「摆放清单/百分比加成清单」两段为真实口径（消除同屏口径矛盾），
//    末尾追加含「优化目标：」的口径说明。全程 try/catch 兜底，失败不影响冻结渲染；不写其它全局。
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
  //   累加 statBreakdown → 真实 bonus[]，同时保留真实事件数组 trueEvents；base[]=Σ真实 stats；total=base+bonus；
  // - 真实总分=Σvalue+Σbonus，回写 #statScore 与 #statBreakdown（聚焦行 .focus-row）；
  // - statusBox 按「摆放清单：」「百分比加成清单：」两锚点重组为真实口径（同构模板重建行 + eventLine 事件文案），
  //   末尾追加含「优化目标：」的聚焦口径说明。
  function focusDecorateStats(best){
    const sel = document.getElementById('focusAttr');
    // 与 solver.js solveAndRender 的门控口径对齐：__FOCUS_OFF__ 为真时强制视为非聚焦，
    // 否则回退闸下 solver.js（focusAttr=''）与 ui-focus 各追加一条权重口径行，造成双写。
    const focus = (sel && !window.__FOCUS_OFF__) ? sel.value : '';
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
        lo:m.lo, hi:m.hi, nbrLo:nb.lo, nbrHi:nb.hi,
        p, inv // 保留原始引用：供真实摆放清单同构模板重建（baseStatsSummary/bonusDescription 直吃 inv 对象口径）
      });
    }
    const base = new Array(K).fill(0), bonus = new Array(K).fill(0);
    for(const v of views){ for(let k = 0; k < K; k++) base[k] += v.sv[k]; }
    const trueEvents = []; // 真实加成事件数组（保留而非仅累加数值，供 eventLine 同式渲染）
    for(let i = 0; i < views.length; i++){
      for(let j = i + 1; j < views.length; j++){
        const a = views[i], b = views[j];
        if(!scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) continue;
        for(const e of scorePairBonusEvents(a, b)){
          trueEvents.push(e);
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
    if(statusBox){
      // 真实摆放清单：逐 placement 用 ui-result.js 同构模板重建；加成描述段直吃 inv 的真实
      // baseStats/bonusRates 对象口径（与非聚焦时冻结渲染逐字同式）；uid 反查失败时退回 p 自身字段。
      const trueList = best.placements.map(p=>{
        const inv = invByUid.get(p.uid);
        const baseSrc = inv || p;
        const descSrc = inv || p;
        return `#${p.no} ${p.itemName}｜${qualityName(p.quality)}｜${p.area}格｜基础 ${baseStatsSummary(baseSrc)}｜${p.customPriority !== null && p.customPriority !== undefined ? `手动邻接优先级 ${p.customPriority}` : '默认邻接规则'}｜${bonusDescription(descSrc)}｜坐标 ${p.cells.map(([r,c])=>`(${r+1},${c+1})`).join(' ')}`;
      }).join('\n');
      const trueEventList = trueEvents.length ? trueEvents.map(eventLine).join('\n') : '无有效百分比加成。';
      // 锚点重组：head + 真实摆放清单 + 真实事件清单 + 原有 suffix（未放入/未参与搜索段）；锚点缺失静默跳过。
      const text = statusBox.textContent;
      const listAnchor = '摆放清单：\n', evAnchor = '百分比加成清单：\n';
      const aIdx = text.indexOf(listAnchor);
      const eIdx = aIdx >= 0 ? text.indexOf(evAnchor, aIdx) : -1;
      if(aIdx >= 0 && eIdx >= 0){
        const head = text.slice(0, aIdx);
        const tailRaw = text.slice(eIdx + evAnchor.length);
        let sIdx = tailRaw.indexOf('\n\n本方案未放入：');
        const sIdx2 = tailRaw.indexOf('\n\n未参与搜索');
        if(sIdx < 0 || (sIdx2 >= 0 && sIdx2 < sIdx)) sIdx = sIdx2;
        const suffix = sIdx >= 0 ? tailRaw.slice(sIdx) : '';
        statusBox.textContent = head + listAnchor + trueList + '\n\n' + evAnchor + trueEventList + suffix;
      }
      statusBox.textContent += `\n\n加成聚焦：优化目标：${statName(focus)}加成最大化（忽略其它属性加成）；上表与清单为真实全属性数值。`;
      // 属性权重口径行（与 solver.js 非聚焦分支同口径，两分支互斥由 solver.js 侧 !focusAttr 守卫）：
      // 必须在锚点重组之后写入（重组只保留特定 suffix，重组前写入的尾行会被吞掉）。
      // trueTotal 公式不改：权重激活时 worker 回传的 p.value 已是加权标量，Σv.value+Σbonus 天然正确
      //（改吃逐属性加权会因舍入分组不同产生 ±0.1 分叉，禁止）。
      // 权重口径改吃求解期快照 window.lastResult.settings.weightMul（solver.js 在权重激活时条件追加，
      // 且 lastResult 在 renderStats 之前赋值）：渲染时实时 readWeightMul() 读 DOM 会与求解中途
      // 改权重产生竞态，导致口径行与实际计算口径不符；无快照（默认全 1/回退）则不写权重行。
      const weightMul = (window.lastResult && window.lastResult.settings && window.lastResult.settings.weightMul) || null;
      if(weightMul){
        statusBox.textContent += `\n\n属性权重口径：权重向量 [攻×${weightMul[0]}、防×${weightMul[1]}、生命×${weightMul[2]}]；搜索目标 total = Σ base_k × w_k + Σ bonus_k × w_k（w=0 属性不计价；基础全零时按 0.01 保底）；展示按真实加成率重算，呈实际总属性。`;
      }
    }
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
