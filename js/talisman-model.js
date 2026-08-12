// talisman-model.js —— 物品数据模型与规范化（品质/加成率/记录归一化）。加载顺序 4/12，依赖 config、utils。
'use strict';

function cloneItems(src){ return src.map(x => normalizeItemRecord({...x, cells:cloneCells(x.cells), enabled:x.enabled !== false})); }
function allowedQualitiesForArea(area){
  if(area === 1 || area === 2) return ['green','blue','purple','gold'];
  if(area === 3 || area === 4) return ['green','blue','purple','gold','red'];
  if(area === 5) return ['red'];
  return ['green','blue','purple','gold','red'];
}
function normalizeQualityForArea(q, area){
  const allowed = allowedQualitiesForArea(area);
  return allowed.includes(q) ? q : allowed[0];
}
function qualityValue(q, area=1){
  const a = Number(area) || 1;
  const table = AREA_VALUE_BY_QUALITY[a] || AREA_VALUE_BY_QUALITY[1];
  const qq = normalizeQualityForArea(q, a);
  return table[qq] ?? Object.values(table)[0] ?? 0;
}
function qualityName(q){ return (QUALITY_MAP[q] || QUALITY_MAP.green).name; }
function qualityLabel(q, area){ return `${qualityName(q)}(${qualityValue(q, area)})`; }
function defaultBonusRate(area, quality, threeSelfBonus){
  const q = normalizeQualityForArea(quality, area);
  if(area === 1) return SINGLE_RATE_BY_QUALITY[q] ?? 0;
  if(area === 5) return 40;
  if(area === 4) return q === 'red' ? 0 : (q === 'gold' ? 40 : 20);
  if(area === 3 && threeSelfBonus) return 20;
  return 0;
}
function normalizeItemRecord(item, keepManualRate=false){
  const area = item.cells ? item.cells.length : 0;
  let threeSelfBonus = !!item.threeSelfBonus;
  let quality = normalizeQualityForArea(item.quality || 'green', area);
  if(area === 5) quality = 'red';
  if(area === 3 && threeSelfBonus) quality = 'red';
  let value = Number(item.value);
  if(!Number.isFinite(value) || value <= 0) value = qualityValue(quality, area);
  let customPriority = item.customPriority;
  if(customPriority === '' || customPriority === null || customPriority === undefined || !Number.isFinite(Number(customPriority))){
    customPriority = null;
  }else{
    customPriority = Math.max(1, Math.min(99, Math.floor(Number(customPriority))));
  }
  let bonusRate = Number(item.bonusRate);
  if(!keepManualRate || !Number.isFinite(bonusRate) || bonusRate < 0) bonusRate = defaultBonusRate(area, quality, threeSelfBonus);
  // 红色装备保留用户填写的加成率，不再强制改回 0%、20% 或 40%。
  // 红色三格是否生效仍由“自身受加成”开关控制；红色四格默认 0%，填写大于 0 的值时按自定义自身加成计算。
  const canStoreCustomRedRate = quality === 'red' && (area === 3 || area === 4 || area === 5);
  if(!canStoreCustomRedRate && area !== 1 && area !== 4 && area !== 5 && !(area === 3 && threeSelfBonus)) bonusRate = 0;
  return {...item, cells:normalizeCells(item.cells || []), quality, value, bonusRate, threeSelfBonus, customPriority, enabled:item.enabled !== false};
}
function bonusKind(it){
  const area = Number(it && it.area) || (it && it.cells ? it.cells.length : 0);
  const quality = (it && it.quality) || 'green';
  const rate = Math.max(0, Number(it && it.bonusRate) || 0);
  if(area === 1) return 'provider';
  // 红色四格默认加成率为 0；用户手动填写大于 0 的值时，按自定义自身加成参与计算。
  if(area === 4 && quality === 'red') return rate > 0 ? 'self' : 'none';
  if((area === 4 && quality !== 'red') || area === 5 || (area === 3 && it.threeSelfBonus)) return 'self';
  return 'none';
}
function bonusControlHtml(it, idx){
  const area = it.cells.length;
  if(area === 1) return '<span class="pill green">单格：给相邻物品</span>';
  if(area === 4 && it.quality === 'red') return Number(it.bonusRate)>0 ? '<span class="pill">红色四格：自定义自身加成</span>' : '<span class="pill gray">红色四格：默认无加成，可自定义</span>';
  if(area === 4) return '<span class="pill">四格：自身受加成</span>';
  if(area === 5) return '<span class="pill">五格：红色自身受加成</span>';
  if(area === 3) return `<label style="margin:0"><input type="checkbox" data-inv-k="threeSelfBonus" data-i="${idx}" ${it.threeSelfBonus?'checked':''}> 自身受加成</label>`;
  return '<span class="pill gray">无</span>';
}
function bonusDescription(it){
  const kind = bonusKind(it);
  if(kind === 'provider') return `单格提供：相邻目标 × ${formatNum(it.bonusRate)}%`;
  if(kind === 'self') return `自身受加成：自身 × ${formatNum(it.bonusRate)}% / 相邻物品`;
  return '无加成属性';
}

function selfPriorityTier(it){
  const area = Number(it.area ?? (it.cells ? it.cells.length : 0));
  const quality = it.quality || 'green';
  const kind = it.bonusKind || bonusKind(it);
  if(kind !== 'self') return -1;
  if(area === 5 && quality === 'red') return 0;
  if(area === 4 && quality === 'gold') return 1;
  if(area === 3 && quality === 'red') return 2;
  if(area === 4 && quality === 'purple') return 3;
  if(area === 4 && quality === 'blue') return 4;
  if(area === 4 && quality === 'green') return 5;
  return -1;
}

