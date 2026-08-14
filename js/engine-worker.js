'use strict';
// ============================================================================
// engine-worker.js —— “超越版求解引擎”SA+ALNS 求解 Worker（期 1）
// ----------------------------------------------------------------------------
// 约定：
//   1. 经典 script：全部顶层函数（window 全局），engineWorkerMain 及所有被它调用的
//      辅助函数均为顶层纯声明，后续由 createEngineWorker() 用 Function.toString()
//      拼装进 Blob Worker。
//   2. 热路径零分配：增量评分直接扫 CSR 对表（adjOff/adjPeer/adjBonus/adjManW/adjDefW），
//      戳去重（touchStamp+epoch）处理同物品多格相邻；不新建对象/数组，不调 Math.exp
//      （256 项 exp 查找表）。
//   3. 评分语义与旧版一致（见 score-shared.js），能量为字典序目标的负标量：
//      E = -(1e12*complete + total + 1e8*manW + 1e5*defW + 10*adj + items + 1e-3*area)
//      total = base + bonus（useBonus=false 时 bonus 不计入能量但仍跟踪用于上报）。
//   4. 确定性：xorshift128+ 为唯一随机源，同 seed+payload 可复现。
// ============================================================================

// ------------------------- Worker 内可变状态（模块级） -------------------------
var ewModel = null, ewMeta = null;
var occ = null, cellOwner = null, solPl = null, placedOrder = null, invPlaced = null;
var touchStamp = null, touchEpoch = 0;
var curBase = 0, curBonus = 0, curManW = 0, curDefW = 0, curAdj = 0, curItems = 0, curArea = 0;
var curEnergy = 0; // 当前标量能量缓存：随 apply/remove 增量维护，避免主循环每迭代重算
var bestSol = null, bestEnergy = Infinity, bestComplete = false, bestBase = 0, bestBonus = 0;
var bestManW = 0, bestDefW = 0, bestAdj = 0, bestItems = 0, bestArea = 0;
var rngS0 = 0, rngS1 = 0;
var curT = 1, T0 = 1, Tmin = 0, expTable = null;
var iters = 0, started = 0, deadline = 0, stoppedFlag = false;
var reheatCount = 0, lastImproveIter = 0, acceptCount = 0, totalMoves = 0;
var ewNodeLimit = 0, ewLastReheatIter = 0; // 主循环分片（P4）：跨片续跑的边界状态
var ewMidRestart = 0; // 中期强制逃逸：重热 8 次仍停滞时从 best 扰动重启（纯状态触发，复现性不变）
var segScores = null, segCounts = null, opWeights = null, opPrefix = null;
var lastProgress = 0, lastIncumbent = 0, lastSwapReq = 0;
var bfsVisited = null, bfsQueue = null, regionStamp = null, touchedList = null;
var requiredItemsTarget = 0; // placedCount + skippedCount === requiredTotalItems 即 complete
// 复用的增量容器（约定同一时刻只有一份活跃 delta，热路径零分配）
var DELTA = {bonus:0, manW:0, defW:0, adj:0};
// undo 栈：apply/remove 时压入反向操作，拒绝回滚 O(算子改动数)；单迭代最多 ≤ 8 次 apply/remove
var ewUndoIt = null, ewUndoPl = null, ewUndoTop = 0, ewUndoSuspend = false;
// 环邻接表（init 期预算）：每摆放的外圈格子列表；配合 cellOwner 实现 O(环长) 增量扫描，
// 避开 CSR 大度数（plen 多时 CSR 度可达上百条边）；pair 分值同步预算为 I×I 表
var ewNbrOff = null, ewNbrCell = null, ewPairBonus = null, ewPairManW = null, ewPairDefW = null;
var ewRefineTopBuf = null; // removeInsert 未放件价值 top-6 复用缓冲（热路径零分配）
var ewScratchSol = null;   // 收尾多端点精化的当前解缓冲

// ------------------------- xorshift128+ RNG -------------------------
function ewRngSeed(seed){
  rngS0 = (seed ^ 0x9E3779B9) >>> 0;
  rngS1 = (Math.imul(rngS0, 0x85EBCA6B) ^ 0xC2B2AE35) >>> 0;
  if(rngS0 === 0 && rngS1 === 0) rngS1 = 0x2545F491;
  for(let k = 0; k < 8; k++) ewRand(); // 预热混合
}
function ewRand(){
  let s1 = rngS0; const s0 = rngS1;
  rngS0 = s0;
  s1 ^= (s1 << 23) | 0;
  rngS1 = (s1 ^ s0 ^ (s1 >>> 17) ^ (s0 >>> 26)) | 0;
  return ((rngS1 + s0) >>> 0) / 4294967296;
}
function ewRandInt(n){ return (ewRand() * n) | 0; }

// ------------------------- 能量与最优比较 -------------------------
function ewCompleteFlag(){ return curItems + ((ewMeta && ewMeta.skippedCount) || 0) === requiredItemsTarget; }
function ewScalarOf(c, base, bonus, manW, defW, adj, items, area){
  const total = base + bonus;
  // 标量化与字典序对齐（P2 根因修复）：cmpBest 优先级 total > manW > defW > adj，但
  // manW/defW 单步变化量（可达 1e10+）远超 Δtotal，入能量会把搜索降级为 defW 驱动，
  // 故不入能量（仍增量跟踪用于上报/契约序列化）。adj 曾取权重 50，但实测它会把
  // totalScore 差 1-5 分的 bonus 位形挤出去（SA adj=25>DFS 21 却 bonus 低 2.76 分），
  // 与字典序（total 先于 adj）方向相反；降为 1e-3 尾部平手项，保证任何 Δtotal≥0.01
  // 都压过任意 Δadj，与 compareSolverBest 口径一致。
  return -((c ? 1e12 : 0) + total + items + 1e-3 * adj + 1e-4 * area);
}
function ewCurrentScalar(){
  return curEnergy;
}
// 字典序比较（对齐旧 compareEvaluationObjects 的优先级序：complete>total>manW>defW>adj>items>area）
function ewBetterLex(c1, total1, mw1, dw1, adj1, it1, ar1, c2, total2, mw2, dw2, adj2, it2, ar2){
  if(c1 !== c2) return c1 ? true : false;
  if(Math.abs(total1 - total2) > 1e-9) return total1 > total2;
  if(Math.abs(mw1 - mw2) > 1e-9) return mw1 > mw2;
  if(Math.abs(dw1 - dw2) > 1e-9) return dw1 > dw2;
  if(adj1 !== adj2) return adj1 > adj2;
  if(it1 !== it2) return it1 > it2;
  if(ar1 !== ar2) return ar1 > ar2;
  return false;
}

// ------------------------- 位板几何 -------------------------
// 摆放 p 是否与当前位板冲突（掩码需是 active 子集，编码期已保证，这里只查重叠）
function ewMaskFits(p){
  const m = ewModel, L = m.L;
  if((occ[0] & m.plMask[p * L]) !== 0) return false;
  if(L > 1 && (occ[1] & m.plMask[p * L + 1]) !== 0) return false;
  return true;
}
function ewOccAdd(p){
  const m = ewModel, L = m.L;
  occ[0] = (occ[0] | m.plMask[p * L]) >>> 0;
  if(L > 1) occ[1] = (occ[1] | m.plMask[p * L + 1]) >>> 0;
  const off = m.plCellsOff[p], len = m.plCellsLen[p], it = m.plItem[p];
  for(let k = 0; k < len; k++) cellOwner[m.cellsFlat[off + k]] = it;
}
function ewOccRemove(p){
  const m = ewModel, L = m.L;
  occ[0] = (occ[0] & ~m.plMask[p * L]) >>> 0;
  if(L > 1) occ[1] = (occ[1] & ~m.plMask[p * L + 1]) >>> 0;
  const off = m.plCellsOff[p], len = m.plCellsLen[p];
  for(let k = 0; k < len; k++) cellOwner[m.cellsFlat[off + k]] = -1;
}

// ------------------------- 增量评分（环扫描 cellOwner，戳去重，O(环长)） -------------------------
// init 期构建：每摆放的外圈格子表 + 物品对分值表（与 encBuildModel 的 CSR 分值语义一致）
function ewBuildNeighborTables(m){
  const I = m.I, W = m.W, H = m.H, P = m.P, K = m.K;
  ewNbrOff = new Uint32Array(P + 1);
  let cap = 0;
  for(let p = 0; p < P; p++) cap += 4 * m.plArea[p]; // 每格最多 4 个外圈邻居
  ewNbrCell = new Uint16Array(cap);
  let t = 0;
  for(let p = 0; p < P; p++){
    ewNbrOff[p] = t;
    touchEpoch++; // 借用戳去重环格（init 期，与主循环无冲突）
    const off = m.plCellsOff[p], len = m.plCellsLen[p];
    for(let k = 0; k < len; k++){
      const cell = m.cellsFlat[off + k];
      const r = (cell / W) | 0, c = cell % W;
      if(r > 0 && touchStamp[W * (r - 1) + c] !== touchEpoch){ touchStamp[W * (r - 1) + c] = touchEpoch; ewNbrCell[t++] = cell - W; }
      if(r + 1 < H && touchStamp[W * (r + 1) + c] !== touchEpoch){ touchStamp[W * (r + 1) + c] = touchEpoch; ewNbrCell[t++] = cell + W; }
      if(c > 0 && touchStamp[W * r + c - 1] !== touchEpoch){ touchStamp[W * r + c - 1] = touchEpoch; ewNbrCell[t++] = cell - 1; }
      if(c + 1 < W && touchStamp[W * r + c + 1] !== touchEpoch){ touchStamp[W * r + c + 1] = touchEpoch; ewNbrCell[t++] = cell + 1; }
    }
  }
  ewNbrOff[P] = t;
  // 物品对分值表（双向对称：每对相邻物品计 weight(i)+weight(j)，与 legacy targetPriorityGain
  // 双向调用口径逐字一致；对称存两份，热路径免条件判断）
  ewPairBonus = new Float64Array(I * I);
  ewPairManW = new Float64Array(I * I);
  ewPairDefW = new Float64Array(I * I);
  const tmpA = {sv:null, rv:null, bonusKind:'none'}, tmpB = {sv:null, rv:null, bonusKind:'none'};
  const kindName = k => (k === 1 ? 'provider' : k === 2 ? 'self' : 'none');
  for(let i = 0; i < I; i++){
    const mwI = m.itemManual[i] >= 0 ? 100000000 * Math.max(1, m.manualCount - m.itemManual[i]) : 0;
    const dwI = (m.itemManual[i] < 0 && m.itemTier[i] >= 0) ? 100000 * Math.max(1, m.defaultTierCount - m.itemTier[i]) : 0;
    tmpA.sv = m.itemStats.subarray(i * K, i * K + K);
    tmpA.rv = m.itemRates.subarray(i * K, i * K + K);
    tmpA.bonusKind = kindName(m.itemKind[i]);
    for(let j = 0; j < I; j++){
      if(i === j) continue;
      const mwJ = m.itemManual[j] >= 0 ? 100000000 * Math.max(1, m.manualCount - m.itemManual[j]) : 0;
      const dwJ = (m.itemManual[j] < 0 && m.itemTier[j] >= 0) ? 100000 * Math.max(1, m.defaultTierCount - m.itemTier[j]) : 0;
      ewPairManW[i * I + j] = mwI + mwJ;
      ewPairDefW[i * I + j] = dwI + dwJ;
      tmpB.sv = m.itemStats.subarray(j * K, j * K + K);
      tmpB.rv = m.itemRates.subarray(j * K, j * K + K);
      tmpB.bonusKind = kindName(m.itemKind[j]);
      ewPairBonus[i * I + j] = scorePotentialPairBonus(tmpA, tmpB);
    }
  }
}
// sign=+1 假设放入 p（p 当前未放）；sign=-1 假设撤掉 p（p 当前在放）。
// 沿摆放外圈格子查 cellOwner，戳去重同物品多格相邻；结果写 DELTA；复杂度 O(环长)。
function ewScanAdj(p, sign){
  const m = ewModel, I = m.I;
  touchEpoch++;
  const itSelf = m.plItem[p];
  let bonus = 0, manW = 0, defW = 0, adj = 0;
  const n0 = ewNbrOff[p], n1 = ewNbrOff[p + 1];
  for(let e = n0; e < n1; e++){
    const it = cellOwner[ewNbrCell[e]];
    if(it < 0 || it === itSelf) continue;
    if(touchStamp[it] === touchEpoch) continue; // 同物品多格相邻只计一次（戳去重）
    touchStamp[it] = touchEpoch;
    adj++;
    const ij = itSelf * I + it;
    if(m.useBonus) bonus += ewPairBonus[ij];
    manW += ewPairManW[ij];
    defW += ewPairDefW[ij];
  }
  // 按 sign 返回带符号增量：+1 放入为增，-1 撤除为减（ewApplyRemove 直接 += 即可）
  DELTA.bonus = sign * bonus; DELTA.manW = sign * manW; DELTA.defW = sign * defW; DELTA.adj = sign * adj;
  return DELTA;
}
// 摆放 p 的单项增量（base/items/area 直接给，邻接分量走 ewScanAdj）
function ewDeltaFor(p, sign){
  const m = ewModel, it = m.plItem[p];
  ewScanAdj(p, sign);
  DELTA.base = sign * m.itemValue[it];
  DELTA.items = sign;
  DELTA.area = sign * m.plArea[p];
  return DELTA;
}
function ewDeltaE(d){
  const useB = ewMeta.useBonus;
  const items2 = curItems + d.items;
  const c2 = items2 + (ewMeta.skippedCount || 0) === requiredItemsTarget;
  const e2 = ewScalarOf(c2, curBase + d.base, useB ? curBonus + d.bonus : 0,
    curManW + d.manW, curDefW + d.defW, curAdj + d.adj, items2, curArea + d.area);
  return e2 - curEnergy; // 当前能量已缓存，免重算 e1
}

// ------------------------- 移动应用（先撤旧再加新；回滚=反向） -------------------------
function ewApplyAdd(it, p){
  // 防御：同件重复 add 会覆盖 solPl 产生幽灵摆放（计数失衡）；栈满丢弃日志（拒绝回滚降级为不可用，宁可不记不可越界）
  if(solPl[it] >= 0) return;
  // 先扫增量再写 solPl：否则 +1 扫会把同物品其它相邻摆放误计为邻接（自身相邻）
  const d = ewDeltaFor(p, +1);
  solPl[it] = p;
  invPlaced[it] = curItems;
  placedOrder[curItems] = it;
  curItems++;
  ewOccAdd(p);
  curBase += d.base; curBonus += d.bonus; curManW += d.manW; curDefW += d.defW;
  curAdj += d.adj; curArea += d.area;
  // 物品数变化 → complete 可能翻转，全量重算能量
  curEnergy = ewScalarOf(ewCompleteFlag(), curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
  if(!ewUndoSuspend && ewUndoTop < ewUndoIt.length){ ewUndoIt[ewUndoTop] = it; ewUndoPl[ewUndoTop] = -1; ewUndoTop++; } // 反向=移除
}
function ewApplyRemove(it){
  const p = solPl[it];
  if(p < 0) return -1;
  const d = ewDeltaFor(p, -1);
  curBase += d.base; curBonus += d.bonus; curManW += d.manW; curDefW += d.defW;
  curAdj += d.adj; curArea += d.area;
  ewOccRemove(p);
  solPl[it] = -1;
  const pos = invPlaced[it];
  const last = placedOrder[curItems - 1];
  placedOrder[pos] = last;
  invPlaced[last] = pos;
  curItems--;
  invPlaced[it] = -1;
  // 物品数变化 → complete 可能翻转，全量重算能量
  curEnergy = ewScalarOf(ewCompleteFlag(), curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
  if(!ewUndoSuspend && ewUndoTop < ewUndoIt.length){ ewUndoIt[ewUndoTop] = it; ewUndoPl[ewUndoTop] = p; ewUndoTop++; } // 反向=放回 p
  return p;
}
// 把 pNew 应用到物品 it（pNew=-1 表示取出背包）；pOld 必须已先行撤除
function ewApplyMove(it, pNew){
  if(pNew >= 0) ewApplyAdd(it, pNew);
}

// ------------------------- 晋级（copyToBest） -------------------------
function ewPartsOfBest(){
  return {complete: bestComplete, area: bestArea, base: bestBase, bonus: bestBonus,
    total: bestBase + bestBonus, adj: bestAdj, items: bestItems,
    manW: bestManW, defW: bestDefW, bestBase, bestBonus, T0};
}
function ewCopyToBest(){
  bestSol.set(solPl);
  bestComplete = ewCompleteFlag();
  bestBase = curBase; bestBonus = curBonus; bestManW = curManW; bestDefW = curDefW;
  bestAdj = curAdj; bestItems = curItems; bestArea = curArea;
  bestEnergy = ewCurrentScalar();
}
function ewBetterThanBest(){
  const e = ewCurrentScalar();
  if(e < bestEnergy - 1e-9) return true;
  if(e > bestEnergy + 1e-9) return false;
  const c = ewCompleteFlag();
  return ewBetterLex(c, curBase + curBonus, curManW, curDefW, curAdj, curItems, curArea,
    bestComplete, bestBase + bestBonus, bestManW, bestDefW, bestAdj, bestItems, bestArea);
}
function ewMaybePromote(now){
  if(!ewBetterThanBest()) return;
  ewCopyToBest();
  lastImproveIter = iters;
  // incumbent-lite 节流 250ms：主线程收到后经 encRebuildBest 全算重建契约 best
  if(now - lastIncumbent >= 250){
    lastIncumbent = now;
    self.postMessage({type:'incumbent-lite', stage:'SA 退火', sol: new Int32Array(bestSol), parts: ewPartsOfBest()});
  }
}

// ------------------------- SA 温度与接受 -------------------------
function ewRebuildExpTable(){
  for(let k = 0; k < 256; k++) expTable[k] = Math.exp(-k / 10.666666666666666); // 覆盖 ΔE/T ∈ [0,24]
}
function ewAcceptTest(deltaE){
  if(curT <= Tmin) return false;
  const x = deltaE / curT;
  if(x >= 24) return false;
  const idx = (x * 10.666666666666666) | 0;
  return ewRand() < expTable[idx >= 255 ? 255 : idx];
}

// ------------------------- ALNS 算子（一期 6 个） -------------------------
// 每个算子直接改动当前解；返回 true 表示产生了候选（供段式计分）。
// σ 计分在 ewAttempt 里按“改进/接受/尝试”统一记。
function ewOpRelocate(){
  if(curItems === 0) return false;
  const it = placedOrder[ewRandInt(curItems)];
  const pOld = solPl[it];
  if(ewRand() < 0.05){ // 小概率取出背包
    ewApplyRemove(it);
    return true;
  }
  const m = ewModel, off = m.itemPlOff[it], len = m.itemPlLen[it];
  ewApplyRemove(it); // 先撤除再找新位，避免旧位掩码干扰 fits 判断
  let pNew = -1;
  if(len > 1){ // 随机试探一次
    const q0 = off + ewRandInt(len);
    if(q0 !== pOld && ewMaskFits(q0)) pNew = q0;
  }
  if(pNew < 0){ // 随机起点环扫找第一个合法位
    const start = len > 0 ? ewRandInt(len) : 0;
    for(let k = 0; k < len; k++){
      const q = off + ((start + k) % len);
      if(q !== pOld && ewMaskFits(q)){ pNew = q; break; }
    }
  }
  if(pNew < 0){ ewApplyAdd(it, pOld); return false; } // 无其它合法位：恢复原状，不算候选
  ewApplyAdd(it, pNew);
  return true;
}
function ewOpMoveGreedy(){
  if(curItems === 0) return false;
  const it = placedOrder[ewRandInt(curItems)];
  const pOld = solPl[it];
  const m = ewModel, off = m.itemPlOff[it], len = m.itemPlLen[it];
  ewApplyRemove(it);
  let bestP = pOld, bestE = 0; // 相对“维持现状”（deltaE=0 即不动）
  // 全枚举（len ≤ 约 42，成本可控；抽样 cap 会漏掉最优位，限制收敛精度）
  const start = ewRandInt(len);
  for(let t = 0; t < len; t++){
    const q = off + ((start + t) % len);
    if(!ewMaskFits(q)) continue;
    const d = ewDeltaFor(q, +1);
    const e = ewDeltaE(d);
    if(e < bestE){ bestE = e; bestP = q; }
  }
  ewApplyAdd(it, bestP);
  return true;
}
function ewOpSwapPair(){
  if(curItems < 2) return false;
  const ai = ewRandInt(curItems), bi = ewRandInt(curItems);
  if(ai === bi) return false;
  const A = placedOrder[ai], B = placedOrder[bi];
  const pA = solPl[A], pB = solPl[B];
  // 摆放归属守卫：互换要求 pA/pB 是对方的合法摆放（同形状），否则下标不属于对方摆放段
  if(ewModel.plItem[pB] !== A || ewModel.plItem[pA] !== B) return false;
  // 先双撤除再做几何兼容判断（否则旧位掩码会误判重叠）
  ewApplyRemove(A);
  ewApplyRemove(B);
  if(ewMaskFits(pB)){
    ewApplyAdd(A, pB);
    if(ewMaskFits(pA)){ ewApplyAdd(B, pA); return true; }
    ewApplyRemove(A); // B 放不进 pA：全部恢复原状
  }
  ewApplyAdd(A, pA);
  ewApplyAdd(B, pB);
  return false;
}
function ewOpRemoveInsert(){
  if(curItems === 0) return false;
  const m = ewModel;
  // 背包未满时先尝试直接插入（净增 1 件），失败再撤一进一（件数不变）
  if(curItems < m.I && ewOpInsertMissing()) return true;
  // 移除目标：50% 贪心选边际贡献最低者（定向换件）+ 50% 随机选（多样性探索，
  // 纯贪心会因目标件边际非最低而永远无法换出，B 档件组合困局的出路）
  // 边际 = value + useBonus 下的邻接加成 + 优先级加权
  let worstIt = -1;
  if(ewRand() < 0.5){
    let worstGain = Infinity;
    for(let k = 0; k < curItems; k++){
      const it = placedOrder[k];
      const p = solPl[it];
      const d = ewDeltaFor(p, -1);
      const gain = -(d.base + (m.useBonus ? d.bonus : 0) + 1e-6 * (d.manW * 1e2 + d.defW) + d.adj);
      if(gain < worstGain){ worstGain = gain; worstIt = it; }
    }
  }else{
    worstIt = placedOrder[ewRandInt(curItems)];
  }
  ewApplyRemove(worstIt);
  // 贪心插入最优未放件：全枚举未放件（背包未满时通常 ≤4 件）× 抽样位 cap 32；
  // 未放件集小，件维全扫不漏换件对象，位维抽样保迭代速度
  let bestIt = -1, bestP = -1, bestE = 0;
  for(let it = 0; it < m.I; it++){
    if(solPl[it] >= 0) continue;
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    const step = len > 32 ? ((len / 32) | 0) || 1 : 1;
    for(let t = 0, k = 0; t < len; t += step, k = (k + step) % len){
      const q = off + k;
      if(!ewMaskFits(q)) continue;
      const d = ewDeltaFor(q, +1);
      const e = ewDeltaE(d);
      if(e < bestE){ bestE = e; bestIt = it; bestP = q; }
    }
  }
  if(bestIt >= 0) ewApplyMove(bestIt, bestP);
  return true;
}
// 纯增件算子（P2）：随机选一件未放件尝试直接插入；背包未满时是通往 complete 的唯一
// 增件通道（relocate/moveGreedy/swapPair 件数不减不增，shuffleRegion 不增）。
function ewOpInsertMissing(){
  const m = ewModel;
  if(curItems >= m.I) return false;
  // 未放件计数后轮盘选一件（避免额外分配）
  let cnt = 0;
  for(let it = 0; it < m.I; it++) if(solPl[it] < 0) cnt++;
  if(cnt === 0) return false;
  let pick = ewRandInt(cnt), it = -1;
  for(let k = 0; k < m.I; k++){ if(solPl[k] < 0){ if(pick === 0){ it = k; break; } pick--; } }
  const off = m.itemPlOff[it], len = m.itemPlLen[it];
  const start = ewRandInt(len);
  for(let k = 0; k < len; k++){
    const q = off + ((start + k) % len);
    if(!ewMaskFits(q)) continue;
    ewApplyAdd(it, q);
    return true;
  }
  return false; // 无合法位：状态未变，不算候选
}
function ewOpShuffleRegion(){
  const m = ewModel;
  if(curItems < 2) return false;
  // 从随机已放件的一个格子出发，在已占用格子上 BFS，收集连通区域内 2-3 件物品
  const seedIt = placedOrder[ewRandInt(curItems)];
  const seedP = solPl[seedIt];
  if(seedP < 0) return false;
  const want = 2 + ewRandInt(2); // 2 或 3 件
  const W = m.W, H = m.H;
  bfsVisited.fill(0);
  regionStamp.fill(0);
  let head = 0, tail = 0, tCount = 0, regionSize = 0;
  const startCell = m.cellsFlat[m.plCellsOff[seedP] + ewRandInt(m.plCellsLen[seedP])];
  bfsQueue[tail++] = startCell;
  bfsVisited[startCell] = 1;
  while(head < tail && tCount < want && regionSize < 64){
    const cell = bfsQueue[head++];
    regionSize++;
    const it = cellOwner[cell];
    if(it >= 0 && regionStamp[it] === 0){
      regionStamp[it] = 1;
      touchedList[tCount++] = it;
    }
    const r = (cell / W) | 0, c = cell % W;
    if(r > 0 && !bfsVisited[cell - W]){ bfsVisited[cell - W] = 1; bfsQueue[tail++] = cell - W; }
    if(r + 1 < H && !bfsVisited[cell + W]){ bfsVisited[cell + W] = 1; bfsQueue[tail++] = cell + W; }
    if(c > 0 && !bfsVisited[cell - 1]){ bfsVisited[cell - 1] = 1; bfsQueue[tail++] = cell - 1; }
    if(c + 1 < W && !bfsVisited[cell + 1]){ bfsVisited[cell + 1] = 1; bfsQueue[tail++] = cell + 1; }
  }
  if(tCount < 2) return false;
  for(let k = 0; k < tCount; k++) ewApplyRemove(touchedList[k]);
  // 腾出的空间逐件喂全部未放件（通往 complete 与件组合换血的关键通道；
  // 未放件通常 ≤4 件，全扫成本可控；只抽 2 件会错过正确换件对象）
  if(curItems < m.I){
    for(let missIt = 0; missIt < m.I; missIt++){
      if(solPl[missIt] >= 0) continue;
      const off = m.itemPlOff[missIt], len = m.itemPlLen[missIt];
      let bestP = -1, bestE = Infinity;
      const step = len > 24 ? ((len / 24) | 0) || 1 : 1;
      const start = ewRandInt(len);
      for(let t = 0, k = start; t < len; t += step, k = (k + step) % len){
        const q = off + k;
        if(!ewMaskFits(q)) continue;
        const d = ewDeltaFor(q, +1);
        const e = ewDeltaE(d);
        if(e < bestE){ bestE = e; bestP = q; }
      }
      if(bestP >= 0) ewApplyAdd(missIt, bestP);
    }
  }
  // 贪心重填：价值降序的确定性顺序（原地选择排序，零分配）
  for(let a = 0; a < tCount; a++){
    let bestK = a;
    for(let b = a + 1; b < tCount; b++){
      const vb = m.itemValue[touchedList[b]], vk = m.itemValue[touchedList[bestK]];
      if(vb > vk || (vb === vk && touchedList[b] < touchedList[bestK])) bestK = b;
    }
    if(bestK !== a){ const tmp = touchedList[a]; touchedList[a] = touchedList[bestK]; touchedList[bestK] = tmp; }
    const it = touchedList[a];
    if(solPl[it] >= 0) continue; // 未放件插入阶段可能已把该件放回（避免双重添加）
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    let bestP = -1, bestE = 0;
    const step = len > 32 ? ((len / 32) | 0) || 1 : 1;
    for(let t = 0, k = 0; t < len; t += step, k = (k + step) % len){
      const q = off + k;
      if(!ewMaskFits(q)) continue;
      const d = ewDeltaFor(q, +1);
      const e = ewDeltaE(d);
      if(e < bestE){ bestE = e; bestP = q; }
    }
    if(bestP >= 0) ewApplyMove(it, bestP);
  }
  return true;
}
// 逃逸重建（op6）：随机拆除 k 件已放件，候选池 = 拆除件 + 全部未放件，
// 按价值降序贪心重填。与 shuffleRegion（连通小区域）互补：大范围破坏能跨越
// “换件组合”能垒（B 档困局：撤换单件的中间态能量差 ~600 分，逐件算子无法接受）。
// big=1 时拆 5-8 件（polish 大扰动，跨越更远盆地），否则 3-5 件。
function ewOpEscapeRebuild(big){
  const m = ewModel;
  if(curItems < 2) return false;
  const k = big ? 5 + ewRandInt(4) : 3 + ewRandInt(3);
  // 随机不重复选 k 件（拒绝采样，件数≤16 时碰撞少）
  let tCount = 0;
  regionStamp.fill(0);
  while(tCount < k && tCount < curItems){
    const it = placedOrder[ewRandInt(curItems)];
    if(regionStamp[it]) continue;
    regionStamp[it] = 1;
    touchedList[tCount++] = it;
  }
  if(tCount < 2) return false;
  for(let q = 0; q < tCount; q++) ewApplyRemove(touchedList[q]);
  // 候选池：拆除件 + 未放件，价值降序（加小随机抖动避免确定性陷阱；
  // touchedList 前段复用为候选池，tCount 为池长）
  for(let it = 0; it < m.I; it++){
    if(solPl[it] < 0 && regionStamp[it] === 0) touchedList[tCount++] = it;
  }
  // 选择排序按 value 降序（池长 ≤ I ≤ 16，O(n²) 可忽）
  for(let a = 0; a < tCount; a++){
    let bestK = a;
    for(let b = a + 1; b < tCount; b++){
      const vb = m.itemValue[touchedList[b]], vk = m.itemValue[touchedList[bestK]];
      if(vb > vk || (vb === vk && touchedList[b] < touchedList[bestK])) bestK = b;
    }
    if(bestK !== a){ const tmp = touchedList[a]; touchedList[a] = touchedList[bestK]; touchedList[bestK] = tmp; }
    const it = touchedList[a];
    if(solPl[it] >= 0) continue;
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    let bestP = -1, bestE = Infinity;
    // polish 路径（big=1）全枚举位，收尾闭合 bonus 尾部差距；热循环路径抽样保速度
    const step = big ? 1 : (len > 32 ? ((len / 32) | 0) || 1 : 1);
    const start = ewRandInt(len);
    for(let t = 0, qq = start; t < len; t += step, qq = (qq + step) % len){
      const q = off + qq;
      if(!ewMaskFits(q)) continue;
      const d = ewDeltaFor(q, +1);
      const e = ewDeltaE(d);
      if(e < bestE){ bestE = e; bestP = q; }
    }
    if(bestP >= 0) ewApplyAdd(it, bestP);
  }
  return true;
}
// ============================================================================
// 期 2：LNS（大邻域搜索）—— 摧毁×受限 DFS 修复 + 配对感知上界剪枝
// ----------------------------------------------------------------------------
// 摧毁三式（destroyRandom / destroyWorst / destroyRegion）拆 k 件（k=2~10 自适应），
// 候选池 = 拆出件 + 未放件，受限 DFS anytime 修复：500ms 软预算分片（与主循环
// 25ms 片机制兼容：同步片内跑完后主循环下一片自然让出，不阻塞消息消化），
// 任一时点可返回当前最好部分解；找不到完整修复时接受部分修复。
// 零 BigInt：BFS/位板（Uint32Array occ + Int16Array cellOwner）实现连通域与碎洞剔除。
// RNG：摧毁选择与失败缓存命中均走主 RNG 流且次序确定（种子复现性不变）；
// DFS 搜索本体零 RNG（anytime 截断点只依赖时钟，解状态确定）。
// ============================================================================
var ewLnsKSmall = 3, ewLnsKBig = 6;
var ewLnsFailVal = null, ewLnsFailIter = null, ewLnsFailN = 0;
var ewLnsPoolMark = null, ewLnsMaxPair = null, ewLnsMinArea = 0;
var ewLnsStackIt = null, ewLnsStackPtr = null, ewLnsStackCnt = null;
var ewLnsCandP = null, ewLnsCandE = null, ewLnsCandOff = null;
var ewLnsUbAt = null, ewLnsUbVal = null, ewLnsUbEpoch = 0;
var ewLnsPool = null, ewLnsPoolN = 0, ewLnsOriginPl = null, ewLnsBestSol = null, ewLnsBestItems = 0, ewLnsOrder = null;
function ewInitLns(){
  const m = ewModel, I = m.I;
  ewLnsKSmall = 3; ewLnsKBig = 6;
  ewLnsFailVal = new Int16Array(8); ewLnsFailIter = new Int32Array(8); ewLnsFailN = 0;
  ewLnsPoolMark = new Int16Array(I);
  ewLnsPool = new Int16Array(I);
  ewLnsOriginPl = new Int32Array(I);
  ewLnsBestSol = new Int32Array(I).fill(-1);
  ewLnsBestItems = 0;
  ewLnsOrder = new Int16Array(I + 1); // 根节点排定的件序（深度 d 放 ewLnsOrder[d]）
  ewLnsMaxPair = new Float64Array(I);
  for(let i = 0; i < I; i++){
    let mx = 0;
    for(let j = 0; j < I; j++){ if(j !== i && ewPairBonus[i * I + j] > mx) mx = ewPairBonus[i * I + j]; }
    ewLnsMaxPair[i] = mx; // 来自 CSR adjBonus 同源表（pairBonusTable 逐字同值）
  }
  ewLnsStackIt = new Int16Array(I + 1);
  ewLnsStackPtr = new Int16Array(I + 1);
  ewLnsStackCnt = new Int16Array(I + 1);
  const CAP = 12, LCAP = CAP * (I + 1);
  ewLnsCandP = new Int32Array(LCAP);
  ewLnsCandE = new Float64Array(LCAP);
  ewLnsCandOff = new Int32Array(I + 2);
  ewLnsUbAt = new Int32Array(I + 1); // 深度级 UB 缓存戳（免逐层重扫碎洞）
  ewLnsUbVal = new Float64Array(I + 1);
}
// 摧毁一：随机不重复拆 k 件（拒绝采样）
function ewLnsDestroyRandom(k){
  regionStamp.fill(0);
  let n = 0;
  while(n < k && n < curItems){
    const it = placedOrder[ewRandInt(curItems)];
    if(regionStamp[it]) continue;
    regionStamp[it] = 1;
    touchedList[n++] = it;
  }
  return n;
}
// 摧毁二：边际贡献最差 k 件。边际 = 撤除该件的 total 损失（复用 ewDeltaFor，
// O(周长)）；损失最小者先拆。选择排序（curItems ≤ I ≤ ~20，O(n²) 可忽）
function ewLnsDestroyWorst(k){
  const useB = ewMeta.useBonus;
  const n = curItems;
  for(let s = 0; s < n; s++) touchedList[s] = placedOrder[s];
  for(let a = 0; a < n; a++){
    let bestK = a, bestGain = Infinity;
    for(let b = a; b < n; b++){
      const it = touchedList[b];
      const d = ewDeltaFor(solPl[it], -1);
      const gain = -(d.base + (useB ? d.bonus : 0) + 1e-3 * d.adj);
      if(gain < bestGain){ bestGain = gain; bestK = b; }
    }
    const tmp = touchedList[a]; touchedList[a] = touchedList[bestK]; touchedList[bestK] = tmp;
  }
  return Math.min(k, n);
}
// 摧毁三：cellOwner BFS 连通域拆件（零 BigInt）：从随机已放件的一格出发在占用格上
// BFS，累计件数达 k 即停（保证拆除集空间连通且件数不超 k）
function ewLnsDestroyRegion(k){
  const m = ewModel, W = m.W, H = m.H;
  if(curItems === 0) return 0;
  const seedIt = placedOrder[ewRandInt(curItems)];
  const seedP = solPl[seedIt];
  if(seedP < 0) return 0;
  regionStamp.fill(0);
  bfsVisited.fill(0);
  let head = 0, tail = 0, n = 0;
  const startCell = m.cellsFlat[m.plCellsOff[seedP] + ewRandInt(m.plCellsLen[seedP])];
  bfsQueue[tail++] = startCell;
  bfsVisited[startCell] = 1;
  while(head < tail && n < k){
    const cell = bfsQueue[head++];
    const it = cellOwner[cell];
    if(it >= 0 && regionStamp[it] === 0){ regionStamp[it] = 1; touchedList[n++] = it; }
    if(n >= k) break;
    const r = (cell / W) | 0, c = cell % W;
    if(r > 0 && !bfsVisited[cell - W]){ bfsVisited[cell - W] = 1; bfsQueue[tail++] = cell - W; }
    if(r + 1 < H && !bfsVisited[cell + W]){ bfsVisited[cell + W] = 1; bfsQueue[tail++] = cell + W; }
    if(c > 0 && !bfsVisited[cell - 1]){ bfsVisited[cell - 1] = 1; bfsQueue[tail++] = cell - 1; }
    if(c + 1 < W && !bfsVisited[cell + 1]){ bfsVisited[cell + 1] = 1; bfsQueue[tail++] = cell + 1; }
  }
  return n;
}
// 配对感知上界（保守：宁松不紧）：
//   UB = 当前分（base+useBonus?bonus）
//      + 分数背包：剩余池件按密度 (value+maxPair)/area 降序装入可用面积（可分割上界）
//      + 配对松弛：剩余各件取 ewLnsMaxPair（potMat 最大可达项）之和
//      （真实加成 = Σ对 ≤ Σ件最大邻居加成）
//   可用面积 = cellCount - curArea - 碎洞（BFS 空格连通域 < 池最小件面积者剔除）
// 浮点累积防御：剪枝侧比较时另加 1e-6 容差（见 ewLnsSearch），本函数不再放宽。
function ewLnsUB(cap){
  const m = ewModel, W = m.W, H = m.H, n = ewLnsPoolN;
  const useB = ewMeta.useBonus;
  // 碎洞剔除：占用格标记（cellOwner，零 BigInt）→ 空格 BFS 连通域，
  // 域格数 < 池最小件面积则整域不可用（放不下剩余最小件的碎洞剔除）
  const total = W * H;
  for(let c = 0; c < total; c++) bfsVisited[c] = cellOwner[c] >= 0 ? 1 : 0;
  let avail = 0;
  for(let c = 0; c < total; c++){
    if(bfsVisited[c]) continue;
    let head = 0, tail = 0, size = 0;
    bfsQueue[tail++] = c;
    bfsVisited[c] = 1;
    while(head < tail){
      const cell = bfsQueue[head++];
      size++;
      const r = (cell / W) | 0, cc = cell % W;
      if(r > 0 && !bfsVisited[cell - W]){ bfsVisited[cell - W] = 1; bfsQueue[tail++] = cell - W; }
      if(r + 1 < H && !bfsVisited[cell + W]){ bfsVisited[cell + W] = 1; bfsQueue[tail++] = cell + W; }
      if(cc > 0 && !bfsVisited[cell - 1]){ bfsVisited[cell - 1] = 1; bfsQueue[tail++] = cell - 1; }
      if(cc + 1 < W && !bfsVisited[cell + 1]){ bfsVisited[cell + 1] = 1; bfsQueue[tail++] = cell + 1; }
    }
    if(size >= ewLnsMinArea) avail += size;
  }
  let ub = curBase + (useB ? curBonus : 0);
  if(n === 0 || avail <= 0) return ub;
  // 分数背包（密度降序，选择排序；n ≤ I ≤ ~20）
  for(let a = cap; a < n; a++){
    let bK = a, bD = -1;
    for(let b = a; b < n; b++){
      const it = ewLnsPool[b];
      const d = (m.itemValue[it] + ewLnsMaxPair[it]) / Math.max(1, m.plArea[m.itemPlOff[it]]);
      if(d > bD){ bD = d; bK = b; }
    }
    if(bK !== a){ const tmp = ewLnsPool[a]; ewLnsPool[a] = ewLnsPool[bK]; ewLnsPool[bK] = tmp; }
  }
  let rem = avail, knap = 0;
  for(let s = cap; s < n; s++){
    const it = ewLnsPool[s];
    const ar = m.plArea[m.itemPlOff[it]];
    if(ar <= rem){ knap += m.itemValue[it]; rem -= ar; }
    else { knap += m.itemValue[it] * rem / ar; break; }
  }
  let pair = 0;
  for(let s = cap; s < n; s++) pair += ewLnsMaxPair[ewLnsPool[s]];
  return ub + knap + (useB ? pair : 0);
}
// 受限 DFS anytime 修复：池件（拆出件+未放件，ewLnsPoolMark 标记，件号升序确定性入池）
// 逐件分支枚举位（ΔE 升序 top-12），深度级 UB 剪枝，任一时点返回当前最好部分解。
// 搜索本体零 RNG；undo 挂起（内部自维护回溯）；结束时恢复 curEnergy。
// 返回 true 表示找到了优于 before 的部分解并已应用；失败时状态复原到拆除后。
function ewLnsSearch(bE, bTotal, bItems, softMs, hardMs, nodeCap){
  const m = ewModel, I = m.I, CAP = 12;
  const t0 = performance.now();
  ewLnsUbEpoch++;
  let n = 0;
  ewLnsMinArea = 63;
  for(let it = 0; it < I; it++){
    if(!ewLnsPoolMark[it]) continue;
    ewLnsPool[n++] = it;
    const ar = m.plArea[m.itemPlOff[it]];
    if(ar < ewLnsMinArea) ewLnsMinArea = ar;
  }
  ewLnsPoolN = n;
  if(n <= 0) return false;
  ewUndoSuspend = true;
  let sp = 0, nodes = 0, any = false;
  let bestE = bE, bestItems = bItems;
  const target = bTotal + 1e-9;
  let completeFound = false;
  for(;;){ // 迭代器驱动：弹未完成节点继续，否则回溯
    let node = -1;
    while(sp > 0){
      if(ewLnsStackPtr[sp - 1] < ewLnsStackCnt[sp - 1]){ node = sp - 1; break; }
      sp--;
      ewApplyRemove(ewLnsStackIt[sp]); // 候选耗尽：回溯撤销该件
    }
    if(node < 0) break;
    if(++nodes > nodeCap || performance.now() - t0 > hardMs) break; // anytime：预算耗尽取当前最好
    if(sp === 0){ // 根节点：池件全序（面积降序，大件先放减少碎洞；平手件号升序确定性）
      ewLnsStackCnt[0] = n;
      for(let i = 0; i < n; i++) ewLnsStackIt[i] = ewLnsPool[i];
      for(let a = 0; a < n; a++){
        let bK = a, bA = -1;
        for(let b = a; b < n; b++){
          const ar = m.plArea[m.itemPlOff[ewLnsStackIt[b]]];
          if(ar > bA || (ar === bA && ewLnsStackIt[b] < ewLnsStackIt[bK])){ bA = ar; bK = b; }
        }
        if(bK !== a){ const tmp = ewLnsStackIt[a]; ewLnsStackIt[a] = ewLnsStackIt[bK]; ewLnsStackIt[bK] = tmp; }
      }
      for(let i = 0; i < n; i++) ewLnsOrder[i] = ewLnsStackIt[i]; // 定序：深度 d 放 ewLnsOrder[d]
      ewLnsStackPtr[0] = 0;
      sp = 1;
      continue;
    }
    const depth = sp - 1;
    const ptr = ewLnsStackPtr[depth];
    if(ptr === 0){ // 首次进入该节点：深度级 UB 剪枝 + 候选枚举
      // 逐节点现算 UB（不同路径同深度棋盘态不同，缓存会错杀好分支；W*H≤42 开销可忽）
      if(ewLnsUB(depth) <= target){ ewLnsStackCnt[depth] = 0; continue; } // UB ≤ incumbent → 剪枝
      const it = ewLnsStackIt[depth];
      const off = m.itemPlOff[it], len = m.itemPlLen[it];
      let cnt = 0;
      const cOff = depth * CAP;
      for(let q = off, ke = off + len; q < ke; q++){
        if(!ewMaskFits(q)) continue;
        const e = ewDeltaE(ewDeltaFor(q, +1));
        if(cnt < CAP){ // 插入排序按 ΔE 升序（CAP=12，O(CAP²) 可忽）
          let ins = cnt;
          while(ins > 0 && ewLnsCandE[cOff + ins - 1] > e){
            ewLnsCandE[cOff + ins] = ewLnsCandE[cOff + ins - 1];
            ewLnsCandP[cOff + ins] = ewLnsCandP[cOff + ins - 1];
            ins--;
          }
          ewLnsCandE[cOff + ins] = e; ewLnsCandP[cOff + ins] = q;
          cnt++;
        }else if(e < ewLnsCandE[cOff + CAP - 1]){ // 替换末位再下沉
          let ins = CAP - 1;
          while(ins > 0 && ewLnsCandE[cOff + ins - 1] > e){
            ewLnsCandE[cOff + ins] = ewLnsCandE[cOff + ins - 1];
            ewLnsCandP[cOff + ins] = ewLnsCandP[cOff + ins - 1];
            ins--;
          }
          ewLnsCandE[cOff + ins] = e; ewLnsCandP[cOff + ins] = q;
        }
      }
      ewLnsStackCnt[depth] = cnt;
    }
    if(ewLnsStackPtr[depth] >= ewLnsStackCnt[depth]) continue; // 无候选：下轮弹出回溯
    const it = ewLnsStackIt[depth];
    const q = ewLnsCandP[depth * CAP + ewLnsStackPtr[depth]++];
    ewApplyAdd(it, q);
    any = true;
    if(depth + 1 === n){ // 叶子：全池已放，评估晋级
      const eNow = ewScalarOf(true, curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
      if(eNow < bestE - 1e-9){ // 严格改进才晋级（平手留给外层 SA 会引入平台随机游走退化）
        bestE = eNow; bestItems = curItems; ewLnsBestSol.set(solPl); ewLnsBestItems = curItems;
      }
      if(ewCompleteFlag()){ completeFound = true; break; } // 完整修复：anytime 提前终止
      ewApplyRemove(it);
    }else{
      ewLnsStackIt[depth + 1] = ewLnsOrder[depth + 1]; // 深度 d 固定放第 d 件（根序已定）
      ewLnsStackPtr[depth + 1] = 0; ewLnsStackCnt[depth + 1] = 0;
      sp++;
    }
  }
  // 回溯清空残栈（恢复拆除后状态）
  while(sp > 0){ sp--; ewApplyRemove(ewLnsStackIt[sp]); }
  ewUndoSuspend = false;
  curEnergy = ewScalarOf(ewCompleteFlag(), curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
  const improved = any && bestE < bE - 1e-9; // 严格优于 before 才应用（拒绝平手，防外层 SA 平台随机游走）
  if(improved){
    for(let it = 0; it < I; it++) if(solPl[it] >= 0) ewApplyRemove(it);
    for(let it = 0; it < I; it++){ const p = ewLnsBestSol[it]; if(p >= 0 && m.plItem[p] === it) ewApplyAdd(it, p); }
  }
  return improved;
}
// LNS 算子（op7=lnsSmall / op8=lnsBig）：摧毁 → anytime DFS 修复 → 晋级或失败记账。
// k 自适应：成功+1 / 失败-1，限 [2,10]；失败组合（small/big×k）短期缓存避免立即重试
// （缓存命中仍消耗一次 RNG 保持流次序确定）。返回 false 时状态与进入前逐字一致。
function ewLnsOp(small){
  const m = ewModel;
  if(curItems < 2) return false;
  let k = small ? ewLnsKSmall : ewLnsKBig;
  if(k > curItems) k = curItems;
  const tag = (small ? 0 : 1) * 16 + k;
  for(let c = 0; c < ewLnsFailN; c++){
    if(ewLnsFailVal[c] === tag && iters - ewLnsFailIter[c] < 4096){ ewRand(); return false; }
  }
  const checkpoint = ewUndoTop;
  const r = ewRand();
  let dn;
  if(r < 0.34) dn = ewLnsDestroyRandom(k);
  else if(r < 0.67) dn = ewLnsDestroyWorst(k);
  else dn = ewLnsDestroyRegion(k);
  if(dn < 2){ ewUndoTop = checkpoint; return false; }
  for(let q = 0; q < dn; q++){ ewLnsOriginPl[q] = solPl[touchedList[q]]; ewApplyRemove(touchedList[q]); }
  // 候选池 = 拆出件 + 全部未放件（poolMark 标记，DFS 内按件号升序确定性入池）
  ewLnsPoolMark.fill(0);
  for(let q = 0; q < dn; q++) ewLnsPoolMark[touchedList[q]] = 1;
  for(let it = 0; it < m.I; it++) if(solPl[it] < 0) ewLnsPoolMark[it] = 1;
  const bE = ewCurrentScalar(), bTotal = curBase + curBonus, bItems = curItems;
  const ok = ewLnsSearch(bE, bTotal, bItems, 500, 500, 200000);
  ewUndoTop = checkpoint; // 摧毁期 undo 日志（DFS 内部挂起不记）截栈丢弃
  if(ok){
    if(small){ if(ewLnsKSmall < 10) ewLnsKSmall++; }
    else if(ewLnsKBig < 10) ewLnsKBig++;
    return true;
  }
  // 失败：状态复原（DFS 已回溯到拆除态）→ 逐件放回原位
  for(let q = 0; q < dn; q++){
    const it = touchedList[q];
    if(solPl[it] < 0) ewApplyAdd(it, ewLnsOriginPl[q]);
  }
  if(small){ if(ewLnsKSmall > 2) ewLnsKSmall--; }
  else if(ewLnsKBig > 2) ewLnsKBig--;
  if(ewLnsFailN < 8){ ewLnsFailVal[ewLnsFailN] = tag; ewLnsFailIter[ewLnsFailN] = iters; ewLnsFailN++; }
  return false;
}

function ewInitOps(){
  opWeights = new Float64Array(9).fill(1);
  opPrefix = new Float64Array(9);
  segScores = new Float64Array(9);
  segCounts = new Float64Array(9);
  opWeights[7] = 0.6; opWeights[8] = 0.6; // LNS 重算子初值略低（单次耗时长），段式计分自然升降
  ewInitLns();
}
function ewPickOp(){
  let s = 0;
  for(let i = 0; i < 9; i++){ s += opWeights[i]; opPrefix[i] = s; }
  const r = ewRand() * s;
  for(let i = 0; i < 9; i++) if(r < opPrefix[i]) return i;
  return 8;
}
function ewRunOp(op){
  if(op === 0) return ewOpRelocate();
  if(op === 1) return ewOpMoveGreedy();
  if(op === 2) return ewOpSwapPair();
  if(op === 3){
    // complete 下“撤一进一”等价于昂贵的坏 relocate（件数已达标，净增通道无意义）：改走廉价重定位
    if(ewCompleteFlag()) return ewOpRelocate();
    return ewOpRemoveInsert();
  }
  if(op === 4) return ewOpShuffleRegion();
  // complete 下无未放件，insertMissing 空扫 O(I) 后返回 false：改走重定位保持迭代有效
  if(op === 5){
    if(ewCompleteFlag()) return ewOpRelocate();
    return ewOpInsertMissing();
  }
  if(op === 7) return ewLnsOp(1); // lnsSmall：k 小（满盘僵局局部重排）
  if(op === 8) return ewLnsOp(0); // lnsBig：k 大（跨盆地件组合换血）
  // op6：逃逸重建（B 档件组合困局专用）
  return ewOpEscapeRebuild();
}
function ewSegmentUpdate(){
  for(let i = 0; i < 9; i++){
    const score = segCounts[i] > 0 ? segScores[i] / segCounts[i] : 0;
    // 逃逸重建保底权重 1.0：其收益（换件组合/跨盆地）需多步才显现，段式计分
    // 短视会把它衰减掉导致 B 档困局复发；保持 ~1/8 的算子份额。
    // LNS 保底 0.3：重算子单次收益高但频率需求低，维持最低探索份额。
    const lo = i === 6 ? 1.0 : (i >= 7 ? 0.3 : 0.1);
    opWeights[i] = Math.min(10, Math.max(lo, opWeights[i] * 0.9 + 0.1 * score));
    segScores[i] = 0; segCounts[i] = 0;
  }
}

// ------------------------- 初始解：价值密度降序 + 逐件增量最优插入 -------------------------
function ewInitialSolution(){
  const m = ewModel;
  occ.fill(0);
  cellOwner.fill(-1);
  solPl.fill(-1);
  curItems = 0; curBase = 0; curBonus = 0; curManW = 0; curDefW = 0; curAdj = 0; curArea = 0;
  ewUndoSuspend = true; ewUndoTop = 0; // 构建期不记 undo
  const spread = m.I > 1 ? m.globalMaxBonus / m.I : 0;
  const order = new Array(m.I);
  for(let i = 0; i < m.I; i++) order[i] = i;
  const density = new Float64Array(m.I);
  for(let i = 0; i < m.I; i++){
    const area = Math.max(1, m.plArea[m.itemPlOff[i]]);
    density[i] = ((m.itemValue[i] + spread) / area) * (0.6 + 0.8 * ewRand());
  }
  order.sort((a, b) => density[b] - density[a] || a - b);
  for(const it of order){
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    let bestP = -1, bestE = Infinity;
    for(let k = 0; k < len; k++){
      const q = off + k;
      if(!ewMaskFits(q)) continue;
      const d = ewDeltaFor(q, +1);
      const e = ewDeltaE(d);
      if(e < bestE){ bestE = e; bestP = q; }
    }
    if(bestP >= 0) ewApplyAdd(it, bestP);
  }
  // 回填一遍：把仍无冲突的未放件补入（确定性顺序，避免首遍密度序造成的可避免缺件）
  for(let it = 0; it < m.I; it++){
    if(solPl[it] >= 0) continue;
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    let bestP = -1, bestE = Infinity;
    for(let k = 0; k < len; k++){
      const q = off + k;
      if(!ewMaskFits(q)) continue;
      const d = ewDeltaFor(q, +1);
      const e = ewDeltaE(d);
      if(e < bestE){ bestE = e; bestP = q; }
    }
    if(bestP >= 0) ewApplyAdd(it, bestP);
  }
  ewUndoSuspend = false; ewUndoTop = 0;
  curEnergy = ewScalarOf(ewCompleteFlag(), curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
  ewCopyToBest();
}

// ------------------------- 解载入（seed / swap-accept 重建，O(Σarea+Σdeg)） -------------------------
function ewLoadSolution(sol){
  const m = ewModel;
  occ.fill(0);
  cellOwner.fill(-1);
  solPl.fill(-1);
  curItems = 0; curBase = 0; curBonus = 0; curManW = 0; curDefW = 0; curAdj = 0; curArea = 0;
  ewUndoSuspend = true; ewUndoTop = 0; // 重建期不记 undo
  for(let i = 0; i < m.I && i < sol.length; i++){
    const p = sol[i];
    if(p < 0) continue;
    if(m.plItem[p] !== i) continue; // 防御：下标错位
    if(!ewMaskFits(p)) continue;     // 防御：非法重叠
    ewApplyAdd(i, p);
  }
  ewUndoSuspend = false;
  curEnergy = ewScalarOf(ewCompleteFlag(), curBase, ewMeta.useBonus ? curBonus : 0, curManW, curDefW, curAdj, curItems, curArea);
  if(ewBetterThanBest()) ewCopyToBest();
}

// ------------------------- 上报 -------------------------
function ewSendProgress(now){
  const secs = Math.max(1e-3, (now - started) / 1000);
  self.postMessage({
    type: 'progress', stage: 'SA 退火', nodes: iters, elapsed: Math.round(now - started),
    bestComplete, bestArea, bestBase, bestBonus, bestTotal: bestBase + bestBonus,
    bestAdjacency: bestAdj, bestItems,
    totalArea: ewMeta.requiredTotalArea, totalItems: ewMeta.requiredTotalItems,
    restarts: reheatCount, saTemp: curT,
    saAcceptRate: totalMoves > 0 ? acceptCount / totalMoves : 0,
    saItersPerSec: Math.round(iters / secs)
  });
}
function ewSendDone(now){
  self.postMessage({
    type: 'done', sol: bestSol, parts: ewPartsOfBest(),
    nodes: iters, elapsed: Math.round(now - started), stopped: stoppedFlag,
    fullPackingAttempted: true, fullPackingFound: bestComplete,
    fullSearchCutoff: false, optimizationCutoff: false, fallbackCutoff: false,
    totalArea: ewMeta.requiredTotalArea, totalBase: ewMeta.requiredTotalBase,
    totalItems: ewMeta.requiredTotalItems, assignmentStrategy: 'sa_alns',
    singletonDeferredCount: 0, assignmentChecks: iters, engine: 'sa'
  });
}

// ------------------------- 消息队列处理（主循环每 1024 迭代检查） -------------------------
var ewMsgQueue = [];
function ewDrainMessages(){
  while(ewMsgQueue.length){
    const msg = ewMsgQueue.shift();
    if(msg.type === 'seed'){
      const sol = msg.sol instanceof Int32Array ? msg.sol : new Int32Array(msg.sol);
      ewLoadSolution(sol);
    }else if(msg.type === 'swap-accept'){
      const sol = msg.sol instanceof Int32Array ? msg.sol : new Int32Array(msg.sol);
      ewLoadSolution(sol);
    }else if(msg.type === 'stop'){
      stoppedFlag = true;
    }
  }
}

// ------------------------- T0 标定（P2）：按算子真实劣化 delta 量级定温 -------------------------
// 旧式 T0=0.03*|E0|+1 被 1e12 complete 常量偏移与 1e8/1e5 高量级项污染，初始温度比算子 delta
// 大几个数量级，几何降温把大部分预算浪费在无效高温区。改为：128 次算子采样收集劣化 delta，
// 中位数×20 → 初始劣化接受率≈exp(-1/20)≈95%。采样后状态完整回滚，不影响搜索解空间。
function ewCalibrateT0(tempIndex){
  const samples = [];
  const cBefore = ewCompleteFlag();
  for(let k = 0; k < 128; k++){
    const before = ewCurrentScalar();
    const checkpoint = ewUndoTop;
    const produced = ewRunOp(ewPickOp());
    if(produced){
      const deltaE = ewCurrentScalar() - before;
      // 过滤 complete 翻转样本：±1e12 台阶会污染量级估计（T0 飙到 1e11 使搜索退化为随机游走）
      if(deltaE > 1e-9 && deltaE < 1e11 && ewCompleteFlag() === cBefore) samples.push(deltaE);
      ewRejectRestore(checkpoint);
    }
    ewUndoTop = checkpoint;
  }
  if(samples.length >= 8){
    samples.sort((a, b) => a - b);
    T0 = samples[(samples.length / 2) | 0] * 20;
  }else{
    T0 = 0.03 * Math.abs(ewCurrentScalar()) + 1; // 采样不足：回退旧式估计
  }
  Tmin = T0 * 1e-4;
  curT = Math.max(Tmin, T0 * Math.pow(0.85, tempIndex));
}

// ------------------------- 收尾精化（确定性局部最优，零 RNG 消耗） -------------------------
// 阶段一：1-relocate 全枚举单件最优重定位，直到一轮无改进；
// 阶段二：2-pair 配对重定位（两件同时换摆），覆盖单件不可达的联合位形（SA 与 DFS
// 尾部差距多来自此处）。complete 下件数不变，直接收紧 total/adj。
function ewRefineSolution(deep){
  const m = ewModel;
  ewUndoSuspend = true;
  // 阶段一：1-relocate
  for(let round = 0; round < 8; round++){
    let improved = false;
    for(let s = 0; s < curItems; s++){
      const it = placedOrder[s];
      const pOld = solPl[it];
      if(pOld < 0) continue;
      const off = m.itemPlOff[it], len = m.itemPlLen[it];
      ewApplyRemove(it);
      let bestP = pOld, bestE = 0;
      for(let k = 0; k < len; k++){
        const q = off + k;
        if(!ewMaskFits(q)) continue;
        const d = ewDeltaFor(q, +1);
        const e = ewDeltaE(d);
        if(e < bestE - 1e-9){ bestE = e; bestP = q; }
      }
      ewApplyAdd(it, bestP);
      if(bestP !== pOld) improved = true;
    }
    if(!improved) break;
  }
  // 阶段二：2-pair 配对重定位全枚举（I≤16 → ≤120 对；单对笛卡尔积 cap 2500，总评估量有界）。
  // 覆盖单件不可达的联合位形（SA 与 DFS 尾部差距多来自此处），多轮直到无改进。
  for(let round = 0; round < 3; round++){
    let improved = false;
    const n = curItems;
    for(let sa = 0; sa < n; sa++){
      for(let sb = sa + 1; sb < n; sb++){
        const A = placedOrder[sa], B = placedOrder[sb];
      const pA = solPl[A], pB = solPl[B];
      if(pA < 0 || pB < 0) continue;
      const offA = m.itemPlOff[A], lenA = m.itemPlLen[A];
      const offB = m.itemPlOff[B], lenB = m.itemPlLen[B];
      if(lenA * lenB > 2500) continue; // 超大笛卡尔积对跳过，保持收尾有界
      ewApplyRemove(A);
      ewApplyRemove(B);
      let bA = pA, bB = pB, bestE = 0; // 基线=原位组合（双撤后逐件还原的总 delta 恰为 0）
      for(let ka = 0; ka < lenA; ka++){
        const qa = offA + ka;
        if(!ewMaskFits(qa)) continue;
        const eA = ewDeltaE(ewDeltaFor(qa, +1)); // 候选总 delta = ΔA + ΔB，旧版只比 ΔB 会误判
        ewApplyAdd(A, qa);
        for(let kb = 0; kb < lenB; kb++){
          const qb = offB + kb;
          if(!ewMaskFits(qb)) continue;
          const e = eA + ewDeltaE(ewDeltaFor(qb, +1));
          if(e < bestE - 1e-9){ bestE = e; bA = qa; bB = qb; }
        }
        ewApplyRemove(A);
      }
      ewApplyAdd(A, bA);
      ewApplyAdd(B, bB);
        if(bA !== pA || bB !== pB) improved = true;
      }
    }
    if(!improved) break;
  }
  // 阶段三：3 件局部洗牌（随机抽样三元组×全位重填）：2-pair 无法跨越需要
  // 三件联动的位形（bonus 尾部差距的常见来源）。抽样 48 个（可重复）三元组；
  // 全枚举 C(n,3) 实测耗时翻倍无收益，回退抽样。
  // 仅 deep（polish）执行：全位枚举较重，初始基线 refine 不跑以免挤占搜索预算。
  if(deep && curItems >= 3){
    for(let trial = 0; trial < 96; trial++){
      touchedList[0] = placedOrder[ewRandInt(curItems)];
      touchedList[1] = placedOrder[ewRandInt(curItems)];
      touchedList[2] = placedOrder[ewRandInt(curItems)];
      if(touchedList[0] === touchedList[1] || touchedList[1] === touchedList[2] || touchedList[0] === touchedList[2]) continue;
      const p0 = solPl[touchedList[0]], p1 = solPl[touchedList[1]], p2 = solPl[touchedList[2]];
      if(p0 < 0 || p1 < 0 || p2 < 0) continue;
      const baseE = ewCurrentScalar();
      ewApplyRemove(touchedList[0]);
      ewApplyRemove(touchedList[1]);
      ewApplyRemove(touchedList[2]);
      const remE = ewCurrentScalar(); // 三件移除后的能量；候选总能量 = remE + 三件边际之和
      // 贪心重填：三件全排列 × 全位枚举（len≤42，最坏 6×42³≈44万/试，收尾路径
      // 非热循环，实测总耗时可接受；旧 cap16 抽样会漏 bonus 位形）；
      // 记录组合归属（gI* 为物品），回填时精确复现该组合。
      let gBestE = Infinity, gI0 = -1, gI1 = -1, gI2 = -1, gA = -1, gB = -1, gC = -1;
      for(let o0 = 0; o0 < 3; o0++){
        const i0 = touchedList[o0];
        const off0 = m.itemPlOff[i0], len0 = m.itemPlLen[i0];
        for(let k0 = 0; k0 < len0; k0++){
          const q0 = off0 + k0;
          if(!ewMaskFits(q0)) continue;
          const e0 = ewDeltaE(ewDeltaFor(q0, +1));
          ewApplyAdd(i0, q0);
          for(let o1 = 0; o1 < 3; o1++){
            if(o1 === o0) continue;
            const i1 = touchedList[o1];
            const off1 = m.itemPlOff[i1], len1 = m.itemPlLen[i1];
            for(let k1 = 0; k1 < len1; k1++){
              const q1 = off1 + k1;
              if(!ewMaskFits(q1)) continue;
              const e01 = e0 + ewDeltaE(ewDeltaFor(q1, +1));
              ewApplyAdd(i1, q1);
              for(let o2 = 0; o2 < 3; o2++){
                if(o2 === o0 || o2 === o1) continue;
                const i2 = touchedList[o2];
                const off2 = m.itemPlOff[i2], len2 = m.itemPlLen[i2];
                for(let k2 = 0; k2 < len2; k2++){
                  const q2 = off2 + k2;
                  if(!ewMaskFits(q2)) continue;
                  const e = remE + e01 + ewDeltaE(ewDeltaFor(q2, +1));
                  if(e < gBestE){ gBestE = e; gI0 = i0; gI1 = i1; gI2 = i2; gA = q0; gB = q1; gC = q2; }
                }
              }
              ewApplyRemove(i1);
            }
          }
          ewApplyRemove(i0);
        }
      }
      // 回填：找到更优组合则按枚举顺序精确装入，否则恢复原位
      // （gBestE 为含三件边际之和的总能量，与 baseE 同口径可比）
      if(gA >= 0 && gBestE < baseE - 1e-9){
        ewApplyAdd(gI0, gA);
        ewApplyAdd(gI1, gB);
        ewApplyAdd(gI2, gC);
      }else{
        ewApplyAdd(touchedList[0], p0);
        ewApplyAdd(touchedList[1], p1);
        ewApplyAdd(touchedList[2], p2);
      }
    }
  }
  ewUndoSuspend = false; ewUndoTop = 0;
  if(ewBetterThanBest()) ewCopyToBest();
}
// 收尾多端点精化（P2 尾部收敛）：deterministic refine 是局部最优，其结果只依赖起点；
// SA 终点若困在次优盆地，单端点精化无法跨越。此处从 best 与若干随机重启贪心解
// 分别跑 ewRefineSolution，取最优晋级（随机重启只在此处消耗 RNG，种子复现性不受影响）。
function ewFinishPolish(){
  const m = ewModel;
  if(!ewScratchSol) ewScratchSol = new Int32Array(m.I);
  // 端点 0：当前 best → 深度精化（含阶段三，改进则晋级）
  ewLoadSolution(new Int32Array(bestSol));
  ewRefineSolution(true);
  // 端点 1..23：前两轮随机重启贪心（密度序随机抖动 → 多样起点）；其余基于 best
  // 的逃逸扰动重建（在 best 盆地邻域换件组合，针对 bonus 尾部差距）+ 精化；
  // trial≥8 叠加大扰动接近全盘重建。polish 在 3s 搜索预算之外，端点数不受限。
  // 注意：ewInitialSolution 末尾会无条件 ewCopyToBest，故每轮先快照 best，
  // 精化后若仍不优于快照则回滚跟踪量（只有真正更优的端点才更新 best）。
  for(let trial = 0; trial < 24; trial++){
    ewScratchSol.set(bestSol);
    const sE = bestEnergy, sC = bestComplete, sB = bestBase, sBo = bestBonus;
    const sMw = bestManW, sDw = bestDefW, sAdj = bestAdj, sIt = bestItems, sAr = bestArea;
    if(trial < 2){
      ewInitialSolution();
    }else{
      ewLoadSolution(new Int32Array(ewScratchSol));
      ewOpEscapeRebuild(trial >= 8 ? 1 : 0);
      if(trial >= 8) ewOpEscapeRebuild(1); // trial8+ 叠加大扰动接近全盘重建
    }
    ewRefineSolution(true);
    const better = ewCurrentScalar() < sE - 1e-9 || (
      Math.abs(ewCurrentScalar() - sE) <= 1e-9 &&
      ewBetterLex(ewCompleteFlag(), curBase + curBonus, curManW, curDefW, curAdj, curItems, curArea,
        sC, sB + sBo, sMw, sDw, sAdj, sIt, sAr));
    if(!better){
      bestSol.set(ewScratchSol);
      bestEnergy = sE; bestComplete = sC; bestBase = sB; bestBonus = sBo;
      bestManW = sMw; bestDefW = sDw; bestAdj = sAdj; bestItems = sIt; bestArea = sAr;
    }
  }
  // 把当前状态恢复到 best（后续上报 parts 与 sol 一致）
  ewLoadSolution(new Int32Array(bestSol));
}

// ------------------------- 主搜索循环（P4：时间片分片，片间让出事件循环消化消息） -------------------------
function ewRunChunk(){
  const REHEAT_ITERS = 2048, MAX_REHEAT = 24, SEGMENT = 256;
  const swapEnabled = !!ewMeta.swapEnabled;
  const sliceStart = performance.now();
  while(iters < ewNodeLimit){
    const now = performance.now();
    if(now >= deadline) break;
    // 时间片让出：先消化队列内 seed/swap-accept/stop，再续跑下一片（RNG 序列与迭代次序不受分片影响）
    if(now - sliceStart >= 25){
      ewDrainMessages();
      if(!stoppedFlag && iters < ewNodeLimit && now < deadline) setTimeout(ewRunChunk, 0);
      else ewFinishSearch();
      return;
    }
    // 段式权重更新（轮盘赌前缀和在 ewPickOp 内现算）
    if(iters > 0 && iters % SEGMENT === 0) ewSegmentUpdate();
    // 中期强制逃逸（B 档件组合困局）：重热已达 8 次仍停滞（纯迭代状态触发，
    // 不依赖时钟，种子复现性不变）→ 从 best 逃逸重建一次并回温
    if(!ewMidRestart && reheatCount >= 8){
      ewMidRestart = 1;
      ewLoadSolution(new Int32Array(bestSol));
      ewOpEscapeRebuild();
      curT = Math.max(Tmin, T0);
      ewRebuildExpTable();
      lastImproveIter = iters; ewLastReheatIter = iters;
    }
    const before = ewCurrentScalar();
    const checkpoint = ewUndoTop; // 算子执行前 undo 栈位：拒绝时反向弹出回滚
    const op = ewPickOp();
    const produced = ewRunOp(op);
    if(produced){
      const after = ewCurrentScalar();
      const deltaE = after - before;
      totalMoves++;
      segCounts[op]++;
      if(deltaE < -1e-9){
        acceptCount++;
        segScores[op] += 33; // σ1：改进接受
      }else if(ewAcceptTest(deltaE)){
        acceptCount++;
        segScores[op] += 9;  // σ2：劣解接受
      }else{
        ewRejectRestore(checkpoint);   // 拒绝：反向弹出 undo 栈至 checkpoint
      }
      ewUndoTop = checkpoint; // 丢弃本迭代 undo 日志（栈有界）
      ewMaybePromote(now);
    }else{
      ewUndoTop = checkpoint; // 未产生候选：算子内部已自恢复，同步截栈
    }
    iters++;
    // 冷却
    curT = Math.max(Tmin, curT * 0.99995);
    // 重热：连续 REHEAT_ITERS 无改进且重热次数未满。best 已 complete 时 50% 全新贪心
    // 重启（跨盆地探索，A 档远盆地差距的出路）；非 complete 时仅回温续跑（B 档件组合
    // 仍在换血，重启会打断增件进程；快照保护 best；RNG 确定性消耗）
    if(iters - lastImproveIter >= REHEAT_ITERS && iters - ewLastReheatIter >= REHEAT_ITERS && reheatCount < MAX_REHEAT){
      if(bestComplete && ewRand() < 0.5){
        if(!ewScratchSol) ewScratchSol = new Int32Array(ewModel.I);
        ewScratchSol.set(bestSol);
        const sE = bestEnergy, sC = bestComplete, sB = bestBase, sBo = bestBonus;
        const sMw = bestManW, sDw = bestDefW, sAdj = bestAdj, sIt = bestItems, sAr = bestArea;
        ewInitialSolution();
        const better = ewCurrentScalar() < sE - 1e-9 || (
          Math.abs(ewCurrentScalar() - sE) <= 1e-9 &&
          ewBetterLex(ewCompleteFlag(), curBase + curBonus, curManW, curDefW, curAdj, curItems, curArea,
            sC, sB + sBo, sMw, sDw, sAdj, sIt, sAr));
        if(!better){
          bestSol.set(ewScratchSol);
          bestEnergy = sE; bestComplete = sC; bestBase = sB; bestBonus = sBo;
          bestManW = sMw; bestDefW = sDw; bestAdj = sAdj; bestItems = sIt; bestArea = sAr;
        }
        // 从新贪心解继续退火（不回载 best：重启的意义就是探索新盆地）
      }else{
        ewLoadSolution(new Int32Array(bestSol));
      }
      curT = Math.max(Tmin, T0);
      ewRebuildExpTable();
      reheatCount++;
      ewLastReheatIter = iters;
      lastImproveIter = iters;
    }
    // 每 1024 迭代：检查消息队列 + 节流进度上报
    if((iters & 1023) === 0){
      ewDrainMessages();
      if(stoppedFlag) break;
      if(now - lastProgress >= 500){ lastProgress = now; ewSendProgress(now); }
    }
    // swap-req：每 2048 迭代且距上次 ≥50ms，发出即走（不等待）；sol 拷贝 Transferable
    if(swapEnabled && (iters & 2047) === 0 && now - lastSwapReq >= 50){
      lastSwapReq = now;
      const copy = new Int32Array(solPl);
      self.postMessage({type:'swap-req', sol: copy}, [copy.buffer]);
    }
  }
  ewFinishSearch();
}
// 收尾：若末次 best 改进未经 incumbent-lite 上报，补发一次（主线程全算重建）
function ewFinishSearch(){
  ewDrainMessages(); // 收尾前再消化一次（stop 可能改变 stopped 语义）
  ewFinishPolish(); // 多端点确定性精化：best + 随机重启贪心，收紧 SA 与 DFS 尾部差距
  const endNow = performance.now();
  if(endNow - lastIncumbent >= 250){
    self.postMessage({type:'incumbent-lite', stage:'SA 退火', sol: new Int32Array(bestSol), parts: ewPartsOfBest()});
  }
  ewSendProgress(endNow);
  ewSendDone(endNow);
}

// ------------------------- 主入口（Blob 内执行） -------------------------
function engineWorkerMain(){
  'use strict';
  self.onmessage = function(ev){
    const msg = ev.data;
    if(!msg || !msg.type) return;
    if(msg.type === 'init'){
      ewMeta = msg.meta || {};
      ewModel = encDecodeBundle(msg.buffer, msg.offsets);
      const m = ewModel;
      occ = new Uint32Array(m.L);
      cellOwner = new Int16Array(m.W * m.H);
      solPl = new Int32Array(m.I).fill(-1);
      bestSol = new Int32Array(m.I).fill(-1);
      placedOrder = new Int16Array(m.I);
      invPlaced = new Int32Array(m.I).fill(-1);
      touchStamp = new Int32Array(Math.max(m.I, m.W * m.H)); // 主循环按物品下标、建表期按格子下标复用
      expTable = new Float64Array(256);
      bfsVisited = new Uint8Array(m.W * m.H);
      bfsQueue = new Int32Array(m.W * m.H);
      regionStamp = new Int16Array(m.I);
      touchedList = new Int16Array(m.I); // escape 重建候选池最长 I 件
      // undo 栈容量 3I+8：shuffleRegion 最坏 = I 移除 + I 未放件插入 + 3 重填；越界写 TypedArray
      // 静默丢弃但 top 照涨 → 回滚读 undefined → 状态损坏（期 1 验收 T4 漂移根因）
      const undoCap = Math.max(16, 3 * m.I + 8);
      ewUndoIt = new Int32Array(undoCap);
      ewUndoPl = new Int32Array(undoCap);
      ewUndoTop = 0; ewUndoSuspend = false;
      requiredItemsTarget = Math.max(0, Number(ewMeta.requiredTotalItems) || m.I);
      ewRngSeed(Number(ewMeta.seedOffset) || 0);
      ewBuildNeighborTables(m);
      ewInitOps();
      ewInitialSolution();
      const tempIndex = Math.max(0, Number(ewMeta.tempIndex) || 0);
      ewCalibrateT0(tempIndex);
      ewRebuildExpTable();
      started = performance.now();
      deadline = started + Math.max(100, Number(ewMeta.timeLimit) || 20000);
      ewNodeLimit = Math.max(1000, Number(ewMeta.nodeLimit) || 2500000);
      ewLastReheatIter = 0;
      lastProgress = started; lastIncumbent = started - 250; lastSwapReq = started - 50;
      iters = 0; acceptCount = 0; totalMoves = 0; reheatCount = 0; lastImproveIter = 0;
      ewMidRestart = 0;
      stoppedFlag = false;
      // 初始贪心解先精化一轮（确定性），再上报基线 incumbent-lite
      ewRefineSolution();
      // 初始贪心解立即上报一次 incumbent-lite，主线程可尽早全算重建展示基线
      self.postMessage({type:'incumbent-lite', stage:'SA 退火', sol: new Int32Array(bestSol), parts: ewPartsOfBest()});
      // 主循环分片调度（P4）：让出事件循环，片间消化 seed/swap-accept/stop
      ewRunChunk();
      return;
    }
    // 非 init 消息：进入队列，主循环内消化（Worker 单线程，onmessage 与循环交替执行）
    ewMsgQueue.push(msg);
  };
}
// 拒绝恢复：弹出 undo 栈至 checkpoint，逐个应用反向操作（O(算子改动数)，远快于全量重建）
function ewRejectRestore(checkpoint){
  ewUndoSuspend = true;
  while(ewUndoTop > checkpoint){
    ewUndoTop--;
    const it = ewUndoIt[ewUndoTop], pl = ewUndoPl[ewUndoTop];
    if(pl < 0) ewApplyRemove(it);
    else ewApplyAdd(it, pl);
  }
  ewUndoSuspend = false;
}

// ------------------------- 拼 Blob 的函数引用清单 -------------------------
// Worker 作用域内的模块级状态声明（本文件顶层 var 不会随 Function.toString() 进 Blob，
// 必须显式拼入，否则严格模式下对未声明变量赋值会抛错）
function engWorkerStateDecls(){
  return 'var ewModel=null,ewMeta=null;'
    + 'var occ=null,cellOwner=null,solPl=null,placedOrder=null,invPlaced=null;'
    + 'var touchStamp=null,touchEpoch=0;'
    + 'var curBase=0,curBonus=0,curManW=0,curDefW=0,curAdj=0,curItems=0,curArea=0;'
    + 'var curEnergy=0;'
    + 'var bestSol=null,bestEnergy=Infinity,bestComplete=false,bestBase=0,bestBonus=0;'
    + 'var bestManW=0,bestDefW=0,bestAdj=0,bestItems=0,bestArea=0;'
    + 'var rngS0=0,rngS1=0;'
    + 'var curT=1,T0=1,Tmin=0,expTable=null;'
    + 'var iters=0,started=0,deadline=0,stoppedFlag=false;'
    + 'var reheatCount=0,lastImproveIter=0,acceptCount=0,totalMoves=0;'
    + 'var segScores=null,segCounts=null,opWeights=null,opPrefix=null;'
    + 'var lastProgress=0,lastIncumbent=0,lastSwapReq=0;'
    + 'var bfsVisited=null,bfsQueue=null,regionStamp=null,touchedList=null;'
    + 'var requiredItemsTarget=0;'
    + 'var DELTA={bonus:0,manW:0,defW:0,adj:0};'
    + 'var ewMsgQueue=[];'
    + 'var ewUndoIt=null,ewUndoPl=null,ewUndoTop=0,ewUndoSuspend=false;'
    + 'var ewNbrOff=null,ewNbrCell=null,ewPairBonus=null,ewPairManW=null,ewPairDefW=null;'
    + 'var ewRefineTopBuf=null;'
    + 'var ewScratchSol=null;'
    + 'var ewNodeLimit=0,ewLastReheatIter=0;\n'
    + 'var ewMidRestart=0;\n'
    + 'var ewLnsKSmall=3,ewLnsKBig=6,ewLnsFailVal=null,ewLnsFailIter=null,ewLnsFailN=0;\n'
    + 'var ewLnsPoolMark=null,ewLnsMaxPair=null,ewLnsMinArea=0,ewLnsPool=null,ewLnsPoolN=0;\n'
    + 'var ewLnsStackIt=null,ewLnsStackPtr=null,ewLnsStackCnt=null,ewLnsOrder=null;\n'
    + 'var ewLnsCandP=null,ewLnsCandE=null,ewLnsCandOff=null;\n'
    + 'var ewLnsUbAt=null,ewLnsUbVal=null,ewLnsUbEpoch=0;\n'
    + 'var ewLnsOriginPl=null,ewLnsBestSol=null,ewLnsBestItems=0;\n';
}
function engWorkerPartFunctions(){
  return [
    // score-shared.js（评分纯函数层；__SCORE_SELFTEST__ 不需要）
    scoreSumRatesProduct, scoreAreAdjacent, scoreViewOf, scorePairBonusEvents,
    scorePotentialPairBonus, scoreTargetPriorityGain, scorePriorityGainFor,
    scoreCompareVectors, scoreEvaluateConcrete, scoreCompareEvaluationObjects,
    scoreBuildStatTotals, scoreMaskToDec, scoreSerializeBest,
    // engine-encoding.js（decode 依赖 encBundleTables）
    encBundleTables, encDecodeBundle,
    // 本文件内部辅助（全部顶层声明）
    ewRngSeed, ewRand, ewRandInt,
    ewCompleteFlag, ewScalarOf, ewCurrentScalar, ewBetterLex,
    ewMaskFits, ewOccAdd, ewOccRemove, ewBuildNeighborTables, ewScanAdj, ewDeltaFor, ewDeltaE,
    ewApplyAdd, ewApplyRemove, ewApplyMove,
    ewPartsOfBest, ewCopyToBest, ewBetterThanBest, ewMaybePromote,
    ewRebuildExpTable, ewAcceptTest,
    ewOpRelocate, ewOpMoveGreedy, ewOpSwapPair, ewOpRemoveInsert,
    ewOpShuffleRegion, ewOpInsertMissing, ewOpEscapeRebuild,
    ewInitLns, ewLnsDestroyRandom, ewLnsDestroyWorst, ewLnsDestroyRegion,
    ewLnsUB, ewLnsSearch, ewLnsOp,
    ewInitOps, ewPickOp, ewRunOp, ewSegmentUpdate,
    ewInitialSolution, ewLoadSolution,
    ewSendProgress, ewSendDone, ewDrainMessages, ewRejectRestore,
    ewCalibrateT0, ewRefineSolution, ewFinishPolish, ewRunChunk, ewFinishSearch
  ];
}

// 创建 Blob Worker：source = 状态声明 + parts.map(toString).join('\n') + '(engineWorkerMain)();'
function createEngineWorker(){
  const source = engWorkerStateDecls()
    + engWorkerPartFunctions().map(f => f.toString()).join('\n')
    + '\n(' + engineWorkerMain.toString() + ')();';
  const blob = new Blob([source], {type:'application/javascript'});
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  worker._blobUrl = url; // 清理依赖：终止后 revokeObjectURL
  return worker;
}

if(typeof window !== 'undefined'){
  window.engineWorkerMain = engineWorkerMain;
  window.engWorkerStateDecls = engWorkerStateDecls;
  window.engWorkerPartFunctions = engWorkerPartFunctions;
  window.createEngineWorker = createEngineWorker;
}
