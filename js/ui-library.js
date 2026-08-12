// ui-library.js —— 物品库卡片：表格渲染/品质下拉/自定义添加/列显示控制。加载顺序 6/12，依赖 config、utils、talisman-model。
'use strict';

function setOptionalColumnVisible(column,visible){
  const className={value:'hide-value-columns','bonus-rate':'hide-bonus-rate-columns','add-count':'hide-add-count-column'}[column];
  if(!className) return;
  document.body.classList.toggle(className,!visible);
  document.querySelectorAll(`[data-column-toggle="${column}"]`).forEach(x=>{ x.checked=visible; });
  updateTableColumnLayout();
}

function updateTableColumnLayout(){
  ['itemsTable','inventoryTable'].forEach(id=>{
    const table=document.getElementById(id);
    if(!table) return;
    const visibleHeaders=[...table.querySelectorAll('thead th')].filter(th=>getComputedStyle(th).display!=='none');
    const visibleCount=visibleHeaders.length;
    table.style.setProperty('--visible-columns',String(Math.max(1,visibleCount)));
    if(id==='inventoryTable'){
      const tracks=visibleHeaders.map(th=>{
        if(th.classList.contains('col-bonus-control')) return '1.8fr';
        if(th.classList.contains('col-name')) return '1.25fr';
        if(th.classList.contains('col-no') || th.classList.contains('col-action')) return '.8fr';
        return '1fr';
      });
      table.style.setProperty('--column-tracks',tracks.join(' '));
      table.querySelectorAll('thead tr,tbody tr').forEach(row=>{ row.style.gridTemplateColumns='var(--column-tracks)'; });
    }
  });
}

function renderQualitySelect(sel, selected, disabled=false, area=1){
  const allowed = allowedQualitiesForArea(area);
  const q = normalizeQualityForArea(selected, area);
  sel.innerHTML = allowed.map(id=>`<option value="${id}" ${id===q?'selected':''}>${qualityLabel(id, area)}</option>`).join('');
  sel.disabled = disabled;
}
function qualitySelectHtml(idx, value, scope, disabled=false, area=1){
  const allowed = allowedQualitiesForArea(area);
  const q = normalizeQualityForArea(value, area);
  const opts = allowed.map(id=>`<option value="${id}" ${id===q?'selected':''}>${qualityLabel(id, area)}</option>`).join('');
  return `<select data-${scope}-k="quality" data-i="${idx}" ${disabled?'disabled':''}>${opts}</select>`;
}

function renderItemsTable(){
  const tbody = document.querySelector('#itemsTable tbody');
  tbody.innerHTML = '';
  itemDefs = itemDefs.map(x=>normalizeItemRecord(x, true));
  itemDefs.forEach((it, idx)=>{
    const area = it.cells.length;
    const tr = document.createElement('tr');
    const locked = area === 5 || (area === 3 && it.threeSelfBonus);
    tr.innerHTML = `
      <td class="col-enabled" data-label="启用"><input type="checkbox" data-lib-k="enabled" data-i="${idx}" ${it.enabled!==false?'checked':''}></td>
      <td class="col-name" data-label="物品"><span class="shape-name">${escapeHtml(it.name)}</span><div class="hint">${area} 格</div></td>
      <td class="col-shape" data-label="形状"></td>
      <td class="col-quality" data-label="品质">${qualitySelectHtml(idx, it.quality, 'lib', locked, area)}</td>
      <td class="col-value" data-label="默认属性"><input type="number" data-lib-k="value" data-i="${idx}" min="0" step="1" value="${formatPlain(it.value)}"></td>
      <td class="col-bonus-rate" data-label="加成率"><input type="number" data-lib-k="bonusRate" data-i="${idx}" min="0" step="1" value="${formatPlain(it.bonusRate)}" ${bonusKind(it)==='none' && it.quality !== 'red'?'disabled':''}></td>
      <td class="col-add-count" data-label="添加数量"><input type="number" data-add-count="${idx}" min="1" step="1" value="1"></td>
      <td class="col-action" data-label="操作"><button class="compact" data-add="${idx}" ${it.enabled===false?'disabled':''}>添加</button></td>`;
    tr.children[2].appendChild(makeMiniPreview(it.cells));
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input[data-lib-k], select[data-lib-k]').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const i = Number(e.target.dataset.i), k = e.target.dataset.libK;
      if(!itemDefs[i]) return;
      if(k==='enabled') itemDefs[i].enabled = e.target.checked;
      if(k==='quality'){
        itemDefs[i].quality = e.target.value;
        itemDefs[i].value = qualityValue(e.target.value, itemDefs[i].cells.length);
        itemDefs[i].bonusRate = defaultBonusRate(itemDefs[i].cells.length, e.target.value, itemDefs[i].threeSelfBonus);
      }
      if(k==='value') itemDefs[i].value = Math.max(0, Number(e.target.value)||0);
      if(k==='bonusRate') itemDefs[i].bonusRate = Math.max(0, Number(e.target.value)||0);
      itemDefs[i] = normalizeItemRecord(itemDefs[i], true);
      renderItemsTable();
    });
  });
  tbody.querySelectorAll('button[data-add]').forEach(btn=>{
    btn.addEventListener('click', e=>{
      const i = Number(e.currentTarget.dataset.add);
      const countInput = tbody.querySelector(`input[data-add-count="${i}"]`);
      const rawCount = Math.max(1, Math.floor(Number(countInput.value)||1));
      const count = Math.min(rawCount, 200);
      if(rawCount > 200) alert('单次添加数量已限制为 200');
      addToInventory(i, count);
    });
  });
}

function addCustomItem(){
  const name = document.getElementById('customName').value.trim() || `自定义-${itemDefs.length+1}`;
  const pattern = document.getElementById('customPattern').value;
  const cells = parsePattern(pattern);
  if(!cells.length){ alert('请用 # 输入至少一个占用格。'); return; }
  const quality = document.getElementById('customQuality').value || 'green';
  const valueRaw = Number(document.getElementById('customValue').value);
  const rateRaw = Number(document.getElementById('customBonusRate').value);
  itemDefs.push(normalizeItemRecord({
    id:'custom-'+Date.now(), name, cells, quality,
    value:valueRaw>0?valueRaw:qualityValue(quality, cells.length), bonusRate:rateRaw>=0?rateRaw:defaultBonusRate(cells.length, quality, false),
    threeSelfBonus:false, enabled:true
  }, true));
  document.getElementById('customName').value = '';
  document.getElementById('customPattern').value = '';
  document.getElementById('customValue').value = '2';
  document.getElementById('customBonusRate').value = '0';
  renderItemsTable();
}

function parsePattern(pattern){
  const lines = pattern.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const cells = [];
  lines.forEach((line,r)=>{
    [...line].forEach((ch,c)=>{ if(ch==='#' || ch==='1' || ch==='■' || ch==='黑') cells.push([r,c]); });
  });
  return normalizeCells(cells);
}

