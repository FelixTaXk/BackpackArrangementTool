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
function bonusModeName(mode){ return mode === 'provider' ? '提升相邻' : mode === 'self' ? '提升自己' : '无'; }
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
  if(kind === 'provider') return `<span class="pill green">提升相邻</span> <span class="hint">${escapeHtml(bonusRatesSummary(it))}</span>`;
  if(kind === 'self') return `<span class="pill">提升自己</span> <span class="hint">${escapeHtml(bonusRatesSummary(it))}</span>`;
  return '<span class="pill gray">无</span>';
}
function bonusDescription(it){
  const kind = bonusKind(it);
  if(kind === 'provider') return `提升相邻：${bonusRatesSummary(it)}（目标基础值 × 加成率）`;
  if(kind === 'self') return `提升自己：${bonusRatesSummary(it)}（自身基础值 × 加成率，每相邻一个不同法宝一次）`;
  return '无加成属性';
}

// 邻接优先级默认档位：优先读取数据库 priorityTier；缺省按“品质+格数”映射，
// 与旧档序等价：红五格 > 金四格 > 红三格self > 紫四 > 蓝四 > 绿四。
const DEFAULT_TIER_COUNT = 6;
const DEFAULT_TIER_LABELS = ['红色五格','金色四格','红色三格（自身加成）','紫色四格','蓝色四格','绿色四格'];
function defaultPriorityTierLabel(tier){ return DEFAULT_TIER_LABELS[tier] || `默认档位 ${tier + 1}`; }
function selfPriorityTier(it){
  const kind = it.bonusKind || bonusKind(it);
  if(kind !== 'self') return -1;
  if(Number.isInteger(it.priorityTier) && it.priorityTier >= 0) return it.priorityTier;
  const area = Number(it.area ?? (it.cells ? it.cells.length : 0));
  const q = QUALITY_NAME_TO_ID[it.quality] || it.quality;
  if(area === 5 && q === 'red') return 0;
  if(area === 4 && q === 'gold') return 1;
  if(area === 3 && q === 'red') return 2;
  if(area === 4 && q === 'purple') return 3;
  if(area === 4 && q === 'blue') return 4;
  if(area === 4 && q === 'green') return 5;
  return -1;
}
