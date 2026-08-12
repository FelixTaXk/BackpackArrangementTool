// ui-inventory.js —— 已有物品清单卡片：清单渲染/格数统计/添加与重编号。加载顺序 7/12，依赖 state、utils、talisman-model。
'use strict';

function renderInventoryTable(){
  const tbody = document.querySelector('#inventoryTable tbody');
  tbody.innerHTML = '';
  inventory = inventory.map(x=>normalizeItemRecord(x, true));
  if(inventory.length === 0){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="col-empty" colspan="9"><div class="empty">暂无已有物品。请先从物品库点击“添加”。</div></td>`;
    tbody.appendChild(tr);
    updateTableColumnLayout();
    renderInventoryCellSummary();
    return;
  }
  inventory.forEach((it, idx)=>{
    const area = it.cells.length;
    const locked = area === 5 || (area === 3 && it.threeSelfBonus);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-no" data-label="编号"><b>#${it.no}</b></td>
      <td class="col-name" data-label="名称"><input class="name-input" type="text" data-inv-k="name" data-i="${idx}" value="${escapeAttr(it.name)}"></td>
      <td class="col-shape" data-label="形状"></td>
      <td class="col-quality" data-label="品质">${qualitySelectHtml(idx, it.quality, 'inv', locked, area)}</td>
      <td class="col-value" data-label="基础属性"><input type="number" data-inv-k="value" data-i="${idx}" min="0" step="1" value="${formatPlain(it.value)}"></td>
      <td class="col-value col-bonus-control" data-label="加成属性">${bonusControlHtml(it, idx)}</td>
      <td class="col-bonus-rate" data-label="加成率"><input type="number" data-inv-k="bonusRate" data-i="${idx}" min="0" step="1" value="${formatPlain(it.bonusRate)}" ${bonusKind(it)==='none' && it.quality !== 'red'?'disabled':''}></td>
      <td class="col-priority" data-label="邻接优先级"><input class="priority-input" type="number" data-inv-k="customPriority" data-i="${idx}" min="1" max="99" step="1" value="${it.customPriority ?? ''}" placeholder="默认" title="1 为最高，数字越小越优先；留空使用默认规则"></td>
      <td class="col-action" data-label="操作"><button class="danger compact" data-del-inv="${idx}">删除</button></td>`;
    tr.children[2].appendChild(makeMiniPreview(it.cells));
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('input[data-inv-k], select[data-inv-k]').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const i = Number(e.target.dataset.i), k = e.target.dataset.invK;
      if(!inventory[i]) return;
      if(k==='name') inventory[i].name = e.target.value.trim() || inventory[i].name;
      if(k==='quality'){
        inventory[i].quality = e.target.value;
        inventory[i].value = qualityValue(e.target.value, inventory[i].cells.length);
        inventory[i].bonusRate = defaultBonusRate(inventory[i].cells.length, e.target.value, inventory[i].threeSelfBonus);
      }
      if(k==='value') inventory[i].value = Math.max(0, Number(e.target.value)||0);
      if(k==='bonusRate') inventory[i].bonusRate = Math.max(0, Number(e.target.value)||0);
      if(k==='customPriority'){
        const raw = String(e.target.value || '').trim();
        inventory[i].customPriority = raw === '' ? null : Math.max(1, Math.min(99, Math.floor(Number(raw)||1)));
      }
      if(k==='threeSelfBonus'){
        inventory[i].threeSelfBonus = e.target.checked;
        if(e.target.checked){
          inventory[i].quality = 'red';
          const currentRate = Number(inventory[i].bonusRate);
          if(!Number.isFinite(currentRate) || currentRate <= 0) inventory[i].bonusRate = 20;
        }
        // 关闭开关时保留已填写的红装加成率，之后重新开启无需再次输入。
      }
      inventory[i] = normalizeItemRecord(inventory[i], true);
      renderInventoryTable();
      renderResultGrid(null);
      lastResult = null;
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

function addToInventory(defIndex, count){
  const def = normalizeItemRecord(itemDefs[defIndex], true);
  if(!def || def.enabled === false) return;
  for(let k=0;k<count;k++){
    inventory.push(normalizeItemRecord({
      uid:'inv-' + Date.now() + '-' + Math.random().toString(16).slice(2),
      no: nextItemNo++,
      typeId: def.id,
      typeName: def.name,
      name: def.name,
      cells: cloneCells(def.cells),
      quality: def.quality,
      value: def.value,
      bonusRate: def.bonusRate,
      threeSelfBonus: !!def.threeSelfBonus,
      customPriority: null
    }, true));
  }
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

