// scripts/verify-clustering.mjs —— 验证「同属性抱团 + 无加成蹲交界」排序键真实生效（只读）。
//
// 命题：在两个不同属性混排时，scoreEvaluateConcrete 的对比链应能区分
//   (a) 同属性相邻数更多（sameAdjCount 大者胜）
//   (b) rate-only 命中数更多（noBaseHitCount 大者胜）
//   (c) 上述软键不得改变 totalScore（面板数字不变）
//   (d) provider+伤害 仅加成「同属性 ∧ 可造成伤害」目标；self+伤害 仅数同属性相邻
//
// 用法：node scripts/verify-clustering.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const sandbox = { console, window: {}, navigator: { hardwareConcurrency: 4 }, document: {}, localStorage: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const rel of ['data/talisman-db.js', 'js/config.js', 'js/utils.js', 'js/state.js', 'js/talisman-model.js', 'js/score-shared.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const G = sandbox;
const DB = G.window.TALISMAN_DB;
const K = DB.bonusStats.length;
const W = 6;

const out = [];
let pass = 0, fail = 0;
function ck(cond, label) {
  if (cond) { pass++; out.push(`  ✓ ${label}`); }
  else { fail++; out.push(`  ✗ ${label}`); }
}
const bit = b => (b < 32 ? { lo: (1 << b) >>> 0, hi: 0 } : { lo: 0, hi: (1 << (b - 32)) >>> 0 });

// 由「所有格子的绝对位号」构造视图：mask + 四邻邻居合并位板
function buildViews(specs) {
  // specs: [{name, attr, cells:[[r,c]], rates, kind, causesDamage}]
  // 先登记除自身外所有占据格 → 位号
  const occ = new Map();
  specs.forEach((s, si) => s.cells.forEach(([r, c]) => occ.set(r * W + c, si)));
  return specs.map(s => {
    const myBits = s.cells.map(([r, c]) => r * W + c);
    let lo = 0, hi = 0;
    for (const b of myBits) { const m = bit(b); lo = (lo | m.lo) >>> 0; hi = (hi | m.hi) >>> 0; }
    let nlo = 0, nhi = 0;
    for (const [r, c] of s.cells) {
      for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || cc >= W) continue;
        const owner = occ.get(rr * W + cc);
        if (owner === undefined) continue;
        const m = bit(rr * W + cc);
        nlo = (nlo | m.lo) >>> 0; nhi = (nhi | m.hi) >>> 0;
      }
    }
    const rv = new Array(K).fill(0);
    for (const k in (s.rates || {})) { const i = DB.bonusStats.findIndex(x => x.id === k); if (i >= 0) rv[i] = s.rates[k]; }
    return {
      no: 0, itemName: s.name, value: 1,
      bonusKind: s.kind || 'none', attribute: s.attr,
      sv: new Array(K).fill(0), rv,
      lo, hi, nbrLo: nlo, nbrHi: nhi,
      causesDamage: !!s.causesDamage
    };
  });
}

const ctx = { statCount: K, useBonus: true, manualCount: 0, defaultTierCount: 25, rateOnlyFromK: 3 };
const G9 = (specs) => G.scoreEvaluateConcrete(buildViews(specs), ctx);
const C9 = (a, b) => G.scoreCompareEvaluationObjects(a, b);

out.push('════════ 抱团 / 交界排序键验证 ════════');
out.push(`DB: meta.version=${DB.meta.version}  K=${K}  bonusStats=[${DB.bonusStats.map(s => s.id).join(',')}]`);
out.push('');

// ── 场景 1：同属性抱团 vs 交错 ───────────────────────────────────────────
// 几何固定：4 个 1×2 横块，位于两行的 (0,0)-(0,1)、(0,2)-(0,3)、(1,0)-(1,1)、(1,2)-(1,3)
// A（抱团）：上排两块同为「土」，下排两块同为「体」
// B（交错）：上排 = 土、体；下排 = 体、土
out.push('──── 场景 1：同属性抱团 vs 交错（sameAdjCount）────');
{
  const geo = r => [[r, 0], [r, 1]];
  const geo2 = r => [[r, 2], [r, 3]];
  const mk = (names) => [
    { name: names[0], attr: names[0] === '土甲' || names[0] === '土乙' ? '土' : '体', cells: geo(0), rates: { dmg: 2 }, kind: 'provider', causesDamage: true },
    { name: names[1], attr: names[1].startsWith('土') ? '土' : '体', cells: geo2(0) },
    { name: names[2], attr: names[2].startsWith('土') ? '土' : '体', cells: geo(1) },
    { name: names[3], attr: names[3].startsWith('土') ? '土' : '体', cells: geo2(1) }
  ];
  const gGroup = G9(mk(['土甲', '土乙', '体甲', '体乙']));   // 上排土土 / 下排体体
  const gCross = G9(mk(['土甲', '体甲', '体乙', '土乙']));   // 上排土体 / 下排体土
  out.push(`  抱团：sameAdj=${gGroup.sameAdjCount} adj=${gGroup.adjacencyCount} | 交错：sameAdj=${gCross.sameAdjCount} adj=${gCross.adjacencyCount}`);
  ck(gGroup.sameAdjCount > gCross.sameAdjCount, `抱团 sameAdjCount(${gGroup.sameAdjCount}) > 交错(${gCross.sameAdjCount})`);
  ck(gGroup.totalScore === gCross.totalScore, `两布局 totalScore 相同(${gGroup.totalScore})，软键不污染面板`);
  ck(C9(gGroup, gCross) === 1, `对比：抱团 > 交错（cmp=${C9(gGroup, gCross)}，期望 1）`);
}

// ── 场景 2：provider dmg 双重护栏 ────────────────────────────────────────
out.push('');
out.push('──── 场景 2：provider dmg 双重护栏（同属性 ∧ causesDamage）────');
{
  const p = { name: '邪源珠', attr: '邪', cells: [[0, 0]], rates: { dmg: 5 }, kind: 'provider', causesDamage: true };
  const hit = { name: '邪伤害', attr: '邪', cells: [[0, 1]], causesDamage: true };
  const noHit = { name: '邪无伤', attr: '邪', cells: [[0, 1]], causesDamage: false };
  const cross = { name: '体伤害', attr: '体', cells: [[0, 1]], causesDamage: true };
  const s = { name: '自伤', attr: '邪', cells: [[0, 0]], rates: { dmg: 3 }, kind: 'self', causesDamage: true };
  const sHit = { name: '邪无伤', attr: '邪', cells: [[0, 1]], causesDamage: false };
  const sCross = { name: '体伤', attr: '体', cells: [[0, 1]], causesDamage: true };

  const gHit = G9([p, hit]), gNoHit = G9([p, noHit]), gCross = G9([p, cross]);
  const gS = G9([s, sHit]), gSCross = G9([s, sCross]);
  out.push(`  provider：同属性∧可伤害=${gHit.noBaseHitCount} / 同属性∧不可伤害=${gNoHit.noBaseHitCount} / 跨属性∧可伤害=${gCross.noBaseHitCount}`);
  out.push(`  self    ：同属性∧不可伤害=${gS.noBaseHitCount} / 跨属性∧可伤害=${gSCross.noBaseHitCount}`);
  ck(gHit.noBaseHitCount === 1, 'provider ∧ 同属性 ∧ 可伤害 → 命中 1');
  ck(gNoHit.noBaseHitCount === 0, 'provider ∧ 同属性 ∧ 不可伤害 → 命中 0（causesDamage 护栏生效）');
  ck(gCross.noBaseHitCount === 0, 'provider ∧ 跨属性 → 命中 0');
  ck(gS.noBaseHitCount === 1, 'self ∧ 同属性相邻 → 命中 1（不看 causesDamage）');
  ck(gSCross.noBaseHitCount === 0, 'self ∧ 跨属性 → 命中 0');
}

// ── 场景 3：rate-only 维不进 totalScore ──────────────────────────────────
out.push('');
out.push('──── 场景 3：rate-only 维不污染 totalScore ────');
{
  const a = { name: 'A', attr: '土', cells: [[0, 0]], rates: { dmg: 10, crit: 10, heal: 10, shield: 10, drain: 10 }, kind: 'provider', causesDamage: true };
  const b = { name: 'B', attr: '土', cells: [[0, 1]], causesDamage: true };
  const g = G9([a, b]);
  ck(g.totalScore === 2, `rate-only 语料 totalScore=${g.totalScore}（=2，仅两件各 value=1 的基础分，rate-only 计 0）`);
  ck(g.noBaseHitCount === 5, `5 个 rate-only 维各命中 1 → noBase=${g.noBaseHitCount}`);
}

// ── 场景 4：noBaseHitCount 优先级高于 sameAdjCount ───────────────────────
out.push('');
out.push('──── 场景 4：加成命中优先于抱团（键序 noBase > sameAdj）────');
{
  // 布局X：同属性相邻（抱团）但无 rate-only 命中
  // 布局Y：跨属性相邻（无抱团）但 provider 命中了同属性可伤害目标
  const x = [
    { name: '土1', attr: '土', cells: [[0, 0]] },
    { name: '土2', attr: '土', cells: [[0, 1]] }
  ];
  const y = [
    { name: '邪源', attr: '邪', cells: [[0, 0]], rates: { dmg: 5 }, kind: 'provider', causesDamage: true },
    { name: '邪伤', attr: '邪', cells: [[0, 1]], causesDamage: true } // 注意：同为邪属性 → 也是同属性
  ];
  const gx = G9(x), gy = G9(y);
  out.push(`  X：sameAdj=${gx.sameAdjCount} noBase=${gx.noBaseHitCount} | Y：sameAdj=${gy.sameAdjCount} noBase=${gy.noBaseHitCount}`);
  ck(gy.noBaseHitCount > gx.noBaseHitCount && C9(gy, gx) === 1, '命中更多者胜（noBase 键在 sameAdj 之前）');
}

out.push('');
out.push(`════════ 结果：${pass} 通过 / ${fail} 失败 ════════`);
console.log(out.join('\n'));
process.exit(fail ? 1 : 0);
