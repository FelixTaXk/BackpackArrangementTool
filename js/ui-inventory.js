// ui-inventory.js —— 已有法宝清单卡片：清单渲染/格数统计/添加与重编号。加载顺序 8/13，依赖 state、utils、talisman-model。
'use strict';

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
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-no" data-label="编号"><b>#${it.no}</b></td>
      <td class="col-name" data-label="名称"><span class="shape-name">${escapeHtml(it.name)}</span></td>
      <td class="col-attribute" data-label="属性"><span class="attr-tag" style="border-color:${attr.displayColor};color:${attr.displayColor}">${escapeHtml(attr.name)}</span></td>
      <td class="col-quality" data-label="品质"><span class="quality-chip" data-quality="${QUALITY_NAME_TO_ID[it.quality] || ''}">${escapeHtml(qualityName(it.quality))}</span></td>
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

function addToInventory(defIndex){
  const def = itemDefs[defIndex];
  if(!def) return;
  const rec = normalizeItemRecord({
    uid:'inv-' + Date.now() + '-' + Math.random().toString(16).slice(2),
    no: nextItemNo++,
    id: def.id,
    customPriority: null
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
