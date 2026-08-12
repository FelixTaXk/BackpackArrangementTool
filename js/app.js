// app.js —— init 与全局事件绑定，文件末尾调用 init()。加载顺序 12/12，依赖全部模块。
'use strict';

function init(){
  active = Array.from({length:6},()=>Array(7).fill(true));
  itemDefs = cloneItems(DEFAULT_ITEMS);
  configureWorkerCountControl();
  bindEvents();
  renderQualitySelect(document.getElementById('customQuality'), 'green', false, 1);
  renderSpaceGrid();
  renderItemsTable();
  renderInventoryTable();
  updateTableColumnLayout();
  renderResultGrid(null);
}

function bindEvents(){
  document.getElementById('resizeBtn').addEventListener('click', applySize);
  document.getElementById('fullBtn').addEventListener('click', ()=>{
    for(let r=0;r<H;r++) for(let c=0;c<W;c++) active[r][c]=true;
    lastResult = null;
    renderSpaceGrid();
    renderResultGrid(null);
  });
  document.getElementById('clearSpaceBtn').addEventListener('click', ()=>{
    for(let r=0;r<H;r++) for(let c=0;c<W;c++) active[r][c]=false;
    lastResult = null;
    renderSpaceGrid();
    renderResultGrid(null);
  });
  document.getElementById('resetItemsBtn').addEventListener('click', ()=>{
    itemDefs = cloneItems(DEFAULT_ITEMS);
    renderItemsTable();
  });
  document.getElementById('addCustomBtn').addEventListener('click', addCustomItem);
  document.getElementById('renumberBtn').addEventListener('click', renumberInventory);
  document.getElementById('clearInventoryBtn').addEventListener('click', ()=>{
    if(confirm('确定清空已有物品清单？')){
      inventory = [];
      nextItemNo = 1;
      lastResult = null;
      renderInventoryTable();
      renderResultGrid(null);
    }
  });
  document.getElementById('solveBtn').addEventListener('click', solveAndRender);
  document.getElementById('cancelSolveBtn').addEventListener('click', cancelSolve);
  document.getElementById('parallelSearch').addEventListener('change', e=>{
    document.getElementById('workerCountLabel').hidden=!e.target.checked;
  });
  document.querySelectorAll('[data-column-toggle]').forEach(toggle=>{
    toggle.addEventListener('change', e=>setOptionalColumnVisible(e.target.dataset.columnToggle,e.target.checked));
  });
  document.getElementById('searchMode').addEventListener('change', e=>{
    const deep=e.target.value==='deep';
    document.getElementById('nodeLimit').disabled=!deep;
    document.getElementById('timeLimit').disabled=!deep;
  });
  document.getElementById('exportBtn').addEventListener('click', exportResult);
  document.getElementById('saveBtn').addEventListener('click', saveConfig);
  document.getElementById('loadBtn').addEventListener('click', loadConfig);
  document.getElementById('useAdjacencyBonus').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  document.getElementById('allowRotate').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  document.getElementById('allowMirror').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  document.getElementById('customQuality').addEventListener('change', e=>{
    const q = e.target.value;
    const cells = parsePattern(document.getElementById('customPattern').value || '#');
    const area = cells.length || 1;
    document.getElementById('customValue').value = qualityValue(q, area);
    document.getElementById('customBonusRate').value = defaultBonusRate(area, q, false);
  });
}


init();
