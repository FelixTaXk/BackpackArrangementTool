// scripts/test-p1.mjs —— P1 双重优先级（品质×格数）回归测试。
// 验证：全部加成项被覆盖、非加成项返回 -1、品质序与格数序双重优先级正确、档位数=25、标签格式。
import { loadLogicLayer, makeAsserter } from './test-harness.mjs';

const { sandbox } = loadLogicLayer();
const a = makeAsserter('P1 双重优先级');

// 准备最小运行环境：prepareInventoryItems 依赖 active / inventory / W / H（线上由 UI 注入）
sandbox.W = 7; sandbox.H = 6;
sandbox.active = Array.from({ length: 6 }, () => Array(7).fill(true));
const DB = sandbox.TALISMAN_DB;
sandbox.inventory = DB.talismans.map((t, i) => ({
  uid: 'inv-' + i, no: i, id: t.id, name: t.name, cells: t.cells,
  quality: t.quality, attribute: t.attribute, value: 1,
  baseStats: t.baseStats, bonusRates: t.bonusRates, bonusMode: t.bonusMode, customPriority: null
}));

const fn = sandbox.bonusPriorityTier;
a.ok(typeof fn === 'function', 'bonusPriorityTier 已导出（solver.js 调用名一致）');

const bonusItems = DB.talismans.filter(t => t.bonusMode === 'provider' || t.bonusMode === 'self');
const noneItems = DB.talismans.filter(t => t.bonusMode === 'none');

a.eq(bonusItems.length, 172, '加成物品总数应为 172（10 组合计）');

// 1) 每个加成项都得到合法档位 [0, 25)
let allValid = true, minT = 1e9, maxT = -1e9;
for (const t of bonusItems){
  const tier = fn({ bonusKind: t.bonusMode, quality: t.quality, area: t.cells.length });
  if(!(Number.isInteger(tier) && tier >= 0 && tier < 25)) allValid = false;
  minT = Math.min(minT, tier); maxT = Math.max(maxT, tier);
}
a.ok(allValid, '全部 172 个加成项档位均在 [0,25) 合法区间');
a.eq(minT, 0, '最高档位为 0（红五格）');
a.eq(maxT, 24, '最低档位为 24（绿一格）');

// 2) 非加成项返回 -1
let allNoneNeg = true;
for (const t of noneItems){
  const tier = fn({ bonusKind: t.bonusMode, quality: t.quality, area: t.cells.length });
  if(tier !== -1) allNoneNeg = false;
}
a.ok(allNoneNeg, '全部非加成物品返回 -1（不计入默认优先级）');

// 3) 双重优先级：品质序（同格数下 红<金<紫<蓝<绿）
const tierOf = (q, cells) => fn({ bonusKind:'self', quality:q, area:cells });
a.ok(tierOf('红',4) < tierOf('金',4), '同 4 格：红 优先于 金');
a.ok(tierOf('金',4) < tierOf('紫',4), '同 4 格：金 优先于 紫');
a.ok(tierOf('紫',4) < tierOf('蓝',4), '同 4 格：紫 优先于 蓝');
a.ok(tierOf('蓝',4) < tierOf('绿',4), '同 4 格：蓝 优先于 绿');

// 4) 双重优先级：格数序（同品质下 5<4<3<2<1）
a.ok(tierOf('红',5) < tierOf('红',4), '同 红：5 格 优先于 4 格');
a.ok(tierOf('红',4) < tierOf('红',3), '同 红：4 格 优先于 3 格');
a.ok(tierOf('红',3) < tierOf('红',2), '同 红：3 格 优先于 2 格');
a.ok(tierOf('红',2) < tierOf('红',1), '同 红：2 格 优先于 1 格');

// 5) 品质优先于格数（红三格 应优先于 绿五格？）——按规则是「品质第一、格数第二」
//    红(0)三格(cr=2) = 0*5+2 = 2；绿(4)五格(cr=0) = 4*5+0 = 20 → 红三格 优先于 绿五格
a.ok(tierOf('红',3) < tierOf('绿',5), '品质优先于格数：红三格 优先于 绿五格（tier 2 < 20）');

// 6) provider 与 self 同品质同格数同档（覆盖全部加成项，不分模式）
a.eq(tierOf('金',1), fn({ bonusKind:'provider', quality:'金', area:1 }), 'provider 与 self 同品质同格数同档（金一格）');

// 7) 标签格式：tier 0 = 红色5格，tier 24 = 绿色1格
a.eq(sandbox.defaultPriorityTierLabel(0), '红5格', 'defaultPriorityTierLabel(0) = 红5格');
a.eq(sandbox.defaultPriorityTierLabel(24), '绿1格', 'defaultPriorityTierLabel(24) = 绿1格');
// 越界回退（间接确认 DEFAULT_TIER_COUNT=25）
a.ok(/默认档位 26/.test(sandbox.defaultPriorityTierLabel(25)), 'tier 25 触发回退标签（确认档位总数=25）');

// 8) area 缺省回退 cells.length（带 cells 数组）
a.eq(fn({ bonusKind:'self', quality:'红', cells:[1,2,3,4,5] }), 0, 'area 缺省时回退 cells.length（红五格=0）');

// 9) 端到端：prepareInventoryItems 产出物品带合法 priorityTier
const prepared = sandbox.prepareInventoryItems();
a.ok(prepared && Array.isArray(prepared.items), 'prepareInventoryItems 返回 {items,...} 结构');
let prepValid = true;
for (const it of (prepared.items || [])){
  if(Number(it.priorityTier) >= 25 || (it.priorityTier < 0 && it.bonusKind !== 'none')) prepValid = false;
}
a.ok(prepValid, 'prepareInventoryItems 全部物品 priorityTier 合法（加成项<25，非加成项=-1）');

const ok = a.report();
process.exit(ok ? 0 : 1);
