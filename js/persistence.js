// persistence.js —— 本地配置保存/读取（schemaVersion 2，仅存数据库引用）与结果导出。加载顺序 18/19，依赖 state、utils、talisman-model、各渲染模块。
'use strict';

function saveConfig(){
  const data = {
    schemaVersion:2,
    W,H,active,
    useAdjacencyBonus:document.getElementById('useAdjacencyBonus').checked,
    searchMode:document.getElementById('searchMode').value,
    // 加成聚焦为可选字段（只加法）；旧存档缺失时读取侧回退 ''（默认·总收益最大化），schemaVersion 不变
    focusAttr:(document.getElementById('focusAttr') || {}).value || '',
    // 属性权重（一期线性）：存八 input 的原始字符串数组（0 必须存活，禁止 Number(..)||1 一类归一）；
    // 旧存档无此键读档行为不变，schemaVersion 不变
    weightMul:WEIGHT_INPUT_IDS.map(id=>(document.getElementById(id) || {}).value ?? ''),
    // 权重口径开关：存 select 原始值（default/custom）；读取侧白名单校验，缺失/非法不触碰 DOM，schemaVersion 不变
    weightMode:(document.getElementById('weightMode') || {}).value,
    nodeLimit:Number(document.getElementById('nodeLimit').value)||2500000,
    // 时间上限/停滞提前结束单位在界面上为秒（与内部 ms 解耦）。旧存档存的是 ms，
    // 加载侧依据阈值（>3600）判别并折算，保证跨版本恢复不炸。
    timeLimit:Number(document.getElementById('timeLimit').value)||30,
    parallelSearch:document.getElementById('parallelSearch').checked,
    workerCount:Number(document.getElementById('workerCount').value)||2,
    // 存档绑定数据库版本：读取时比对，防止 id 复用导致同 id 指向不同法宝而不自知。
    dbVersion:(window.TALISMAN_DB && window.TALISMAN_DB.meta && window.TALISMAN_DB.meta.version) ?? null,
    // 数值全部来自内置数据库，清单只存引用（id + 手动邻接优先级 + 红品质长老星级）。
    inventory:inventory.map(x=>({id:x.id, customPriority:x.customPriority ?? null, starLevel:x.starLevel ?? null}))
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
    document.getElementById('timeLimit').disabled = !deep;
  }
  if(Number(data.nodeLimit) >= 1000) document.getElementById('nodeLimit').value = String(Math.floor(Number(data.nodeLimit)));
  // 时间上限单位由 ms 改为秒：旧存档存 ms（≥3600 秒的量级不可能以秒出现，用此判据迁移），
  // 新存档直接是秒。折算后钳制在 [1, 3600] 秒合理范围。
  const tl = Number(data.timeLimit);
  if(Number.isFinite(tl) && tl > 0){
    const seconds = tl > 3600 ? Math.max(1, Math.round(tl / 1000)) : Math.min(3600, Math.max(1, Math.round(tl)));
    document.getElementById('timeLimit').value = String(seconds);
  }
  // 自动早停（无 UI readout）：阈值由 solveAndRender 内部按「最长×1/3」推导；此处不触碰 DOM。
  // 求解引擎已统一为 SA（老引擎退役），旧存档中的 engineMode 字段直接忽略。
  // 加成聚焦：须属 bonusStats id 否则回退 ''（老存档无此键行为不变）。
  const focusStatKeys = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
  const focusSel = document.getElementById('focusAttr');
  if(focusSel) focusSel.value = focusStatKeys.indexOf(data.focusAttr) >= 0 ? data.focusAttr : '';
  // 属性权重（一期线性）：老存档无此键（data.weightMul == null）不触碰 DOM，行为不变；
  // 仅 Array.isArray && (length===3 || length===8) 且逐项合法才写回：旧 3 维（atk/def/hp）扩展为 8 维
  // （新增 5 个 rate-only 维度默认权重 1），新 8 维原样回写。非法值整体忽略保持默认 1。schemaVersion 不变；
  // 程序化赋值不派发 change（先例见上方 searchMode 注释），手工同步 chips 选中态。
  if(Array.isArray(data.weightMul) && (data.weightMul.length === 3 || data.weightMul.length === 8) && data.weightMul.every(v=>Number.isFinite(Number(v)) && Number(v) >= 0)){
    // 回写归一化为十进制串：校验用 Number(v) 会接受 "0x10"/true 一类字面量，原样赋给 number input
    // 会被 HTML 净化为 ''，再被 readWeightMul 判非法，故需归一化；而 "٣" 一类非 ASCII 数字串
    // Number() 判 NaN，在校验处即整体回退（不进入本分支）；String(Number(v)) 保证校验值与 DOM 值回环一致。
    // 3 维 → 8 维扩展：新 5 维（伤害/暴击伤害/治疗效果/护盾值/汲取）权重补 1。
    const w = data.weightMul.length === 3 ? [...data.weightMul, '1','1','1','1','1'] : data.weightMul.slice(0, 8);
    WEIGHT_INPUT_IDS.forEach((id, i) => { document.getElementById(id).value = String(Number(w[i])); });
    if(typeof syncWeightPresetChips === 'function') syncWeightPresetChips();
  }
  // 权重口径：仅白名单值写 DOM（老存档缺失/非法不触碰，保持 DOM 现状）；
  // 程序化赋值不派发 change（先例见上方 searchMode 注释），写后手工同步 wrap 显隐与 chips 选中态。
  if(data.weightMode === 'default' || data.weightMode === 'custom'){
    document.getElementById('weightMode').value = data.weightMode;
    document.getElementById('weightCustomWrap').hidden = data.weightMode !== 'custom';
    if(typeof syncWeightPresetChips === 'function') syncWeightPresetChips();
  }
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
    // 长老星级透传（只加法）：旧存档缺键时红品质回退 1 星（原值）、非红 null，读档行为零变化。
    const item = normalizeItemRecord({id:rec && rec.id, no:nextItemNo, customPriority:rec && rec.customPriority, starLevel:rec && rec.starLevel});
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

// 清单导入导出 schema（v1）：仅存必要字段（id + customPriority + starLevel + no），
// 与 saveConfig 中的 inventory 序列化口径一致；读档侧按 id 反查当前数据库重建。
// 导出文件名带本地日期时间戳便于多版本管理。
function exportInventory(){
  const data = {
    schemaVersion: 1,
    type: 'bag-solver-inventory',
    dbVersion: (window.TALISMAN_DB && window.TALISMAN_DB.meta && window.TALISMAN_DB.meta.version) ?? null,
    exportedAt: new Date().toISOString(),
    inventory: inventory.map(x => ({
      id: x.id,
      no: x.no,
      customPriority: x.customPriority ?? null,
      starLevel: x.starLevel ?? null
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json;charset=utf-8'});
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  const ts = new Date();
  const pad = n => String(n).padStart(2, '0');
  a.download = `法宝清单-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}

// 清单导入：先校验 schema/类型，再按用户选择「追加」或「替换」合并；缺失的 id 在数据库中查不到时跳过并汇总提示。
// 成功合并后重建 uid 触发 UI 重渲染并清空上一次求解结果（导入后配置已变）。
function importInventoryFromText(text){
  let data;
  try{ data = JSON.parse(text); }catch(e){
    alert('文件不是合法 JSON：' + e.message);
    return;
  }
  if(!data || typeof data !== 'object'){ alert('文件内容不是对象。'); return; }
  if(data.type !== 'bag-solver-inventory'){ alert('文件类型不匹配，应为「法宝清单」导出文件。'); return; }
  if(!Array.isArray(data.inventory)){ alert('文件缺少 inventory 数组。'); return; }
  const records = data.inventory.filter(r => r && typeof r === 'object' && r.id);
  if(records.length === 0){ alert('清单为空。'); return; }
  const currentLen = inventory.length;
  const mode = currentLen === 0 ? 'replace' : (confirm(`当前清单已有 ${currentLen} 件法宝。\n确定：替换为导入清单（现有法宝会被清空）。\n取消：追加到当前清单末尾。`) ? 'replace' : 'append');
  const base = mode === 'replace' ? [] : inventory.slice();
  const missing = [];
  const nextNoBase = base.length > 0 ? Math.max(...base.map(x => Number(x.no) || 0)) + 1 : 1;
  let nextNo = nextNoBase;
  for(const rec of records){
    // 透传 customPriority/starLevel（缺键视为 null），构造与 saveConfig 读档一致的最小记录。
    const item = normalizeItemRecord({
      id: rec.id,
      no: nextNo,
      customPriority: rec.customPriority,
      starLevel: rec.starLevel
    });
    if(!item){ missing.push(String(rec.id)); continue; }
    item.uid = 'inv-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    base.push(item);
    nextNo++;
  }
  inventory = base;
  if(mode === 'replace') nextItemNo = nextNo; else nextItemNo = nextNo;
  lastResult = null;
  renderSpaceGrid(); renderItemsTable(); renderInventoryTable(); renderResultGrid(null);
  const summary = mode === 'replace' ? '已替换' : '已追加';
  if(missing.length){
    alert(`${summary} ${records.length - missing.length}/${records.length} 件法宝。以下 id 在当前数据库中不存在，已跳过：${missing.join('、')}`);
  }else{
    alert(`${summary} ${records.length} 件法宝。`);
  }
}
function importInventoryFromFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(e){
    const text = String(e.target.result || '');
    importInventoryFromText(text);
  };
  reader.onerror = function(){ alert('读取文件失败：' + (reader.error && reader.error.message || '未知错误')); };
  reader.readAsText(file, 'utf-8');
}
