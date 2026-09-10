// scripts/analyze-adjacency.mjs —— 真实结果样例的邻接结构分析（只读，不改任何生产代码）。
//
// 用途：拿「导出结果」生成的 bag-solver-result.json，用真实源复算当前 best 的
// base/bonus/total/adjacencyCount/damageBondCount，并额外统计属性抱团指标
// （sameAdj / crossAdj / crossWaste），用于：
//   1) 判定现状是「加成未优化到位」还是「加成已达上界、只是缺结构偏好」；
//   2) 作为改前基线，供改动后同清单对比。
//
// 用法：node scripts/analyze-adjacency.mjs [结果文件路径]
// 默认读取项目根目录的 bag-solver-result.json。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const resultPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'bag-solver-result.json');

// ---------- 加载真实源（score-shared 为纯函数层，无 DOM 依赖） ----------
const sandbox = { console, window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const rel of ['js/score-shared.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
const S = sandbox.window;
for (const fn of ['scoreAreAdjacent', 'scoreIsDamageBond', 'scorePairBonusEvents', 'scoreEvaluateConcrete']) {
  if (typeof S[fn] !== 'function') throw new Error(`score-shared.js 缺少 ${fn}`);
}

// 十进制串 → {lo,hi}（与 js/utils.js maskDecToLoHi 同式；42 位内恒在 Number 安全整数范围）
function decToLoHi(s) {
  const n = Number(s) || 0;
  const hi = Math.floor(n / 4294967296);
  return { lo: n - hi * 4294967296, hi };
}

// ---------- 读结果 ----------
const d = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const best = d.best || {};
const invByNo = new Map((d.inventory || []).map(x => [x.no, x]));

// 导出的 placement 用十进制串存 mask/neighborMask（encRebuildBest 剔除内部 lo/hi 视图键），
// 这里还原出 lo/hi/nbrLo/nbrHi 供 score-shared 使用；已带 lo/hi 的样例按原样保留。
const placements = (best.placements || []).map(p => {
  const m = decToLoHi(p.mask);
  const nb = decToLoHi(p.neighborMask);
  return Object.assign({}, p, {
    lo: p.lo !== undefined ? p.lo : m.lo,
    hi: p.hi !== undefined ? p.hi : m.hi,
    nbrLo: p.nbrLo !== undefined ? p.nbrLo : nb.lo,
    nbrHi: p.nbrHi !== undefined ? p.nbrHi : nb.hi,
  });
});

// ---------- 复算：用 score-shared 全量评估器 ----------
const statCount = (d.settings?.statKeys || []).length || 3;
const ctx = {
  statCount,
  useBonus: !!d.settings?.useAdjacencyBonus,
  manualCount: Math.max(0, ...placements.map(p => (p.manualOrder ?? -1) + 1), 0),
  defaultTierCount: Math.max(0, ...placements.map(p => (p.priorityTier ?? -1) + 1), 0),
  totalItems: d.solverMeta?.totalItems ?? placements.length,
};
const ev = S.scoreEvaluateConcrete(placements, ctx);

// ---------- 新增口径：属性抱团指标 ----------
const attrOf = p => p.attribute;
const isBonusCapable = p => p.bonusKind === 'provider' || p.bonusKind === 'self';
let sameAdj = 0, crossAdj = 0, crossWaste = 0;
const crossWasteList = [];

for (let i = 0; i < placements.length; i++) {
  for (let j = i + 1; j < placements.length; j++) {
    const a = placements[i], b = placements[j];
    if (!S.scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) continue;
    if (attrOf(a) === attrOf(b)) { sameAdj++; continue; }
    crossAdj++;
    const aCap = isBonusCapable(a), bCap = isBonusCapable(b);
    if (aCap && bCap) crossWaste += 2;
    else if (aCap || bCap) crossWaste += 1;
    if (aCap || bCap) {
      crossWasteList.push({
        no: aCap ? a.no : b.no,
        name: aCap ? a.itemName : b.itemName,
        attr: aCap ? attrOf(a) : attrOf(b),
        kind: aCap ? a.bonusKind : b.bonusKind,
        against: aCap ? b.no : a.no,
        againstName: aCap ? b.itemName : a.itemName,
        againstAttr: aCap ? attrOf(b) : attrOf(a),
      });
    }
  }
}

// ---------- 输出 ----------
const out = [];
out.push('════════ 求解结果分析 ════════');
out.push(`文件: ${path.relative(ROOT, resultPath)}`);
out.push(`空间: ${d.width}×${d.height}  清单: ${(d.inventory||[]).length} 件  已摆放: ${placements.length}  complete=${!!best.complete}`);
out.push(`设置: 加成=${ctx.useBonus}  档位=${d.settings?.searchMode}  并行=${d.settings?.parallelSearch}×${d.settings?.workerCount}  聚焦=${d.settings?.focusAttr || '(无)'}`);
out.push('');
out.push('──── 目标函数复算（真实源 score-shared）────');
out.push(`  baseScore   = ${ev.baseScore}`);
out.push(`  bonusScore  = ${ev.bonusScore}`);
out.push(`  totalScore  = ${ev.totalScore}`);
out.push(`  adjacency   = ${ev.adjacencyCount}`);
out.push(`  damageBond  = ${ev.damageBondCount}`);
out.push(`  （导出快照 base=${best.baseScore} bonus=${best.bonusScore} total=${best.totalScore} adj=${best.adjacencyCount} bond=${best.damageBondCount}）`);
const drift = Math.abs(ev.totalScore - (best.totalScore ?? NaN)) > 1e-6;
out.push(`  复算一致性: ${drift ? '⚠ 与导出快照不一致' : '✓ 一致'}`);
out.push('');
out.push('──── 属性抱团指标（新增口径，当前引擎完全不看）────');
out.push(`  同属性相邻 sameAdj    = ${sameAdj}`);
out.push(`  异属性相邻 crossAdj   = ${crossAdj}`);
out.push(`  交界浪费 crossWaste   = ${crossWaste}   （异属性且至少一端有加成能力；双端都有记 2）`);
if (crossAdj > 0) {
  out.push(`  sameAdj / (sameAdj+crossAdj) = ${(sameAdj / (sameAdj + crossAdj) * 100).toFixed(1)}% 同属性`);
}
out.push('');
if (crossWasteList.length) {
  out.push('──── 蹲在交界的「有加成能力」法宝明细 ────');
  for (const x of crossWasteList) {
    out.push(`  #${String(x.no).padStart(2)} ${x.name}（${x.attr}/${x.kind}）  ←异属性相邻→  #${String(x.against).padStart(2)} ${x.againstName}（${x.againstAttr}）`);
  }
} else {
  out.push('──── 交界处无「有加成能力」法宝（crossWaste=0）────');
}
out.push('');

// 加成上界估算：把每个 provider/self 件摆到"全同属性包围"的理论最优，估算 bonus 上界
// 简化口径：只统计自件（self）可达上界 + provider 作用于同属性件的乘数，用于粗判"是否已到上界"。
const capBonus = placements
  .filter(p => p.rv && p.sv && (p.rv.some(v => v > 0)))
  .reduce((s, p) => s + (p.sv.reduce((t, v, k) => t + v * ((p.rv[k] || 0) / 100), 0)), 0);
out.push('──── 粗判 ────');
out.push(`  理论上界（每加成件仅计自身一轮，粗估）≈ ${capBonus.toFixed(2)}`);
out.push(`  实际 bonusScore = ${ev.bonusScore.toFixed(2)}`);
out.push(`  → ${ev.bonusScore >= capBonus * 0.999 ? '已达/接近粗估上界，问题在结构（缺抱团偏好）' : '明显低于粗估上界，加成可能未优化到位（需先查求解质量）'}`);
out.push('');

// 网格可视化
out.push('──── 摆放网格（编号 / 属性首字 / 加成标记：P=provider S=self . =none）────');
const grid = Array.from({ length: d.height }, () => Array(d.width).fill('  · '));
const attrChar = { 金:'金', 木:'木', 水:'水', 火:'火', 土:'土', 雷:'雷', 邪:'邪', 体:'体' };
for (const p of placements) {
  const tag = p.bonusKind === 'provider' ? 'P' : p.bonusKind === 'self' ? 'S' : ' ';
  for (const [r, c] of p.cells) {
    if (r < d.height && c < d.width) grid[r][c] = `${String(p.no).padStart(2)}${attrChar[p.attribute] || '?'}${tag}`;
  }
}
for (let r = 0; r < d.height; r++) out.push('  ' + grid[r].map(s => s.padEnd(4)).join('') + (r === 0 ? '   ← 行 r' : ''));
out.push('');

console.log(out.join('\n'));
