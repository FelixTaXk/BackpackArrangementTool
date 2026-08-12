// persistence.js —— 本地配置保存/读取与结果导出。加载顺序 11/12，依赖 state、utils、talisman-model、各渲染模块。
'use strict';

function saveConfig(){
  const data = {
    W,H,active,itemDefs,inventory,nextItemNo,
    allowRotate:document.getElementById('allowRotate').checked,
    allowMirror:document.getElementById('allowMirror').checked,
    useAdjacencyBonus:document.getElementById('useAdjacencyBonus').checked
  };
  try{
    localStorage.setItem('bagSolverConfig', JSON.stringify(data));
  }catch(e){
    alert('保存失败：浏览器本地存储不可用或已满。');
    return;
  }
  alert('已保存到浏览器本地存储。');
}
function loadConfig(){
  const raw = localStorage.getItem('bagSolverConfig');
  if(!raw){ alert('没有找到已保存配置。'); return; }
  try{
    const data = JSON.parse(raw);
    W = Math.max(1, Math.min(7, Number(data.W)||7));
    H = Math.max(1, Math.min(6, Number(data.H)||6));
    active = data.active;
    if(!Array.isArray(active) || active.length !== H || active.some(row=>!Array.isArray(row) || row.length !== W)){
      active = Array.from({length:H},()=>Array(W).fill(true));
    }else{
      active = active.map(row=>row.map(v=>v !== false && !!v));
    }
    itemDefs = data.itemDefs ? cloneItems(data.itemDefs) : cloneItems(DEFAULT_ITEMS);
    if(Array.isArray(data.inventory)){
      inventory = data.inventory.map(x=>normalizeItemRecord({...x, cells:cloneCells(x.cells || [])}, true));
    }else{
      inventory = [];
      let no = 1;
      for(const def of itemDefs){
        const qty = Math.max(0, Math.floor(Number(def.qty)||0));
        for(let i=0;i<qty;i++) inventory.push(normalizeItemRecord({uid:'migrate-'+Date.now()+'-'+no, no:no++, typeId:def.id, typeName:def.name, name:def.name, cells:cloneCells(def.cells), quality:def.quality, value:def.value, bonusRate:def.bonusRate, threeSelfBonus:!!def.threeSelfBonus}, true));
      }
    }
    nextItemNo = data.nextItemNo || (inventory.reduce((m,x)=>Math.max(m, Number(x.no)||0),0)+1);
    document.getElementById('gridW').value = W; document.getElementById('gridH').value = H;
    document.getElementById('allowRotate').checked = data.allowRotate === true;
    document.getElementById('allowMirror').checked = !!data.allowMirror;
    document.getElementById('useAdjacencyBonus').checked = data.useAdjacencyBonus === true;
    lastResult = null; renderSpaceGrid(); renderItemsTable(); renderInventoryTable(); renderResultGrid(null);
  }catch(e){ alert('读取失败：配置数据损坏。'); }
}

function exportResult(){
  const data = lastResult || {message:'尚未计算结果', W, H, active, itemDefs, inventory};
  const blob = new Blob([JSON.stringify(data, (k,v)=> typeof v === 'bigint' ? v.toString() : v, 2)], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = 'bag-solver-result.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
