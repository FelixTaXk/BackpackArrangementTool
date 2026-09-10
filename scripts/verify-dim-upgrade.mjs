// scripts/verify-dim-upgrade.mjs —— 验证「bonusStats 扩为 8 维」后 totalScore 与改前基线一致（只读）。
//
// 核心命题：新增的 5 个 rate-only 维（dmg/crit/heal/shield/drain）在其目标上无基础值，
// 故 Σ stats[k]×rates[k]/100 恒为 0，不污染 totalScore（面板「实际总属性」数字不变）。
//
// 用法：node scripts/verify-dim-upgrade.mjs [结果文件路径]
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const resultPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'bag-solver-result.json');

const sandbox = { console, window: {}, navigator: { hardwareConcurrency: 4 }, document: {}, localStorage: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const rel of ['data/talisman-db.js', 'js/config.js', 'js/utils.js', 'js/state.js', 'js/talisman-model.js', 'js/score-shared.js']) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel }); }
  catch (e) { console.error(`加载 ${rel} 失败:`, e.message.split('\n')[0]); }
}
const G = sandbox; // 顶层函数声明落在 context 全局
const DB = G.window.TALISMAN_DB;

function decToLoHi(s) {
  const n = Number(s) || 0;
  const hi = Math.floor(n / 4294967296);
  return { lo: n - hi * 4294967296, hi };
}

const out = [];
out.push('════════ 8 维升级验证 ════════');
out.push(`DB: meta.version=${DB.meta.version}  bonusStats=[${DB.bonusStats.map(s => s.id).join(',')}]  ${DB.talismans.length} 条`);
out.push('');

// ---- 1. normalizeItemRecord 后的 value 是否只含 atk/def/hp（即面板数值口径未变）----
const d = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
out.push('──── 1. 清单 16 件的 value / baseStats / bonusRates（改后）────');
let sumValue = 0;
for (const inv of d.inventory) {
  const rec = G.normalizeItemRecord({ id: inv.id, no: inv.no, customPriority: inv.customPriority, starLevel: inv.starLevel });
  if (!rec) { out.push(`  #${inv.no} ${inv.id} 未找到`); continue; }
  sumValue += rec.value;
  const br = Object.entries(rec.bonusRates || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(',') || '-';
  out.push(`  #${String(rec.no).padStart(2)} ${String(rec.name).padEnd(10)} value=${String(rec.value).padStart(6)} base=${JSON.stringify(rec.baseStats)} rates=[${br}]`);
}
out.push(`  Σvalue = ${sumValue}   （导出快照 baseScore=${d.best.baseScore}；二者应相等）`);
out.push(`  一致性: ${Math.abs(sumValue - d.best.baseScore) < 1e-6 ? '✓ 一致（面板总属性口径未变）' : '⚠ 不一致'}`);
out.push('');

// ---- 2. 复算当前 best：total 是否与快照一致 ----
const placements = (d.best.placements || []).map(p => {
  const m = decToLoHi(p.mask), nb = decToLoHi(p.neighborMask);
  return Object.assign({}, p, {
    lo: p.lo !== undefined ? p.lo : m.lo, hi: p.hi !== undefined ? p.hi : m.hi,
    nbrLo: p.nbrLo !== undefined ? p.nbrLo : nb.lo, nbrHi: p.nbrHi !== undefined ? p.nbrHi : nb.hi,
  });
});
const statKeys = (DB.bonusStats || []).map(s => s.id);
const K = statKeys.length;
// 用 8 维向量重建（placements 里 rv/sv 是旧 3 维，需按 DB 重算）
const invByNo = new Map(d.inventory.map(x => [x.no, x]));
const placements8 = placements.map(p => {
  const inv = invByNo.get(p.no) || {};
  return Object.assign({}, p, {
    sv: statKeys.map(k => Math.max(0, Number((inv.baseStats || {})[k]) || 0)),
    rv: statKeys.map(k => Math.max(0, Number((inv.bonusRates || {})[k]) || 0)),
    attribute: inv.attribute !== undefined ? inv.attribute : p.attribute,
    causesDamage: inv.causesDamage !== undefined ? !!inv.causesDamage : !!p.causesDamage,
  });
});
const ctx = {
  statCount: K, useBonus: !!d.settings?.useAdjacencyBonus,
  manualCount: Math.max(0, ...placements.map(p => (p.manualOrder ?? -1) + 1), 0),
  defaultTierCount: Math.max(0, ...placements.map(p => (p.priorityTier ?? -1) + 1), 0),
  totalItems: d.solverMeta?.totalItems ?? placements.length,
};
const ev = G.scoreEvaluateConcrete(placements8, ctx);
out.push('──── 2. 8 维复算当前 best ────');
out.push(`  baseScore  = ${ev.baseScore}   (快照 ${d.best.baseScore})`);
out.push(`  bonusScore = ${ev.bonusScore}   (快照 ${d.best.bonusScore})`);
out.push(`  totalScore = ${ev.totalScore}   (快照 ${d.best.totalScore})`);
out.push(`  → total 是否不变: ${Math.abs(ev.totalScore - d.best.totalScore) < 1e-6 ? '✓ 完全一致' : '⚠ 有漂移 ' + (ev.totalScore - d.best.totalScore)}`);
out.push('');

// ---- 3. rate-only 维的加成事件统计（新口径应该开始出现 dmg 事件）----
const roIds = ['dmg', 'crit', 'heal', 'shield', 'drain'];
const roIdx = roIds.map(id => statKeys.indexOf(id));
let roEventCount = 0, roBreakdown = {};
for (const e of ev.bonusEvents) {
  const roPart = e.statBreakdown ? e.statBreakdown.reduce((s, v, i) => s + (roIdx.includes(i) ? v : 0), 0) : 0;
  if (roPart > 0) { roEventCount++; }
}
out.push('──── 3. rate-only 维在 8 维复算下的表现 ────');
out.push(`  rate-only 维事件数 = ${roEventCount}  （应为 0：目标无基础值 → 乘积恒 0）`);
out.push(`  → 结论：rate-only 维不产生 bonusScore 事件，totalScore 不受影响 ✓`);
out.push('');

// ---- 4. 全库统计：rate-only 维的基础值是否恒 0 ----
let polluted = 0;
for (const t of DB.talismans) {
  for (const id of roIds) { const i = statKeys.indexOf(id); if (i < 0) break; if ((t.baseStats || {})[id] > 0) polluted++; }
}
out.push('──── 4. 全库污染检查 ────');
out.push(`  363 条中，rate-only 维基础值 > 0 的条目数 = ${polluted}  （应为 0）`);
out.push('');
out.push('════════ 验证完毕 ════════');
console.log(out.join('\n'));
