// scripts/measure-bonus-loss.mjs —— 离线测算：当前解还能捞回多少真实加成（只读，不改生产代码）。
//
// 背景：真实清单（bag-solver-result.json）中，真正能贡献加成的只有 5 个 self 件
// （provider 件的 bonusRates 为空，是其"伤害"加成未纳入 bonusStats 注册表所致）。
// 其中 #13 百炼成金锤（体/self, def+50%）同属性邻居 = 0，贡献 0.00，是唯一明显漏损。
//
// 测算两件事：
//   A. #13 的上限漏损：把它同属性邻居补到理论最大能多拿多少（乐观上界）。
//   B. 全局离线优化：在【完全不降 totalScore】的约束下，穷举/局部搜索所有摆放，
//      求总加成最大能达到多少（即"当前解离不降总分的加成最优值有多远"）。
//
// 用法：node scripts/measure-bonus-loss.mjs [结果文件路径]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const resultPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'bag-solver-result.json');

const sandbox = { console, window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/score-shared.js'), 'utf8'), sandbox, { filename: 'js/score-shared.js' });
const S = sandbox.window;

function decToLoHi(s) { const n = Number(s) || 0; const hi = Math.floor(n / 4294967296); return { lo: n - hi * 4294967296, hi }; }

const d = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const rawP = d.best.placements || [];
const W = d.width, H = d.height;
const active = d.active || Array.from({ length: H }, () => Array(W).fill(true));

// 还原 placement 的 lo/hi/nbrLo/nbrHi（导出为十进制串）
const P = rawP.map(p => {
  const m = decToLoHi(p.mask), nb = decToLoHi(p.neighborMask);
  return Object.assign({}, p, { lo: m.lo, hi: m.hi, nbrLo: nb.lo, nbrHi: nb.hi });
});
const byNo = new Map(P.map(p => [p.no, p]));
const statCount = (d.settings?.statKeys || []).length || 3;

const ctxBase = {
  statCount, useBonus: true,
  manualCount: Math.max(0, ...P.map(p => (p.manualOrder ?? -1) + 1), 0),
  defaultTierCount: Math.max(0, ...P.map(p => (p.priorityTier ?? -1) + 1), 0),
  totalItems: d.solverMeta?.totalItems ?? P.length,
};

const out = [];
const log = s => { out.push(s); console.log(s); };

log('════════ 加成漏损与抱团空间测算 ════════');
log('');

// ---------- 基本信息：谁真能加成 ----------
const bonusCapable = P.filter(p => (p.rv || []).some(v => v > 0));
log('──── 真正能贡献加成的法宝（rv 有非零率）────');
for (const p of bonusCapable) {
  const perUnit = p.sv.reduce((t, v, k) => t + v * ((p.rv[k] || 0) / 100), 0);
  const cnt = new Map();
  for (const q of P) {
    if (q === p) continue;
    if (S.scoreAreAdjacent(p.nbrLo, p.nbrHi, q.lo, q.hi)) cnt.set(q.no, q.attribute);
  }
  const same = [...cnt.entries()].filter(([, a]) => a === p.attribute).length;
  const diff = [...cnt.entries()].filter(([, a]) => a !== p.attribute).length;
  log(`  #${String(p.no).padStart(2)} ${p.itemName}（${p.attribute}/${p.bonusKind}） ${JSON.stringify(p.rv)}`);
  log(`       同属性邻居 ${same} · 异属性邻居 ${diff} · 单次加成 ${perUnit.toFixed(2)} · 当前贡献 ${(same * perUnit).toFixed(2)}`);
}
log('');

// ---------- A. 每个加成件的"邻居上限"漏损 ----------
log('──── A. 加成件邻居饱和度（同属性邻居 / 可容纳邻居上限）────');
const CAP = 4; // 单格件理论最多 4 邻居；占多格的件实际可达更多，这里给保守的 4 作粗参照
for (const p of bonusCapable) {
  const perUnit = p.sv.reduce((t, v, k) => t + v * ((p.rv[k] || 0) / 100), 0);
  let same = 0, total = 0;
  for (const q of P) {
    if (q === p) continue;
    if (S.scoreAreAdjacent(p.nbrLo, p.nbrHi, q.lo, q.hi)) { total++; if (q.attribute === p.attribute) same++; }
  }
  const lossPct = total > 0 ? (100 - same / total * 100).toFixed(0) : '0';
  log(`  #${String(p.no).padStart(2)} ${p.itemName.padEnd(9)} 同属性${String(same).padStart(2)} / 邻居${String(total).padStart(2)}  非同类占比 ${lossPct}%  ` +
      (same === 0 ? '⚠ 完全没吃到' : ''));
}
log('');

// ---------- B. 全局离线优化：不降 total 前提下最大化 bonus ----------
log('──── B. 离线优化：固定几何、只重排「谁放哪」（不降 total 约束）────');
log('      做法：把每件看作"占位几何"固定，仅交换任意两件的归属，穷举所有 2-swap，');
log('      接受条件 = total 不降 且 bonus 上升；迭代到收敛。这是无损（total 不减）的最大化。');
log('');

// 关键：几何占位（mask/nbrMask/cells）固定，把 item 属性"贴"到占位上。
// 交换两件 a、b 的归属 → 等价于把 a 的属性放到 b 的位置、b 的属性放到 a 的位置。
function placementWith(geom, from) {
  return Object.assign({}, geom, {
    sv: from.sv, rv: from.rv, attribute: from.attribute,
    bonusKind: from.bonusKind, causesDamage: from.causesDamage,
    value: from.value, no: from.no, itemName: from.itemName,
  });
}
function evalAssign(assign) {
  // assign: 数组，第 i 个元素是放到几何位 i 上的法宝
  const placements = assign.map((item, i) => placementWith(P[i], item));
  return S.scoreEvaluateConcrete(placements, ctxBase);
}

let assign = P.slice(); // 初始：当前位置的件
let cur = evalAssign(assign);
log(`  初始: total=${cur.totalScore.toFixed(2)}  bonus=${cur.bonusScore.toFixed(2)}  base=${cur.baseScore}`);

let improved = true, rounds = 0;
while (improved && rounds < 200) {
  improved = false; rounds++;
  for (let i = 0; i < assign.length; i++) {
    for (let j = i + 1; j < assign.length; j++) {
      if (assign[i].attribute === assign[j].attribute && (assign[i].rv || []).every((v, k) => v === (assign[j].rv || [])[k])) continue;
      const cand = assign.slice();
      [cand[i], cand[j]] = [cand[j], cand[i]];
      const ev = evalAssign(cand);
      // 不降 total（允许 1e-9 容差）且 bonus 更高
      if (ev.totalScore >= cur.totalScore - 1e-6 && ev.bonusScore > cur.bonusScore + 1e-9) {
        assign = cand; cur = ev; improved = true;
      }
    }
  }
}
log(`  收敛(${rounds} 轮): total=${cur.totalScore.toFixed(2)}  bonus=${cur.bonusScore.toFixed(2)}`);
log(`  → 不降 total 的加成上限 = ${cur.bonusScore.toFixed(2)}（当前 ${d.best.bonusScore.toFixed(2)}，可提升 ${(cur.bonusScore - d.best.bonusScore).toFixed(2)}，+${((cur.bonusScore / d.best.bonusScore - 1) * 100).toFixed(1)}%）`);
log('');

// ---------- C. 抱团指标：当前 vs 优化后 ----------
function structure(placements) {
  let sameAdj = 0, crossAdj = 0, crossWaste = 0;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const a = placements[i], b = placements[j];
      if (!S.scoreAreAdjacent(a.nbrLo, a.nbrHi, b.lo, b.hi)) continue;
      if (a.attribute === b.attribute) { sameAdj++; continue; }
      crossAdj++;
      const aCap = (a.rv || []).some(v => v > 0);
      const bCap = (b.rv || []).some(v => v > 0);
      crossWaste += (aCap ? 1 : 0) + (bCap ? 1 : 0);
    }
  }
  return { sameAdj, crossAdj, crossWaste };
}
const sBefore = structure(P);
const Popt = assign.map((item, i) => placementWith(P[i], item));
const sAfter = structure(Popt);
log('──── C. 结构指标对比（当前解 → 不降 total 的加成最优解）────');
log(`  同属性相邻 sameAdj : ${sBefore.sameAdj}  →  ${sAfter.sameAdj}   （${sAfter.sameAdj - sBefore.sameAdj >= 0 ? '+' : ''}${sAfter.sameAdj - sBefore.sameAdj}）`);
log(`  异属性相邻 crossAdj: ${sBefore.crossAdj}  →  ${sAfter.crossAdj}`);
log(`  交界浪费 crossWaste: ${sBefore.crossWaste}  →  ${sAfter.crossWaste}   （口径：异属性且至少一端 rv 非零）`);
log('');

// ---------- D. 输出优化后的布局 ----------
log('──── D. 不降总分下的加成最优布局（编号地图）────');
const gridNo = Array.from({ length: H }, () => Array(W).fill('·'));
const gridAttr = Array.from({ length: H }, () => Array(W).fill('·'));
for (let i = 0; i < P.length; i++) {
  const geom = P[i], item = assign[i];
  for (const [r, c] of geom.cells) { gridNo[r][c] = String(item.no); gridAttr[r][c] = item.attribute; }
}
for (let r = 0; r < H; r++) log('  r' + r + '  ' + gridNo[r].map(s => s.padEnd(3)).join(''));
log('');
log('──── 对应属性地图 ────');
for (let r = 0; r < H; r++) log('  r' + r + '  ' + gridAttr[r].map(s => s.padEnd(3)).join(''));
log('');

fs.writeFileSync(path.join(ROOT, 'measure-bonus-loss-report.txt'), out.join('\n'), 'utf8');
console.log('\n（报告已写入 measure-bonus-loss-report.txt）');
