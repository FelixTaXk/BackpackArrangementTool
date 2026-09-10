// solver.js —— 求解编排：物品准备/Worker 生命周期/心跳状态/取消/比较/求解入口。加载顺序 14/19，依赖 state、utils、talisman-model。
'use strict';

// 加成维口径常量：bonusStats 中前 3 维（atk/def/hp）有基础值，其后为 rate-only 维
// （dmg/crit/heal/shield/drain，无基础值、不进 totalScore、仅驱动排序）。
// 该值同时决定 rate-only 命中统计的起始下标，须与 score-shared / engine-encoding 默认 3 保持一致。
const ENGINE_RATE_ONLY_FROM_K = 3;

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
  // 旋转/镜像选项已从界面移除；用户要求禁止旋转与镜像，法宝仅以原方向摆放。
  const allowRot = false;
  const allowMir = false;
  const {lo:activeLo, hi:activeHi} = buildActiveMask();
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
      attribute: inv.attribute,
      causesDamage: !!(inv.causesDamage),
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
    base.priorityTier = bonusPriorityTier(base);
    const placeMap = new Map();
    for(const ori of orientations(base.cells, allowRot, allowMir)){
      const maxR = Math.max(...ori.map(x=>x[0])), maxC = Math.max(...ori.map(x=>x[1]));
      for(let r0=0;r0<=H-maxR-1;r0++){
        for(let c0=0;c0<=W-maxC-1;c0++){
          const abs = ori.map(([r,c])=>[r+r0,c+c0]);
          // 双 Uint32 位板：格位必须全部落在已解锁掩码内，否则该摆放不可行。
          let mLo = 0, mHi = 0, ok = true;
          for(const [r,c] of abs){
            const idx = r*W+c;
            if(idx < 32){
              const b = 1 << idx;
              if((activeLo & b) === 0){ ok = false; break; }
              mLo |= b;
            }else{
              const b = 1 << (idx-32);
              if((activeHi & b) === 0){ ok = false; break; }
              mHi |= b;
            }
          }
          // mask 直接以十进制串落库：既是 placeMap 去重键，也是跨线程线格式（与旧 BigInt.toString() 逐字一致）。
          const maskDec = ok ? maskToDec(mLo, mHi) : '';
          if(ok && !placeMap.has(maskDec)){
            placeMap.set(maskDec, {
              mask:maskDec, cells:abs, uid:base.uid, no:base.no, itemName:base.name, typeName:base.typeName,
              area:base.area, quality:base.quality, value:base.value, stats:base.stats, rates:base.rates, bonusKind:base.bonusKind, attribute:base.attribute, causesDamage:base.causesDamage, priorityTier:base.priorityTier, customPriority:base.customPriority, manualOrder:-1, itemIndex:-1
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
${s.sa ? `模拟退火温度：${Number(s.sa.temp ?? 0).toPrecision(4)}
模拟退火接受率：${((Number(s.sa.acceptRate) || 0) * 100).toFixed(1)}%
模拟退火迭代速率：${((Number(s.sa.itersPerSec) || 0) / 10000).toFixed(1)} 万/秒
模拟退火重热次数：${Number(s.sa.restarts) || 0}
算子权重 Top3：${(s.sa.opTop3 || []).map(o => `${o.name}(${Number(o.w || 0).toFixed(2)})`).join('、')}
（注：lnsSmall/lnsBig 默认关闭，此处权重非零不代表正在执行。）
` : ''}求解器可能正在评估一个耗时较长的完整候选；计时持续变化即表示任务仍在运行。
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
  // SA 实时行（期 3，条件渲染）：仅当消息带 SA 键时记录；无 SA 键时
  // solverStatusState.sa 恒为 undefined，渲染时整行不出现，输出逐字不变。
  if(msg.saTemp !== undefined || msg.saAcceptRate !== undefined || msg.saItersPerSec !== undefined){
    const prev = solverStatusState.sa || {};
    solverStatusState.sa = {
      temp: msg.saTemp ?? prev.temp,
      acceptRate: msg.saAcceptRate ?? prev.acceptRate,
      itersPerSec: msg.saItersPerSec ?? prev.itersPerSec,
      restarts: msg.restarts ?? prev.restarts ?? 0,
      opTop3: Array.isArray(msg.saOpTop3) ? msg.saOpTop3 : prev.opTop3
    };
  }
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

// 属性权重（一期线性）读取闸门（全局函数，ui-focus.js 复用；persistence.js 独立同口径校验
//（读档时校验存档形状，语义不同））：
// - 权重口径开关：#weightMode 存在且 value !== 'custom'（默认口径）→ null（默认 ≡ 全 1，逐字节零污染）；
// - window.__WEIGHTS_OFF__ 为真 → null（仿 __FOCUS_OFF__ 回退闸，强制全 1 语义）；
// - 逐项判定：控件缺失、value.trim() 为空串、非有限、<0、或 >1e6 上限，任一成立 → null
//   （非法值整体回退默认全 1）。清空/空白视为非法回退，非「0」；上限 1e6 防极端权重使
//   计分溢出 Infinity（比较链 Infinity-Infinity=NaN 退化）；
// - 三项精确 ===1 → null（默认 ≡ 现状：闸门整段不执行，原值原样流转，禁止“重算出相同值”路径——
//   浮点重算会污染引擎哈希种子，改变 RNG 序列）；
// - 否则返回原始数组 [wAtk, wDef, wHp]。
function readWeightMul(){
  // 权重口径首判：默认口径 ≡ 全 1，直接 return null（改写块/口径行/settings 键全不执行）；仅自定义口径才读八 input。
  const modeEl = document.getElementById('weightMode');
  if(modeEl && modeEl.value !== 'custom') return null;
  if(window.__WEIGHTS_OFF__) return null;
  const weightMul = [];
  for(const id of WEIGHT_INPUT_IDS){
    const el = document.getElementById(id);
    if(!el || String(el.value).trim() === '') return null; // 控件缺失/清空/空白：非法回退，非「0」
    const v = Number(el.value);
    if(!Number.isFinite(v) || v < 0 || v > 1e6) return null;
    weightMul.push(v);
  }
  // 八维权重全部为 1 → 默认 ≡ 全 1，return null（禁止浮点重算路径，避免污染哈希种子改变 RNG 序列）。
  if(weightMul.length > 0 && weightMul.every(w => w === 1)) return null;
  return weightMul;
}

// 真实重算（方案A）：权重激活时 worker 侧加成率已随权重缩放（rates×w），其回传的
// bonusEvents/bonusScore/statTotals 均为「加权口径」。本函数以 placement.uid 反查 inventory
// 原始条目的真实 baseStats/bonusRates（同 ui-focus.js 聚焦反查口径），经 score-shared 纯函数
// （scoreAreAdjacent/scorePairBonusEvents，与 worker pairBonusEvents 同语义）重算真实加成事件，
// 产出 trueEvents/trueBonus[]/真实基础分项与 ΣtrueBonus。mask/neighborMask 为十进制串，
// dec→lo/hi 同 ui-focus.js dec2lohi 同式。纯只读：不改 inventory/lastResult/入参 best。
function trueStatsOfBest(best){
  const statKeys = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
  const K = statKeys.length;
  const dec2lohi = maskDecToLoHi; // utils.js 共享实现（原就地副本已上收，逐字同式）
  const invByUid = new Map((Array.isArray(inventory) ? inventory : []).map(x=>[x.uid, x]));
  const views = [];
  for(const p of best.placements){
    const inv = invByUid.get(p.uid);
    if(!inv) continue;
    const stats = statKeys.map(k=>Math.max(0, Number((inv.baseStats || {})[k]) || 0));
    const rates = statKeys.map(k=>Math.max(0, Number((inv.bonusRates || {})[k]) || 0));
    const m = dec2lohi(p.mask), nb = dec2lohi(p.neighborMask);
    views.push({no:p.no, itemName:p.itemName, value:Number(p.value)||0, bonusKind:bonusKind(inv), attribute:inv.attribute, sv:stats, rv:rates, lo:m.lo, hi:m.hi, nbrLo:nb.lo, nbrHi:nb.hi});
  }
  const base = new Array(K).fill(0), bonus = new Array(K).fill(0);
  for(const v of views){ for(let k = 0; k < K; k++) base[k] += v.sv[k]; }
  const trueEvents = [];
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
  let sumTrueBonus = 0;
  for(let k = 0; k < K; k++) sumTrueBonus += bonus[k];
  return {trueEvents, trueBonus:bonus, trueBase:base, sumTrueBonus, total:base.map((v,k)=>v + bonus[k])};
}

// 真实重算展示覆盖（终态就地 / 实时克隆两用，任务 #62 统一真实总属性口径）：展示一律呈
// 实际总属性 = ΣtrueBase + ΣtrueBonus（官方定价）——baseScore=ΣtrueBase（renderStats statusBox
// 分解行「基础属性」消费点）、totalScore=ΣtrueBase+ΣtrueBonus（#statScore 横幅与「实际总属性」
// 行消费点）、bonusScore/statTotals/bonusEvents 换真实口径；不引入新舍入。加权搜索目标口径仅
// 保留在 statusBox 权重口径行。bonusOn=false（未勾选百分比加成）时会话无加成事件：加成保持
// worker 0 值不动，仅覆盖基础分项与总分（真实加成重算结果不展示，避免呈现搜索目标未计价项）。
// 注意：实时路径必须作用于浅拷贝（msg.best 原件仍参与后续 compareSolverBest 比较，口径须保持加权值）。
function withTrueStatsForDisplay(best, bonusOn){
  const truth = trueStatsOfBest(best);
  let sumTrueBase = 0;
  for(let k = 0; k < truth.trueBase.length; k++) sumTrueBase += truth.trueBase[k];
  if(bonusOn === false){
    const zero = truth.trueBase.map(()=>0);
    return {
      baseScore: sumTrueBase,
      statTotals: {base: truth.trueBase, bonus: zero, total: truth.trueBase.slice()},
      totalScore: sumTrueBase
    };
  }
  return {
    bonusEvents: truth.trueEvents,
    bonusScore: truth.sumTrueBonus,
    baseScore: sumTrueBase,
    statTotals: {base:truth.trueBase, bonus:truth.trueBonus, total:truth.total},
    totalScore: sumTrueBase + truth.sumTrueBonus
  };
}

// 非聚焦权重会话摆放清单真实口径重组：冻结 ui-result.js renderStats 的摆放清单行直吃
// placement 自身 rates 数组（worker 缩放值 rates×w），横幅/分项/事件清单已是真实口径而
// 清单率文本不是（w>1 呈放大率、w=0 条目率文本整段消失）。此处对齐 ui-focus.js 聚焦分支
// 清单模板（uid 反查 inventory 真实条目，baseStats/bonusRates 对象口径），仅锚点替换
// 「摆放清单：」段；事件清单段已由 withTrueStatsForDisplay 覆盖为真实 trueEvents，不动。
// 锚点缺失静默跳过；全程只改 statusBox 文本，不写 best/inventory/lastResult。
function rebuildTruePlacementList(best){
  const statusBox = document.getElementById('statusBox');
  if(!statusBox || !best || !Array.isArray(best.placements)) return;
  const text = statusBox.textContent;
  const listAnchor = '摆放清单：\n', evAnchor = '\n\n百分比加成清单：';
  const aIdx = text.indexOf(listAnchor);
  const eIdx = aIdx >= 0 ? text.indexOf(evAnchor, aIdx) : -1;
  if(aIdx < 0 || eIdx < 0) return;
  const invByUid = new Map((Array.isArray(inventory) ? inventory : []).map(x=>[x.uid, x]));
  // 同构模板重建（与 ui-focus.js focusDecorateStats trueList 逐字同式）：uid 反查失败退回 p 自身字段。
  const trueList = best.placements.map(p=>{
    const inv = invByUid.get(p.uid);
    const baseSrc = inv || p;
    const descSrc = inv || p;
    return `#${p.no} ${p.itemName}｜${qualityName(p.quality)}｜${p.area}格｜基础 ${baseStatsSummary(baseSrc)}｜${p.customPriority !== null && p.customPriority !== undefined ? `手动邻接优先级 ${p.customPriority}` : '默认邻接规则'}｜${bonusDescription(descSrc)}｜坐标 ${p.cells.map(([r,c])=>`(${r+1},${c+1})`).join(' ')}`;
  }).join('\n') || '未放入任何物品。';
  statusBox.textContent = text.slice(0, aIdx) + listAnchor + trueList + text.slice(eIdx);
}

function solveAndRender(){
  if(solverWorker) return;
  const prepared = prepareInventoryItems();
  const {items, skipped, manualItems, manualPriorityLevels} = prepared;
  // 加成聚焦：非法/空值回退 ''；window.__FOCUS_OFF__ 为真时强制旁路（线上回退闸，同 __ENGINE_LNS_ON__ 风格）。
  const statKeys = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
  const focusRaw = (document.getElementById('focusAttr') && document.getElementById('focusAttr').value) || '';
  let focusAttr = (statKeys.indexOf(focusRaw) >= 0) ? focusRaw : '';
  if(window.__FOCUS_OFF__) focusAttr = '';
  // 守卫（仿空间/清单守卫惯例）：加成全 0 时聚焦无意义，未勾选共鸣加成则拦截。
  if(focusAttr && !(document.getElementById('useAdjacencyBonus') && document.getElementById('useAdjacencyBonus').checked)){ alert('加成聚焦需要勾选“百分比相邻加成”。'); return; }
  // 聚焦有效：非聚焦下标加成率置 0（stats/value 不动）；placements 与 items 共享同一 rates 数组引用，
  // 一次改写全覆盖；仅 prepared 副本数组受影响，inventory 原始对象不受影响。未聚焦时分支不执行。
  if(focusAttr){
    const fi = statKeys.indexOf(focusAttr);
    items.forEach(t=>{ t.rates.forEach((_,k)=>{ if(k !== fi) t.rates[k] = 0; }); });
  }
  // 属性权重（方案A）：搜索目标 total = Σ base_k·w_k + Σ bonus_k·w_k（权重同时作用于基础与加成：
  // 基础经 value 双层改写，加成经下方 rates 缩放由 worker 目标函数自动吃到）；展示侧按真实加成率重算。
  // RNG 闸门：weightMul 仅 readWeightMul() 非 null（非全 1/非回退/合法）时进入本块；全 1 时整段不执行，
  // 原值原样流转（禁止浮点重算路径，避免污染哈希种子改变 RNG 序列）。
  const weightMul = readWeightMul();
  if(weightMul){
    // 同一次循环双层同步改写：placement.value 是独立标量拷贝，不会自动跟随 item.value；
    // worker baseScore 吃 placement.value，SA 经 serialItems 吃 item.value，两层必须同值；
    // 禁止对两层分别调用 scoreWeightedTotal（同一标量只算一次）。skipped 项不改（items 仅含 prepared）。
    items.forEach(t=>{
      const wv = scoreWeightedTotal(t.stats, weightMul);
      t.value = wv;
      for(const p of t.placements) p.value = wv;
    });
    // 加成加权：rates 随权重缩放（rates 为 items 与 placements 共享引用，一次覆盖；仅 prepared
    // 副本受影响，inventory 原始对象不动，同聚焦置零先例）。组合语义：聚焦置零在前、缩放在后，
    // 非聚焦属性先置 0 再缩放仍为 0。缩放后 pairBonusTable 的加成项
    // 自动成为 Σ bonus_k×w_k，worker 零改动。权重向量短于属性数时缺位按 0（该属性加成不计价）。
    items.forEach(t=>{ t.rates.forEach((_,k)=>{ const w = weightMul[k]; t.rates[k] *= Number.isFinite(w) ? w : 0; }); });
  }
  const {lo:activeLo, hi:activeHi, count:activeCells} = buildActiveMask();
  if(activeCells===0){ alert('请至少选择一个已解锁空间格。'); return; }
  if(inventory.length===0){ alert('请先从法宝库添加已有法宝。'); return; }
  if(items.length===0){ alert('已有物品都无法放入当前空间。请调整空间、旋转/镜像设置或物品清单。'); return; }
  const searchMode=document.getElementById('searchMode').value;
  // 求解引擎统一为 SA（老 DFS 引擎已退役并删除）；fast 档同样走 SA（仅节点/时间上限被收紧，见 engOrchCreateWorkers）。
  const requestedNodeLimit = Math.max(1000, Number(document.getElementById('nodeLimit').value)||2500000);
  const requestedTimeLimit = Math.max(100, Number(document.getElementById('timeLimit').value)||20000);
  const nodeLimit=searchMode==='fast'?Math.min(requestedNodeLimit,350000):requestedNodeLimit;
  const timeLimit=searchMode==='fast'?Math.min(requestedTimeLimit,3000):requestedTimeLimit;
  const useBonus = document.getElementById('useAdjacencyBonus').checked;
  const parallel=document.getElementById('parallelSearch').checked;
  const workerLimit=getParallelWorkerLimit();
  // 生效值可见（任务 7）：钳制规则本身不变，记录原始请求值供 statusBox 提示实际生效值。
  const requestedWorkerCount=Math.floor(Number(document.getElementById('workerCount').value)||2);
  const workerCount=parallel?Math.max(2,Math.min(workerLimit,requestedWorkerCount)):1;

  // placements.mask 自 prepareInventoryItems 起即为十进制串（旧版此处的 BigInt→String 转换已前移），
  // 浅拷贝仍保留：避免把加权缩放后的 prepared 副本引用直接交给 structured clone 之外的消费点。
  const serialItems = items.map(t=>({
    ...t,
    placements:t.placements.map(p=>({...p}))
  }));
  const totalSearchArea = inventory.reduce((sum,x)=>sum+(x.cells?.length||0),0);
  const totalSearchBase = inventory.reduce((sum,x)=>sum+Math.max(0,Number(x.value)||0),0);
  // Worker 启动负载：由 orchestrator 构建 SoA 模型与 init
  const workerPayload={
    items:serialItems,
    activeMask:maskToDec(activeLo, activeHi), activeCells, W, H, nodeLimit, timeLimit, useBonus,
    statKeys:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id),
    statCount:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).length,
    // rate-only 维起始下标：bonusStats 前 3 维（atk/def/hp）有基础值，其后 dmg/crit/heal/shield/drain
    // 为 rate-only 维（无基础值，不进 totalScore，仅驱动排序）。与 score-shared 默认 3 一致。
    rateOnlyFromK:ENGINE_RATE_ONLY_FROM_K,
    manualCount:manualPriorityLevels.length,
    defaultTierCount:DEFAULT_TIER_COUNT,
    requiredTotalItems:inventory.length,
    requiredTotalArea:totalSearchArea,
    requiredTotalBase:totalSearchBase,
    skippedCount:skipped.length
  };
  // 加成聚焦键仅聚焦非空时追加（只加法；未聚焦时 payload 逐字节不变）。
  if(focusAttr) workerPayload.focusAttr = focusAttr;
  solverWorkers=engOrchCreateWorkers({searchMode, workerCount, payload:workerPayload});
  solverWorker=solverWorkers[0];
  setSolverRunning(true);
  startSolverStatusHeartbeat(activeCells, inventory.length);
  // 生效值可见（任务 7）：未勾选并行时明确单 Worker；workerCount 被硬件上限钳制时显示实际值；fast 档 timeLimit 截断时显示实际生效值。
  const workerText=parallel ? (requestedWorkerCount>workerLimit ? `${workerCount} 个 Worker（请求 ${requestedWorkerCount}，受硬件上限钳制，实际 ${workerCount}）` : `${workerCount} 个 Worker`) : '单 Worker 运行（未勾选并行搜索）';
  const timeText=(searchMode==='fast' && requestedTimeLimit>3000) ? `${timeLimit} ms（快速档截断上限，请求 ${requestedTimeLimit} ms）` : `${timeLimit} ms`;
  // fast 档 nodeLimit 同样被截断（见上方钳制），仿 timeText 显示生效值与请求值。
  const nodeText=(searchMode==='fast' && requestedNodeLimit>350000) ? `${nodeLimit.toLocaleString('zh-CN')}（快速档截断上限，请求 ${requestedNodeLimit.toLocaleString('zh-CN')}）` : nodeLimit.toLocaleString('zh-CN');
  document.getElementById('statusBox').textContent = `正在后台搜索（${searchMode==='fast'?'快速':'深度'}档，${workerText}）…
物品总占格：${totalSearchArea}，可用空间：${activeCells}
${skipped.length>0?'存在单件无法合法放置的物品，将直接搜索最佳可行子集。':(totalSearchArea<=activeCells?'先寻找全部物品的完整摆法，再按实际总属性与邻接顺序优化。':'物品总面积超过空间，将按实际总属性与邻接顺序搜索最佳可行子集。')}
节点上限：${nodeText}
时间上限：${timeText}
自定义邻接优先物品：${manualItems.length} 件
求解起点：从已有物品清单自动生成
${focusAttr ? `优化目标：${statName(focusAttr)}加成最大化（忽略其它属性加成）\n` : ''}
${weightMul ? `属性权重：${formatWeightVector(weightMul)}（搜索目标 total = Σ base_k×w_k + Σ bonus_k×w_k，w=0 属性不计价、基础全零按 0.01 保底；横幅与分项呈实际总属性 = Σ真实基础 + Σ真实加成，搜索目标仅用于导向搜索）\n` : ''}
状态区会每 500 ms 更新计时；求解器阶段、节点和最好评分在收到新进度时同步更新。
页面仍可正常操作；需要中止时点击“停止计算”。`;

  let completedWorkers=0, totalNodes=0, globalBest=null, winningMessage=null;
  const doneWorkers=new Set(); // 已 done 的 Worker 集合（看门狗只对未完成者补发终态）
  let watchdogTimer=null;
  // incumbent 实时渲染节流：≥200ms 才允许一次 renderStats 全量刷新，防多 Worker 高频晋升 DOM 过载；
  // 终态 finishWorker 不受节流约束，保证最终横幅/分项必为真实口径。
  let lastLiveStatsRender = 0;
  const wallStarted=performance.now();
  const finishWorker=function(worker,msg){
    // 幂等守卫：看门狗合成终态与在途真实 done 存在竞态（真实 done 已入队时看门狗先到），
    // 按 worker 引用去重，终态流程只执行一次；正常单次 done 路径行为不变。
    if(doneWorkers.has(worker)) return;
    doneWorkers.add(worker);
    completedWorkers++;
    totalNodes+=Number(msg.nodes)||0;
    const comparison=compareSolverBest(msg.best,globalBest);
    if(comparison>0) globalBest=msg.best;
    if(comparison>=0 || !winningMessage) winningMessage=msg;
    const url=worker._blobUrl; worker.terminate(); if(url) URL.revokeObjectURL(url);
    if(completedWorkers<workerCount) return;
    if(watchdogTimer){ clearTimeout(watchdogTimer); watchdogTimer=null; }
    const best=globalBest, meta=winningMessage;
    // 属性权重终态真实覆盖（任务 #62）：worker 侧基础是加权 Σvalue、加成是 rates 缩放后的
    // Σ bonus_k×w_k 口径，此处统一覆盖为实际总属性（ΣtrueBase + ΣtrueBonus，横幅/分解行/分项表
    // 同一口径）。比较链已结束，就地覆盖安全；lastResult 仍在此后一次性赋值（实时指针语义不变）。
    // 未勾选百分比加成时仅覆盖基础分项与总分（加成恒 0），默认口径 weightMul 为 null 整段不执行。
    if(weightMul) Object.assign(best, withTrueStatsForDisplay(best, useBonus));
    lastResult = {
      best, nodes:totalNodes, elapsed:Math.round(performance.now()-wallStarted), stopped:meta.stopped, width:W, height:H, active:active.map(r=>r.slice()),
      inventory:inventory.map(x=>({...x,cells:cloneCells(x.cells)})),
      settings:{useAdjacencyBonus:useBonus,searchMode,parallelSearch:parallel,workerCount,optimizationOrder:['complete_loading','actual_total_score','manual_priority_neighbors','default_priority_neighbors','no_base_bonus_hits','same_attr_adjacency','damage_bond','total_adjacency_count'],statKeys:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>({id:s.id,name:s.name})),manualPriorityRule:'1 is highest; blank uses default rules',assignmentStrategy:'geometry_then_item_assignment',focusAttr},
      skipped:skipped.map(x=>({no:x.no,name:x.name,area:x.area,value:x.value})),manualItems,
      solverMeta:{fullPackingAttempted:meta.fullPackingAttempted,fullPackingFound:meta.fullPackingFound,fullSearchCutoff:meta.fullSearchCutoff,optimizationCutoff:meta.optimizationCutoff,fallbackCutoff:meta.fallbackCutoff,totalArea:meta.totalArea,totalBase:meta.totalBase,totalItems:meta.totalItems,fullGroupCount:meta.fullGroupCount,detailedGroupCount:meta.detailedGroupCount,assignmentStrategy:meta.assignmentStrategy,singletonDeferredCount:meta.singletonDeferredCount,assignmentChecks:meta.assignmentChecks,workerCount,engine:meta.engine||'sa'}
    };
    solverWorkers=[]; solverWorker=null; stopSolverStatusHeartbeat(); setSolverRunning(false);
    // 属性权重键仅权重激活时追加（只加法；默认全 1 时不出现，同 focusAttr 条件追加先例）。
    if(weightMul) lastResult.settings.weightMul = weightMul;
    renderResultGrid(best);
    renderStats(best,totalNodes,lastResult.elapsed,meta.stopped,activeCells,skipped,lastResult.solverMeta);
    // 非聚焦权重会话：摆放清单率文本按真实 rates 重组（冻结 renderStats 直吃缩放 rates）。
    // 聚焦分支由 ui-focus.js 锚点重组覆盖（含权重组合），此处 !focusAttr 守卫两分支互斥；
    // 默认口径 weightMul 为 null 不执行，statusBox 输出逐字不变。useBonus 未勾选时 rates
    // 同样已被缩放（无事件但清单率文本仍失真），故不附加 useBonus 条件。
    if(weightMul && !focusAttr) rebuildTruePlacementList(best);
    // SA 终态摘要（期 3）：renderStats 冻结不可改，此处条件追加。仅 SA 参与过的会话
    // engOrchSaSummary 返回非 null；无会话恒 null，statusBox 输出逐字不变。
    const saSummary = (typeof engOrchSaSummary === 'function') ? engOrchSaSummary() : null;
    if(saSummary){
      const top3 = Array.isArray(saSummary.opTop3) ? saSummary.opTop3.map(o => `${o.name}(${Number(o.w || 0).toFixed(2)})`).join('、') : '-';
      // 回火态三态渲染（SAB 直连 / broker / 未启用），不再对单 SA 谎报回火通道
      const temperingText = saSummary.tempering ? (saSummary.sabMode ? '（SAB 直连回火通道）' : '（主线程 broker 回火）') : '（未启用回火（单 SA））';
      const composeText = `${saSummary.workerCount} SA`;
      document.getElementById('statusBox').textContent += `\n\n模拟退火（SA）摘要：${composeText} Worker 参与${temperingText}
末次温度：${Number(saSummary.temp ?? 0).toPrecision(4)}，末次接受率：${((Number(saSummary.acceptRate) || 0) * 100).toFixed(1)}%，迭代速率：${((Number(saSummary.itersPerSec) || 0) / 10000).toFixed(1)} 万/秒，重热次数：${Number(saSummary.restarts) || 0}
算子权重 Top3：${top3}（lnsSmall/lnsBig 默认关闭，权重非零不代表已执行）`;
    }
    // 属性权重终态口径行（仅非聚焦分支）：聚焦分支的权重行由 ui-focus.js 在锚点重组后写入，
    // 两分支互斥不得双写（重组只保留特定 suffix，重组前写入的尾行会被吞掉）。
    if(weightMul && !focusAttr){
      document.getElementById('statusBox').textContent += `\n\n属性权重口径：权重向量 [${formatWeightVector(weightMul)}]；搜索目标 total = Σ base_k × w_k + Σ bonus_k × w_k（w=0 属性不计价；基础全零时按 0.01 保底）；横幅与分项呈实际总属性（Σ真实基础 + Σ真实加成），搜索目标仅用于导向搜索。`;
    }
  };
  // 会话级硬看门狗（任务 7）：会话上限 = timeLimit + polish 预算（与 engine-worker.js
  // ewFinishPolish 同式：Math.min(3000, Math.max(500, timeLimit*0.25))，两处须同步不得漂移）
  // + 3000ms 裕量（覆盖消息收尾），保证 T≥100ms 全档位下看门狗 > SA 最坏结束时间。
  // 到点 terminate 未 done 的 Worker，保留已有
  // incumbent，走正常终态汇总流程（finishWorker 补齐计数）。会话快照绑定：solverWorkers 在终态/
  // 取消/新会话会被重新赋值，仅当仍等于本会话数组时才触发，避免误伤后续新会话；用户取消
  // （cleanupSolverWorker 置 solverWorker=null）后自动失效。
  const sessionWorkers=solverWorkers;
  watchdogTimer=setTimeout(function(){
    if(!solverWorker || solverWorkers!==sessionWorkers) return;
    // 从未收到任何 incumbent 时构造空解兼兼容后续渲染/真实重算路径（形状同初始 best）。
    const emptyBest={
      complete:false, baseScore:-1, bonusScore:0, totalScore:-1, area:0, itemCount:0, adjacencyCount:0,
      manualPriorityVector:new Array(manualPriorityLevels.length).fill(0), defaultPriorityVector:new Array(DEFAULT_TIER_COUNT).fill(0),
      placements:[], occupied:'0', bonusEvents:[], priorityLinks:[],
      sameAdjCount:0, noBaseHitCount:0,
      statKeys:(window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id)
    };
    for(const w of solverWorkers.slice()){
      if(doneWorkers.has(w)) continue;
      // best 传 null：globalBest 已有 incumbent 时 compareSolverBest(null,·)=-1，不覆盖不降级 winningMessage；
      // 无 incumbent 时传空解兼兼容终态流程。
      finishWorker(w, {type:'done', best:globalBest ? null : emptyBest, nodes:0, elapsed:Math.round(performance.now()-wallStarted), stopped:true,
        fullPackingAttempted:true, fullPackingFound:!!(globalBest && globalBest.complete),
        fullSearchCutoff:true, optimizationCutoff:false, fallbackCutoff:false,
        totalArea:totalSearchArea, totalBase:totalSearchBase, totalItems:inventory.length});
    }
    document.getElementById('statusBox').textContent += '\n\n达到时间上限提前结束：主线程看门狗已终止未完成 Worker，保留当前最好方案。';
  }, timeLimit + Math.min(3000, Math.max(500, timeLimit * 0.25)) + 3000);

  solverWorkers.forEach((worker,workerIndex)=>{ worker.onmessage = function(ev){
    let msg = ev.data;
    // 新引擎消息接入：进入现有分支前完成契约转换（现有分支逻辑零改动）
    if(msg.type === 'swap-req'){ engOrchHandleSwapReq(worker, msg); return; }
    if(msg.type === 'incumbent-lite'){ const rebuilt = engOrchConvertIncumbentLite(worker, msg); if(!rebuilt) return; msg = rebuilt; }
    if(msg.type === 'progress'){
      engOrchNoteProgress(worker, msg);
      updateSolverStatusFromMessage({...msg,nodes:totalNodes+(Number(msg.nodes)||0),stage:`Worker ${workerIndex+1}/${workerCount}：${msg.stage||'搜索中'}`},activeCells);
      return;
    }
    if(msg.type === 'incumbent'){
      if(compareSolverBest(msg.best,globalBest)>0){
        globalBest=msg.best; renderResultGrid(msg.best);
        // 实时真实渲染（节流 ≥200ms）：incumbent 晋升即刷新「实际总属性」横幅与分项统计。
        // SA orchestrator（incumbent-lite→incumbent）单点覆盖。
        // 权重口径：对浅拷贝覆盖真实重算字段（msg.best 原件保持加权口径，继续参与后续比较）；
        // 未勾选百分比加成时同走覆盖（仅基础分项），默认口径（weightMul null）worker 值即真实值，
        // 直接渲染无需重算。renderStats 走现有
        // 装饰链（ui-focus 聚焦重算 / ui-stash 自动退出重放包装，均为既有行为）。终态由
        // finishWorker 兜底覆盖，节流跳过的中间帧不影响最终展示。
        const nowLive=performance.now();
        if(nowLive-lastLiveStatsRender>=200){
          lastLiveStatsRender=nowLive;
          const shown=weightMul ? Object.assign({}, msg.best, withTrueStatsForDisplay(msg.best, useBonus)) : msg.best;
          renderStats(shown, totalNodes+(Number(msg.nodes)||0), Number(msg.elapsed)||0, false, activeCells, skipped, {totalArea:msg.totalArea, totalItems:msg.totalItems, fullPackingFound:!!msg.fullPackingFound});
          // 实时路径同口径：摆放清单率文本同样直吃缩放 rates，与终态同一重组函数处理。
          if(weightMul && !focusAttr) rebuildTruePlacementList(shown);
        }
      }
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
    if(msg.type === 'done') msg = engOrchConvertDone(worker, msg) || msg;
    if(msg.type !== 'done') return;
    finishWorker(worker,msg);
  };
  worker.onerror = function(err){
    const message = err && err.message ? err.message : '未知错误';
    cleanupSolverWorker();
    document.getElementById('statusBox').textContent = `计算失败：${message}`;
  };
  // SA Worker 已在创建时由 orchestrator 发送 init 负载，无需再发启动消息
  });
}


