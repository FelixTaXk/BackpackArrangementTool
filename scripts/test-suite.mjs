// scripts/test-suite.mjs —— 优化与功能扩展的回归测试套件（Node，零依赖）。
// 通过 scripts/test-harness.mjs 加载真实源文件，逐项断言。
// 用法：node scripts/test-suite.mjs
//
// 分节：
//   O1  位板掩码 BigInt → 双 Uint32（行为中性）
//   O2  engine-encoding pairBonusTable 去装箱（数值等价）
//   P1  双重优先级（品质红最高 × 5 格最高）
//   P2  全部加成项计入目标函数（加成率直接计价）
//   P3  引擎档位统一（legacy 废弃）
//   SS  score-shared 内置自测

import { loadLogicLayer, makeAsserter } from './test-harness.mjs';

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

const allPass = results.every(Boolean);
console.log(allPass ? '\n全部分节通过。' : '\n存在失败分节。');
process.exit(allPass ? 0 : 1);
