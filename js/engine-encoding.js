'use strict';
// ============================================================================
// engine-encoding.js —— “超越版求解引擎”编码层（期 1 基础层）
// ----------------------------------------------------------------------------
// 职责：
//   1. 把主线程 serialItems（js/solver.js 产出，placements.mask 为十进制 BigInt 字符串）
//      编码为 SoA（Structure of Arrays）紧凑模型 + CSR 邻接对表；
//   2. 打包为单个 8 字节对齐的 ArrayBuffer（Transferable），零拷贝 postMessage 进 Worker；
//   3. Worker 内 encDecodeBundle 零拷贝视图重建；
//   4. 主线程 encRebuildBest 实现“晋级全算”闸门：从 Worker 回传的摆放下标数组
//      全量重建 placements → scoreEvaluateConcrete 重算 → scoreSerializeBest 序列化。
// 约定：经典 script，全部顶层纯函数；BigInt 仅允许在 encParseMask 构建期使用，
//      热路径（评分/搜索）一律双 Uint32（lo/hi）。评分复用 score-shared.js 的 score* 函数。
// ============================================================================

// 十进制掩码字符串 → {lo,hi} 双 Uint32。掩码 ≤42 位，double 表示精确，
// 直接数值拆分免 BigInt 开销（>53 位才回退 BigInt，仅作防御）
function encParseMask(decStr){
  if(decStr.length <= 15){
    const n = Number(decStr);
    return {lo: n % 4294967296, hi: Math.floor(n / 4294967296)};
  }
  const m = BigInt(decStr);
  return {lo: Number(m & 0xFFFFFFFFn), hi: Number(m >> 32n)};
}

// 42 位内掩码数值对 → 十进制字符串（Number 精确：hi*4294967296+lo）
function encMaskToDec(lo, hi){
  return String(hi * 4294967296 + lo);
}

// 由 cellsFlat（r*W+c 索引）构建外圈邻接掩码 {lo,hi}（对齐旧 makeNeighborMask 语义：四方向外圈）
function encMakeNeighborLoHi(cellsFlat, W, H){
  let lo = 0, hi = 0;
  const set = idx => {
    if(idx >= 32) hi = (hi | (1 << (idx - 32))) >>> 0;
    else lo = (lo | (1 << idx)) >>> 0;
  };
  for(const idx of cellsFlat){
    const r = Math.floor(idx / W), c = idx % W;
    if(r > 0) set((r - 1) * W + c);
    if(r + 1 < H) set((r + 1) * W + c);
    if(c > 0) set(r * W + (c - 1));
    if(c + 1 < W) set(r * W + (c + 1));
  }
  return {lo, hi};
}

function encKindOf(bonusKind){
  if(bonusKind === 'provider') return 1;
  if(bonusKind === 'self') return 2;
  return 0;
}

function encKindName(kind){
  return kind === 1 ? 'provider' : kind === 2 ? 'self' : 'none';
}

function encStatVec(v, K){
  const out = new Array(K).fill(0);
  if(Array.isArray(v)){ for(let k = 0; k < K; k++){ const x = Number(v[k]); out[k] = Number.isFinite(x) && x > 0 ? x : 0; } }
  return out;
}

// 单件物品的优先级加权贡献（权重公式与旧 L148-149 一致：1e8/1e5 × max(1,len-i)）
function encPriorityWeight(manualOrder, priorityTier, manualCount, defaultTierCount){
  let w = 0;
  if(manualOrder >= 0 && manualOrder < manualCount) w += 100000000 * Math.max(1, manualCount - manualOrder);
  else if(priorityTier >= 0 && priorityTier < defaultTierCount) w += 100000 * Math.max(1, defaultTierCount - priorityTier);
  return w;
}

// ----------------------------------------------------------------------------
// encBuildModel：serialItems + activeMaskStr + W/H + opts → SoA 模型 + CSR 对表
// opts = {statKeys, statCount, manualCount, defaultTierCount, useBonus}
// ----------------------------------------------------------------------------
function encBuildModel(serialItems, activeMaskStr, W, H, opts){
  const K = Math.max(0, Number(opts.statCount) || 0);
  const manualCount = Number(opts.manualCount) || 0;
  const defaultTierCount = Number(opts.defaultTierCount) || 0;
  const useBonus = !!opts.useBonus;
  const L = Math.ceil(W * H / 32);
  const activeMask = encParseMask(activeMaskStr);
  const cellCount = (function(){ let n = 0, lo = activeMask.lo, hi = activeMask.hi;
    while(lo){ lo &= lo - 1; n++; } while(hi){ hi &= hi - 1; n++; } return n; })();
  const I = serialItems.length;
  let P = 0, totalCells = 0;
  for(const t of serialItems){ P += t.placements.length; totalCells += t.placements.length * t.cells.length; }

  // ---- Placement SoA ----
  const plMask = new Uint32Array(P * L);
  const plNbr = new Uint32Array(P * L);
  const plItem = new Uint16Array(P);
  const plArea = new Uint8Array(P);
  const plCellsOff = new Uint32Array(P);
  const plCellsLen = new Uint16Array(P);
  const cellsFlat = new Uint8Array(totalCells);       // 每个格子的 r*W+c 索引
  const plCellsXY = new Uint8Array(totalCells * 2);   // 重建用扁平 [[r,c]]：[r0,c0,r1,c1,...]

  // ---- Item SoA ----
  const itemValue = new Float64Array(I);
  const itemStats = new Float64Array(I * K);
  const itemRates = new Float64Array(I * K);
  const itemKind = new Uint8Array(I);          // 0=none 1=provider 2=self
  const itemManual = new Int16Array(I);        // manualOrder（-1 表示无）
  const itemTier = new Int8Array(I);           // priorityTier（-1 表示无）
  const itemPlOff = new Uint32Array(I);
  const itemPlLen = new Uint16Array(I);
  const itemMeta = [];                         // 原始数据（no/itemName/quality/stats/rates/cells 等），不进 bundle

  let p = 0, cellPtr = 0;
  for(let i = 0; i < I; i++){
    const t = serialItems[i];
    const sv = encStatVec(t.stats, K), rv = encStatVec(t.rates, K);
    itemValue[i] = Number(t.value) || 0;
    itemKind[i] = encKindOf(t.bonusKind);
    itemManual[i] = t.manualOrder >= 0 ? t.manualOrder : -1;
    itemTier[i] = t.priorityTier >= 0 ? t.priorityTier : -1;
    for(let k = 0; k < K; k++){ itemStats[i * K + k] = sv[k]; itemRates[i * K + k] = rv[k]; }
    itemPlOff[i] = p;
    itemPlLen[i] = t.placements.length;
    itemMeta.push({
      no: t.no, uid: t.uid, itemName: t.name, typeName: t.typeName, quality: t.quality,
      cells: t.cells.map(c => c.slice()),
      stats: (t.stats || []).slice(), rates: (t.rates || []).slice(),
      customPriority: t.customPriority
    });
    for(const pl of t.placements){
      const m = encParseMask(pl.mask);
      const len = pl.cells.length;
      plMask[p * L] = m.lo;
      if(L > 1) plMask[p * L + 1] = m.hi;
      const flat = pl.cells.map(([r, c]) => r * W + c);
      const nbr = encMakeNeighborLoHi(flat, W, H);
      plNbr[p * L] = nbr.lo;
      if(L > 1) plNbr[p * L + 1] = nbr.hi;
      plItem[p] = i;
      plArea[p] = len;
      plCellsOff[p] = cellPtr;
      plCellsLen[p] = len;
      for(let c2 = 0; c2 < len; c2++){
        const idx = flat[c2];
        cellsFlat[cellPtr + c2] = idx;
        plCellsXY[(cellPtr + c2) * 2] = Math.floor(idx / W);
        plCellsXY[(cellPtr + c2) * 2 + 1] = idx % W;
      }
      cellPtr += len;
      p++;
    }
  }

  // ---- CSR 邻接对表：几何相邻（双向 OR）的物品摆放对 ----
  // 格子桶法：按格子登记占用摆放，仅对“占用同一格或相邻格”的摆放对做判定，复杂度由
  // O(P²) 降为 O(Σ桶内对)；同趟预算每摆放外圈环表（csrRingOff/csrRingCell），枚举阶段
  // 免逐格 r/c 运算与边界分支。候选排序后逐项判定，输出与全对扫描逐字一致。
  const cellBucket = new Array(W * H);
  for(let c = 0; c < W * H; c++) cellBucket[c] = [];
  const csrRingOff = new Uint32Array(P + 1);
  const csrRingCell = new Uint16Array(totalCells * 4); // 每格最多 4 个外圈邻居（去重后更少）
  const ringStamp = new Int32Array(W * H);
  let ringEpoch = 0, ringT = 0;
  for(let a = 0; a < P; a++){
    const off = plCellsOff[a], len = plCellsLen[a];
    csrRingOff[a] = ringT;
    ringEpoch++;
    for(let k = 0; k < len; k++){
      const cell = cellsFlat[off + k];
      cellBucket[cell].push(a);
      const r = (cell / W) | 0, c = cell % W;
      if(r > 0 && ringStamp[cell - W] !== ringEpoch){ ringStamp[cell - W] = ringEpoch; csrRingCell[ringT++] = cell - W; }
      if(r + 1 < H && ringStamp[cell + W] !== ringEpoch){ ringStamp[cell + W] = ringEpoch; csrRingCell[ringT++] = cell + W; }
      if(c > 0 && ringStamp[cell - 1] !== ringEpoch){ ringStamp[cell - 1] = ringEpoch; csrRingCell[ringT++] = cell - 1; }
      if(c + 1 < W && ringStamp[cell + 1] !== ringEpoch){ ringStamp[cell + 1] = ringEpoch; csrRingCell[ringT++] = cell + 1; }
    }
  }
  csrRingOff[P] = ringT;
  const seenStamp = new Int32Array(P);
  let stampEpoch = 0;
  const scratch = new Int32Array(P); // 候选计数暂存（容量上界）；升序输出改由 candMark 线性扫描产出
  const candMark = new Int32Array(P); // 候选标记：candMark[b]===stampEpoch 则 b 为本行候选（扫描 b=0..P-1 即升序）
  const plItemJ = new Array(P);      // JS 数组缓存热字段，避免逐候选的 TypedArray 读取
  for(let x = 0; x < P; x++) plItemJ[x] = plItem[x];
  const cellStamp = new Int32Array(W * H); // 外圈格子级去重：同一外圈格只扫一次桶（用 a+1 作戳，免 epoch 维护）
  const adjOffTmp = new Uint32Array(P + 1);
  let adjBuf = new Int32Array(Math.max(1024, P * 32)); // 倍增容量，收尾截断，免逐元素 push
  let eFlat = 0;
  for(let a = 0; a < P; a++){
    stampEpoch++;
    const itA = plItemJ[a];
    let n = 0;
    // 纯外圈枚举：b 相邻 a ⟺ b 占用 a 外圈任一格（外圈 = 各格四邻居去重并集，环表已预算）。
    // U 形自邻（自身格属外圈）自然覆盖；几何保证免掩码 AND，逐字等价旧暴力口径。
    const rn0 = csrRingOff[a], rn1 = csrRingOff[a + 1];
    for(let e = rn0; e < rn1; e++){
      const rc = csrRingCell[e];
      if(cellStamp[rc] === a + 1) continue; // 格子级去重：同一外圈格只扫一次桶（epoch=a+1 免清零）
      cellStamp[rc] = a + 1;
      const bucket = cellBucket[rc];
      for(let t = 0; t < bucket.length; t++){
        const b = bucket[t];
        if(b === a || seenStamp[b] === stampEpoch) continue;
        seenStamp[b] = stampEpoch;
        if(plItemJ[b] !== itA){ scratch[n++] = b; candMark[b] = stampEpoch; } // 同件物品不同摆放互斥，不必入表
      }
    }
    adjOffTmp[a] = eFlat;
    if(eFlat + n > adjBuf.length){
      const nb = new Int32Array(Math.max(adjBuf.length * 2, eFlat + n));
      nb.set(adjBuf.subarray(0, eFlat));
      adjBuf = nb;
    }
    // 升序输出：线性扫描标记（O(P)，免逐行比较排序；与旧全对扫描遍历顺序一致，CSR 内容逐字不变）
    for(let b = 0; b < P; b++){
      if(candMark[b] === stampEpoch) adjBuf[eFlat++] = b;
    }
  }
  adjOffTmp[P] = eFlat;
  const E = eFlat;
  const adjOff = adjOffTmp;
  const adjFlat = adjBuf.subarray(0, E);
  const adjPeer = new Uint32Array(E);
  const adjBonus = new Float64Array(E);  // = scorePotentialPairBonus 精确值
  const adjManW = new Float64Array(E);   // 双向手动优先级加权和
  const adjDefW = new Float64Array(E);   // 双向默认优先级加权和
  // 物品对预计算：adjBonus/adjManW/adjDefW 只依赖物品对而非摆放对，
  // 预算 I×I 表后边循环仅查表（避免逐边调用 scorePotentialPairBonus）
  const tmpA = {sv:null, rv:null, bonusKind:'none'}, tmpB = {sv:null, rv:null, bonusKind:'none'};
  const pairBonusTable = new Float64Array(I * I);
  const itemMw = new Float64Array(I), itemDw = new Float64Array(I);
  for(let i = 0; i < I; i++){
    itemMw[i] = itemManual[i] >= 0 ? 100000000 * Math.max(1, manualCount - itemManual[i]) : 0;
    itemDw[i] = (itemManual[i] < 0 && itemTier[i] >= 0) ? 100000 * Math.max(1, defaultTierCount - itemTier[i]) : 0;
    tmpA.sv = itemStats.subarray(i * K, i * K + K);
    tmpA.rv = itemRates.subarray(i * K, i * K + K);
    tmpA.bonusKind = encKindName(itemKind[i]);
    for(let j = 0; j < I; j++){
      if(i === j) continue;
      tmpB.sv = itemStats.subarray(j * K, j * K + K);
      tmpB.rv = itemRates.subarray(j * K, j * K + K);
      tmpB.bonusKind = encKindName(itemKind[j]);
      pairBonusTable[i * I + j] = scorePotentialPairBonus(tmpA, tmpB);
    }
  }
  // JS 数组缓存：边循环查表免 TypedArray 读取；行不变量（mwA/dwA）外提
  const itemMwJ = Array.from(itemMw), itemDwJ = Array.from(itemDw), pairBonusJ = Array.from(pairBonusTable);
  let e = 0;
  for(let a = 0; a < P; a++){
    const ia = plItemJ[a], iaI = ia * I;
    const mwA = itemMwJ[ia], dwA = itemDwJ[ia];
    const end = adjOff[a + 1];
    for(let t = adjOff[a]; t < end; t++){
      const b = adjFlat[t], ib = plItemJ[b];
      adjPeer[e] = b;
      adjBonus[e] = pairBonusJ[iaI + ib];
      adjManW[e] = mwA + itemMwJ[ib];  // 双向手动优先级加权和
      adjDefW[e] = dwA + itemDwJ[ib];  // 双向默认优先级加权和
      e++;
    }
  }

  // globalMaxBonus：所有无序物品对 potential 之和（对齐旧 L242-245 语义，复用预计算表）
  let globalMaxBonus = 0;
  if(useBonus){
    for(let i = 0; i < I; i++){
      for(let j = i + 1; j < I; j++) globalMaxBonus += pairBonusTable[i * I + j];
    }
  }

  return {
    W, H, L, I, K, P, cellCount,
    manualCount, defaultTierCount, useBonus,
    statKeys: (opts.statKeys || []).slice(),
    activeMask, globalMaxBonus,
    plMask, plNbr, plItem, plArea, plCellsOff, plCellsLen, cellsFlat, plCellsXY,
    itemValue, itemStats, itemRates, itemKind, itemManual, itemTier, itemPlOff, itemPlLen,
    itemMeta,
    adjOff, adjPeer, adjBonus, adjManW, adjDefW
  };
}

// ----------------------------------------------------------------------------
// bundle：所有 TypedArray 按 8 字节对齐拼接成单个 ArrayBuffer（itemMeta 除外）。
// 布局：头部 40 字节标量（Int32×10）+ 各数组段。offsets 为纯 JSON 可序列化对象。
// ----------------------------------------------------------------------------
function encBundleTables(){
  return [
    'plMask', 'plNbr', 'plItem', 'plArea', 'plCellsOff', 'plCellsLen', 'cellsFlat', 'plCellsXY',
    'itemValue', 'itemStats', 'itemRates', 'itemKind', 'itemManual', 'itemTier', 'itemPlOff', 'itemPlLen',
    'adjOff', 'adjPeer', 'adjBonus', 'adjManW', 'adjDefW'
  ];
}

function encBuildBundle(model){
  const HEAD = 40; // 10 个 Int32 标量：W H L I K P manualCount defaultTierCount useBonus cellCount
  const tables = encBundleTables();
  let size = HEAD;
  const segs = [];
  for(const name of tables){
    const arr = model[name];
    const start = size;
    size += arr.byteLength;
    size = (size + 7) & ~7; // 8 字节对齐
    segs.push({name, arr, start});
  }
  const buffer = new ArrayBuffer(size);
  const fullView = new Uint8Array(buffer); // 单次全缓冲视图：段拷贝走字节 memcpy，免逐段 TypedArray 构造
  const head = new Int32Array(buffer, 0, 10);
  head[0] = model.W; head[1] = model.H; head[2] = model.L; head[3] = model.I; head[4] = model.K;
  head[5] = model.P; head[6] = model.manualCount; head[7] = model.defaultTierCount;
  head[8] = model.useBonus ? 1 : 0; head[9] = model.cellCount;
  const offsets = {
    head: 0,
    activeMaskLo: model.activeMask.lo, activeMaskHi: model.activeMask.hi,
    globalMaxBonus: model.globalMaxBonus,
    statKeys: model.statKeys.slice()
  };
  for(const s of segs){
    fullView.set(new Uint8Array(s.arr.buffer, s.arr.byteOffset, s.arr.byteLength), s.start);
    offsets[s.name] = {byteOffset: s.start, length: s.arr.length};
  }
  return {buffer, offsets};
}

// Worker 内重建模型视图（顶层可序列化：只依赖参数与 TypedArray 构造器）
function encDecodeBundle(buffer, offsets){
  const head = new Int32Array(buffer, offsets.head, 10);
  const model = {
    W: head[0], H: head[1], L: head[2], I: head[3], K: head[4], P: head[5],
    manualCount: head[6], defaultTierCount: head[7], useBonus: !!head[8], cellCount: head[9],
    activeMask: {lo: offsets.activeMaskLo, hi: offsets.activeMaskHi},
    globalMaxBonus: offsets.globalMaxBonus,
    statKeys: offsets.statKeys || []
  };
  const TYPES = {
    plMask: Uint32Array, plNbr: Uint32Array, plItem: Uint16Array, plArea: Uint8Array,
    plCellsOff: Uint32Array, plCellsLen: Uint16Array, cellsFlat: Uint8Array, plCellsXY: Uint8Array,
    itemValue: Float64Array, itemStats: Float64Array, itemRates: Float64Array, itemKind: Uint8Array,
    itemManual: Int16Array, itemTier: Int8Array, itemPlOff: Uint32Array, itemPlLen: Uint16Array,
    adjOff: Uint32Array, adjPeer: Uint32Array, adjBonus: Float64Array, adjManW: Float64Array, adjDefW: Float64Array
  };
  for(const name of encBundleTables()){
    const meta = offsets[name];
    model[name] = new TYPES[name](buffer, meta.byteOffset, meta.length);
  }
  return model;
}

// ----------------------------------------------------------------------------
// encRebuildBest：晋级全算闸门（主线程实现）。
// solPlInt32：Worker 回传的摆放下标数组（Int32Array）；从 SoA 模型全量重建 placements，
// 经 scoreEvaluateConcrete 重算后 scoreSerializeBest 序列化，返回与旧版键集一致的 best。
// ctx = {statCount, useBonus, manualCount, defaultTierCount, totalItems(可选)}
// ----------------------------------------------------------------------------
function encRebuildBest(solPlInt32, model, ctx){
  const K = ctx.statCount !== undefined ? Number(ctx.statCount) : model.K;
  const W = model.W;
  const placements = [];
  for(let s = 0; s < solPlInt32.length; s++){
    const p = solPlInt32[s];
    if(p < 0) continue; // 未放件：与旧引擎口径一致（placements 只含已放件）
    const i = model.plItem[p];
    const meta = model.itemMeta[i];
    const cells = [];
    const off = model.plCellsOff[p], len = model.plCellsLen[p];
    for(let c = 0; c < len; c++) cells.push([model.plCellsXY[(off + c) * 2], model.plCellsXY[(off + c) * 2 + 1]]);
    const maskLo = model.plMask[p * model.L], maskHi = model.L > 1 ? model.plMask[p * model.L + 1] : 0;
    const nbrLo = model.plNbr[p * model.L], nbrHi = model.L > 1 ? model.plNbr[p * model.L + 1] : 0;
    placements.push({
      no: meta.no, uid: meta.uid, itemName: meta.itemName, typeName: meta.typeName,
      quality: meta.quality, cells, area: model.plArea[p],
      value: model.itemValue[i],
      stats: meta.stats.slice(), rates: meta.rates.slice(),
      sv: Array.from(model.itemStats.subarray(i * K, i * K + K)),
      rv: Array.from(model.itemRates.subarray(i * K, i * K + K)),
      bonusKind: encKindName(model.itemKind[i]),
      priorityTier: model.itemTier[i],
      customPriority: meta.customPriority,
      manualOrder: model.itemManual[i],
      itemIndex: i,
      placementIndex: p - model.itemPlOff[i],
      lo: maskLo, hi: maskHi, nbrLo, nbrHi,
      mask: {lo: maskLo, hi: maskHi},
      neighborMask: {lo: nbrLo, hi: nbrHi}
    });
  }
  const evalCtx = {
    statCount: K,
    useBonus: ctx.useBonus !== undefined ? !!ctx.useBonus : !!model.useBonus,
    manualCount: ctx.manualCount !== undefined ? Number(ctx.manualCount) : model.manualCount,
    defaultTierCount: ctx.defaultTierCount !== undefined ? Number(ctx.defaultTierCount) : model.defaultTierCount,
    totalItems: ctx.totalItems !== undefined ? Number(ctx.totalItems) : model.I
  };
  const best = scoreEvaluateConcrete(placements, evalCtx);
  // placements 项键集与 legacy 路径（solver-worker.js serializeBest）逐键一致：
  // 剔除 scoreViewOf 注入的内部视图键 lo/hi/nbrLo/nbrHi，补 geometryGroupIndex（SA 侧恒 null）
  best.placements = best.placements.map(p => ({
    mask: p.mask, neighborMask: p.neighborMask, cells: p.cells,
    placementIndex: p.placementIndex, itemIndex: p.itemIndex,
    uid: p.uid, no: p.no, itemName: p.itemName, typeName: p.typeName,
    area: p.area, quality: p.quality, value: p.value,
    stats: p.stats, rates: p.rates, sv: p.sv, rv: p.rv,
    bonusKind: p.bonusKind, priorityTier: p.priorityTier, customPriority: p.customPriority,
    manualOrder: p.manualOrder,
    geometryGroupIndex: p.geometryGroupIndex ?? null
  }));
  return scoreSerializeBest(best, ctx.statKeys || model.statKeys, K);
}

if(typeof window !== 'undefined'){
  window.encParseMask = encParseMask;
  window.encMaskToDec = encMaskToDec;
  window.encMakeNeighborLoHi = encMakeNeighborLoHi;
  window.encBuildModel = encBuildModel;
  window.encBundleTables = encBundleTables;
  window.encBuildBundle = encBuildBundle;
  window.encDecodeBundle = encDecodeBundle;
  window.encRebuildBest = encRebuildBest;
}
