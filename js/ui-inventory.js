// ui-inventory.js —— 已有法宝清单卡片：清单渲染/格数统计/添加与重编号。加载顺序 8/13，依赖 state、utils、talisman-model。
'use strict';

// 长老星级下拉选项 HTML（表驱动，文案纯「N星」）；selectedLv 缺省选 1 星。
function starLevelOptionsHtml(selectedLv){
  const sel = Number(selectedLv) || 1;
  return STAR_LEVEL_BONUS.map((b,i)=>`<option value="${i+1}"${sel === i+1 ? ' selected' : ''}>${i+1}星</option>`).join('');
}

// 同族变体查找：红品质家族为独立家族（无普通品质变体），普通家族仅有绿/蓝/紫/金变体，
// 故变体必须按家族名匹配推导（数据库序号非家族稳定，按 id 品质段替换会跨族静默换件）。
function familyVariants(name){
  return (Array.isArray(itemDefs) ? itemDefs : []).filter(d => d.name === name);
}

// 品质行内下拉选项 HTML：仅列出该家族实际拥有的品质（顺序绿/蓝/紫/金/红，与 config.js 品质口径一致），
// 当前品质 selected；红专属家族因此只有「红」一个选项（保留下拉形态）。
function qualityOptionsHtml(selectedQuality, variants){
  const selId = QUALITY_NAME_TO_ID[selectedQuality] || selectedQuality;
  return QUALITY_OPTIONS
    .filter(q => variants.some(v => (QUALITY_NAME_TO_ID[v.quality] || v.quality) === q.id))
    .map(q=>`<option value="${q.id}" data-q="${q.id}"${selId === q.id ? ' selected' : ''}>${escapeHtml(q.name)}</option>`).join('');
}

function renderInventoryTable(){
  const tbody = document.querySelector('#inventoryTable tbody');
  tbody.innerHTML = '';
  if(inventory.length === 0){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="col-empty" colspan="9"><div class="empty">暂无已有法宝。请先从法宝库点击“添加”。</div></td>';
    tbody.appendChild(tr);
    updateTableColumnLayout();
    renderInventoryCellSummary();
    return;
  }
  inventory.forEach((it, idx)=>{
    const attr = ATTRIBUTE_MAP[it.attribute] || {name:it.attribute, displayColor:'#6b7280'};
    const variants = familyVariants(it.name);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-no" data-label="编号"><b>#${it.no}</b></td>
      <td class="col-name" data-label="名称"><span class="shape-name">${escapeHtml(it.name)}</span></td>
      <td class="col-attribute" data-label="属性"><span class="attr-tag" style="border-color:${attr.displayColor};color:${attr.displayColor}">${escapeHtml(attr.name)}</span></td>
      <td class="col-quality" data-label="品质"><select data-quality-select data-inv-quality data-i="${idx}" data-q="${QUALITY_NAME_TO_ID[it.quality] || ''}" title="品质可修改：同族变体匹配重建（跨族无变体会提示复原）">${qualityOptionsHtml(it.quality, variants)}</select>${it.quality === '红' ? `<select data-star-select data-q="red" data-inv-star data-i="${idx}" title="长老星级：基础属性按星级放大（1星无加成）">${starLevelOptionsHtml(it.starLevel)}</select>` : ''}</td>
      <td class="col-shape" data-label="形状"></td>
      <td class="col-base" data-label="基础属性">${baseStatsLinesHtml(it)}</td>
      <td class="col-bonus" data-label="加成模式">${bonusLinesHtml(it)}</td>
      <td class="col-priority" data-label="邻接优先级"><input class="priority-input" type="number" data-inv-k="customPriority" data-i="${idx}" min="1" max="99" step="1" value="${it.customPriority ?? ''}" placeholder="默认" title="1 为最高，数字越小越优先；留空使用默认规则"></td>
      <td class="col-action" data-label="操作"><button class="danger compact" data-del-inv="${idx}">删除</button></td>`;
    tr.querySelector('.col-shape').appendChild(makeMiniPreview(it.cells));
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input[data-inv-k]').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const i = Number(e.target.dataset.i);
      if(!inventory[i]) return;
      const raw = String(e.target.value || '').trim();
      inventory[i].customPriority = raw === '' ? null : Math.max(1, Math.min(99, Math.floor(Number(raw)||1)));
      lastResult = null;
      renderResultGrid(null);
    });
  });
  // 清单品质行内编辑：按家族名匹配同族变体（不再按 id 品质段替换推导——数据库序号非家族稳定，
  // 旧逻辑会把红专属法宝静默换成同序号普通法宝，形状/加成损坏）。目标品质无同族变体（红↔普通边界）
  // 时 alert 提示并复原下拉；有变体则走 normalizeItemRecord 重建（保留 uid/no/customPriority/starLevel）并清结果。
  tbody.querySelectorAll('select[data-inv-quality]').forEach(sel=>{
    sel.addEventListener('change', e=>{
      const i = Number(e.target.dataset.i);
      const old = inventory[i];
      if(!old) return;
      const newQid = e.target.value;
      const curQid = QUALITY_NAME_TO_ID[old.quality] || '';
      if(newQid === curQid) return;
      const newQualityName = (QUALITY_MAP[newQid] || {}).name || newQid;
      const target = familyVariants(old.name).find(v => v.quality === newQualityName);
      if(!target){
        alert(`该家族无${newQualityName}品质变体。`);
        e.target.value = curQid;
        return;
      }
      const rec = normalizeItemRecord({id:target.id, uid:old.uid, no:old.no, customPriority:old.customPriority, starLevel:old.starLevel});
      if(!rec) return;
      inventory[i] = rec;
      lastResult = null;
      renderInventoryTable();
      renderResultGrid(null);
    });
  });
  // 红法宝星级行内编辑（仿 customPriority 先例）：以 normalizeItemRecord 重建记录使新星级倍率
  // 物化到 baseStats/value；必须保留 uid/no（uid 是聚焦装饰层反查键，no 保持编号稳定）。
  tbody.querySelectorAll('select[data-inv-star]').forEach(sel=>{
    sel.addEventListener('change', e=>{
      const i = Number(e.target.dataset.i);
      const old = inventory[i];
      if(!old) return;
      const rec = normalizeItemRecord({id:old.id, uid:old.uid, no:old.no, customPriority:old.customPriority, starLevel:Number(e.target.value)});
      if(!rec) return;
      inventory[i] = rec;
      lastResult = null;
      renderInventoryTable();
      renderResultGrid(null);
    });
  });
  tbody.querySelectorAll('button[data-del-inv]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const i = Number(e.currentTarget.dataset.delInv);
      inventory.splice(i,1);
      lastResult = null;
      renderInventoryTable();
      renderResultGrid(null);
    });
  });
  updateTableColumnLayout();
  renderInventoryCellSummary();
}

function renderInventoryCellSummary(){
  const itemEl=document.getElementById('inventoryItemTotal');
  const cellEl=document.getElementById('inventoryCellTotal');
  const balanceEl=document.getElementById('inventoryCellBalance');
  if(!itemEl || !cellEl || !balanceEl) return;
  const used=inventory.reduce((sum,item)=>sum+(item.cells?.length||0),0);
  const available=active.reduce((sum,row)=>sum+row.filter(Boolean).length,0);
  const difference=used-available;
  itemEl.textContent=String(inventory.length);
  cellEl.textContent=`${used} / ${available}`;
  balanceEl.className='cell-balance '+(difference===0?'exact':difference>0?'over':'under');
  balanceEl.textContent=difference===0?'格数刚好':difference>0?`超出 ${difference} 格`:`还差 ${Math.abs(difference)} 格`;
}

function addToInventory(defIndex, starLevel){
  const def = itemDefs[defIndex];
  if(!def) return;
  const rec = normalizeItemRecord({
    uid:'inv-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    no: nextItemNo++,
    id: def.id,
    customPriority: null,
    // 长老星级透传（只加法，旧调用不传时红品质回退 1 星、非红 null）；放大由 normalizeItemRecord 源层物化。
    starLevel: starLevel ?? null
  });
  if(rec) inventory.push(rec);
  renderInventoryTable();
  renderResultGrid(null);
  lastResult = null;
}

function renumberInventory(){
  inventory.forEach((it, idx)=>{ it.no = idx + 1; });
  nextItemNo = inventory.length + 1;
  renderInventoryTable();
  renderResultGrid(null);
  lastResult = null;
}
