// talisman-model.js —— 法宝数据模型（数据库查库/记录归一化/加成摘要/默认优先级档位）。加载顺序 5/13，依赖 config、utils、state。
'use strict';

// 品质中文名→内部 id 映射 QUALITY_NAME_TO_ID 由 config.js 提供（本文件加载顺序在其之后）。

// 长老星级倍率（源层物化唯一放大点）：仅红品质且星级∈1..STAR_LEVEL_BONUS.length 时
// 返回 1+加成率，否则恒返 1（星级=1/非红时位级恒等，RNG 字节纪律）。
function starMultiplier(quality, starLevel){
  if(QUALITY_NAME_TO_ID[quality] !== 'red') return 1;
  const lv = Math.floor(Number(starLevel));
  if(!Number.isFinite(lv) || lv < 1 || lv > STAR_LEVEL_BONUS.length) return 1;
  return 1 + STAR_LEVEL_BONUS[lv - 1];
}

// ---------------------------------------------------------------------------
// 属性注册表派生映射与共享常量
// ---------------------------------------------------------------------------
// extraRates 在数据库中以中文名（伤害/暴击伤害/…）存储，bonusStats 注册表以 id 存储；
// 此映射把 extraRates 中文名解析为注册表 id，供 normalizeItemRecord 把 rate-only 战斗加成并入有效基础属性。
const STAT_NAME_TO_ID = (typeof window !== 'undefined' && window.TALISMAN_DB && Array.isArray(window.TALISMAN_DB.bonusStats))
  ? Object.fromEntries(window.TALISMAN_DB.bonusStats.map(s => [s.name, s.id]))
  : {};

// 属性权重输入控件 id（与 bonusStats 注册表顺序一致：atk/def/hp/dmg/crit/heal/shield/drain）。
// 全部权重口径读取/持久化/预设同步均以该列表为唯一事实源，避免散落的 3 维硬编码。
const WEIGHT_INPUT_IDS = ['weightAtk','weightDef','weightHp','weightDmg','weightCrit','weightHeal','weightShield','weightDrain'];

// 属性权重向量展示串：按 bonusStats 顺序拼「<项目名>×<w>」，全维度覆盖（rate-only 维度 w=0 显示 ×0 表示该维度不计价）。
function formatWeightVector(weightMul){
  const stats = (typeof window !== 'undefined' && window.TALISMAN_DB && Array.isArray(window.TALISMAN_DB.bonusStats)) ? window.TALISMAN_DB.bonusStats : [];
  return stats.map((s, i) => `${statName(s.id)}×${Number(weightMul && weightMul[i]) || 0}`).join('、');
}

// 清单 / 法宝库记录统一按 talisman id 查库重建；数值全部来自数据库，不允许自定义。
function normalizeItemRecord(item){
  const rec = item && typeof item === 'object' ? item : {};
  const def = rec.id ? talismanById(rec.id) : null;
  if(!def) return null;
  let customPriority = rec.customPriority;
  if(customPriority === '' || customPriority === null || customPriority === undefined || !Number.isFinite(Number(customPriority))){
    customPriority = null;
  }else{
    customPriority = Math.max(1, Math.min(99, Math.floor(Number(customPriority))));
  }
  // 长老星级：仅红品质接受 1..N（N 由 STAR_LEVEL_BONUS.length 派生），非法/缺失回退 1；非红恒为 null。
  let starLevel = null;
  if(QUALITY_NAME_TO_ID[def.quality] === 'red'){
    const lv = Math.floor(Number(rec.starLevel));
    starLevel = (Number.isFinite(lv) && lv >= 1 && lv <= STAR_LEVEL_BONUS.length) ? lv : 1;
  }
  const starF = starMultiplier(def.quality, starLevel);
  // 基础属性拷贝后按星级倍率逐项放大（保留 1 位小数，消除 13×1.6=20.799… 浮点噪声）；
  // starF=1 时不触碰原值（整数位级不变）；bonusRates 不放大。
  const baseStats = {...def.baseStats};
  if(starF !== 1){
    for(const k of Object.keys(baseStats)){ baseStats[k] = Math.round(Number(baseStats[k]) * starF * 10) / 10; }
  }
  // 「加成率即基础值」：将 rate-only 战斗加成（伤害/暴击伤害/治疗效果/护盾值/汲取）直接并入有效基础属性，
  // 作为目标函数的直接基础贡献（该维度加成率恒为 0，不参与百分比加成传播，故不会重复计价）。
  // 不参与长老星级放大（战斗加成百分比与基础属性 atk/def/hp 系不同机制，仅基础属性受星级倍率影响）。
  const extraRates = def.extraRates || {};
  for(const [name, v] of Object.entries(extraRates)){
    const id = STAT_NAME_TO_ID[name];
    if(id) baseStats[id] = Math.max(0, Number(v) || 0);
  }
  return {
    uid: rec.uid || ('inv-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
    no: Number(rec.no) || 0,
    id: def.id,
    name: def.name,
    cells: normalizeCells(def.cells),
    attribute: def.attribute,
    quality: def.quality,
    starLevel,
    baseStats,
    bonusMode: def.bonusMode,
    bonusRates: {...def.bonusRates},
    customPriority,
    // 预折算标量（Σ 放大后 baseStats，保持 value=ΣbaseStats 恒等），供求解器比较与剪枝使用；分项明细见 baseStats。
    value: Object.values(baseStats).reduce((s,v)=>s + Number(v), 0)
  };
}

function talismanById(id){
  const db = typeof window !== 'undefined' ? window.TALISMAN_DB : null;
  if(!db || !Array.isArray(db.talismans)) return null;
  return db.talismans.find(t=>t.id === id) || null;
}
function buildItemDefs(){
  const db = window.TALISMAN_DB;
  return (db && Array.isArray(db.talismans) ? db.talismans : []).map(t=>normalizeItemRecord({id:t.id, uid:'def-' + t.id, no:0})).filter(Boolean);
}

// 品质展示（数据库中品质为中文名，转为内部 id 后使用既有配色）。
function qualityName(q){ return (QUALITY_MAP[QUALITY_NAME_TO_ID[q] || q] || {name:q}).name; }
function qualityLabel(q){ return qualityName(q); }

// 加成模式直接由数据库字段决定；求解器 placement 携带 bonusKind 字段，同样兼容。
function bonusKind(it){
  const mode = it && (it.bonusMode || it.bonusKind);
  return mode === 'provider' ? 'provider' : mode === 'self' ? 'self' : 'none';
}
function bonusModeName(mode){ return mode === 'provider' ? '提升相邻同属性' : mode === 'self' ? '提升自己' : '无'; }
function statName(k){
  const s = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).find(x=>x.id === k);
  return s ? s.name : k;
}
function baseStatsSummary(it){
  if(it.baseStats && Object.keys(it.baseStats).length){
    const keys = Object.keys(it.baseStats).filter(k=>Number(it.baseStats[k]) > 0);
    return keys.length ? keys.map(k=>`${statName(k)}${formatNum(it.baseStats[k])}`).join(' ') : '-';
  }
  if(Array.isArray(it.stats)){
    const ids = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
    const parts = it.stats.map((v,k)=>Number(v) > 0 ? `${statName(ids[k] || ('stat' + k))}${formatNum(v)}` : null).filter(Boolean);
    return parts.length ? parts.join(' ') : '-';
  }
  return '-';
}
function bonusRatesSummary(it){
  if(it.bonusRates && Object.keys(it.bonusRates).length){
    const keys = Object.keys(it.bonusRates).filter(k=>Number(it.bonusRates[k]) > 0);
    return keys.length ? keys.map(k=>`${statName(k)}${formatNum(it.bonusRates[k])}%`).join(' ') : '';
  }
  if(Array.isArray(it.rates)){
    const ids = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
    return it.rates.map((v,k)=>Number(v) > 0 ? `${statName(ids[k] || ('stat' + k))}${formatNum(v)}%` : null).filter(Boolean).join(' ');
  }
  return '';
}
function bonusControlHtml(it){
  const kind = bonusKind(it);
  if(kind === 'provider') return `<span class="pill green">提升相邻同属性</span> <span class="hint">${escapeHtml(bonusRatesSummary(it))}</span>`;
  if(kind === 'self') return `<span class="pill">提升自己</span> <span class="hint">${escapeHtml(bonusRatesSummary(it))}</span>`;
  return '<span class="pill gray">无</span>';
}
function bonusDescription(it){
  const kind = bonusKind(it);
  if(kind === 'provider') return `提升相邻同属性：${bonusRatesSummary(it)}（同属性目标基础值 × 加成率）`;
  if(kind === 'self') return `提升自己：${bonusRatesSummary(it)}（自身基础值 × 加成率，每相邻一个同属性法宝一次）`;
  return '无加成属性';
}

// ---------------------------------------------------------------------------
// 双重优先级默认档位（P1：推广为「品质×格数」通用规则，覆盖全部加成项）
// ---------------------------------------------------------------------------
// 品质序（高→低）：红 > 金 > 紫 > 蓝 > 绿        （rank 0 = 最高优先级）
// 格数序（高→低）：5 > 4 > 3 > 2 > 1              （rank 0 = 最高等级）
// 单档 tier = 品质rank × 格数档数 + 格数rank，∈ [0, DEFAULT_TIER_COUNT)，tier 越小越优先。
// 非加成物品（bonusKind === 'none'）一律返回 -1（不计入默认优先级）；
// 加成物品（provider / self）全部覆盖，体现「红色最高、5 格最高」的双重优先级排序。
const QUALITY_PRIORITY = ['red', 'gold', 'purple', 'blue', 'green'];
const CELL_PRIORITY = [5, 4, 3, 2, 1];
const DEFAULT_TIER_COUNT = QUALITY_PRIORITY.length * CELL_PRIORITY.length; // 5 × 5 = 25
function qualityPriorityRank(q){
  const id = QUALITY_NAME_TO_ID[q] || q;
  return QUALITY_PRIORITY.indexOf(id); // 未知品质返回 -1
}
function cellPriorityRank(area){
  return CELL_PRIORITY.indexOf(area);  // 未知格数返回 -1
}
function defaultPriorityTierLabel(tier){
  if(!Number.isInteger(tier) || tier < 0 || tier >= DEFAULT_TIER_COUNT) return `默认档位 ${tier + 1}`;
  const cellsIdx = tier % CELL_PRIORITY.length;
  const qualityIdx = (tier - cellsIdx) / CELL_PRIORITY.length;
  return `${qualityName(QUALITY_PRIORITY[qualityIdx])}${CELL_PRIORITY[cellsIdx]}格`;
}
// 加成物品的双重优先级档位（provider / self 一视同仁，仅按品质×格数排序）。
function bonusPriorityTier(it){
  const kind = it.bonusKind || bonusKind(it);
  if(kind === 'none') return -1;
  const qr = qualityPriorityRank(it.quality);
  const cr = cellPriorityRank(Number(it.area ?? (it.cells ? it.cells.length : 0)));
  if(qr < 0 || cr < 0) return -1; // 非法品质/格数不计
  return qr * CELL_PRIORITY.length + cr;
}
