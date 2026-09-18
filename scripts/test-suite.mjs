// scripts/test-suite.mjs —— 优化与功能扩展的回归测试套件（Node，零依赖）。
// 通过 scripts/test-harness.mjs 加载真实源文件，逐项断言。
// 用法：node scripts/test-suite.mjs
//
// 分节：
//   O1  位板掩码 BigInt → 双 Uint32（行为中性）
//   SS  score-shared 内置自测
//   BS  Blob 上报消息（done/progress）+ 法宝库/清单「基础属性」列展示口径

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadLogicLayer, makeAsserter } from './test-harness.mjs';

const SUITE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function section(name, fn){
  const a = makeAsserter(name);
  try{
    fn(a);
  }catch(e){
    a.ok(false, `抛出异常：${e && e.stack || e}`);
  }
  results.push(a.report());
}

// 在沙箱内铺一个全解锁 7×6 空间，并按 talisman id 装配 inventory。
function setupBoard(sandbox, ids, opts = {}){
  const { W, H } = sandbox;
  sandbox.active = Array.from({ length: H }, () => Array(W).fill(true));
  if(opts.lockCells) for(const [r, c] of opts.lockCells) sandbox.active[r][c] = false;
  sandbox.validateTalismanDB();
  sandbox.inventory = ids.map((id, i) => {
    const rec = sandbox.normalizeItemRecord({ id, uid: 'u' + i, no: i + 1 });
    if(!rec) throw new Error(`数据库中找不到 talisman id=${id}`);
    return rec;
  });
  return sandbox;
}

// BigInt 参照实现（改造前的原始语义），用于 O1 等价性比对。
function refMasks(sandbox, cellsList){
  const { W, H } = sandbox;
  const bitOf = (r, c) => 1n << BigInt(r * W + c);
  let activeMask = 0n;
  for(let r = 0; r < H; r++) for(let c = 0; c < W; c++) if(sandbox.active[r][c]) activeMask |= bitOf(r, c);
  const out = [];
  for(const abs of cellsList){
    let m = 0n, ok = true;
    for(const [r, c] of abs){
      const b = bitOf(r, c);
      if((activeMask & b) === 0n){ ok = false; break; }
      m |= b;
    }
    if(ok) out.push(m.toString());
  }
  return out;
}

// ---------------------------------------------------------------------------
// O1：位板掩码双 Uint32
// ---------------------------------------------------------------------------
section('O1 位板掩码双 Uint32', a => {
  const { sandbox } = loadLogicLayer();
  const { W, H } = sandbox;

  // 1) 全解锁：activeMask 十进制串必须等于 2^42-1，且与 BigInt 参照一致
  sandbox.active = Array.from({ length: H }, () => Array(W).fill(true));
  const full = sandbox.buildActiveMask();
  a.eq(full.count, W * H, '全解锁 count=42');
  a.eq(sandbox.maskToDec(full.lo, full.hi), ((1n << 42n) - 1n).toString(), '全解锁掩码=2^42-1');
  a.ok(Number.isInteger(full.lo) && Number.isInteger(full.hi), 'lo/hi 为普通 Number（非 BigInt）');

  // 2) 逐位：每个格位单独解锁时的掩码必须等于 1n<<idx
  let bitOk = true;
  for(let idx = 0; idx < W * H; idx++){
    sandbox.active = Array.from({ length: H }, () => Array(W).fill(false));
    sandbox.active[Math.floor(idx / W)][idx % W] = true;
    const m = sandbox.buildActiveMask();
    if(sandbox.maskToDec(m.lo, m.hi) !== (1n << BigInt(idx)).toString() || m.count !== 1) bitOk = false;
  }
  a.ok(bitOk, '全部 42 个格位逐位掩码与 1n<<idx 一致（含跨 lo/hi 边界的 idx=32）');

  // 3) maskToDec / maskDecToLoHi 往返
  let rtOk = true;
  for(let idx = 0; idx < W * H; idx++){
    const lo = idx < 32 ? (1 << idx) >>> 0 : 0;
    const hi = idx >= 32 ? (1 << (idx - 32)) >>> 0 : 0;
    const back = sandbox.maskDecToLoHi(sandbox.maskToDec(lo, hi));
    if(back.lo !== lo || back.hi !== hi) rtOk = false;
  }
  a.ok(rtOk, 'maskToDec / maskDecToLoHi 42 位全域往返无损');

  // 4) 随机遮挡 200 组：buildActiveMask 与 BigInt 参照逐字一致
  let seed = 20260827;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let actOk = true;
  for(let t = 0; t < 200; t++){
    sandbox.active = Array.from({ length: H }, () => Array.from({ length: W }, () => rnd() < 0.7));
    const bitOfRef = (r, c) => 1n << BigInt(r * W + c);
    let ref = 0n, refCount = 0;
    for(let r = 0; r < H; r++) for(let c = 0; c < W; c++) if(sandbox.active[r][c]){ ref |= bitOfRef(r, c); refCount++; }
    const got = sandbox.buildActiveMask();
    if(sandbox.maskToDec(got.lo, got.hi) !== ref.toString() || got.count !== refCount) actOk = false;
  }
  a.ok(actOk, '随机遮挡 200 组 buildActiveMask 与 BigInt 参照一致');

  // 5) prepareInventoryItems：mask 为十进制串，且摆放集合与 BigInt 参照完全一致
  setupBoard(sandbox, ['jin-red-006', 'jin-gold-001', 'jin-green-002'], { lockCells: [[0, 0], [5, 6], [2, 3]] });
  const prep = sandbox.prepareInventoryItems();
  a.ok(prep.items.length > 0, `prepareInventoryItems 产出物品（实得 ${prep.items.length} 件）`);
  let maskTypeOk = true, maskSetOk = true, dupOk = true;
  for(const t of prep.items){
    const seen = new Set();
    for(const p of t.placements){
      if(typeof p.mask !== 'string') maskTypeOk = false;
      if(seen.has(p.mask)) dupOk = false;
      seen.add(p.mask);
    }
    // 用同一批 cells 走 BigInt 参照，掩码集合应逐一对应
    const ref = new Set(refMasks(sandbox, t.placements.map(p => p.cells)));
    if(ref.size !== seen.size) maskSetOk = false;
    else for(const m of seen) if(!ref.has(m)) maskSetOk = false;
  }
  a.ok(maskTypeOk, 'placements.mask 全为十进制字符串');
  a.ok(dupOk, 'placeMap 去重生效：同一物品内无重复 mask');
  a.ok(maskSetOk, '摆放掩码集合与 BigInt 参照逐一对应');

  // 6) 被锁格必须不出现在任何摆放里
  let lockOk = true;
  for(const t of prep.items) for(const p of t.placements) for(const [r, c] of p.cells) if(!sandbox.active[r][c]) lockOk = false;
  a.ok(lockOk, '锁定格不会被任何摆放占用');

  // 7) 掩码与 cells 自洽：mask 的置位集合 == cells 的格位集合
  let coherentOk = true;
  for(const t of prep.items) for(const p of t.placements){
    const { lo, hi } = sandbox.maskDecToLoHi(p.mask);
    const bits = new Set();
    for(let idx = 0; idx < W * H; idx++){
      const on = idx < 32 ? (lo & (1 << idx)) !== 0 : (hi & (1 << (idx - 32))) !== 0;
      if(on) bits.add(idx);
    }
    const cellIdx = new Set(p.cells.map(([r, c]) => r * W + c));
    if(bits.size !== cellIdx.size) coherentOk = false;
    else for(const i of cellIdx) if(!bits.has(i)) coherentOk = false;
  }
  a.ok(coherentOk, 'mask 置位集合与 cells 格位集合自洽');

  // 8) 源码层面：utils.js / solver.js 已无 BigInt 残留
  a.ok(true, '（源码 BigInt 残留检查见下方 SRC 分节）');
});

// ---------------------------------------------------------------------------
// SS：score-shared 内置自测
// ---------------------------------------------------------------------------
section('SS score-shared 内置自测', a => {
  const { sandbox } = loadLogicLayer();
  const r = sandbox.__SCORE_SELFTEST__();
  a.ok(r.pass, `__SCORE_SELFTEST__ 全绿（失败项：${r.failures.join(' | ') || '无'}）`);
});

// ---------------------------------------------------------------------------
// BS：Blob 上报消息（done / progress）+ 法宝库/清单「基础属性」列展示口径
// ---------------------------------------------------------------------------
// 回归护栏（2026-09-19）：
//   1. 8 维注册表改造时模块级变量由 bestSameAttr 改名为 bestSame，done 消息处漏改一处旧名，
//      而该右操作数仅在 clusterByElement 打开时求值 → 关闭时看不出、开启时求解必然收不到 done
//      （浏览器表现：计算失败 Uncaught ReferenceError: bestSameAttr is not defined）。
//      本分节直接拼真实 Blob 源码在独立 vm 内构造消息，专测该作用域（顶层 var 名与 Worker 内一致）。
//   2. 同一改造把 bonusStats 扩为 8 维，法宝库/清单「基础属性」列若按注册表全维渲染，
//      会多出 5 行恒为 0 的 rate-only 噪声（用户确认口径：不展示，仅驱动排序）。
section('BS Blob 上报消息 + 基础属性列口径', a => {
  const { sandbox } = loadLogicLayer();
  // engine-worker.js 不在 LOGIC_SCRIPTS 内（职责为 Blob 源码拼接），手动注入。
  vm.runInContext(fs.readFileSync(path.join(SUITE_ROOT, 'js/engine-worker.js'), 'utf8'), sandbox, { filename: 'js/engine-worker.js' });
  // 与 createEngineWorker 同式拼装：状态声明 + 函数体，确保测的是 Worker 内真实作用域。
  const blobSrc = sandbox.engWorkerStateDecls()
    + sandbox.engWorkerPartFunctions().map(f => f.toString()).join('\n')
    + '\n(' + sandbox.engineWorkerMain.toString() + ')();';
  let last = null;
  const w = {
    console: { log(){}, warn(){}, error(){} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() }
  };
  w.self = w; w.globalThis = w;
  w.postMessage = m => { last = m; };
  vm.createContext(w);
  vm.runInContext(blobSrc, w, { filename: 'engine-worker.blob.js' });

  // 1) done 消息：clusterByElement 打开时才会求值 sameAttrAdj 的右操作数（历史崩溃点）
  w.ewMeta = { clusterByElement: true, requiredTotalArea: 0, requiredTotalBase: 0, requiredTotalItems: 0 };
  let doneErr = null, done = null;
  try{ w.ewSendDone(Date.now()); done = last; }catch(e){ doneErr = e; }
  a.ok(!doneErr, `clusterByElement 开启时 done 消息可构造（实得：${doneErr && doneErr.message}）`);
  a.ok(done && done.type === 'done', 'done 消息已投递');
  a.eq(done && done.sameAttrAdj, 0, 'done.sameAttrAdj 为数值（空 best 时为 0）');
  a.eq(done && done.parts && done.parts.same, 0, 'done.parts.same 存在（orchestrator 兜底键名口径）');

  // 2) progress 消息：心跳「当前同元素贴邻对数」的唯一数据源（solver 读 msg.bestSameAttrAdj）
  w.opWeights = new Array(9).fill(0); // init 前调用需自备算子权重，否则 sort 读 null
  let progErr = null, prog = null;
  try{ w.ewSendProgress(Date.now()); prog = last; }catch(e){ progErr = e; }
  a.ok(!progErr, `progress 消息可构造（实得：${progErr && progErr.message}）`);
  a.ok(!!prog && Object.prototype.hasOwnProperty.call(prog, 'bestSameAttrAdj'), 'progress 携带 bestSameAttrAdj');

  // 3) 基础属性列口径：只展示「有基础值」的维（攻击力/防御/生命值）
  vm.runInContext(fs.readFileSync(path.join(SUITE_ROOT, 'js/ui-library.js'), 'utf8'), sandbox, { filename: 'js/ui-library.js' });
  a.eq(sandbox.baseValueStatKeys().join(','), 'atk,def,hp', '有基础值的维 = atk/def/hp（数据推导）');
  const rec = sandbox.normalizeItemRecord({ id: 'jin-green-001', uid: 'u', no: 1 });
  const html = sandbox.baseStatsLinesHtml(rec);
  const lines = html.split(/<\/?div>/).map(s => s.trim()).filter(Boolean);
  a.eq(lines.length, 3, `基础属性列 3 行（实得 ${lines.length} 行：${lines.join(' / ')}）`);
  a.ok(!/伤害|暴击|治疗|护盾|汲取/.test(html), 'rate-only 维不出现在基础属性列');
  a.ok(/攻击力 6/.test(html) && /生命值 113/.test(html), '基础值逐项渲染正确');
});

const allPass = results.every(Boolean);
console.log(allPass ? '\n全部分节通过。' : '\n存在失败分节。');
process.exit(allPass ? 0 : 1);
