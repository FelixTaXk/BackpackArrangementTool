// ui-result.js —— 求解结果渲染：摆放网格/统计文本/重点邻接摘要/加成事件行。加载顺序 8/12，依赖 utils、talisman-model。
'use strict';

function renderResultGrid(best){
  const el = document.getElementById('resultGrid');
  el.style.gridTemplateColumns = `repeat(${W}, var(--cell))`;
  el.innerHTML = '';
  const cellMap = new Map();
  const legends = [];
  if(best && best.placements){
    best.placements.forEach((p)=>{
      const style = qualityDisplayStyle(p.quality);
      legends.push({
        label:`#${p.no} ${qualityName(p.quality)}｜${p.itemName}`,
        fill:style.fill,
        border:style.border
      });
      p.cells.forEach(([r,c])=>cellMap.set(`${r},${c}`, {
        no:String(p.no), label:p.no, fill:style.fill, border:style.border, text:style.text,
        name:p.itemName, quality:p.quality
      }));
    });
  }
  for(let r=0;r<H;r++){
    for(let c=0;c<W;c++){
      const div = document.createElement('div');
      div.className = 'cell' + (active[r][c] ? '' : ' inactive');
      if(active[r][c]){
        const x = cellMap.get(`${r},${c}`);
        if(x){
          div.classList.add('item-cell');
          div.textContent = x.label;
          div.style.background = x.fill;
          div.style.color = x.text;
          div.title = `#${x.no} ${qualityName(x.quality)}｜${x.name}`;

          // 同一装备内部只保留细分格线，装备外缘使用更明显的品质色边界。
          const sameTop = cellMap.get(`${r-1},${c}`)?.no === x.no;
          const sameRight = cellMap.get(`${r},${c+1}`)?.no === x.no;
          const sameBottom = cellMap.get(`${r+1},${c}`)?.no === x.no;
          const sameLeft = cellMap.get(`${r},${c-1}`)?.no === x.no;
          div.style.borderTop = sameTop ? '1px solid rgba(17,24,39,.18)' : `2px solid ${x.border}`;
          div.style.borderRight = sameRight ? '1px solid rgba(17,24,39,.18)' : `2px solid ${x.border}`;
          div.style.borderBottom = sameBottom ? '1px solid rgba(17,24,39,.18)' : `2px solid ${x.border}`;
          div.style.borderLeft = sameLeft ? '1px solid rgba(17,24,39,.18)' : `2px solid ${x.border}`;
        }
      } else div.textContent = '×';
      el.appendChild(div);
    }
  }
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  legends.sort((a,b)=>{
    const na = Number((a.label.match(/^#(\d+)/)||[])[1]) || 0;
    const nb = Number((b.label.match(/^#(\d+)/)||[])[1]) || 0;
    return na-nb;
  }).forEach(x=>{
    const t = document.createElement('span');
    t.className = 'tag';
    t.innerHTML = `<span class="sw" style="background:${x.fill};border-color:${x.border}"></span>${escapeHtml(x.label)}`;
    legend.appendChild(t);
  });
}

function renderStats(best, nodes, elapsed, stopped, activeCells, skipped, solverMeta={}){
  document.getElementById('statScore').textContent = formatNum(best.totalScore);
  document.getElementById('statBase').textContent = formatNum(best.baseScore);
  document.getElementById('statBonus').textContent = formatNum(best.bonusScore);
  const manualPriorityTotal = (best.manualPriorityVector || []).reduce((a,b)=>a+b,0);
  const defaultPriorityTotal = (best.defaultPriorityVector || []).reduce((a,b)=>a+b,0);
  document.getElementById('statPriority').textContent = `${manualPriorityTotal + defaultPriorityTotal} 次`;
  document.getElementById('statAdjacency').textContent = `${best.adjacencyCount ?? 0} 对`;
  document.getElementById('statArea').textContent = `${best.area}/${activeCells}`;
  document.getElementById('statItems').textContent = best.itemCount;
  document.getElementById('statNodes').textContent = nodes.toLocaleString('zh-CN');
  const unused = activeCells - best.area;
  const list = best.placements.map((p)=>`#${p.no} ${p.itemName}｜${qualityName(p.quality)}｜${p.area}格｜基础值 ${formatNum(p.value)}｜${p.customPriority !== null && p.customPriority !== undefined ? `手动邻接优先级 ${p.customPriority}` : '默认邻接规则'}｜${bonusDescription(p)}｜坐标 ${p.cells.map(([r,c])=>`(${r+1},${c+1})`).join(' ')}`).join('\n') || '未放入任何物品。';
  const eventList = best.bonusEvents.length ? best.bonusEvents.map(eventLine).join('\n') : '无有效百分比加成。';
  const prioritySummary = buildPrioritySummary(best);
  const skippedText = skipped && skipped.length ? `\n\n未参与搜索（单件在当前空间/方向规则下没有任何合法位置）：\n${skipped.map(x=>`#${x.no} ${x.name}`).join('\n')}` : '';
  const placedNos = new Set(best.placements.map(p=>String(p.no)));
  const omitted = inventory.filter(x=>!placedNos.has(String(x.no)) && !(skipped||[]).some(y=>String(y.no)===String(x.no)));
  const omittedText = omitted.length ? `\n\n本方案未放入：\n${omitted.map(x=>`#${x.no} ${x.name}（${x.cells.length}格）`).join('\n')}` : '';
  let conclusion;
  if(solverMeta.fullPackingFound){
    conclusion = stopped ? '已确认所有物品均可放入；后续属性与邻接优化达到时间/节点上限，返回目前找到的最好完整方案，但未证明全局最优。' : '已确认所有物品均可放入，并完成实际总属性与邻接优化。';
  }else if(skipped && skipped.length){
    conclusion = stopped ? '至少一件物品在当前空间/方向规则下没有合法位置；搜索达到上限，返回目前按目标顺序找到的最佳可行子集。' : '至少一件物品在当前空间/方向规则下没有合法位置，因此无法完整装入；已返回最佳可行子集。';
  }else if(solverMeta.totalArea>activeCells){
    conclusion = stopped ? '物品总面积超过可用空间；搜索达到上限，返回目前按目标顺序找到的最佳可行子集。' : '物品总面积超过可用空间；已完成最佳可行子集搜索。';
  }else if(solverMeta.fullSearchCutoff){
    conclusion = '在完整装入可行性搜索达到上限前尚未找到全装方案；这不等于无法全部放入。建议提高搜索时间或节点上限。';
  }else if(solverMeta.fullPackingAttempted){
    conclusion = '完整装入搜索已穷尽：在当前空间、形状、旋转和镜像规则下，无法把所有物品同时放入。';
  }else{
    conclusion = stopped ? '搜索达到上限，返回当前最好方案。' : '搜索完成。';
  }
  let singleSingleAdj=0, singleMultiAdj=0, multiMultiAdj=0;
  for(let i=0;i<best.placements.length;i++) for(let j=i+1;j<best.placements.length;j++){
    const a=best.placements[i], b=best.placements[j];
    if(!areAdjacent(a.cells,b.cells)) continue;
    const as=a.area===1, bs=b.area===1;
    if(as&&bs) singleSingleAdj++;
    else if(as||bs) singleMultiAdj++;
    else multiMultiAdj++;
  }
  document.getElementById('statusBox').textContent = `${conclusion}\n耗时：${elapsed} ms\n求解起点：从已有物品清单自动生成\n自动布局策略：多格物品先布局，${solverMeta.singletonDeferredCount ?? 0} 件单格物品延后分配（属性分配检查 ${Number(solverMeta.assignmentChecks||0).toLocaleString('zh-CN')} 次）\n完整装入：${best.complete?'是':'否'}\n物品总占格：${solverMeta.totalArea ?? '-'}，可用空间：${activeCells}\n放入物品：${best.itemCount}/${solverMeta.totalItems ?? inventory.length}\n空余可用格：${unused}\n比较顺序：完整装入 ＞ 实际总属性（基础属性 + 百分比加成）＞ 手动指定物品邻接（1最高，同优先级合并比较）＞ 默认重点物品邻接 ＞ 总邻接数量\n实际总属性：${formatNum(best.totalScore)} = 基础属性 ${formatNum(best.baseScore)} + 百分比加成 ${formatNum(best.bonusScore)}\n总邻接数量：${best.adjacencyCount ?? 0} 对不同物品\n邻接结构：单格-单格 ${singleSingleAdj} 对｜单格-多格 ${singleMultiAdj} 对｜多格-多格 ${multiMultiAdj} 对\n\n重点物品邻接：\n${prioritySummary}\n\n摆放清单：\n${list}\n\n百分比加成清单：\n${eventList}${omittedText}${skippedText}`;
}
function buildPrioritySummary(best){
  const countByItem = new Map();
  for(const p of best.placements){
    if(p.manualOrder >= 0){
      countByItem.set(p.no, {no:p.no, name:p.itemName, mode:'custom', customPriority:p.customPriority, manualOrder:p.manualOrder, count:0});
    }else if(p.priorityTier >= 0){
      countByItem.set(p.no, {no:p.no, name:p.itemName, mode:'default', tier:p.priorityTier, count:0});
    }
  }
  for(const link of best.priorityLinks || []){
    const x = countByItem.get(link.target);
    if(x) x.count++;
  }
  const rows = [...countByItem.values()].sort((a,b)=>{
    if(a.mode !== b.mode) return a.mode === 'custom' ? -1 : 1;
    if(a.mode === 'custom') return a.customPriority-b.customPriority || a.manualOrder-b.manualOrder || b.count-a.count || a.no-b.no;
    return a.tier-b.tier || b.count-a.count || a.no-b.no;
  });
  if(!rows.length) return '当前没有手动指定优先级的物品，也没有符合默认邻接规则的重点物品。';
  return rows.map(x=>{
    const label = x.mode === 'custom' ? `手动优先级 ${x.customPriority}` : SELF_PRIORITY_TIERS[x.tier].label;
    return `[${label}] #${x.no} ${x.name}：${x.count} 个不同邻居`;
  }).join('\n');
}

function eventLine(e){
  if(e.kind === 'single_provider') return `单格 #${e.source} ${e.sourceName} → #${e.target} ${e.targetName}：${formatNum(e.base)} × ${formatNum(e.rate)}% = +${formatNum(e.bonus)}`;
  if(e.kind === 'self_neighbor') return `#${e.target} ${e.targetName} 因相邻 #${e.neighbor} ${e.neighborName} 自身加成：${formatNum(e.base)} × ${formatNum(e.rate)}% = +${formatNum(e.bonus)}`;
  return `+${formatNum(e.bonus)}`;
}

