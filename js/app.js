// app.js —— init 与全局事件绑定，文件末尾调用 init()。加载顺序 19/19，依赖全部模块。
'use strict';

function init(){
  validateTalismanDB();
  active = Array.from({length:6},()=>Array(7).fill(true));
  itemDefs = buildItemDefs();
  configureWorkerCountControl();
  bindEvents();
  syncWeightPresetChips();
  initLibraryFilter();
  rebuildKindFilter();
  renderSpaceGrid();
  renderItemsTable();
  renderInventoryTable();
  updateTableColumnLayout();
  renderResultGrid(null);
}

// 属性权重预设 chips 选中态同步（全局函数，persistence.js 读档复用）：
// 以八 input 当前值（Number 合法化后）逐一 === 各钮 dataset.weights 向量决定 .active；无匹配则八钮全去选中。
function syncWeightPresetChips(){
  const inputs = WEIGHT_INPUT_IDS.map(id=>{
    const el = document.getElementById(id);
    return el ? Number(el.value) : NaN;
  });
  document.querySelectorAll('#weightPresets button.attr-medallion').forEach(btn=>{
    const vec = (btn.dataset.weights || '').split(',').map(Number);
    btn.classList.toggle('active', vec.length === WEIGHT_INPUT_IDS.length && vec.every((v,i)=>v === inputs[i]));
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
    rebuildKindFilter();
    renderItemsTable();
  });
  // 种类筛选（本期新增）：选项随属性罗盘重建；单击切换选中，再次单击已选项则取消（未选择→库表不展示）。
  document.getElementById('libraryFilterKind').addEventListener('click', e=>{
    const btn = e.target.closest('button.kind-medallion');
    if(!btn) return;
    const val = btn.dataset.kindFilter || '';
    if(btn.classList.contains('active')) setLibraryFilterKind('');
    else setLibraryFilterKind(val);
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
  // 清单导入导出：导入走隐藏 file input（accept 限定 .json），导出直接触发下载。
  // 导入流程与 saveConfig 读档同源：按 id 反查当前数据库重建条目，缺键的 id 跳过并提示。
  document.getElementById('exportInventoryBtn').addEventListener('click', exportInventory);
  const importFileInput = document.getElementById('importInventoryFile');
  document.getElementById('importInventoryBtn').addEventListener('click', ()=> importFileInput && importFileInput.click());
  if(importFileInput){
    importFileInput.addEventListener('change', e=>{
      const file = e.target.files && e.target.files[0];
      if(file) importInventoryFromFile(file);
      e.target.value = ''; // 重置 input：同文件可重复导入
    });
  }
  document.getElementById('solveBtn').addEventListener('click', solveAndRender);
  document.getElementById('cancelSolveBtn').addEventListener('click', cancelSolve);
  document.getElementById('parallelSearch').addEventListener('change', e=>{
    document.getElementById('workerCountLabel').hidden=!e.target.checked;
  });
  document.getElementById('searchMode').addEventListener('change', e=>{
    const deep=e.target.value==='deep';
    document.getElementById('timeLimit').disabled=!deep;
  });
  document.getElementById('focusAttr').addEventListener('change', ()=>{
    lastResult = null;
    renderResultGrid(null);
  });
  // 属性权重八项：与既有控件同构用 change 事件（不用 input）；权重变化使既有结果口径失效。
  for(const id of WEIGHT_INPUT_IDS){
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
  // 手工执行同一「清结果 + 同步选中态」逻辑；权重向量长度与 WEIGHT_INPUT_IDS 一致（8 维）。
  document.getElementById('weightPresets').addEventListener('click', e=>{
    const btn = e.target.closest('button.attr-medallion');
    if(!btn) return;
    const vec = (btn.dataset.weights || '').split(',').map(Number);
    if(vec.length !== WEIGHT_INPUT_IDS.length || vec.some(v=>!Number.isFinite(v) || v < 0)) return;
    WEIGHT_INPUT_IDS.forEach((id, i) => { document.getElementById(id).value = String(vec[i]); });
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
