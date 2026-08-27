// scripts/bench-phases.mjs —— 定位 encBuildModel 内部真实热点：
// 分别复刻「候选升序输出」（旧 O(P) 标记扫描 vs 排序）与「边表分配/写入」两段成本，
// 并核算 bundle 内存峰值。用法：node scripts/bench-phases.mjs
import { loadLogicLayer } from './test-harness.mjs';

const { sandbox } = loadLogicLayer();
const { W, H } = sandbox;

function prep(count){
  sandbox.active = Array.from({ length: H }, () => Array(W).fill(true));
  sandbox.validateTalismanDB();
  const all = sandbox.TALISMAN_DB.talismans;
  sandbox.inventory = [];
  for(let i = 0; i < count; i++){
    const def = all[i % all.length];
    const rec = sandbox.normalizeItemRecord({ id: def.id, uid: 'u' + i, no: i + 1 });
    if(rec) sandbox.inventory.push(rec);
  }
  const p = sandbox.prepareInventoryItems();
  return p.items.map(t => ({ ...t, placements: t.placements.map(x => ({ ...x })) }));
}

console.log('件数    P      E         model(ms)  bundle(ms)  边表字节     bundle字节    合计MB');
for(const n of [40, 100, 150]){
  const serial = prep(n);
  const am = sandbox.buildActiveMask();
  const amStr = sandbox.maskToDec(am.lo, am.hi);
  const opts = { statKeys: ['atk', 'def', 'hp'], statCount: 3, manualCount: 0, defaultTierCount: 6, useBonus: true };

  const t0 = process.hrtime.bigint();
  const model = sandbox.encBuildModel(serial, amStr, W, H, opts);
  const t1 = process.hrtime.bigint();
  const bundle = sandbox.encBundleModel ? sandbox.encBundleModel(model) : null;
  const t2 = process.hrtime.bigint();

  const E = model.adjPeer.length;
  // 边表：adjPeer(Uint32) + adjBonus/adjManW/adjDefW(Float64×3) + adjFlat(Int32) + adjOff(Uint32)
  const edgeBytes = E * 4 + E * 8 * 3 + E * 4 + (model.P + 1) * 4;
  const bundleBytes = bundle && bundle.buffer ? bundle.buffer.byteLength : (bundle && bundle.byteLength) || 0;
  console.log(
    String(n).padStart(4),
    String(model.P).padStart(6),
    String(E).padStart(9),
    (Number(t1 - t0) / 1e6).toFixed(1).padStart(10),
    (Number(t2 - t1) / 1e6).toFixed(1).padStart(11),
    String(edgeBytes).padStart(11),
    String(bundleBytes).padStart(12),
    ((edgeBytes + bundleBytes) / 1048576).toFixed(1).padStart(8)
  );
}

// 单独对比「升序输出」两种策略：O(P) 标记扫描 vs 本行候选排序
console.log('\n升序输出策略对比（合成：P 行，每行 n 个候选）');
console.log('  P     n    标记扫描O(P²)ms   候选排序O(n log n)ms   胜者');
for(const [P, n] of [[1180, 400], [3018, 900], [4536, 1400], [3018, 60], [4536, 100]]){
  const candMark = new Int32Array(P);
  const scratch = new Int32Array(P);
  const out = new Int32Array(P * 2);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // 预生成每行候选（同一批数据喂给两种策略）
  const rows = [];
  for(let a = 0; a < P; a++){
    const s = new Set();
    while(s.size < n) s.add(Math.floor(rnd() * P));
    rows.push([...s]);
  }
  // A：标记扫描
  let ta0 = process.hrtime.bigint(), sink = 0, epoch = 0;
  for(let a = 0; a < P; a++){
    epoch++;
    for(const b of rows[a]) candMark[b] = epoch;
    let e = 0;
    for(let b = 0; b < P; b++) if(candMark[b] === epoch) out[e++] = b;
    sink += e;
  }
  let ta1 = process.hrtime.bigint();
  // B：候选排序
  let tb0 = process.hrtime.bigint(), sink2 = 0;
  for(let a = 0; a < P; a++){
    const row = rows[a];
    let k = 0;
    for(const b of row) scratch[k++] = b;
    const view = scratch.subarray(0, k);
    view.sort();
    for(let i = 0; i < k; i++) out[i] = view[i];
    sink2 += k;
  }
  let tb1 = process.hrtime.bigint();
  const msA = Number(ta1 - ta0) / 1e6, msB = Number(tb1 - tb0) / 1e6;
  console.log(
    String(P).padStart(5), String(n).padStart(5),
    msA.toFixed(1).padStart(16), msB.toFixed(1).padStart(22),
    '  ' + (msA < msB ? '标记扫描' : '候选排序') + `（${(Math.max(msA, msB) / Math.min(msA, msB)).toFixed(2)}×）`,
    sink === sink2 ? '' : ' [数据不一致!]'
  );
}
