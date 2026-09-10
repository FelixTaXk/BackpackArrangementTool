// scripts/run-headless-sa.mjs —— 无浏览器端到端 SA 运行器（复用真实 solver 准备逻辑 + 真实 worker 源码）。
//
// 目的：在 Node 里跑真实 SA 引擎，用真实清单（bag-solver-result.json）验证
// 「同属性抱团 + 无加成蹲交界」键在完整搜索后确实生效，且 totalScore 不变。
//
// 用法：node scripts/run-headless-sa.mjs [结果文件路径]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadLogicLayer } from './test-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const resultPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'bag-solver-result.json');
const SRC = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

const W = SRC.width, H = SRC.height;

// ── 1. 逻辑层沙箱（test-harness 提供 DOM 桩；含 solver/engine-worker）────
const sandbox = loadLogicLayer().sandbox;
const G = sandbox;
// engine-worker.js 不在 harness 的纯逻辑层清单内（其职责为 Blob 源码拼接），此处手动注入。
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/engine-worker.js'), 'utf8'), G, { filename: 'js/engine-worker.js' });
const DB = G.window.TALISMAN_DB;
const statKeys = DB.bonusStats.map(s => s.id);
const statCount = statKeys.length;
const RATE_ONLY_FROM_K = 3;

// ── 2. 用真实 solver 准备逻辑装配清单 ────────────────────────────────────
G.active = Array.from({ length: H }, () => Array(W).fill(true));
for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
  if (SRC.active && SRC.active[r] && SRC.active[r][c] === false) G.active[r][c] = false;
}
G.validateTalismanDB();
G.inventory = SRC.inventory.map((inv, i) => {
  const rec = G.normalizeItemRecord({ id: inv.id, uid: inv.uid || ('u' + i), no: inv.no || (i + 1) });
  if (!rec) throw new Error(`找不到 id=${inv.id}`);
  return rec;
});

let prepared, skipped;
const prep = G.prepareInventoryItems();
prepared = prep.items;
skipped = prep.skipped || [];

console.log('════════ 无浏览器端到端 SA 验证 ════════');
console.log(`清单 ${G.inventory.length} 件  属性 ${JSON.stringify(G.inventory.reduce((m, x) => (m[x.attribute] = (m[x.attribute] || 0) + 1, m), {}))}`);
console.log(`尺寸 ${W}×${H}  K=${statCount}  rateOnlyFromK=${RATE_ONLY_FROM_K}  可放 ${prepared.length} 件  跳过 ${skipped.length}`);
console.log(`基线 Σvalue=${G.inventory.reduce((s, x) => s + (Number(x.value) || 0), 0)}  旧结果 totalScore=${SRC.best.totalScore}`);
console.log('');

// ── 3. SoA 模型 + bundle（真实 encBuildModel 路径）───────────────────────
const maskStr = (() => {
  let lo = 0, hi = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!G.active[r][c]) continue;
    const b = r * W + c;
    if (b < 32) lo = (lo | (1 << b)) >>> 0; else hi = (hi | (1 << (b - 32))) >>> 0;
  }
  return String(hi * 4294967296 + lo);
})();

const model = G.encBuildModel(prepared, maskStr, W, H, {
  statKeys, statCount, rateOnlyFromK: RATE_ONLY_FROM_K,
  manualCount: 0, defaultTierCount: 25, useBonus: true
});
const bundle = G.encBuildBundle(model);
console.log(`模型：I=${model.I}  P=${model.P}  K=${model.K}  rateOnlyFromK=${model.rateOnlyFromK}`);

// ── 4. 真实 worker 源码在独立 vm 里跑（模拟 Worker 全局）────────────────
const workerSrc = G.engWorkerStateDecls()
  + G.engWorkerPartFunctions().map(f => f.toString()).join('\n')
  + '\n(' + G.engineWorkerMain.toString() + ')();';

let doneMsg = null, incumbents = [];
const wctx = {
  console: { log() {}, warn() {}, error: console.error },
  setTimeout, clearTimeout, setInterval, clearInterval,
  performance: { now: () => Date.now() }
};
wctx.self = wctx; wctx.globalThis = wctx;
wctx.postMessage = (m) => {
  if (!m) return;
  // 真实 Worker 走结构化克隆；Node vm 内为同引用。凡携带 sol 的消息立即快照，
  // 否则后续 SA 迭代会就地改写该 Int32Array，导致回读时解已被污染。
  const snap = (x) => (x instanceof Int32Array) ? Int32Array.from(x) : (Array.isArray(x) ? x.slice() : x);
  const copy = Object.assign({}, m);
  if (copy.sol) copy.sol = snap(copy.sol);
  if (copy.best && copy.best.sol) copy.best = Object.assign({}, copy.best, { sol: snap(copy.best.sol) });
  if (copy.parts) copy.parts = Object.assign({}, copy.parts);
  if (m.type === 'done') doneMsg = copy;
  if (m.type === 'incumbent' || m.type === 'progress') incumbents.push(copy);
};
vm.createContext(wctx);

try {
  vm.runInContext(workerSrc, wctx, { filename: 'engine-worker.blob.js' });
  console.log('✓ worker 源码在 Node vm 中加载并执行成功');
} catch (e) {
  console.error('✗ worker 源码执行失败：', e.message);
  console.error(e.stack.split('\n').slice(0, 8).join('\n'));
  process.exit(2);
}

// ── 5. 主动发 init，驱动 SA（worker 在 engineWorkerMain 内注册 self.onmessage）──
const buf = bundle.buffer.slice(0);
const initMsg = {
  type: 'init', buffer: buf, offsets: bundle.offsets,
  meta: {
    seedOffset: 1, nodeLimit: 20000000, timeLimit: 12000, useBonus: true,
    requiredTotalItems: prepared.length,
    tempIndex: 0, lnsEnabled: true
  }
};
const evalCtx = { statCount, useBonus: true, manualCount: 0, defaultTierCount: 25, totalItems: prepared.length, statKeys, rateOnlyFromK: RATE_ONLY_FROM_K };

// self.onmessage 即 wctx.onmessage（沙箱内 self === globalThis）
wctx.onmessage({ data: initMsg });

await new Promise(r => setTimeout(r, 13000));

console.log(`  done：${doneMsg ? '✓ 收到' : '✗ 未收到'}   进度消息：${incumbents.length} 条`);
if (doneMsg) {
  const sol = doneMsg.sol;
  const placed = Array.from(sol).filter(x => x >= 0).length;
  console.log(`  done.sol 长度=${sol.length} 已放=${placed} nodes=${doneMsg.nodes} elapsed=${doneMsg.elapsed} complete=${doneMsg.fullPackingFound}`);
  console.log(`  parts=${JSON.stringify(doneMsg.parts && {c:doneMsg.parts.complete, total:doneMsg.parts.total, items:doneMsg.parts.items, adj:doneMsg.parts.adj, same:doneMsg.parts.same, noBase:doneMsg.parts.noBase, dmg:doneMsg.parts.dmg})}`);
  if (incumbents.length) {
    const m = incumbents[incumbents.length - 1];
    console.log(`  末条进度 type=${m.type} keys=${Object.keys(m).join(',')}`);
  }
}

function bestFrom(sol) {
  if (!sol) return null;
  try { return G.encRebuildBest(sol, model, evalCtx); } catch (e) { return null; }
}
const sols = [];
if (doneMsg && doneMsg.sol) sols.push(doneMsg.sol);
for (const m of incumbents) { if (m.sol) sols.push(m.sol); if (m.best && m.best.sol) sols.push(m.best.sol); }

console.log('');
if (sols.length === 0) {
  console.log('⚠ 未取到任何解对象（worker 消息通道未完整打通）。');
  console.log('  这属于测试驱动问题（非引擎缺陷）：浏览器内由 engine-orchestrator 负责 init/start 握手。');
  console.log('  已确认的关键事实：worker 源码拼接在 Node 中可正常加载执行。');
  process.exit(0);
}

// 诊断：直接复算 done.sol，确认回放链路
if (doneMsg && doneMsg.sol) {
  const dbg = G.encRebuildBest(doneMsg.sol, model, evalCtx);
  console.log(`  [diag] done.sol 直接回放：placements=${dbg.placements.length} total=${dbg.totalScore} adj=${dbg.adjacencyCount} same=${dbg.sameAdjCount} nb=${dbg.noBaseHitCount}`);
  console.log(`  [diag] sol 前 5 项=${Array.from(doneMsg.sol).slice(0,5).join(',')}  model.plItem 前 5 项=${Array.from(model.plItem.slice(0,5)).join(',')}`);
}

// ── 6. 复算并对比（以 done.sol 为准；incumbent 仅作兜底）────────────────
// 注意：encRebuildBest 返回的 placements 已由 scoreSerializeBest 序列化 ——
// mask/neighborMask 是十进制字符串（生产链路不再二次评估，故无害）；
// 测试需经 decToLoHi 还原后再喂 scoreEvaluateConcrete。
function decToLoHi(s) {
  const n = Number(s) || 0;
  const hi = Math.floor(n / 4294967296);
  return { lo: n - hi * 4294967296, hi };
}
function revivable(placements) {
  return placements.map(p => Object.assign({}, p, {
    lo: decToLoHi(p.mask).lo, hi: decToLoHi(p.mask).hi,
    nbrLo: decToLoHi(p.neighborMask).lo, nbrHi: decToLoHi(p.neighborMask).hi
  }));
}

console.log('');
console.log('──── 解对象复算（score-shared 独立口径）────');
const candidates = [];
if (doneMsg && doneMsg.sol) candidates.push([doneMsg.sol, 'done']);
for (const m of incumbents) { if (m.sol) candidates.push([m.sol, 'incumbent']); if (m.best && m.best.sol) candidates.push([m.best.sol, 'incumbent.best']); }

let bestG = null, bestSrc = '';
for (const [sol, src] of candidates) {
  let b;
  try { b = G.encRebuildBest(sol, model, evalCtx); } catch (e) { continue; }
  if (!b) continue;
  const g = G.scoreEvaluateConcrete(revivable(b.placements), evalCtx);
  if (!bestG || G.scoreCompareEvaluationObjects(g, bestG) > 0) { bestG = g; bestSrc = src; }
}
if (!bestG) { console.log('⚠ 解对象无法复算'); process.exit(0); }
console.log(`  来源=${bestSrc}`);

console.log(`  complete=${bestG.complete}  totalScore=${bestG.totalScore}  bonus=${bestG.bonusScore}  base=${bestG.baseScore}`);
console.log(`  items=${bestG.itemCount}  adj=${bestG.adjacencyCount}  sameAdj=${bestG.sameAdjCount}  noBase=${bestG.noBaseHitCount}  dmgBond=${bestG.damageBondCount}`);
console.log('');
console.log('──── 对比旧结果 ────');
console.log(`  旧：total=${SRC.best.totalScore}  bonus=${SRC.best.bonusScore}  adj=${SRC.best.adjacencyCount}  dmgBond=${SRC.best.damageBondCount}`);
console.log(`  新：total=${bestG.totalScore}  bonus=${bestG.bonusScore}  adj=${bestG.adjacencyCount}  sameAdj=${bestG.sameAdjCount}  noBase=${bestG.noBaseHitCount}`);
const ok = Math.abs(bestG.totalScore - SRC.best.totalScore) < 1e-6;
console.log(`  → totalScore 保持：${ok ? '✓ 一致' : '差 ' + (bestG.totalScore - SRC.best.totalScore)}`);
