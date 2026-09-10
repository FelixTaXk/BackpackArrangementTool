// scripts/ab-clustering.mjs —— A/B 对照：同种子同预算下，「软键开 / 关」两版排序的产出对比。
//
// 目的：隔离「软键（抱团 + rate-only 命中）」对 SA 的影响。
//   开 = 现状（noBase/same 入能量标量 + 入字典序）
//   关 = 把软键权重归零（能量标量去掉 1e-5 项、字典序跳过 nb/sm），其余完全一致
//
// 用法：node scripts/ab-clustering.mjs [结果文件] [时间ms]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadLogicLayer } from './test-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const resultPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'bag-solver-result.json');
const TIME = Math.max(1000, Number(process.argv[3]) || 8000);
const SRC = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const W = SRC.width, H = SRC.height;

function build() {
  const G = loadLogicLayer().sandbox;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/engine-worker.js'), 'utf8'), G, { filename: 'js/engine-worker.js' });
  const DB = G.window.TALISMAN_DB;
  const statKeys = DB.bonusStats.map(s => s.id), statCount = statKeys.length;
  G.active = Array.from({ length: H }, () => Array(W).fill(true));
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (SRC.active && SRC.active[r] && SRC.active[r][c] === false) G.active[r][c] = false;
  G.validateTalismanDB();
  G.inventory = SRC.inventory.map((inv, i) => G.normalizeItemRecord({ id: inv.id, uid: inv.uid || ('u' + i), no: inv.no || (i + 1) }));
  const prep = G.prepareInventoryItems();
  let lo = 0, hi = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { if (!G.active[r][c]) continue; const b = r * W + c; if (b < 32) lo = (lo | (1 << b)) >>> 0; else hi = (hi | (1 << (b - 32))) >>> 0; }
  const maskStr = String(hi * 4294967296 + lo);
  const model = G.encBuildModel(prep.items, maskStr, W, H, { statKeys, statCount, rateOnlyFromK: 3, manualCount: 0, defaultTierCount: 25, useBonus: true });
  const bundle = G.encBuildBundle(model);
  return { G, DB, statKeys, statCount, model, bundle, prepared: prep.items };
}

async function run(softKeysOn, seedOffset) {
  const { G, statKeys, statCount, model, bundle, prepared } = build();
  let src = G.engWorkerStateDecls()
    + G.engWorkerPartFunctions().map(f => f.toString()).join('\n')
    + '\n(' + G.engineWorkerMain.toString() + ')();';
  if (!softKeysOn) {
    // 关软键：能量标量去掉 nb/sm 项；字典序跳过 nb/sm 两键。
    src = src.replace(
      /return -\(\(c \? 1e12 : 0\) \+ total \+ items \+ 1e-3 \* adj \+ 1e-4 \* area \+ 1e-5 \* nb \+ 1e-5 \* sm\);/,
      'return -((c ? 1e12 : 0) + total + items + 1e-3 * adj + 1e-4 * area);'
    ).replace(
      /if\(nb1 !== nb2\) return nb1 > nb2;\s*if\(sm1 !== sm2\) return sm1 > sm2;/,
      ''
    );
    if (src.includes('1e-5 * nb') || src.includes('if(nb1 !== nb2)')) {
      throw new Error('软键关闭改写未生效 —— 源码模式已漂移，请更新正则');
    }
  }
  let done = null;
  const wctx = { console: { log() {}, warn() {}, error: console.error }, setTimeout, clearTimeout, performance: { now: () => Date.now() } };
  wctx.self = wctx; wctx.globalThis = wctx;
  wctx.postMessage = (m) => { if (m && m.type === 'done') done = { sol: Int32Array.from(m.sol), parts: Object.assign({}, m.parts) }; };
  vm.createContext(wctx);
  vm.runInContext(src, wctx, { filename: 'blob.js' });
  wctx.onmessage({ data: { type: 'init', buffer: bundle.buffer.slice(0), offsets: bundle.offsets, meta: { seedOffset, nodeLimit: 20000000, timeLimit: TIME, useBonus: true, requiredTotalItems: prepared.length, tempIndex: 0, lnsEnabled: true } } });
  const t0 = Date.now();
  while (!done && Date.now() - t0 < TIME + 8000) await new Promise(r => setTimeout(r, 100));
  return { G, model, done, prepared, statKeys, statCount };
}

const decToLoHi = (s) => { const n = Number(s) || 0; const hi = Math.floor(n / 4294967296); return { lo: n - hi * 4294967296, hi }; };
function evalDone(res) {
  if (!res.done) return null;
  const evalCtx = { statCount: res.statCount, useBonus: true, manualCount: 0, defaultTierCount: 25, totalItems: res.prepared.length, statKeys: res.statKeys, rateOnlyFromK: 3 };
  const b = res.G.encRebuildBest(res.done.sol, res.model, evalCtx);
  const placements = b.placements.map(p => Object.assign({}, p, {
    lo: decToLoHi(p.mask).lo, hi: decToLoHi(p.mask).hi,
    nbrLo: decToLoHi(p.neighborMask).lo, nbrHi: decToLoHi(p.neighborMask).hi
  }));
  return res.G.scoreEvaluateConcrete(placements, evalCtx);
}

console.log('════════ A/B 对照：软键开 vs 关 ════════');
console.log(`清单 ${SRC.inventory.length} 件  尺寸 ${W}×${H}  预算 ${TIME}ms  旧结果 total=${SRC.best.totalScore}`);
console.log('');

for (const seed of [1, 7, 42]) {
  const on = evalDone(await run(true, seed));
  const off = evalDone(await run(false, seed));
  const f = (g) => g ? `total=${g.totalScore} bonus=${g.bonusScore} adj=${g.adjacencyCount} same=${g.sameAdjCount} nb=${g.noBaseHitCount}` : 'null';
  console.log(`── seed=${seed} ──`);
  console.log(`  软键关：${f(off)}`);
  console.log(`  软键开：${f(on)}`);
  if (on && off) {
    const dl = on.totalScore - off.totalScore;
    console.log(`  Δtotal=${dl >= 0 ? '+' : ''}${dl}  Δsame=${on.sameAdjCount - off.sameAdjCount}  Δnb=${on.noBaseHitCount - off.noBaseHitCount}`);
  }
  console.log('');
}
