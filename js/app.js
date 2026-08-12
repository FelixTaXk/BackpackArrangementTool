// app.js —— init 与全局事件绑定，文件末尾调用 init()。加载顺序 13/13，依赖全部模块。
'use strict';

function init(){
  validateTalismanDB();
  active = Array.from({length:6},()=>Array(7).fill(true));
  itemDefs = buildItemDefs();
  configureWorkerCountControl();
  bindEvents();
  initLibraryFilter();
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
    itemDefs = buildItemDefs();
    renderItemsTable();
  });
  document.getElementById('libraryFilterAttribute').addEventListener('change', renderItemsTable);
  document.getElementById('renumberBtn').addEventListener('click', renumberInventory);
  document.getElementById('clearInventoryBtn').addEventListener('click', ()=>{
    if(confirm('确定清空已有法宝清单？')){
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
}


init();
