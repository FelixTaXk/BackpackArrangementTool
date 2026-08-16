// persistence.js —— 本地配置保存/读取（schemaVersion 2，仅存数据库引用）与结果导出。加载顺序 12/13，依赖 state、utils、talisman-model、各渲染模块。
'use strict';

function saveConfig(){
  const data = {
    schemaVersion:2,
    W,H,active,
    useAdjacencyBonus:document.getElementById('useAdjacencyBonus').checked,
    searchMode:document.getElementById('searchMode').value,
    // 求解引擎为可选字段；旧存档缺失时读取侧缺省 legacy，schemaVersion 不变
    engineMode:document.getElementById('engineMode').value,
    // 加成聚焦为可选字段（只加法）；旧存档缺失时读取侧回退 ''（默认·总收益最大化），schemaVersion 不变
    focusAttr:(document.getElementById('focusAttr') || {}).value || '',
    nodeLimit:Number(document.getElementById('nodeLimit').value)||2500000,
    timeLimit:Number(document.getElementById('timeLimit').value)||20000,
    parallelSearch:document.getElementById('parallelSearch').checked,
    workerCount:Number(document.getElementById('workerCount').value)||2,
    // 存档绑定数据库版本：读取时比对，防止 id 复用导致同 id 指向不同法宝而不自知。
    dbVersion:(window.TALISMAN_DB && window.TALISMAN_DB.meta && window.TALISMAN_DB.meta.version) ?? null,
    // 数值全部来自内置数据库，清单只存引用（id + 手动邻接优先级）。
    inventory:inventory.map(x=>({id:x.id, customPriority:x.customPriority ?? null}))
  };
  try{
    localStorage.setItem('bagSolverConfig', JSON.stringify(data));
  }catch(e){
    alert('保存失败：浏览器本地存储不可用或已满。');
    return;
  }
  alert('已保存到浏览器本地存储。');
}
// 新旧存档共用的空间与求解设置应用（W/H/active 与各控件）；旧版存档迁移时也复用此函数。
function applySharedSettings(data){
  W = Math.max(1, Math.min(7, Number(data.W)||7));
  H = Math.max(1, Math.min(6, Number(data.H)||6));
  active = data.active;
  if(!Array.isArray(active) || active.length !== H || active.some(row=>!Array.isArray(row) || row.length !== W)){
    active = Array.from({length:H},()=>Array(W).fill(true));
  }else{
    active = active.map(row=>row.map(v=>v !== false && !!v));
  }
  document.getElementById('gridW').value = W; document.getElementById('gridH').value = H;
  // 旋转/镜像选项已从界面移除并固定为始终允许；旧存档中的对应字段直接忽略。
  document.getElementById('useAdjacencyBonus').checked = data.useAdjacencyBonus === true;
  if(data.searchMode === 'fast' || data.searchMode === 'deep'){
    document.getElementById('searchMode').value = data.searchMode;
    // 程序化赋值不会触发 change 事件，手动同步限制输入框的 disabled 状态（快速档禁用）。
    const deep = data.searchMode === 'deep';
    document.getElementById('nodeLimit').disabled = !deep;
    document.getElementById('timeLimit').disabled = !deep;
  }
  if(Number(data.nodeLimit) >= 1000) document.getElementById('nodeLimit').value = String(Math.floor(Number(data.nodeLimit)));
  if(Number(data.timeLimit) >= 100) document.getElementById('timeLimit').value = String(Math.floor(Number(data.timeLimit)));
  // 求解引擎：非法或缺省值（旧存档）一律回退 legacy。
  // 期 3 决策（拍板：保守）：页面默认档已改 auto（index.html selected + solver.js DOM 缺省），
  // 但老存档缺此字段读档时仍回退 legacy（老用户读档行为不变）；已存值跟随存档。
  document.getElementById('engineMode').value = (data.engineMode === 'hybrid' || data.engineMode === 'auto') ? data.engineMode : 'legacy';
  // 加成聚焦：须属 bonusStats id 否则回退 ''（老存档无此键行为不变，仿 engineMode 保守先例）。
  const focusStatKeys = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
  const focusSel = document.getElementById('focusAttr');
  if(focusSel) focusSel.value = focusStatKeys.indexOf(data.focusAttr) >= 0 ? data.focusAttr : '';
  document.getElementById('parallelSearch').checked = !!data.parallelSearch;
  document.getElementById('workerCountLabel').hidden = !data.parallelSearch;
  if(Number(data.workerCount) >= 2) document.getElementById('workerCount').value = String(Math.floor(Number(data.workerCount)));
}
function loadConfig(){
  const raw = localStorage.getItem('bagSolverConfig');
  if(!raw){ alert('没有找到已保存配置。'); return; }
  let data;
  try{ data = JSON.parse(raw); }catch(e){ alert('读取失败：配置数据损坏。'); return; }
  if(!data || Number(data.schemaVersion) !== 2){
    // 旧版存档：先整体备份到 v1.bak 再删除原 key；清单按 id 引用无法迁移，只能重置，
    // 但与 schema 无关的空间/求解设置字段仍可沿用。
    try{
      localStorage.setItem('bagSolverConfig.v1.bak', raw);
      localStorage.removeItem('bagSolverConfig');
    }catch(e){}
    if(data && typeof data === 'object') applySharedSettings(data);
    inventory = [];
    nextItemNo = 1;
    lastResult = null;
    renderSpaceGrid(); renderItemsTable(); renderInventoryTable(); renderResultGrid(null);
    alert('存档为旧版格式，清单已重置（旧数据已备份），空间与求解设置已保留。');
    return;
  }
  applySharedSettings(data);
  // 比对存档时的数据库版本与当前版本；不一致只提示不清空（id 可能复用指向不同法宝，需用户核对）。
  const currentDbVersion = (window.TALISMAN_DB && window.TALISMAN_DB.meta && window.TALISMAN_DB.meta.version) ?? null;
  const savedDbVersion = data.dbVersion ?? null;
  if(savedDbVersion !== currentDbVersion){
    const fmtVer = v => v == null ? '未知' : v;
    alert(`法宝数据库已更新（存档版本 ${fmtVer(savedDbVersion)} → 当前 ${fmtVer(currentDbVersion)}），旧清单中的法宝可能与保存时不是同一件，请核对清单内容。`);
  }
  // 按 id 查库重建清单；查不到的 id 跳过并提示。
  inventory = [];
  nextItemNo = 1;
  const missing = [];
  (Array.isArray(data.inventory) ? data.inventory : []).forEach(rec=>{
    const item = normalizeItemRecord({id:rec && rec.id, no:nextItemNo, customPriority:rec && rec.customPriority});
    if(!item){ if(rec && rec.id) missing.push(String(rec.id)); return; }
    item.uid = 'inv-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    inventory.push(item);
    nextItemNo++;
  });
  lastResult = null; renderSpaceGrid(); renderItemsTable(); renderInventoryTable(); renderResultGrid(null);
  if(missing.length) alert(`读取完成。以下法宝 id 在当前数据库中不存在，已跳过：${missing.join('、')}`);
  else alert('读取完成。');
}

function exportResult(){
  const data = lastResult || {message:'尚未计算结果', W, H, active, inventory};
  const blob = new Blob([JSON.stringify(data, (k,v)=> typeof v === 'bigint' ? v.toString() : v, 2)], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'bag-solver-result.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
