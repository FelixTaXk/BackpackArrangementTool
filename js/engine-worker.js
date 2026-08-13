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
  // 标量化与字典序对齐（P2 根因修复）：cmpBest 优先级 total > manW > defW，但 1e8/1e5 权重项的
  // 单步变化量（可达 1e10+）远超 Δtotal（~1e3），若入能量会把搜索降级为 defW 驱动、
  // total 永远追不上 DFS。故 manW/defW 不入能量（仍增量跟踪用于上报/契约序列化），
  // SA 专注最大化 complete → total → adj 主链。
  return -((c ? 1e12 : 0) + total + 10 * adj + items + 1e-3 * area);
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
    manW: bestManW, defW: bestDefW, T0};
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
  // 移除边际贡献最低者：边际 = value + useBonus 下的邻接加成 + 优先级加权
  let worstIt = -1, worstGain = Infinity;
  for(let k = 0; k < curItems; k++){
    const it = placedOrder[k];
    const p = solPl[it];
    const d = ewDeltaFor(p, -1);
    const gain = -(d.base + (m.useBonus ? d.bonus : 0) + 1e-6 * (d.manW * 1e2 + d.defW) + d.adj);
    if(gain < worstGain){ worstGain = gain; worstIt = it; }
  }
  ewApplyRemove(worstIt);
  // 贪心插入最优未放件（每件摆放枚举抽样上限 48，控制热路径成本）
  let bestIt = -1, bestP = -1, bestE = 0;
  for(let it = 0; it < m.I; it++){
    if(solPl[it] >= 0) continue;
    const off = m.itemPlOff[it], len = m.itemPlLen[it];
    const step = len > 48 ? ((len / 48) | 0) || 1 : 1;
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
  // 腾出的空间优先喂未放件（通往 complete 的关键通道）：随机抽至多 2 件未放件、
  // 抽样位贪心（控制热路径成本；全枚举会把迭代速度拖垮一个量级）
  if(curItems < m.I){
    for(let trial = 0; trial < 2; trial++){
      let cnt = 0;
      for(let it = 0; it < m.I; it++) if(solPl[it] < 0) cnt++;
      if(cnt === 0) break;
      let pick = ewRandInt(cnt), missIt = -1;
      for(let k = 0; k < m.I; k++){ if(solPl[k] < 0){ if(pick === 0){ missIt = k; break; } pick--; } }
      const off = m.itemPlOff[missIt], len = m.itemPlLen[missIt];
      let bestP = -1, bestE = Infinity;
      const step = len > 48 ? ((len / 48) | 0) || 1 : 1;
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
    const step = len > 48 ? ((len / 48) | 0) || 1 : 1;
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

// ------------------------- 段式权重与轮盘赌 -------------------------
function ewInitOps(){
  opWeights = new Float64Array(6).fill(1);
  opPrefix = new Float64Array(6);
  segScores = new Float64Array(6);
  segCounts = new Float64Array(6);
}
function ewPickOp(){
  let s = 0;
  for(let i = 0; i < 6; i++){ s += opWeights[i]; opPrefix[i] = s; }
  const r = ewRand() * s;
  for(let i = 0; i < 6; i++) if(r < opPrefix[i]) return i;
  return 5;
}
function ewRunOp(op){
  if(op === 0) return ewOpRelocate();
  if(op === 1) return ewOpMoveGreedy();
  if(op === 2) return ewOpSwapPair();
  if(op === 3) return ewOpRemoveInsert();
  if(op === 4) return ewOpShuffleRegion();
  return ewOpInsertMissing();
}
function ewSegmentUpdate(){
  for(let i = 0; i < 6; i++){
    const score = segCounts[i] > 0 ? segScores[i] / segCounts[i] : 0;
    opWeights[i] = Math.min(10, Math.max(0.1, opWeights[i] * 0.9 + 0.1 * score));
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

// ------------------------- 收尾精化（确定性 1-relocate 局部最优，零 RNG 消耗） -------------------------
// SA 收尾后对当前解循环全枚举单件最优重定位，直到一轮无改进；complete 下件数不变，
// 直接收紧 total/adj 尾部差距（不受温度/接受概率干扰）。
function ewRefineSolution(){
  const m = ewModel;
  ewUndoSuspend = true;
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
  ewUndoSuspend = false; ewUndoTop = 0;
  if(ewBetterThanBest()) ewCopyToBest();
}

// ------------------------- 主搜索循环（P4：时间片分片，片间让出事件循环消化消息） -------------------------
function ewRunChunk(){
  const REHEAT_ITERS = 4096, MAX_REHEAT = 8, SEGMENT = 256;
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
    // 重热：连续 REHEAT_ITERS 无改进且重热次数未满
    if(iters - lastImproveIter >= REHEAT_ITERS && iters - ewLastReheatIter >= REHEAT_ITERS && reheatCount < MAX_REHEAT){
      curT = Math.max(Tmin, T0 * 0.5);
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
  ewRefineSolution(); // 确定性局部精化：收紧 SA 与 DFS 的尾部差距
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
      touchedList = new Int16Array(4);
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
    + 'var ewNodeLimit=0,ewLastReheatIter=0;\n';
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
    ewOpShuffleRegion, ewOpInsertMissing,
    ewInitOps, ewPickOp, ewRunOp, ewSegmentUpdate,
    ewInitialSolution, ewLoadSolution,
    ewSendProgress, ewSendDone, ewDrainMessages, ewRejectRestore,
    ewCalibrateT0, ewRefineSolution, ewRunChunk, ewFinishSearch
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
