// ui-library.js —— 法宝库卡片：表格渲染/属性筛选/表格列布局。加载顺序 7/13，依赖 config、utils、state、talisman-model。
'use strict';

function updateTableColumnLayout(){
  ['itemsTable','inventoryTable'].forEach(id=>{
    const table=document.getElementById(id);
    if(!table) return;
    const visibleHeaders=[...table.querySelectorAll('thead th')].filter(th=>getComputedStyle(th).display!=='none');
    table.style.setProperty('--visible-columns',String(Math.max(1,visibleHeaders.length)));
    if(id==='inventoryTable'){
      const tracks=visibleHeaders.map(th=>{
        if(th.classList.contains('col-base')) return '1.4fr';
        if(th.classList.contains('col-name')) return '1.25fr';
        if(th.classList.contains('col-no') || th.classList.contains('col-action')) return '.8fr';
        return '1fr';
      });
      table.style.setProperty('--column-tracks',tracks.join(' '));
      table.querySelectorAll('thead tr,tbody tr').forEach(row=>{ row.style.gridTemplateColumns='var(--column-tracks)'; });
    }
  });
}

function libraryFilterAttribute(){
  const sel = document.getElementById('libraryFilterAttribute');
  return sel ? sel.value : '';
}

function initLibraryFilter(){
  const sel = document.getElementById('libraryFilterAttribute');
  if(!sel || sel.options.length > 1) return;
  for(const a of ATTRIBUTE_OPTIONS){
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name;
    sel.appendChild(opt);
  }
}

function renderItemsTable(){
  const tbody = document.querySelector('#itemsTable tbody');
  tbody.innerHTML = '';
  const attrFilter = libraryFilterAttribute();
  const rows = itemDefs
    .map((it, idx)=>({it, idx}))
    .filter(({it})=>!attrFilter || it.attribute === attrFilter);
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="col-empty" colspan="8"><div class="empty">当前筛选条件下没有法宝。</div></td>';
    tbody.appendChild(tr);
    updateTableColumnLayout();
    return;
  }
  rows.forEach(({it, idx})=>{
    const area = it.cells.length;
    const attr = ATTRIBUTE_MAP[it.attribute] || {name:it.attribute, displayColor:'#6b7280'};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-name" data-label="名称"><span class="shape-name">${escapeHtml(it.name)}</span><div class="hint">${area} 格</div></td>
      <td class="col-attribute" data-label="属性"><span class="attr-tag" style="border-color:${attr.displayColor};color:${attr.displayColor}">${escapeHtml(attr.name)}</span></td>
      <td class="col-quality" data-label="品质">${escapeHtml(qualityName(it.quality))}</td>
      <td class="col-shape" data-label="形状预览"></td>
      <td class="col-base" data-label="基础属性">${escapeHtml(baseStatsSummary(it))}</td>
      <td class="col-bonus" data-label="加成">${bonusControlHtml(it)}</td>
      <td class="col-add-count" data-label="添加数量"><input type="number" data-add-count="${idx}" min="1" step="1" value="1"></td>
      <td class="col-action" data-label="操作"><button class="compact" data-add="${idx}">添加</button></td>`;
    tr.querySelector('.col-shape').appendChild(makeMiniPreview(it.cells));
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('button[data-add]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const i = Number(e.currentTarget.dataset.add);
      const countInput = tbody.querySelector(`input[data-add-count="${i}"]`);
      const rawCount = Math.max(1, Math.floor(Number(countInput && countInput.value)||1));
      const count = Math.min(rawCount, 200);
      if(rawCount > 200) alert('单次添加数量已限制为 200');
      addToInventory(i, count);
    });
  });
  updateTableColumnLayout();
}
