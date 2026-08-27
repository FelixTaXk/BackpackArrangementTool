import { readFileSync } from 'fs';

// 加载 data/talisman-db.js 到内存（node 环境用局部 window 绑定）
const txt = readFileSync('data/talisman-db.js', 'utf8');
const window = globalThis;
eval(txt);
const DB = window.TALISMAN_DB;

const talismans = DB.talismans;
console.log('=== 总览 ===');
console.log('talismans 条数:', talismans.length);
console.log('bonusStats 注册表:', JSON.stringify(DB.bonusStats));
console.log('attributes:', JSON.stringify(DB.attributes));
console.log('qualities:', JSON.stringify(DB.qualities));

// 收集所有 stat 键
const baseKeys = new Set(), rateKeys = new Set(), extraStatKeys = new Set(), extraRateKeys = new Set();
for (const t of talismans) {
  for (const k of Object.keys(t.baseStats || {})) baseKeys.add(k);
  for (const k of Object.keys(t.bonusRates || {})) rateKeys.add(k);
  for (const k of Object.keys(t.extraStats || {})) extraStatKeys.add(k);
  for (const k of Object.keys(t.extraRates || {})) extraRateKeys.add(k);
}
console.log('\n=== stat 键分布 ===');
console.log('baseStats 键:', JSON.stringify([...baseKeys]));
console.log('bonusRates 键:', JSON.stringify([...rateKeys]));
console.log('extraStats 键:', JSON.stringify([...extraStatKeys]));
console.log('extraRates 键:', JSON.stringify([...extraRateKeys]));

// 加成物品（bonusMode != none）按 (quality, cells, bonusMode) 分组
const combos = {};
let bonusCount = 0, rateOnlyCount = 0;
for (const t of talismans) {
  const area = (t.cells || []).length;
  const mode = t.bonusMode;
  if (mode === 'provider' || mode === 'self') {
    bonusCount++;
    const key = `${t.quality}/${area}格/${mode}`;
    combos[key] = (combos[key] || 0) + 1;
    // rate-only 判定：baseStats 全 0 且 bonusRates 全 0，但 extraRates 有非零
    const baseSum = Object.values(t.baseStats || {}).reduce((s, v) => s + Number(v || 0), 0);
    const rateSum = Object.values(t.bonusRates || {}).reduce((s, v) => s + Number(v || 0), 0);
    const extraRateSum = Object.values(t.extraRates || {}).reduce((s, v) => s + Number(v || 0), 0);
    if (baseSum === 0 && rateSum === 0 && extraRateSum > 0) rateOnlyCount++;
  }
}
console.log('\n=== 加成物品 (bonusMode=provider/self) 组合数 ===');
console.log('加成物品总数:', bonusCount);
const sortedCombos = Object.entries(combos).sort((a, b) => b[1] - a[1]);
for (const [k, v] of sortedCombos) console.log(`  ${k}: ${v}`);
console.log('仅在 extraRates 含非零率(rate-only) 物品数:', rateOnlyCount);

// 共鸣值 字段存在性
let hasResonance = 0;
for (const t of talismans) {
  if (t.extraStats && t.extraStats['共鸣值'] !== undefined) hasResonance++;
  if (t.extraRates && t.extraRates['共鸣值'] !== undefined) hasResonance++;
}
console.log('\n含 共鸣值 字段的物品数:', hasResonance);

// 既有 3 项 + extraRates 全部键（排除 共鸣值）构成的新注册表候选
const newStatCandidates = new Set([...rateKeys, ...extraRateKeys]);
newStatCandidates.delete('共鸣值');
console.log('\n=== 拟纳入计价的 bonus stat 候选（排除 共鸣值）===');
console.log(JSON.stringify([...newStatCandidates]));
console.log('候选数:', newStatCandidates.size);
