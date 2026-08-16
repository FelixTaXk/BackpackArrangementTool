// app.js —— init 与全局事件绑定，文件末尾调用 init()。加载顺序 13/13，依赖全部模块。
'use strict';

function init(){
  validateTalismanDB();
  active = Array.from({length:6},()=>Array(7).fill(true));
  itemDefs = buildItemDefs();
  configureWorkerCountControl();
  bindEvents();
  syncWeightPresetChips();
  initLibraryFilter();
  renderSpaceGrid();
  renderItemsTable();
  renderInventoryTable();
  updateTableColumnLayout();
  renderResultGrid(null);
}

// 属性权重预设 chips 选中态同步（全局函数，persistence.js 读档复用）：
// 以三 input 当前值（Number 合法化后）逐一 === 各钮 dataset.weights 向量决定 .active；无匹配则三钮全去选中。
function syncWeightPresetChips(){
  const inputs = ['weightAtk','weightDef','weightHp'].map(id=>{
    const el = document.getElementById(id);
    return el ? Number(el.value) : NaN;
  });
  document.querySelectorAll('#weightPresets button.attr-medallion').forEach(btn=>{
    const vec = (btn.dataset.weights || '').split(',').map(Number);
    btn.classList.toggle('active', vec.length === 3 && vec.every((v,i)=>v === inputs[i]));
  });
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
  // 属性筛选罗盘条（期4）：圆徽按钮组替换原下拉，事件委托到容器；筛选语义不变（属性值集合一致）。
  document.getElementById('libraryFilterAttribute').addEventListener('click', e=>{
    const btn = e.target.closest('button.attr-medallion');
    if(!btn) return;
    setLibraryFilter(btn.dataset.attrFilter || '');
    renderItemsTable();
  });
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
  document.getElementById('engineMode').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  document.getElementById('focusAttr').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  // 属性权重三项（一期线性）：与既有控件同构用 change 事件（不用 input）；权重变化使既有结果口径失效。
  for(const id of ['weightAtk','weightDef','weightHp']){
    document.getElementById(id).addEventListener('change', ()=>{
      lastResult = null;
      renderResultGrid(null);
      syncWeightPresetChips();
    });
  }
  // 权重口径开关（默认/自定义）：切换自定义区显隐；口径变化使既有结果口径失效。
  // 默认口径下 readWeightMul 首判返回 null，三 input 与预设钮隐藏且零污染。
  document.getElementById('weightMode').addEventListener('change', e=>{
    document.getElementById('weightCustomWrap').hidden = e.target.value !== 'custom';
    lastResult = null;
    renderResultGrid(null);
    syncWeightPresetChips();
  });
  // 预设钮容器事件委托（仿属性筛选罗盘写法）：程序化赋值不派发 change（先例见 persistence.js 注释），
  // 手工执行同一「清结果 + 同步选中态」逻辑。
  document.getElementById('weightPresets').addEventListener('click', e=>{
    const btn = e.target.closest('button.attr-medallion');
    if(!btn) return;
    const vec = (btn.dataset.weights || '').split(',').map(Number);
    if(vec.length !== 3 || vec.some(v=>!Number.isFinite(v) || v < 0)) return;
    document.getElementById('weightAtk').value = String(vec[0]);
    document.getElementById('weightDef').value = String(vec[1]);
    document.getElementById('weightHp').value = String(vec[2]);
    lastResult = null;
    renderResultGrid(null);
    syncWeightPresetChips();
  });
  document.getElementById('exportBtn').addEventListener('click', exportResult);
  document.getElementById('saveBtn').addEventListener('click', saveConfig);
  document.getElementById('loadBtn').addEventListener('click', loadConfig);
  document.getElementById('useAdjacencyBonus').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
}


init();
