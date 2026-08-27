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

// 位板掩码统一为双 Uint32 数值对 {lo,hi}（低 32 位 / 高位），与 score-shared.js 第 8 行
// 「热路径禁用 BigInt」约定及 engine-encoding.js encParseMask/encMaskToDec 完全互通：
//   n = hi*4294967296 + lo
// 7×6=42 格棋盘：格位 idx=r*W+c，idx 0..31 落在 lo，idx 32..41 落在 hi。
// 十进制串仍是唯一跨线程线格式（冻结的 solver-worker.js 用 BigInt(str) 还原，不受影响）。
function buildActiveMask(){
  let lo = 0, hi = 0, count = 0;
  for(let r=0;r<H;r++) for(let c=0;c<W;c++) if(active[r][c]){
    const idx = r*W+c;
    if(idx < 32) lo |= (1 << idx); else hi |= (1 << (idx-32));
    count++;
  }
  return {lo: lo>>>0, hi: hi>>>0, count};
}
// {lo,hi} → 十进制串（与 scoreMaskToDec / encMaskToDec 同式）
function maskToDec(lo, hi){ return String((hi>>>0) * 4294967296 + (lo>>>0)); }
// 十进制串 → {lo,hi}（maskToDec 的逆，42 位内恒在 Number 安全整数范围）
function maskDecToLoHi(s){
  const n = Number(s) || 0;
  const hi = Math.floor(n / 4294967296);
  return {lo: n - hi * 4294967296, hi};
}

function escapeHtml(s){ return String(s).replace(/[&<>\"]/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function formatNum(x){ const n = Number(x)||0; return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/,''); }

