// engine-orchestrator.js —— “超越版求解引擎”主线程集成编排。加载顺序 13/19，依赖 score-shared、engine-encoding、engine-worker，先于 solver.js。
'use strict';
// ============================================================================
// 职责：
//   1. engOrchCreateWorkers：按搜索档位组合 Portfolio——全部 createEngineWorker（纯 SA，
//      老 DFS 引擎已退役并删除），K 个 SA Worker 并行，回火交换取各成员最佳。
//      返回数组直接进 solverWorkers（cleanup/cancel/onerror 零改动覆盖），每个 Worker 带 _blobUrl。
//   2. 回火 broker：engOrchHandleSwapReq——相邻温度对 (i,i+1) 奇偶轮转，
//      Metropolis 准则 min(1, exp((βk-βk+1)(Ek+1-Ek))) 决定是否交换解。
//      隐藏开关 window.__ENGINE_TEMPERING_OFF__ = true 时直接回发原 sol 不交换。
//      期 2 收口：init meta 恒带 lnsEnabled（缺省 false 即 LNS 关闭），
//      隐藏开关 window.__ENGINE_LNS_ON__ = true 时置 true（同风格）。
//   3. 契约转换：SA Worker 的 incumbent-lite / done 消息经 encRebuildBest 全算重建，
//      包装成标准 incumbent/done 消息后交给现有消息循环（incumbent/done 分支零改动）。
// ============================================================================

// 单次求解会话的编排状态（无会话时为 null，全部 hook 自动退化为无操作）
var engOrchState = null;

// ----------------------------------------------------------------------------
// SAB 增强档能力探测（期 3）：仅 crossOriginIsolated === true 且 SharedArrayBuffer
// 可用时启用 SAB 回火直连通道；file:// 环境 crossOriginIsolated 恒 false → 走 broker
// （行为与现状完全一致）。隐藏开关 window.__ENGINE_SAB_OFF__ 真值 = 强制 broker
// （风格与 __ENGINE_TEMPERING_OFF__/__ENGINE_LNS_ON__ 一致）。
// ----------------------------------------------------------------------------
function engOrchSabAvailable(){
  if(typeof window !== 'undefined' && window.__ENGINE_SAB_OFF__) return false;
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
}

// ----------------------------------------------------------------------------
// Portfolio 路由与 SA Worker 初始化
// opts = {searchMode, workerCount, payload}
// payload 为 Worker 启动负载（items/activeMask/W/H/limits/统计与清单口径等），
// 用于主线程构建 SoA 模型与 bundle；全部走 SA 引擎（老 DFS 已退役）。
// ----------------------------------------------------------------------------
function engOrchCreateWorkers(opts){
  const searchMode = opts.searchMode === 'fast' ? 'fast' : 'deep';
  const K = Math.max(1, Math.floor(Number(opts.workerCount) || 1));
  const payload = opts.payload;
  // 主线程一次性构建 SoA 模型 + bundle（encBuildModel 内部允许 BigInt，仅构建期）
  const model = encBuildModel(payload.items, payload.activeMask, payload.W, payload.H, {
    statKeys: payload.statKeys, statCount: payload.statCount,
    manualCount: payload.manualCount, defaultTierCount: payload.defaultTierCount,
    useBonus: payload.useBonus
  });
  const bundle = encBuildBundle(model);
  // complete 语义：已放件数 + skippedCount === requiredTotalItems
  const requiredTotalItems = Math.max(0, Number(payload.requiredTotalItems) || 0);
  const skippedCount = Math.max(0, Number(payload.skippedCount) || 0);
  const ctx = {
    statCount: payload.statCount, useBonus: payload.useBonus,
    manualCount: payload.manualCount, defaultTierCount: payload.defaultTierCount,
    totalItems: Math.max(0, requiredTotalItems - skippedCount),
    statKeys: payload.statKeys,
    requiredTotalItems, skippedCount,
    requiredTotalArea: payload.requiredTotalArea, requiredTotalBase: payload.requiredTotalBase
  };
  const saCount = K; // 纯 SA：K 个 SA Worker 并行
  const temperingOn = !window.__ENGINE_TEMPERING_OFF__ && saCount >= 2;
  // SAB 增强档（期 3）：回火开启且 crossOriginIsolated 时建立 SAB 直连通道（固定槽位+
  // 序列号+Atomics 发布屏障，无 wait/notify，主循环每 2048 迭代轮询），替代 broker 的
  // swap-req/swap-accept 消息对；任何失败回落 broker。
  // K=1（saCount<2）或 file:// 永不启用，单 Worker 行为不变。
  let sab = null, sabMode = false;
  if(temperingOn && engOrchSabAvailable()){
    try{
      sab = new SharedArrayBuffer(32 * saCount + 4 * saCount * model.I);
      sabMode = true;
    }catch(e){ sab = null; sabMode = false; } // SAB 初始化失败：照常走 broker
  }
  engOrchState = {
    model, ctx,
    groupCounts: engOrchGroupCounts(payload.items),
    workers: new Map(),   // worker → {kind, tempIndex, E, nodes, elapsed}
    byTemp: new Map(),    // tempIndex → worker
    saWorkers: [],
    pairParity: 0,        // 奇偶轮转位
    T0: 0,                // 温度标度：由 Worker 标定的 parts.T0 同步（engOrchConvertIncumbentLite）
    sabMode,              // 期 3：本会话回火通道是否走 SAB 直连（false = broker）
    temperingOn,          // 期 3 评审修复：实际回火启用态（saCount>=2 且未被隐藏开关禁用），摘要三态用
    saLast: null          // 期 3：最近一次 SA progress 摘要（终态 statusBox 追加用）
  };
  const workers = []; // 全部为 SA Worker
  for(let n = 0; n < saCount; n++){
    const w = createEngineWorker();
    w._engineKind = 'sa';
    w._tempIndex = n;
    const buf = bundle.buffer.slice(0); // 每 Worker 独立副本（Transferable 发出即脱离）
    const initMsg = {
      type: 'init', buffer: buf, offsets: bundle.offsets,
      meta: {
        seedOffset: Math.imul(workers.length + 1, 0x85ebca6b), // 随最终下标唯一的随机种子
        nodeLimit: payload.nodeLimit, timeLimit: payload.timeLimit, useBonus: payload.useBonus,
        requiredTotalItems, requiredTotalArea: payload.requiredTotalArea,
        requiredTotalBase: payload.requiredTotalBase, skippedCount,
        tempIndex: n, swapEnabled: temperingOn,
        lnsEnabled: !!window.__ENGINE_LNS_ON__, // 期 2 收口：LNS 默认关闭；隐藏开关 __ENGINE_LNS_ON__ 开启（只加法新键，冻结契约不变）
        sabMode,                 // 期 3：SAB 直连通道开关（只加法新键；false/缺省 = broker）
        saCount: sabMode ? saCount : 0
      }
    };
    if(sabMode) initMsg.sab = sab; // SAB 经 postMessage 结构化克隆传递（不可放入 transfer list）
    w.postMessage(initMsg, [buf]);
    workers.push(w);
    engOrchState.saWorkers.push(w);
  }
  for(const w of workers){
    engOrchState.workers.set(w, {kind:'sa', tempIndex: w._tempIndex, E: null, nodes: 0, elapsed: 0});
    engOrchState.byTemp.set(w._tempIndex, w);
  }
  return workers;
}

// ----------------------------------------------------------------------------
// 回火 broker：SA Worker 发来 {type:'swap-req', sol(Int32Array Transferable)}。
// i/E 由主线程小表补齐（tempIndex 在创建时分配；E 用 SoA 模型对 sol 现场重算）。
// 交换则把对方 sol 以 swap-accept 回发双方；不交换也回发原 sol（缓冲回收，Worker 不等待）。
// ----------------------------------------------------------------------------
function engOrchHandleSwapReq(worker, msg){
  const sol = msg && msg.sol;
  if(!engOrchState || !sol || sol.length === undefined){ return; }
  const rec = engOrchState.workers.get(worker);
  if(!rec || rec.kind !== 'sa'){ return; }
  // 隐藏开关：整体禁用回火，直接回发原 sol，正确性不受影响
  if(window.__ENGINE_TEMPERING_OFF__){
    worker.postMessage({type:'swap-accept', sol}, [sol.buffer]);
    return;
  }
  rec.lastSol = new Int32Array(sol); // 主线程留存一份解缓存（交换配对用）；sol 原件继续参与转移
  const Ei = engOrchEnergyOf(sol);
  rec.E = Ei;
  const i = rec.tempIndex;
  // 奇偶轮转：本轮 parity 决定参与对 (i,i+1) 还是 (i-1,i)
  const j = (i % 2 === engOrchState.pairParity) ? i + 1 : i - 1;
  engOrchState.pairParity ^= 1;
  const peer = engOrchState.byTemp.get(j);
  const peerRec = peer ? engOrchState.workers.get(peer) : null;
  if(!peer || !peerRec || peerRec.E === null){
    worker.postMessage({type:'swap-accept', sol}, [sol.buffer]); // 无合法对手或对手能量未知：回发原 sol
    return;
  }
  const k = Math.min(i, j);
  const Ek = k === i ? Ei : peerRec.E;
  const Ek1 = k === i ? peerRec.E : Ei;
  const betaK = engOrchBeta(k), betaK1 = engOrchBeta(k + 1);
  const acceptProb = Math.min(1, Math.exp((betaK - betaK1) * (Ek1 - Ek)));
  const Ej = peerRec.E;
  if(Math.random() < acceptProb && peerRec.lastSol){
    // 交换：请求方 sol（原件）转移给 peer；peer 缓存解转移给请求方；能量随解互换
    const toReq = peerRec.lastSol;
    peerRec.lastSol = new Int32Array(sol);
    peer.postMessage({type:'swap-accept', sol}, [sol.buffer]);
    worker.postMessage({type:'swap-accept', sol: toReq}, [toReq.buffer]);
    rec.E = Ej; peerRec.E = Ei;
  }else if(Math.random() < acceptProb){
    // peer 尚无解缓存：半交换——请求方 sol 副本送给 peer，请求方收回原 sol
    peer.postMessage({type:'swap-accept', sol: new Int32Array(sol)}, []);
    worker.postMessage({type:'swap-accept', sol}, [sol.buffer]);
    peerRec.E = Ei;
  }else{
    worker.postMessage({type:'swap-accept', sol}, [sol.buffer]); // 不交换：回发原 sol
  }
}

// 温度标度：T0 估计与 Worker 同式（0.03*|E0|+1）；β_k = 1/max(Tmin, T0*0.85^k)
function engOrchBeta(k){
  if(!engOrchState.T0) engOrchState.T0 = 1;
  const Tmin = engOrchState.T0 * 1e-4;
  return 1 / Math.max(Tmin, engOrchState.T0 * Math.pow(0.85, k));
}

// sol（摆放下标数组）的标量能量：与 engine-worker 的 ewScalarOf 逐字同式。
// 用主线程 SoA 模型的 CSR 邻接对表现场重算（每件物品至多一个摆放在放，摆放对↔物品对双射）。
function engOrchEnergyOf(sol){
  const m = engOrchState.model, ctx = engOrchState.ctx;
  let base = 0, area = 0, items = 0, bonus = 0, manW = 0, defW = 0, dmg = 0, adj = 0;
  const placedPl = [];
  for(let i = 0; i < m.I; i++){
    const p = sol[i];
    if(p < 0 || m.plItem[p] !== i) continue;
    placedPl.push(p);
    base += m.itemValue[i];
    area += m.plArea[p];
    items++;
  }
  for(const a of placedPl){
    const ia = m.plItem[a];
    for(let e = m.adjOff[a]; e < m.adjOff[a + 1]; e++){
      const b = m.adjPeer[e];
      const ib = m.plItem[b];
      if(ib <= ia) continue;       // 无序对只计一次
      if(sol[ib] !== b) continue;  // 对手摆放未在放
      adj++;
      if(m.useBonus) bonus += m.adjBonus[e];
      manW += m.adjManW[e];
      defW += m.adjDefW[e];
      dmg += m.adjDmg ? m.adjDmg[e] : 0; // 伤害贴邻 bond 计数（对称 CSR，无序对一次）
    }
  }
  const complete = items + ctx.skippedCount === ctx.requiredTotalItems;
  return engOrchScalar(complete, base, ctx.useBonus ? bonus : 0, manW, defW, dmg, adj, items, area);
}

// 与 Worker 侧 ewScalarOf 逐字一致的能量标量（dmg = 伤害贴邻 bond 数，取 1e2 弱于任一默认档位边 1e5，
// 使 bond 仅在各档位加权相等后破平——近似 Worker 侧 ewBetterLex 的 dmg 项，见 worker 注释）
function engOrchScalar(c, base, bonus, manW, defW, dmg, adj, items, area){
  const total = base + bonus;
  return -((c ? 1e12 : 0) + total + 1e8 * manW + 1e5 * defW + 1e2 * dmg + 10 * adj + items + 1e-3 * area);
}

// ----------------------------------------------------------------------------
// 契约转换：incumbent-lite → 旧 incumbent 消息（encRebuildBest 晋级全算）
// ----------------------------------------------------------------------------
function engOrchConvertIncumbentLite(worker, msg){
  if(!engOrchState || !msg || !msg.sol) return null;
  // 温度标度同步：Worker 侧 T0 已改为算子 delta 采样标定（旧式 0.03*|E|+1 被 1e12 常量偏移污染），
  // 回火 β 阶梯直接采用 Worker 上报的标定值，保证交换判定与链内温度同量级
  if(msg.parts && Number(msg.parts.T0) > 0) engOrchState.T0 = msg.parts.T0;
  const rec = engOrchState.workers.get(worker);
  let best;
  try{
    best = encRebuildBest(msg.sol, engOrchState.model, engOrchState.ctx);
  }catch(e){
    return null; // 重建失败不污染消息循环；Worker 继续搜索
  }
  best.placements = best.placements.map(engOrchCanonicalPlacement);
  if(rec){
    rec.E = engOrchEnergyFromBest(best);
    rec.lastSol = new Int32Array(msg.sol); // 回火交换用的对手解缓存
  }
  return {
    type: 'incumbent', stage: msg.stage, best,
    nodes: rec ? rec.nodes : 0, elapsed: rec ? rec.elapsed : 0,
    fullPackingFound: !!best.complete,
    totalArea: engOrchState.ctx.requiredTotalArea,
    totalItems: engOrchState.ctx.requiredTotalItems
  };
}

// 由重建 best 反推能量（与 Worker 能量式一致；优先级权重公式见 score-shared）
function engOrchEnergyFromBest(best){
  const ctx = engOrchState.ctx;
  let manW = 0, defW = 0;
  const mv = best.manualPriorityVector || [];
  for(let i = 0; i < mv.length; i++) manW += (mv[i] || 0) * Math.max(1, mv.length - i) * 1e8;
  const dv = best.defaultPriorityVector || [];
  for(let i = 0; i < dv.length; i++) defW += (dv[i] || 0) * Math.max(1, dv.length - i) * 1e5;
  const dmg = Number(best.damageBondCount) || 0; // 伤害贴邻 bond（encRebuildBest 经 scoreEvaluateConcrete 已计）
  return engOrchScalar(!!best.complete, best.baseScore, ctx.useBonus ? best.bonusScore : 0,
    manW, defW, dmg, best.adjacencyCount || 0, best.itemCount || 0, best.area || 0);
}

// placements 项字段序列化（剔除内部 lo/hi 视图键，补 geometryGroupIndex）
function engOrchCanonicalPlacement(p){
  return {
    mask: p.mask, neighborMask: p.neighborMask, cells: p.cells,
    uid: p.uid, no: p.no, itemName: p.itemName, typeName: p.typeName,
    area: p.area, quality: p.quality, value: p.value,
    stats: p.stats, rates: p.rates, sv: p.sv, rv: p.rv,
    bonusKind: p.bonusKind, attribute: p.attribute, causesDamage: !!p.causesDamage, priorityTier: p.priorityTier, customPriority: p.customPriority,
    manualOrder: p.manualOrder, itemIndex: p.itemIndex,
    geometryGroupIndex: p.geometryGroupIndex ?? null, placementIndex: p.placementIndex
  };
}

// ----------------------------------------------------------------------------
// 契约转换：SA done → 标准 done 消息（缺完整 best 时用 encRebuildBest 补齐；
// fullGroupCount/detailedGroupCount 由主线程 engOrchGroupCounts 补齐）
// ----------------------------------------------------------------------------
function engOrchConvertDone(worker, msg){
  if(!engOrchState || !worker || worker._engineKind !== 'sa') return msg;
  let best = msg.best;
  if(!best && msg.sol){
    try{
      best = encRebuildBest(msg.sol, engOrchState.model, engOrchState.ctx);
      best.placements = best.placements.map(engOrchCanonicalPlacement);
    }catch(e){
      best = null;
    }
  }
  const rec = engOrchState.workers.get(worker);
  return {
    type: 'done', best,
    nodes: msg.nodes ?? (rec ? rec.nodes : 0),
    elapsed: msg.elapsed ?? (rec ? rec.elapsed : 0),
    stopped: !!msg.stopped,
    fullPackingAttempted: msg.fullPackingAttempted !== undefined ? msg.fullPackingAttempted : true,
    fullPackingFound: msg.fullPackingFound !== undefined ? msg.fullPackingFound : !!(best && best.complete),
    fullSearchCutoff: !!msg.fullSearchCutoff,
    optimizationCutoff: !!msg.optimizationCutoff,
    fallbackCutoff: !!msg.fallbackCutoff,
    totalArea: msg.totalArea !== undefined ? msg.totalArea : engOrchState.ctx.requiredTotalArea,
    totalBase: msg.totalBase !== undefined ? msg.totalBase : engOrchState.ctx.requiredTotalBase,
    totalItems: msg.totalItems !== undefined ? msg.totalItems : engOrchState.ctx.requiredTotalItems,
    fullGroupCount: msg.fullGroupCount !== undefined ? msg.fullGroupCount : engOrchState.groupCounts.full,
    detailedGroupCount: msg.detailedGroupCount !== undefined ? msg.detailedGroupCount : engOrchState.groupCounts.detailed,
    assignmentStrategy: msg.assignmentStrategy || 'sa_alns',
    singletonDeferredCount: msg.singletonDeferredCount || 0,
    assignmentChecks: msg.assignmentChecks || 0,
    engine: msg.engine || 'sa'
  };
}

// 分组计数：full 键（几何分组）与 detailed 键（含属性/品质签名）统计（mask 十进制串字典序排序）。
function engOrchGroupCounts(serialItems){
  const sig = t => `${t.value}|${t.bonusKind}|${(t.stats || []).join(',')}|${(t.rates || []).join(',')}`;
  const fullKeys = new Set(), detailedKeys = new Set();
  for(const t of serialItems){
    const masks = t.placements.map(p => String(p.mask)).sort().join(',');
    const cp = t.customPriority === null || t.customPriority === undefined ? '' : t.customPriority;
    fullKeys.add([masks, t.area, t.priorityTier, t.manualOrder, cp].join('|'));
    detailedKeys.add([masks, t.area, t.quality, sig(t), t.attribute ?? '', t.priorityTier, t.manualOrder, cp].join('|'));
  }
  return {full: fullKeys.size, detailed: detailedKeys.size};
}

// ----------------------------------------------------------------------------
// 进度记录：消息循环 progress 分支前调用（仅 SA 档会话有意义）
// ----------------------------------------------------------------------------
function engOrchNoteProgress(worker, msg){
  if(!engOrchState) return;
  const rec = engOrchState.workers.get(worker);
  if(!rec) return;
  rec.nodes = Number(msg.nodes) || rec.nodes;
  rec.elapsed = Number(msg.elapsed) || rec.elapsed;
  // 进度消息补齐 fullPackingFound 键（SA progress 缺该键且直通 UI；此处就地按 bestComplete 补齐，
  // 与 SA complete 语义同口径，不删改任何现有键）。
  if(rec.kind === 'sa' && msg && msg.fullPackingFound === undefined){
    msg.fullPackingFound = !!msg.bestComplete;
  }
  // 期 3：留存最近一次 SA progress 摘要（终态 statusBox 追加用；只读新键，不改 msg）
  if(rec.kind === 'sa' && msg && (msg.saTemp !== undefined || msg.saAcceptRate !== undefined || msg.saItersPerSec !== undefined)){
    const prev = engOrchState.saLast || {};
    engOrchState.saLast = {
      temp: msg.saTemp ?? prev.temp,
      acceptRate: msg.saAcceptRate ?? prev.acceptRate,
      itersPerSec: msg.saItersPerSec ?? prev.itersPerSec,
      restarts: msg.restarts ?? prev.restarts ?? 0,
      opTop3: Array.isArray(msg.saOpTop3) ? msg.saOpTop3 : prev.opTop3
    };
  }
}

// ----------------------------------------------------------------------------
// 期 3：SA 终态摘要。solver.js finishWorker 在 renderStats 之后调用，
// 非 null 时向 statusBox.textContent 条件追加。仅 SA 参与过且上报过 progress 的
// 会话返回非 null；无会话恒 null，statusBox 输出逐字不变。
// ----------------------------------------------------------------------------
function engOrchSaSummary(){
  if(!engOrchState || !engOrchState.saWorkers || !engOrchState.saWorkers.length) return null;
  if(!engOrchState.saLast) return null;
  return {
    workerCount: engOrchState.saWorkers.length,
    sabMode: !!engOrchState.sabMode,
    // 透传实际回火态（saCount=1 时 temperingOn=false 从未交换，
    // 展示层据此渲染「未启用回火（单 SA）」而非谎报 broker/SAB）
    tempering: engOrchState.saWorkers.length >= 2 && !!engOrchState.temperingOn,
    temp: engOrchState.saLast.temp,
    acceptRate: engOrchState.saLast.acceptRate,
    itersPerSec: engOrchState.saLast.itersPerSec,
    restarts: engOrchState.saLast.restarts,
    opTop3: engOrchState.saLast.opTop3
  };
}

if(typeof window !== 'undefined'){
  window.engOrchCreateWorkers = engOrchCreateWorkers;
  window.engOrchHandleSwapReq = engOrchHandleSwapReq;
  window.engOrchConvertIncumbentLite = engOrchConvertIncumbentLite;
  window.engOrchConvertDone = engOrchConvertDone;
  window.engOrchNoteProgress = engOrchNoteProgress;
  window.engOrchSaSummary = engOrchSaSummary;
  window.engOrchSabAvailable = engOrchSabAvailable;
  window.engOrchEnergyOf = engOrchEnergyOf;
  window.engOrchGroupCounts = engOrchGroupCounts;
}
