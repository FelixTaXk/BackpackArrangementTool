// scripts/bench-model.mjs —— encBuildModel 建模阶段基准（判定「是否值得优化」的证据脚本）。
// 用法：node scripts/bench-model.mjs
import { loadLogicLayer } from './test-harness.mjs';

const { sandbox } = loadLogicLayer();
const { W, H } = sandbox;

function build(count, lockRatio = 0){
  sandbox.active = Array.from({ length: H }, () => Array(W).fill(true));
  let locked = 0;
  const want = Math.floor(W * H * lockRatio);
  for(let r = 0; r < H && locked < want; r++) for(let c = 0; c < W && locked < want; c++){ sandbox.active[r][c] = false; locked++; }
  sandbox.validateTalismanDB();
  const all = sandbox.TALISMAN_DB.talismans;
  sandbox.inventory = [];
  for(let i = 0; i < count; i++){
    const def = all[i % all.length];
    const rec = sandbox.normalizeItemRecord({ id: def.id, uid: 'u' + i, no: i + 1 });
    if(rec) sandbox.inventory.push(rec);
  }
  const t0 = process.hrtime.bigint();
  const prep = sandbox.prepareInventoryItems();
  const t1 = process.hrtime.bigint();
  const serial = prep.items.map(t => ({ ...t, placements: t.placements.map(p => ({ ...p })) }));
  const am = sandbox.buildActiveMask();
  const t2 = process.hrtime.bigint();
  const model = sandbox.encBuildModel(serial, sandbox.maskToDec(am.lo, am.hi), W, H, {
    statKeys: ['atk', 'def', 'hp'], statCount: 3, manualCount: 0,
    defaultTierCount: sandbox.DEFAULT_TIER_COUNT !== undefined ? sandbox.DEFAULT_TIER_COUNT : 10,
    useBonus: true
  });
  const t3 = process.hrtime.bigint();
  const P = model.P, I = model.I, E = model.adjPeer.length;
  return {
    items: I, P, E,
    prepMs: Number(t1 - t0) / 1e6,
    modelMs: Number(t3 - t2) / 1e6,
    pSquared: P * P
  };
}

console.log('清单件数 →  I     P      E        prepare(ms)  encBuildModel(ms)   P²');
for(const n of [10, 20, 40, 60, 100, 150]){
  const r = build(n);
  console.log(
    String(n).padStart(6),
    String(r.items).padStart(5),
    String(r.P).padStart(6),
    String(r.E).padStart(8),
    r.prepMs.toFixed(2).padStart(12),
    r.modelMs.toFixed(2).padStart(18),
    String(r.pSquared).padStart(12)
  );
}
console.log('\n注：搜索预算默认 20000ms（deep 档）。建模耗时占比 = encBuildModel / 20000。');
