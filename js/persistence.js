// persistence.js —— 本地配置保存/读取（schemaVersion 2，仅存数据库引用）与结果导出。加载顺序 12/13，依赖 state、utils、talisman-model、各渲染模块。
'use strict';

function saveConfig(){
  const data = {
    schemaVersion:2,
    W,H,active,
    allowRotate:document.getElementById('allowRotate').checked,
    allowMirror:document.getElementById('allowMirror').checked,
    useAdjacencyBonus:document.getElementById('useAdjacencyBonus').checked,
    searchMode:document.getElementById('searchMode').value,
    nodeLimit:Number(document.getElementById('nodeLimit').value)||2500000,
    timeLimit:Number(document.getElementById('timeLimit').value)||20000,
    parallelSearch:document.getElementById('parallelSearch').checked,
    workerCount:Number(document.getElementById('workerCount').value)||2,
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
  document.getElementById('allowRotate').checked = data.allowRotate === true;
  document.getElementById('allowMirror').checked = !!data.allowMirror;
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
