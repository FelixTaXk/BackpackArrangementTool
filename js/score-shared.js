'use strict';
// ============================================================================
// score-shared.js —— “超越版求解引擎”评分纯函数层（期 1 基础层）
// ----------------------------------------------------------------------------
// 约定：
//   1. 经典 script：全部为顶层纯函数，挂 window 全局（node 下用 typeof window 守卫），
//      无 DOM / 无全局状态依赖；后续会用 Function.toString() 拼装进 Blob Worker。
//   2. 热路径禁用 BigInt：位板掩码一律使用双 Uint32 数值对 {lo,hi}（低 32 位 / 高位），
//      42 位以内的板面（W*H<=42）序列化时用 String(hi*4294967296+lo) 精确转十进制。
//   3. 评分语义与旧版 js/solver-worker.js 逐字一致：
//      - provider：提升相邻法宝，bonus = Σ 目标.stats[k] × 源.rates[k]/100
//      - self：提升自己，bonus = Σ 自身.stats[k] × 自身.rates[k]/100（每相邻一个不同法宝一次）
//      - 事件 kind：single_provider / self_neighbor（含 statBreakdown）
//      - 优先级权重：手动 1e8×max(1,len-i)，默认 1e5×max(1,len-i)
// ============================================================================

// Σ stats[k] × rates[k]/100（对齐旧 sumRatesProduct，statCount 取向量长度）
function scoreSumRatesProduct(sv, rv){
  let s = 0;
  const n = sv.length;
  for(let k = 0; k < n; k++) s += sv[k] * (rv[k] || 0) / 100;
  return s;
}

// 双 Uint32 几何相邻判定：a 的外圈邻居掩码与 b 的占用掩码双向 OR（对齐旧 areAdjacent）
function scoreAreAdjacent(aLo, aHi, bNbrLo, bNbrHi){
  return ((aLo & bNbrLo) | (aHi & bNbrHi)) !== 0;
}

// 规范化评分视图：为携带 stats/rates 原始数组的摆放项补齐 sv/rv 与 lo/hi/nbrLo/nbrHi。
// 已携带对应字段的对象按原样返回，不做任何修改（纯函数）。
function scoreViewOf(p){
  if(p.sv && p.rv && p.lo !== undefined && p.nbrLo !== undefined) return p;
  const cleanVec = v => Array.isArray(v) ? v.map(x=>{ const n = Number(x); return Number.isFinite(n) && n > 0 ? n : 0; }) : [];
  return Object.assign(Object.create(null), p, {
    sv: p.sv || cleanVec(p.stats),
    rv: p.rv || cleanVec(p.rates),
    lo: p.lo !== undefined ? p.lo : (p.mask ? (p.mask.lo|0) : 0),
    hi: p.hi !== undefined ? p.hi : (p.mask ? (p.mask.hi|0) : 0),
    nbrLo: p.nbrLo !== undefined ? p.nbrLo : (p.neighborMask ? (p.neighborMask.lo|0) : 0),
    nbrHi: p.nbrHi !== undefined ? p.nbrHi : (p.neighborMask ? (p.neighborMask.hi|0) : 0)
  });
}

// 相邻两法宝产生的加成事件数组（对齐旧 pairBonusEvents，字段逐字一致；四处 push 均带 bonus>0 守卫）
function scorePairBonusEvents(a, b){
  // 守卫：未携带 sv/rv 的原始几何模板跳过而非崩溃（空数组是合法向量，用 == null 判定）。
  if(a.sv == null || a.rv == null || b.sv == null || b.rv == null) return [];
  if(!scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) return [];
  const events = [];
  const aStats = a.sv, aRates = a.rv, bStats = b.sv, bRates = b.rv;
  // provider：提升相邻法宝
  if(a.bonusKind === 'provider'){
    const bonus = scoreSumRatesProduct(bStats, aRates);
    if(bonus > 0) events.push({kind:'single_provider', source:a.no, sourceName:a.itemName, target:b.no, targetName:b.itemName, base:b.value, bonus, statBreakdown:bStats.map((v,k)=>v*aRates[k]/100)});
  }
  if(b.bonusKind === 'provider'){
    const bonus = scoreSumRatesProduct(aStats, bRates);
    if(bonus > 0) events.push({kind:'single_provider', source:b.no, sourceName:b.itemName, target:a.no, targetName:a.itemName, base:a.value, bonus, statBreakdown:aStats.map((v,k)=>v*bRates[k]/100)});
  }
  // self：提升自己（每相邻一个不同法宝一次）
  if(a.bonusKind === 'self'){
    const bonus = scoreSumRatesProduct(aStats, aRates);
    if(bonus > 0) events.push({kind:'self_neighbor', source:a.no, sourceName:a.itemName, target:a.no, targetName:a.itemName, neighbor:b.no, neighborName:b.itemName, base:a.value, bonus, statBreakdown:aStats.map((v,k)=>v*aRates[k]/100)});
  }
  if(b.bonusKind === 'self'){
    const bonus = scoreSumRatesProduct(bStats, bRates);
    if(bonus > 0) events.push({kind:'self_neighbor', source:b.no, sourceName:b.itemName, target:b.no, targetName:b.itemName, neighbor:a.no, neighborName:a.itemName, base:b.value, bonus, statBreakdown:bStats.map((v,k)=>v*bRates[k]/100)});
  }
  return events;
}

// 无序物品对的潜在加成上限（不做相邻检查，对齐旧 potentialPairBonus）
function scorePotentialPairBonus(a, b){
  if(a.sv == null || a.rv == null || b.sv == null || b.rv == null) return 0;
  let bonus = 0;
  const aStats = a.sv, aRates = a.rv, bStats = b.sv, bRates = b.rv;
  if(a.bonusKind === 'provider') bonus += scoreSumRatesProduct(bStats, aRates);
  if(b.bonusKind === 'provider') bonus += scoreSumRatesProduct(aStats, bRates);
  if(a.bonusKind === 'self') bonus += scoreSumRatesProduct(aStats, aRates);
  if(b.bonusKind === 'self') bonus += scoreSumRatesProduct(bStats, bRates);
  return bonus;
}

// 单个目标的优先级增益（对齐旧 targetPriorityGain，原地累计进向量并记录 link）
function scoreTargetPriorityGain(target, neighbor, manualVector, defaultVector, links){
  if(target.manualOrder >= 0){
    manualVector[target.manualOrder]++;
    links.push({mode:'custom', target:target.no, targetName:target.itemName, neighbor:neighbor.no, neighborName:neighbor.itemName, manualOrder:target.manualOrder, customPriority:target.customPriority});
  }else if(target.priorityTier >= 0){
    defaultVector[target.priorityTier]++;
    links.push({mode:'default', target:target.no, targetName:target.itemName, neighbor:neighbor.no, neighborName:neighbor.itemName, tier:target.priorityTier});
  }
}

// 摆放 p 相对已放置集合 placed 的优先级增益（对齐旧 priorityGainFor，权重公式一致）
function scorePriorityGainFor(p, placed, manualCount, defaultTierCount){
  const manualVector = new Array(manualCount).fill(0);
  const defaultVector = new Array(defaultTierCount).fill(0);
  const links = [];
  const pv = scoreViewOf(p);
  for(const oldRaw of placed){
    const old = scoreViewOf(oldRaw);
    if(!scoreAreAdjacent(pv.nbrLo, pv.nbrHi, old.lo, old.hi)) continue;
    scoreTargetPriorityGain(pv, old, manualVector, defaultVector, links);
    scoreTargetPriorityGain(old, pv, manualVector, defaultVector, links);
  }
  let weighted = 0;
  for(let i = 0; i < manualVector.length; i++) weighted += manualVector[i] * Math.max(1, manualVector.length - i) * 100000000;
  for(let i = 0; i < defaultVector.length; i++) weighted += defaultVector[i] * Math.max(1, defaultVector.length - i) * 100000;
  return {manualVector, defaultVector, links, weighted};
}

// 向量字典序比较（对齐旧 compareVectors）
function scoreCompareVectors(a, b){
  const n = Math.max(a.length, b.length);
  for(let i = 0; i < n; i++){
    const d = (a[i] || 0) - (b[i] || 0);
    if(d !== 0) return d;
  }
  return 0;
}

// 具体摆放全量评估（对齐旧 evaluateConcrete；occupied 用 {lo,hi} 数值对代替 BigInt）
// ctx = {statCount, useBonus, manualCount, defaultTierCount, totalItems(可选，默认 placements.length)}
function scoreEvaluateConcrete(placements, ctx){
  const useBonus = !!ctx.useBonus;
  const manualCount = Number(ctx.manualCount) || 0;
  const defaultTierCount = Number(ctx.defaultTierCount) || 0;
  const totalItems = Number.isFinite(Number(ctx.totalItems)) && Number(ctx.totalItems) >= 0 ? Number(ctx.totalItems) : placements.length;
  let baseScore = 0, area = 0, adjacencyCount = 0;
  let occLo = 0, occHi = 0;
  const manualVector = new Array(manualCount).fill(0);
  const defaultVector = new Array(defaultTierCount).fill(0);
  const bonusEvents = [], priorityLinks = [];
  let bonusScore = 0;
  const views = placements.map(scoreViewOf);
  for(const p of views){ baseScore += p.value; area += p.area; occLo = (occLo | p.lo) >>> 0; occHi = (occHi | p.hi) >>> 0; }
  for(let i = 0; i < views.length; i++) for(let j = i + 1; j < views.length; j++){
    const a = views[i], b = views[j];
    if(!scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) continue;
    adjacencyCount++;
    scoreTargetPriorityGain(a, b, manualVector, defaultVector, priorityLinks);
    scoreTargetPriorityGain(b, a, manualVector, defaultVector, priorityLinks);
    if(useBonus){
      for(const e of scorePairBonusEvents(a, b)){ bonusScore += e.bonus; bonusEvents.push(e); }
    }
  }
  return {
    complete: placements.length === totalItems,
    baseScore, bonusScore, totalScore: baseScore + bonusScore, area,
    itemCount: placements.length, adjacencyCount,
    manualPriorityVector: manualVector, defaultPriorityVector: defaultVector,
    placements: placements.slice(), occupied: {lo: occLo, hi: occHi},
    bonusEvents, priorityLinks
  };
}

// 结果对象字典序比较（对齐旧 compareEvaluationObjects，EPS=1e-9）
function scoreCompareEvaluationObjects(a, b){
  const EPS = 1e-9;
  const ac = !!a.complete, bc = !!b.complete;
  if(ac !== bc) return ac ? 1 : -1;
  if(Math.abs(a.totalScore - b.totalScore) > EPS) return a.totalScore > b.totalScore ? 1 : -1;
  const mc = scoreCompareVectors(a.manualPriorityVector, b.manualPriorityVector); if(mc !== 0) return mc;
  const dc = scoreCompareVectors(a.defaultPriorityVector, b.defaultPriorityVector); if(dc !== 0) return dc;
  if((a.adjacencyCount || 0) !== (b.adjacencyCount || 0)) return (a.adjacencyCount || 0) > (b.adjacencyCount || 0) ? 1 : -1;
  if(a.itemCount !== b.itemCount) return a.itemCount > b.itemCount ? 1 : -1;
  if(a.area !== b.area) return a.area > b.area ? 1 : -1;
  if(Math.abs(a.baseScore - b.baseScore) > EPS) return a.baseScore > b.baseScore ? 1 : -1;
  if(Math.abs(a.bonusScore - b.bonusScore) > EPS) return a.bonusScore > b.bonusScore ? 1 : -1;
  return 0;
}

// 统计总量（对齐旧 buildStatTotals）：base=Σ摆放 stats，bonus=Σ事件 statBreakdown，total=base+bonus
function scoreBuildStatTotals(best, statCount){
  const base = new Array(statCount).fill(0);
  const bonus = new Array(statCount).fill(0);
  const vec = v => { const out = new Array(statCount).fill(0); if(Array.isArray(v)){ for(let k = 0; k < statCount; k++){ const x = Number(v[k]); out[k] = Number.isFinite(x) && x > 0 ? x : 0; } } return out; };
  for(const p of best.placements){ const s = vec(p.stats); for(let k = 0; k < statCount; k++) base[k] += s[k]; }
  for(const e of best.bonusEvents){ for(let k = 0; k < statCount; k++) bonus[k] += (e.statBreakdown && e.statBreakdown[k]) || 0; }
  const total = base.map((v, k) => v + bonus[k]);
  return {base, bonus, total};
}

// 掩码数值对 → 十进制字符串（42 位内 Number 精确：hi*4294967296+lo）
function scoreMaskToDec(m){
  const lo = Number(m.lo) || 0, hi = Number(m.hi) || 0;
  return String(hi * 4294967296 + lo);
}

// ----------------------------------------------------------------------------
// 属性权重（一期线性）：权重只作用于基础属性计价，加成按原价（bonus 项由调用方在外层按原值累加）。
// ----------------------------------------------------------------------------

// 有效权重：w>0 取 w；w=0/非法保底 0.01。
function scoreEffectiveWeight(w){
  return Number.isFinite(w) && w > 0 ? w : 0.01;
}

// 加权计价合计：Σ max(0, stats_k) × w_k（w>0 取原值；w=0/非法该项归零，即“0 权重属性不计价”），
// 合计为 0 时按保底权重 0.01 逐项重计（“0 按 0.01 保底”为整体兜底语义，防全零权重计价退化），
// 求和后一位小数舍入（对齐 talisman-model.js 星级舍入 Math.round(x*10)/10 先例）。
// stats/weights 非数组防御返回 0。
function scoreWeightedTotal(stats, weights){
  if(!Array.isArray(stats) || !Array.isArray(weights)) return 0;
  let s = 0;
  for(let k = 0; k < stats.length; k++){
    const w = weights[k];
    if(Number.isFinite(w) && w > 0) s += Math.max(0, Number(stats[k]) || 0) * w;
  }
  if(s === 0){
    for(let k = 0; k < stats.length; k++) s += Math.max(0, Number(stats[k]) || 0) * scoreEffectiveWeight(0);
  }
  return Math.round(s * 10) / 10;
}

// 序列化最好结果（对齐旧 serializeBest，键集完全一致；occupied/mask/neighborMask 转十进制字符串）
function scoreSerializeBest(best, statKeys, statCount){
  return {
    ...best,
    occupied: scoreMaskToDec(best.occupied),
    statKeys: statKeys || [],
    statTotals: scoreBuildStatTotals(best, statCount),
    placements: best.placements.map(p => ({
      ...p,
      mask: scoreMaskToDec(p.mask),
      neighborMask: scoreMaskToDec(p.neighborMask)
    }))
  };
}

// ----------------------------------------------------------------------------
// 自测：手工构造小布局的黄金断言。node 与浏览器均可跑（typeof window 守卫）。
// 返回 {pass, failures[]}。
// ----------------------------------------------------------------------------
function __SCORE_SELFTEST__(){
  const failures = [];
  function assert(cond, name){ if(!cond) failures.push(name); }
  function close(x, y){ return Math.abs(x - y) < 1e-9; }

  // 布局 1：provider + 普通目标相邻（3 属性向量）
  // A：provider，rates=[10,20,0]，占格 bit0（lo=1）；邻居外圈 bit1（lo=2）
  // B：none，stats=[100,50,10]，value=12，占格 bit1（lo=2）
  const a1 = {no:1, itemName:'甲', value:5, area:1, bonusKind:'provider',
    stats:[0,0,0], rates:[10,20,0], sv:[0,0,0], rv:[10,20,0],
    lo:1, hi:0, nbrLo:2, nbrHi:0, mask:{lo:1,hi:0}, neighborMask:{lo:2,hi:0},
    manualOrder:-1, priorityTier:-1, customPriority:null};
  const b1 = {no:2, itemName:'乙', value:12, area:1, bonusKind:'none',
    stats:[100,50,10], rates:[0,0,0], sv:[100,50,10], rv:[0,0,0],
    lo:2, hi:0, nbrLo:1, nbrHi:0, mask:{lo:2,hi:0}, neighborMask:{lo:1,hi:0},
    manualOrder:-1, priorityTier:-1, customPriority:null};
  const ev1 = scorePairBonusEvents(a1, b1);
  assert(ev1.length === 1, '布局1：应恰好 1 个事件');
  assert(ev1[0] && ev1[0].kind === 'single_provider', '布局1：事件 kind 为 single_provider');
  assert(ev1[0] && close(ev1[0].bonus, 20), '布局1：bonus=100×10/100=10 + 50×20/100=10 → 20');
  assert(ev1[0] && ev1[0].source === 1 && ev1[0].target === 2 && ev1[0].base === 12, '布局1：source/target/base 字段');
  assert(ev1[0] && close(ev1[0].statBreakdown[0], 10) && close(ev1[0].statBreakdown[1], 10) && close(ev1[0].statBreakdown[2], 0), '布局1：statBreakdown 分项');

  // 布局 2：不相邻 → 无事件；potential 与相邻无关
  const c2 = {no:3, itemName:'丙', value:3, area:1, bonusKind:'provider',
    stats:[4,0,0], rates:[10,0,0], sv:[4,0,0], rv:[10,0,0],
    lo:4, hi:0, nbrLo:8, nbrHi:0, mask:{lo:4,hi:0}, neighborMask:{lo:8,hi:0},
    manualOrder:-1, priorityTier:-1, customPriority:null};
  assert(scorePairBonusEvents(a1, c2).length === 0, '布局2：不相邻不产生事件');
  assert(close(scorePotentialPairBonus(a1, c2), 0.4), '布局2：potential=4×10/100=0.4 与相邻无关');

  // 布局 3：self 相邻（每相邻一次触发一次）+ 手动优先级 manualOrder
  // D：self，stats=[200,0,0]，rates=[5,0,0] → bonus=200×5/100=10；manualOrder=0
  const d3 = {no:4, itemName:'丁', value:8, area:1, bonusKind:'self',
    stats:[200,0,0], rates:[5,0,0], sv:[200,0,0], rv:[5,0,0],
    lo:2, hi:0, nbrLo:5, nbrHi:0, mask:{lo:2,hi:0}, neighborMask:{lo:5,hi:0},
    manualOrder:0, priorityTier:-1, customPriority:'贴边'};
  const ev3 = scorePairBonusEvents(d3, a1);
  // a1 是 provider → 对 d3 产生 single_provider（200×10/100=20）；d3 是 self → self_neighbor（10）
  assert(ev3.length === 2, '布局3：provider+self 共 2 个事件');
  const selfEv = ev3.find(e => e.kind === 'self_neighbor');
  assert(!!selfEv, '布局3：含 self_neighbor 事件');
  assert(selfEv && close(selfEv.bonus, 10) && selfEv.neighbor === 1 && selfEv.target === 4, '布局3：self bonus/neighbor/target 字段');
  const g3 = scorePriorityGainFor(d3, [a1], 2, 3);
  // a1 无优先级；d3 manualOrder=0：old→p 方向计一次
  assert(g3.manualVector[0] === 1 && g3.manualVector[1] === 0, '布局3：manualVector=[1,0]');
  assert(g3.weighted === 1 * Math.max(1, 2 - 0) * 100000000, '布局3：weighted=1×2×1e8');
  assert(g3.links.length === 1 && g3.links[0].mode === 'custom' && g3.links[0].manualOrder === 0 && g3.links[0].customPriority === '贴边', '布局3：custom link 字段');

  // 布局 4：默认优先级 priorityTier 双向
  // E：priorityTier=1（占 bit2），F：priorityTier=0（占 bit3），E/F 相邻
  const e4 = {no:5, itemName:'戊', value:1, area:1, bonusKind:'none',
    stats:[0,0,0], rates:[0,0,0], sv:[0,0,0], rv:[0,0,0],
    lo:4, hi:0, nbrLo:8, nbrHi:0, mask:{lo:4,hi:0}, neighborMask:{lo:10,hi:0},
    manualOrder:-1, priorityTier:1, customPriority:null};
  const f4 = {no:6, itemName:'己', value:1, area:1, bonusKind:'none',
    stats:[0,0,0], rates:[0,0,0], sv:[0,0,0], rv:[0,0,0],
    lo:8, hi:0, nbrLo:4, nbrHi:0, mask:{lo:8,hi:0}, neighborMask:{lo:12,hi:0},
    manualOrder:-1, priorityTier:0, customPriority:null};
  const g4 = scorePriorityGainFor(e4, [f4], 0, 3);
  // 双向：e4(tier1) 一次 + f4(tier0) 一次 → defaultVector=[1,1,0]
  assert(g4.defaultVector[0] === 1 && g4.defaultVector[1] === 1 && g4.defaultVector[2] === 0, '布局4：defaultVector=[1,1,0]');
  assert(g4.weighted === 1 * 3 * 100000 + 1 * 2 * 100000, '布局4：weighted=3e5+2e5');
  assert(g4.links.every(l => l.mode === 'default'), '布局4：links 均为 default');

  // 布局 5：evaluateConcrete 混合评估（provider+self+none，含 manualOrder/priorityTier）
  // 三件相邻排成链：a1(bit0) - b1(bit1) - d3(bit2)
  const b5 = Object.assign(Object.create(null), b1, {nbrLo: 1 | 4, nbrHi: 0});
  const d5 = Object.assign(Object.create(null), d3, {lo: 4, hi: 0, nbrLo: 2, nbrHi: 0, mask: {lo:4, hi:0}, neighborMask: {lo:2, hi:0}});
  const best5 = scoreEvaluateConcrete([a1, b5, d5], {statCount:3, useBonus:true, manualCount:2, defaultTierCount:3, totalItems:3});
  assert(best5.complete === true, '布局5：3/3 件 complete');
  assert(close(best5.baseScore, 5 + 12 + 8), '布局5：baseScore=Σvalue=25');
  assert(best5.adjacencyCount === 2, '布局5：链式相邻 2 对');
  // bonus：a1→b1 提供 20；d3 与 b1 相邻 self +10；d3 与 a1 不相邻
  assert(close(best5.bonusScore, 30), '布局5：bonusScore=20+10=30');
  assert(best5.bonusEvents.length === 2, '布局5：2 个加成事件');
  assert(best5.occupied.lo === 7 && best5.occupied.hi === 0, '布局5：occupied=bit0|bit1|bit2=7');
  assert(best5.manualPriorityVector[0] === 1, '布局5：manualVector[0]=1（d3 与 b1 相邻）');
  // 序列化：键集对齐旧 serializeBest
  const ser5 = scoreSerializeBest(best5, ['atk','def','hp'], 3);
  assert(ser5.occupied === '7', '布局5：序列化 occupied 十进制串');
  assert(Array.isArray(ser5.statKeys) && ser5.statKeys.length === 3, '布局5：序列化 statKeys');
  assert(close(ser5.statTotals.base[0], 300) && close(ser5.statTotals.bonus[0], 10 + 10), '布局5：statTotals base/bonus 汇总');
  assert(ser5.placements.every(p => typeof p.mask === 'string' && typeof p.neighborMask === 'string'), '布局5：序列化 mask/neighborMask 为十进制字符串');
  assert(ser5.placements[2].mask === '4', '布局5：d3 mask 序列化为 "4"');
  // 比较函数字典序
  const worse = Object.assign(Object.create(null), best5, {totalScore: best5.totalScore - 1});
  assert(scoreCompareEvaluationObjects(best5, worse) === 1, '比较：totalScore 高者胜');
  const incomplete = Object.assign(Object.create(null), best5, {complete:false, totalScore: best5.totalScore + 999});
  assert(scoreCompareEvaluationObjects(best5, incomplete) === 1, '比较：complete 优先于 totalScore');

  // 布局 6：属性权重（一期线性）scoreEffectiveWeight / scoreWeightedTotal
  assert(scoreEffectiveWeight(0) === 0.01, '权重：eff(0)=0.01 保底');
  assert(scoreEffectiveWeight(3) === 3, '权重：eff(3)=3 原值');
  assert(scoreWeightedTotal([100,50,10],[3,0,0]) === 300, '权重：w=[3,0,0]→300');
  assert(scoreWeightedTotal([100,50,10],[0,3,3]) === 180, '权重：w=[0,3,3]→180');
  assert(scoreWeightedTotal([100,50,10],[0,0,0]) === 1.6, '权重：w=[0,0,0]→1.6（0 按 0.01 保底）');
  const wtRound = scoreWeightedTotal([13.3,0,0],[3,0,0]);
  assert(wtRound === 39.9 && String(wtRound) === '39.9', '权重：13.3×3=39.9 精确舍入（非 39.899999… 噪声）');
  const wtBase = scoreWeightedTotal([319,33,13835],[1,1,1]);
  assert(wtBase === 14187 && String(wtBase) === '14187', '权重：全 1 与手算 319+33+13835=14187 一致且串一致');
  assert(scoreWeightedTotal(null,[1,1,1]) === 0 && scoreWeightedTotal([1],'x') === 0, '权重：stats/weights 非数组防御返回 0');

  return {pass: failures.length === 0, failures};
}

if(typeof window !== 'undefined'){
  window.scoreSumRatesProduct = scoreSumRatesProduct;
  window.scoreAreAdjacent = scoreAreAdjacent;
  window.scoreViewOf = scoreViewOf;
  window.scorePairBonusEvents = scorePairBonusEvents;
  window.scorePotentialPairBonus = scorePotentialPairBonus;
  window.scoreTargetPriorityGain = scoreTargetPriorityGain;
  window.scorePriorityGainFor = scorePriorityGainFor;
  window.scoreCompareVectors = scoreCompareVectors;
  window.scoreEvaluateConcrete = scoreEvaluateConcrete;
  window.scoreCompareEvaluationObjects = scoreCompareEvaluationObjects;
  window.scoreBuildStatTotals = scoreBuildStatTotals;
  window.scoreMaskToDec = scoreMaskToDec;
  window.scoreSerializeBest = scoreSerializeBest;
  window.scoreEffectiveWeight = scoreEffectiveWeight;
  window.scoreWeightedTotal = scoreWeightedTotal;
  window.__SCORE_SELFTEST__ = __SCORE_SELFTEST__;
}
