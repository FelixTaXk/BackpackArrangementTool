// config.js —— 常量与数据校验（属性/品质注册表、法宝数据库校验）。加载顺序 2/13，依赖 data/talisman-db.js。
'use strict';

const QUALITY_OPTIONS = [
  {id:'green', name:'绿'},
  {id:'blue', name:'蓝'},
  {id:'purple', name:'紫'},
  {id:'gold', name:'金'},
  {id:'red', name:'红'}
];
const QUALITY_MAP = Object.fromEntries(QUALITY_OPTIONS.map(q=>[q.id,q]));
// 摆放结果只按品质着色，同品质物品依靠序号与外轮廓区分。
const QUALITY_DISPLAY_STYLES = {
  green:  {fill:'#DDF3D8', border:'#3F7D44', text:'#173A1B'},
  blue:   {fill:'#DCEBFA', border:'#3F6E9D', text:'#183A5A'},
  purple: {fill:'#EADFF5', border:'#76539A', text:'#3E2857'},
  gold:   {fill:'#F7E8B8', border:'#9A7424', text:'#503A08'},
  red:    {fill:'#F4D3D0', border:'#A5443F', text:'#5D1E1B'}
};
// 数据库中品质为中文名，展示时先映射为内部 id 再取配色；talisman-model 亦复用此映射。
const QUALITY_NAME_TO_ID = {绿:'green', 蓝:'blue', 紫:'purple', 金:'gold', 红:'red'};
// 长老星级基础属性加成表（仅红品质法宝适用）：下标 = 星级-1，值 = 基础属性加成率
// （1星+0% / 2星+60% / 3星+60% / 4星+100% / 5星+150%）；星级数/合法上界/UI 选项数均由 .length 派生（表驱动）。
const STAR_LEVEL_BONUS = [0, 0.6, 0.6, 1.0, 1.5];
function qualityDisplayStyle(q){ return QUALITY_DISPLAY_STYLES[QUALITY_NAME_TO_ID[q] || q] || QUALITY_DISPLAY_STYLES.green; }

// 属性注册表：8 种法宝属性，displayColor 用于界面展示。
const ATTRIBUTE_OPTIONS = [
  {id:'金', name:'金', displayColor:'#b45309'},
  {id:'木', name:'木', displayColor:'#15803d'},
  {id:'水', name:'水', displayColor:'#1d4ed8'},
  {id:'火', name:'火', displayColor:'#b91c1c'},
  {id:'土', name:'土', displayColor:'#a16207'},
  {id:'雷', name:'雷', displayColor:'#7c3aed'},
  {id:'邪', name:'邪', displayColor:'#c0392b'},
  {id:'体', name:'体', displayColor:'#be185d'}
];
const ATTRIBUTE_MAP = Object.fromEntries(ATTRIBUTE_OPTIONS.map(a=>[a.id,a]));

// 启动时逐条校验 TALISMAN_DB.talismans：形状连通且不超过 7×6、枚举合法、
// baseStats/bonusRates 的 key 必须在 bonusStats 注册表中；非法条目剔除并 console.warn 汇总。
function validateTalismanDB(){
  const db = typeof window !== 'undefined' ? window.TALISMAN_DB : null;
  if(!db || !Array.isArray(db.talismans)){
    console.warn('[talisman-db] 数据库缺失，使用空数据。');
    if(db) db.talismans = [];
    return [];
  }
  const attrs = Array.isArray(db.attributes) ? db.attributes : [];
  const quals = Array.isArray(db.qualities) ? db.qualities : [];
  const statIds = (Array.isArray(db.bonusStats) ? db.bonusStats : []).map(s=>s && s.id).filter(Boolean);
  const valid = [];
  const removed = [];
  const seenIds = new Set();
  db.talismans.forEach((t, idx)=>{
    const errors = [];
    if(!t || typeof t !== 'object'){ errors.push('条目为空'); }
    else{
      if(typeof t.id !== 'string' || !t.id){ errors.push('缺少 id'); }
      else if(seenIds.has(t.id)){ errors.push(`id 重复：${t.id}`); }
      if(!attrs.includes(t.attribute)) errors.push(`属性非法：${t.attribute}`);
      if(!quals.includes(t.quality)) errors.push(`品质非法：${t.quality}`);
      if(!Array.isArray(t.cells) || t.cells.length === 0){ errors.push('形状为空'); }
      else{
        const ok = t.cells.every(c=>Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]) && c[0] >= 0 && c[0] <= 5 && c[1] >= 0 && c[1] <= 6);
        if(!ok) errors.push('形状坐标超出 7×6 范围');
        else{
          const keys = new Set(t.cells.map(c=>c.join(',')));
          if(keys.size !== t.cells.length) errors.push('形状坐标重复');
          else if(!isShapeConnected(t.cells)) errors.push('形状不连通');
        }
      }
      if(!['provider','self','none'].includes(t.bonusMode)) errors.push(`bonusMode 非法：${t.bonusMode}`);
      if(t.priorityTier !== undefined && (!Number.isInteger(t.priorityTier) || t.priorityTier < 0 || t.priorityTier > 5)) errors.push(`priorityTier 越界：${t.priorityTier}`);
      for(const key of ['baseStats','bonusRates']){
        const obj = t[key];
        if(obj && typeof obj === 'object'){
          for(const k of Object.keys(obj)){
            if(!statIds.includes(k)) errors.push(`${key} 含未注册项目：${k}`);
            else if(!Number.isFinite(Number(obj[k])) || Number(obj[k]) < 0) errors.push(`${key}.${k} 数值非法`);
          }
        }else if(key === 'baseStats'){
          errors.push('缺少 baseStats');
        }
      }
      if(t.baseStats && !errors.some(e=>e.includes('baseStats')) && Object.values(t.baseStats).reduce((s,v)=>s+Number(v),0) <= 0){
        errors.push('baseStats 总和必须大于 0');
      }
    }
    if(errors.length){ removed.push(`#${idx} ${t && t.id ? t.id : '(无id)'}：${errors.join('；')}`); }
    else{ seenIds.add(t.id); valid.push(t); }
  });
  db.talismans = valid;
  if(removed.length) console.warn(`[talisman-db] 已剔除 ${removed.length} 条非法法宝记录：\n${removed.join('\n')}`);
  return valid;
}
function isShapeConnected(cells){
  if(cells.length <= 1) return true;
  const set = new Set(cells.map(([r,c])=>`${r},${c}`));
  const queue = [cells[0]];
  const seen = new Set([`${cells[0][0]},${cells[0][1]}`]);
  while(queue.length){
    const [r,c] = queue.shift();
    for(const [nr,nc] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]){
      const k = `${nr},${nc}`;
      if(set.has(k) && !seen.has(k)){ seen.add(k); queue.push([nr,nc]); }
    }
  }
  return seen.size === cells.length;
}
