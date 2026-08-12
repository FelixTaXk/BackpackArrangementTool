// utils.js —— 几何与文本工具（形状变换/邻接/掩码/转义/格式化/迷你预览）。加载顺序 3/13，运行时读取 state 全局。
'use strict';

function cloneCells(cells){ return cells.map(c=>[c[0],c[1]]); }
function makeMiniPreview(cells){
  const norm = normalizeCells(cells);
  const maxR = Math.max(...norm.map(x=>x[0])), maxC = Math.max(...norm.map(x=>x[1]));
  const root = document.createElement('div');
  root.className = 'mini';
  root.style.gridTemplateColumns = `repeat(${maxC+1}, 14px)`;
  const set = new Set(norm.map(x=>x.join(',')));
  for(let r=0;r<=maxR;r++) for(let c=0;c<=maxC;c++){
    const d = document.createElement('div');
    d.className = 'mcell' + (set.has(`${r},${c}`)?' fill':'');
    root.appendChild(d);
  }
  return root;
}

function normalizeCells(cells){
  if(!cells.length) return [];
  const minR = Math.min(...cells.map(x=>x[0]));
  const minC = Math.min(...cells.map(x=>x[1]));
  return cells.map(([r,c])=>[r-minR,c-minC]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
}
function cellsKey(cells){ return normalizeCells(cells).map(x=>x.join(',')).join(';'); }
function rotate(cells){ return normalizeCells(cells.map(([r,c])=>[c,-r])); }
function mirror(cells){ return normalizeCells(cells.map(([r,c])=>[r,-c])); }
function orientations(cells, allowRot, allowMir){
  const out = new Map();
  const seeds = [normalizeCells(cells)];
  if(allowMir) seeds.push(mirror(cells));
  for(const seed of seeds){
    let cur = seed;
    const n = allowRot ? 4 : 1;
    for(let i=0;i<n;i++){
      out.set(cellsKey(cur), cur);
      cur = rotate(cur);
    }
  }
  return [...out.values()];
}

function areAdjacent(cellsA, cellsB){
  const set = new Set(cellsB.map(([r,c]) => r + ',' + c));
  return cellsA.some(([r,c]) => set.has((r-1)+','+c) || set.has((r+1)+','+c) || set.has(r+','+(c-1)) || set.has(r+','+(c+1)));
}

function buildActiveMask(){
  let mask = 0n, count = 0;
  for(let r=0;r<H;r++) for(let c=0;c<W;c++) if(active[r][c]){ mask |= bitOf(r,c); count++; }
  return {mask,count};
}
function bitOf(r,c){ return 1n << BigInt(r*W+c); }

function escapeHtml(s){ return String(s).replace(/[&<>\"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function formatNum(x){ const n = Number(x)||0; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/,''); }

