// scripts/test-p2.mjs —— P2 八维加成计价回归测试（「加成率即基础值」）。
// 验证：bonusStats 注册表扩展为 8 维；rate-only 战斗加成（伤害/暴击伤害/治疗效果/护盾值/汲取）
// 经 normalizeItemRecord 精确并入有效基础属性（不参与长老星级放大、不参与百分比加成传播）；
// prepareInventoryItems 产出 8 维 stats/rates 向量，rate-only 维度 sv>0 且 rv=0；
// scoreEvaluateConcrete 的基础分计入 rate-only 维度；formatWeightVector 产出 8 段展示串。
import { loadLogicLayer, makeAsserter } from './test-harness.mjs';

const { sandbox } = loadLogicLayer();
const a = makeAsserter('P2 八维加成计价');

const DB = sandbox.TALISMAN_DB;
const stats = DB.bonusStats;
const nameToId = Object.fromEntries(stats.map(s => [s.name, s.id]));

// 1) 注册表 8 维且顺序/id/名称正确
a.eq(stats.length, 8, 'bonusStats 注册表应为 8 维');
const ids = stats.map(s => s.id);
a.ok(JSON.stringify(ids) === JSON.stringify(['atk','def','hp','dmg','crit','heal','shield','drain']), `8 维 id 顺序正确（实得 ${JSON.stringify(ids)}）`);
const names = stats.map(s => s.name);
a.ok(['伤害','暴击伤害','治疗效果','护盾值','汲取'].every(n => names.includes(n)), '5 个 rate-only 维度名称齐全');

// 2) 现有 DB 中所有带 extraRates 的物品：归一化后 baseStats[id] 精确等于原始值（无放大/丢失）
let mergeOk = true, rateOnlyCount = 0;
for(const t of DB.talismans){
  if(t.extraRates && Object.keys(t.extraRates).length){
    rateOnlyCount++;
    const norm = sandbox.normalizeItemRecord({ id: t.id, no: 0 });
    if(!norm){ mergeOk = false; break; }
    for(const [name, val] of Object.entries(t.extraRates)){
      const id = nameToId[name];
      if(!(id && norm.baseStats[id] === Math.max(0, Number(val) || 0))){ mergeOk = false; break; }
    }
    if(!mergeOk) break;
  }
}
a.ok(rateOnlyCount > 0, `数据库中存在带 extraRates 的物品（实得 ${rateOnlyCount} 件）`);
a.ok(mergeOk, '全部 rate-only extraRates 精确并入 baseStats（无放大、无丢失）');

// 3) 合成红品质物品：基础属性受星级放大，rate-only 不受放大（直接证明「加成率即基础值」不随星级缩放）
DB.talismans.push({
  id: '__p2_test_red', name: '测试红', attribute: '金', quality: '红', cells: [[0,0]],
  baseStats: { atk: 100, def: 0, hp: 0 }, bonusMode: 'none', bonusRates: {}, extraRates: { '伤害': 5 }
});
const red = sandbox.normalizeItemRecord({ id: '__p2_test_red', no: 0, starLevel: 2 });
// STAR_LEVEL_BONUS[1] = 0.6（星级 1 为 +0 基准，故用星级 2 验证放大）→ starF = 1.6 → atk = round(100*1.6*10)/10 = 160
a.eq(red.baseStats.atk, 160, '红品质 atk=100 受星级放大为 160（基础属性路径生效）');
a.eq(red.baseStats.dmg, 5, '红品质 rate-only 伤害=5 不受星级放大（精确并入，非 8）');

// 4) prepareInventoryItems：stats 向量长度 8，rate-only 维度 sv>0 且 rv=0
sandbox.W = 7; sandbox.H = 6;
sandbox.active = Array.from({ length: 6 }, () => Array(7).fill(true));
// 与线上一致：清单物品必须由 normalizeItemRecord 构建（rate-only 至此才并入 baseStats）。
sandbox.inventory = DB.talismans.map((t, i) => {
  const rec = sandbox.normalizeItemRecord({ id: t.id, no: i, customPriority: null });
  return rec;
});
const prepared = sandbox.prepareInventoryItems();
const dmgItem = DB.talismans.find(t => t.extraRates && t.extraRates['伤害']);
const dmgNorm = sandbox.normalizeItemRecord({ id: dmgItem.id, no: 0 });
const dmgIdx = ids.indexOf('dmg');
a.eq(dmgNorm.baseStats.dmg, Math.max(0, Number(dmgItem.extraRates['伤害']) || 0), '伤害维度在归一化 baseStats 中可见');
const dmgPrepared = prepared.items.find(it => it.typeId === dmgItem.id);
a.ok(dmgPrepared && dmgPrepared.stats.length === 8, 'prepared 物品 stats 向量长度为 8');
a.ok(dmgPrepared && dmgPrepared.stats[dmgIdx] > 0, 'prepared stats 的 dmg 维度 > 0（计入基础）');
a.ok(dmgPrepared && dmgPrepared.rates[dmgIdx] === 0, 'prepared rates 的 dmg 维度 === 0（rate-only 不传播加成）');

// 5) scoreEvaluateConcrete：含 rate-only 基础的摆放，baseScore 计入该维度值（不依赖加成传播）
const pl = {
  no: 1, itemName: 'X', value: dmgNorm.baseStats.dmg, area: 1, bonusKind: 'none',
  stats: [0,0,0, dmgNorm.baseStats.dmg,0,0,0,0], rates: [0,0,0,0,0,0,0,0],
  lo: 1, hi: 0, nbrLo: 0, nbrHi: 0, mask: { lo: 1, hi: 0 }, neighborMask: { lo: 0, hi: 0 },
  manualOrder: -1, priorityTier: -1, customPriority: null, cells: [[0,0]]
};
const ev = sandbox.scoreEvaluateConcrete([pl], { statCount: 8, useBonus: false, manualCount: 0, defaultTierCount: 25, totalItems: 1 });
a.ok(Math.abs(ev.baseScore - dmgNorm.baseStats.dmg) < 1e-9, `baseScore 计入 rate-only 基础值（期望 ${dmgNorm.baseStats.dmg}，实得 ${ev.baseScore}）`);

// 6) formatWeightVector：8 维展示串
const fv = sandbox.formatWeightVector([1,2,3,4,5,6,7,8]);
a.eq(fv.split('、').length, 8, 'formatWeightVector 产出 8 段');
a.ok(/伤害×4/.test(fv), 'formatWeightVector 含「伤害×4」段');

const ok = a.report();
process.exit(ok ? 0 : 1);
