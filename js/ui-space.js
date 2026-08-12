// ui-space.js —— 背包空间卡片：尺寸应用与格子网格渲染。加载顺序 5/12，依赖 state。
'use strict';

function applySize(){
  const newW = Math.max(1, Math.min(7, Math.floor(Number(document.getElementById('gridW').value)) || 1));
  const newH = Math.max(1, Math.min(6, Math.floor(Number(document.getElementById('gridH').value)) || 1));
  document.getElementById('gridW').value = newW;
  document.getElementById('gridH').value = newH;
  const old = active;
  W = newW; H = newH;
  active = Array.from({length:H}, (_,r)=>Array.from({length:W},(_,c)=> old[r] && old[r][c] !== undefined ? old[r][c] : true));
  lastResult = null; renderSpaceGrid(); renderResultGrid(null);
}

function renderSpaceGrid(){
  const el = document.getElementById('spaceGrid');
  el.style.gridTemplateColumns = `repeat(${W}, var(--cell))`;
  el.innerHTML = '';
  for(let r=0;r<H;r++){
    for(let c=0;c<W;c++){
      const cell = document.createElement('div');
      cell.className = 'cell' + (active[r][c] ? '' : ' inactive');
      cell.textContent = active[r][c] ? '' : '×';
      cell.title = `行 ${r+1}, 列 ${c+1}`;
      cell.addEventListener('click', ()=>{ active[r][c] = !active[r][c]; lastResult = null; renderSpaceGrid(); renderResultGrid(null); });
      el.appendChild(cell);
    }
  }
  renderInventoryCellSummary();
}

