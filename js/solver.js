// solver.js —— 求解编排：物品准备/Worker 生命周期/心跳状态/取消/比较/求解入口。加载顺序 10/12，依赖 solver-worker、state、utils、talisman-model。
'use strict';

function getParallelWorkerLimit(){
  const cores = Math.floor(Number(navigator.hardwareConcurrency) || 4);
  // 保留一个逻辑核心给页面交互；低核心设备至少仍可选择 4 个 Worker。
  return Math.max(4, Math.min(12, cores > 4 ? cores - 1 : cores));
}

function configureWorkerCountControl(){
  const input = document.getElementById('workerCount');
  const limit = getParallelWorkerLimit();
  input.max = String(limit);
  input.value = String(Math.max(2, Math.min(limit, Math.floor(Number(input.value) || 2))));
  document.getElementById('workerCountHint').textContent = `最多 ${limit} 个（按设备能力）`;
}
function prepareInventoryItems(){
  const allowRot = document.getElementById('allowRotate').checked;
  const allowMir = document.getElementById('allowMirror').checked;
  const {mask:activeMask} = buildActiveMask();
  const prepared = [];
  const skipped = [];
  const statIds = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
  for(const inv of inventory){
    const kind = bonusKind(inv);
    const base = {
      uid: inv.uid,
      no: inv.no,
      typeId: inv.id,
      typeName: inv.name,
      name: inv.name,
      cells: normalizeCells(inv.cells),
      area: inv.cells.length,
      quality: inv.quality,
      value: Math.max(0, Number(inv.value)||0),
      // 分项基础值与加成率数组（按 bonusStats 顺序），供求器计算分项加成与 statTotals。
      stats: statIds.map(k=>Math.max(0, Number((inv.baseStats || {})[k])||0)),
      rates: statIds.map(k=>Math.max(0, Number((inv.bonusRates || {})[k])||0)),
      bonusKind: kind,
      priorityTier: -1,
      customPriority: inv.customPriority ?? null,
      manualOrder: -1,
      placements: []
    };
    base.priorityTier = selfPriorityTier(base);
    const placeMap = new Map();
    for(const ori of orientations(base.cells, allowRot, allowMir)){
      const maxR = Math.max(...ori.map(x=>x[0])), maxC = Math.max(...ori.map(x=>x[1]));
      for(let r0=0;r0<=H-maxR-1;r0++){
        for(let c0=0;c0<=W-maxC-1;c0++){
          const abs = ori.map(([r,c])=>[r+r0,c+c0]);
          let m = 0n, ok = true;
          for(const [r,c] of abs){
            const b = bitOf(r,c);
            if((activeMask & b) === 0n){ ok = false; break; }
            m |= b;
          }
          if(ok && !placeMap.has(m.toString())){
            placeMap.set(m.toString(), {
              mask:m, cells:abs, uid:base.uid, no:base.no, itemName:base.name, typeName:base.typeName,
              area:base.area, quality:base.quality, value:base.value, stats:base.stats, rates:base.rates, bonusKind:base.bonusKind, priorityTier:base.priorityTier, customPriority:base.customPriority, manualOrder:-1, itemIndex:-1
            });
          }
        }
      }
    }
    base.placements = [...placeMap.values()];
    if(base.placements.length > 0) prepared.push(base);
    else skipped.push(base);
  }
  // 相同手动优先级属于同一层级：多个“1”共同构成最高优先级目标。
  const manualPriorityLevels = [...new Set(prepared
    .filter(t=>t.customPriority !== null)
    .map(t=>t.customPriority))].sort((a,b)=>a-b);
  const manualLevelOrder = new Map(manualPriorityLevels.map((priority,order)=>[priority,order]));
  const manualItems = prepared
    .filter(t=>t.customPriority !== null)
    .sort((a,b)=>a.customPriority-b.customPriority || a.no-b.no);
  manualItems.forEach(t=>{ t.manualOrder = manualLevelOrder.get(t.customPriority); });
  prepared.forEach((t, idx)=>{
    t.itemIndex = idx;
    t.placements.forEach(p=>{
      p.itemIndex = idx;
      p.manualOrder = t.manualOrder;
      p.customPriority = t.customPriority;
    });
  });
  return {
    items:prepared,
    skipped,
    manualPriorityLevels,
    manualItems:manualItems.map(t=>({no:t.no,name:t.name,priority:t.customPriority,order:t.manualOrder}))
  };
}


function stopSolverStatusHeartbeat(){
  if(solverStatusTimer){
    clearInterval(solverStatusTimer);
    solverStatusTimer = null;
  }
  solverStatusState = null;
}

function renderLiveSolverStatus(){
  if(!solverStatusState || !solverWorker) return;
  const s = solverStatusState;
  const now = performance.now();
  const elapsed = Math.max(0, Math.round(now - s.startedAt));
  const sinceWorkerReport = Math.max(0, Math.round(now - s.lastReportAt));
  const bestKnown = Number.isFinite(Number(s.bestTotal)) && Number(s.bestTotal) >= 0;
  document.getElementById('statusBox').textContent = `${s.stage || '正在后台搜索'}
已检查节点：${Number(s.nodes || 0).toLocaleString('zh-CN')}
已耗时：${elapsed} ms（界面每 500 ms 刷新）
距求解器最近一次进度报告：${sinceWorkerReport} ms
当前是否完整装入：${s.bestComplete?'是':'否'}
当前最好实际总属性：${bestKnown?formatNum(s.bestTotal):'尚未形成可评分方案'}
当前最好基础值：${bestKnown?formatNum(s.bestBase):'-'}
当前最好百分比加成：${bestKnown?formatNum(s.bestBonus):'-'}
当前最好总邻接数量：${bestKnown?(s.bestAdjacency ?? 0):'-'}
当前放入物品：${s.bestItems ?? 0}/${s.totalItems ?? inventory.length}
当前空间利用：${Math.max(0,Number(s.bestArea)||0)}/${s.activeCells}
${s.restarts ? `多起点尝试：${s.restarts}\n` : ''}
求解器可能正在评估一个耗时较长的完整候选；计时持续变化即表示任务仍在运行。
可点击“停止计算”保留当前已显示结果。`;
}

function startSolverStatusHeartbeat(activeCells,totalItems){
  stopSolverStatusHeartbeat();
  const now = performance.now();
  solverStatusState = {
    startedAt:now,lastReportAt:now,stage:'准备并启动后台搜索',nodes:0,
    bestComplete:false,bestArea:0,bestBase:-1,bestBonus:0,bestTotal:-1,bestAdjacency:0,bestItems:0,
    activeCells,totalItems,restarts:0
  };
  solverStatusTimer = setInterval(renderLiveSolverStatus,500);
}

function updateSolverStatusFromMessage(msg,activeCells){
  if(!solverStatusState) return;
  Object.assign(solverStatusState,{
    stage:msg.stage || solverStatusState.stage,
    nodes:msg.nodes ?? solverStatusState.nodes,
    bestComplete:msg.bestComplete ?? msg.best?.complete ?? solverStatusState.bestComplete,
    bestArea:msg.bestArea ?? msg.best?.area ?? solverStatusState.bestArea,
    bestBase:msg.bestBase ?? msg.best?.baseScore ?? solverStatusState.bestBase,
    bestBonus:msg.bestBonus ?? msg.best?.bonusScore ?? solverStatusState.bestBonus,
    bestTotal:msg.bestTotal ?? msg.best?.totalScore ?? solverStatusState.bestTotal,
    bestAdjacency:msg.bestAdjacency ?? msg.best?.adjacencyCount ?? solverStatusState.bestAdjacency,
    bestItems:msg.bestItems ?? msg.best?.itemCount ?? solverStatusState.bestItems,
    totalItems:msg.totalItems ?? solverStatusState.totalItems,
    activeCells,
    restarts:msg.restarts ?? solverStatusState.restarts,
    lastReportAt:performance.now()
  });
  renderLiveSolverStatus();
}

function setSolverRunning(running){
  const solveBtn = document.getElementById('solveBtn');
  const cancelBtn = document.getElementById('cancelSolveBtn');
  solveBtn.disabled = running;
  solveBtn.textContent = running ? '正在搜索…' : '搜索更优摆放解';
  cancelBtn.disabled = !running;
}

function cleanupSolverWorker(){
  stopSolverStatusHeartbeat();
  for(const worker of solverWorkers){
    const url=worker._blobUrl;
    worker.terminate();
    if(url) URL.revokeObjectURL(url);
  }
  solverWorkers=[];
  solverWorker = null;
  setSolverRunning(false);
}

function cancelSolve(){
  if(!solverWorker) return;
  cleanupSolverWorker();
  document.getElementById('statusBox').textContent = '计算已由用户停止。可以降低搜索节点/时间上限后重新计算，也可以直接再次计算。';
}

function compareSolverBest(a,b){
  if(!a) return -1;
  if(!b) return 1;
  if(!!a.complete!==!!b.complete) return a.complete?1:-1;
  const numbers=['totalScore'];
  for(const key of numbers) if(Math.abs((Number(a[key])||0)-(Number(b[key])||0))>1e-9) return Number(a[key])>Number(b[key])?1:-1;
  const compareVector=(x=[],y=[])=>{
    const n=Math.max(x.length,y.length);
    for(let i=0;i<n;i++) if((x[i]||0)!==(y[i]||0)) return (x[i]||0)>(y[i]||0)?1:-1;
    return 0;
  };
  let c=compareVector(a.manualPriorityVector,b.manualPriorityVector); if(c) return c;
  c=compareVector(a.defaultPriorityVector,b.defaultPriorityVector); if(c) return c;
  for(const key of ['adjacencyCount','itemCount','area','baseScore','bonusScore']){
    if(Math.abs((Number(a[key])||0)-(Number(b[key])||0))>1e-9) return Number(a[key])>Number(b[key])?1:-1;
  }
  return 0;
}

function solveAndRender(){
  if(solverWorker) return;
  const prepared = prepareInventoryItems();
  const {items, skipped, manualItems, manualPriorityLevels} = prepared;
  const {mask:activeMask, count:activeCells} = buildActiveMask();
  if(activeCells===0){ alert('请至少选择一个已解锁空间格。'); return; }
  if(inventory.length===0){ alert('请先从物品库添加已有物品。'); return; }
  if(items.length===0){ alert('已有物品都无法放入当前空间。请调整空间、旋转/镜像设置或物品清单。'); return; }
  const searchMode=document.getElementById('searchMode').value;
  const requestedNodeLimit = Math.max(1000, Number(document.getElementById('nodeLimit').value)||2500000);
  const requestedTimeLimit = Math.max(100, Number(document.getElementById('timeLimit').value)||20000);
  const nodeLimit=searchMode==='fast'?Math.min(requestedNodeLimit,350000):requestedNodeLimit;
  const timeLimit=searchMode==='fast'?Math.min(requestedTimeLimit,3000):requestedTimeLimit;
  const useBonus = document.getElementById('useAdjacencyBonus').checked;
  const parallel=document.getElementById('parallelSearch').checked;
  const workerLimit=getParallelWorkerLimit();
  const workerCount=parallel?Math.max(2,Math.min(workerLimit,Math.floor(Number(document.getElementById('workerCount').value)||2))):1;

  const serialItems = items.map(t=>({
    ...t,
    placements:t.placements.map(p=>({...p, mask:p.mask.toString()}))
  }));
  solverWorkers=Array.from({length:workerCount},()=>createSolverWorker());
  solverWorker=solverWorkers[0];
  setSolverRunning(true);
  startSolverStatusHeartbeat(activeCells, inventory.length);
  const totalSearchArea = inventory.reduce((sum,x)=>sum+(x.cells?.length||0),0);
  const totalSearchBase = inventory.reduce((sum,x)=>sum+Math.max(0,Number(x.value)||0),0);
  document.getElementById('statusBox').textContent = `正在后台搜索（${searchMode==='fast'?'快速':'深度'}档，${workerCount} 个 Worker）…
物品总占格：${totalSearchArea}，可用空间：${activeCells}
${skipped.length>0?'存在单件无法合法放置的物品，将直接搜索最佳可行子集。':(totalSearchArea<=activeCells?'先寻找全部物品的完整摆法，再按实际总属性与邻接顺序优化。':'物品总面积超过空间，将按实际总属性与邻接顺序搜索最佳可行子集。')}
节点上限：${nodeLimit.toLocaleString('zh-CN')}
时间上限：${timeLimit} ms
自定义邻接优先物品：${manualItems.length} 件
求解起点：从已有物品清单自动生成

状态区会每 500 ms 更新计时；求解器阶段、节点和最好评分在收到新进度时同步更新。
页面仍可正常操作；需要中止时点击“停止计算”。`;

  let completedWorkers=0, totalNodes=0, globalBest=null, winningMessage=null;
  const wallStarted=performance.now();
  const finishWorker=function(worker,msg){
    completedWorkers++;
    totalNodes+=Number(msg.nodes)||0;
    const comparison=compareSolverBest(msg.best,globalBest);
    if(comparison>0) globalBest=msg.best;
    if(comparison>=0 || !winningMessage) winningMessage=msg;
    const url=worker._blobUrl; worker.terminate(); if(url) URL.revokeObjectURL(url);
    if(completedWorkers<workerCount) return;
    const best=globalBest, meta=winningMessage;
    lastResult = {
      best, nodes:totalNodes, elapsed:Math.round(performance.now()-wallStarted), stopped:meta.stopped, width:W, height:H, active:active.map(r=>r.slice()),
      inventory:inventory.map(x=>({...x,cells:cloneCells(x.cells)})),
      settings:{allowRotate:document.getElementById('allowRotate').checked,allowMirror:document.getElementById('allowMirror').checked,useAdjacencyBonus:useBonus,searchMode,parallelSearch:parallel,workerCount,optimizationOrder:['complete_loading','actual_total_score','manual_priority_neighbors','default_priority_neighbors','total_adjacency_count'],statKeys:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>({id:s.id,name:s.name})),manualPriorityRule:'1 is highest; blank uses default rules',assignmentStrategy:'geometry_then_item_assignment'},
      skipped:skipped.map(x=>({no:x.no,name:x.name,area:x.area,value:x.value})),manualItems,
      solverMeta:{fullPackingAttempted:meta.fullPackingAttempted,fullPackingFound:meta.fullPackingFound,fullSearchCutoff:meta.fullSearchCutoff,optimizationCutoff:meta.optimizationCutoff,fallbackCutoff:meta.fallbackCutoff,totalArea:meta.totalArea,totalBase:meta.totalBase,totalItems:meta.totalItems,fullGroupCount:meta.fullGroupCount,detailedGroupCount:meta.detailedGroupCount,assignmentStrategy:meta.assignmentStrategy,singletonDeferredCount:meta.singletonDeferredCount,assignmentChecks:meta.assignmentChecks,workerCount}
    };
    solverWorkers=[]; solverWorker=null; stopSolverStatusHeartbeat(); setSolverRunning(false);
    renderResultGrid(best);
    renderStats(best,totalNodes,lastResult.elapsed,meta.stopped,activeCells,skipped,lastResult.solverMeta);
  };
  solverWorkers.forEach((worker,workerIndex)=>{ worker.onmessage = function(ev){
    const msg = ev.data;
    if(msg.type === 'progress'){
      updateSolverStatusFromMessage({...msg,nodes:totalNodes+(Number(msg.nodes)||0),stage:`Worker ${workerIndex+1}/${workerCount}：${msg.stage||'搜索中'}`},activeCells);
      return;
    }
    if(msg.type === 'incumbent'){
      if(compareSolverBest(msg.best,globalBest)>0){ globalBest=msg.best; renderResultGrid(msg.best); }
      updateSolverStatusFromMessage({
        ...msg,
        stage:msg.stage || (msg.best.complete?'已找到完整摆法，继续优化':'已找到更优可行方案'),
        bestComplete:msg.best.complete,
        bestArea:msg.best.area,
        bestBase:msg.best.baseScore,
        bestBonus:msg.best.bonusScore,
        bestTotal:msg.best.totalScore,
        bestAdjacency:msg.best.adjacencyCount,
        bestItems:msg.best.itemCount
      },activeCells);
      return;
    }
    if(msg.type !== 'done') return;
    finishWorker(worker,msg);
  };
  worker.onerror = function(err){
    const message = err && err.message ? err.message : '未知错误';
    cleanupSolverWorker();
    document.getElementById('statusBox').textContent = `计算失败：${message}`;
  };
  worker.postMessage({
    items:serialItems,
    activeMask:activeMask.toString(), activeCells, W, H, nodeLimit, timeLimit, useBonus,
    statKeys:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id),
    statCount:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).length,
    seedOffset:Math.imul(workerIndex+1,0x85ebca6b),
    manualCount:manualPriorityLevels.length,
    defaultTierCount:DEFAULT_TIER_COUNT,
    requiredTotalItems:inventory.length,
    requiredTotalArea:totalSearchArea,
    requiredTotalBase:totalSearchBase,
    skippedCount:skipped.length
  });
  });
}


