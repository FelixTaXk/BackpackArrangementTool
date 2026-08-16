// ui-library.js —— 法宝库卡片：表格渲染/属性筛选/同种法宝合并展示（品质行内下拉）/表格列布局。加载顺序 7/13，依赖 config、utils、state、talisman-model。
'use strict';

function updateTableColumnLayout(){
  ['itemsTable','inventoryTable'].forEach(id=>{
    const table=document.getElementById(id);
    if(!table) return;
    const visibleHeaders=[...table.querySelectorAll('thead th')].filter(th=>getComputedStyle(th).display!=='none');
    table.style.setProperty('--visible-columns',String(Math.max(1,visibleHeaders.length)));
    if(id==='itemsTable'){
      const tracks=visibleHeaders.map(th=>{
        if(th.classList.contains('col-name')) return '1.4fr';
        if(th.classList.contains('col-base') || th.classList.contains('col-bonus')) return '1.2fr';
        if(th.classList.contains('col-shape')) return '.8fr';
        if(th.classList.contains('col-attribute')) return '.7fr';
        if(th.classList.contains('col-quality')) return '.9fr';
        if(th.classList.contains('col-action')) return '.7fr';
        return '1fr';
      });
      table.style.setProperty('--column-tracks',tracks.join(' '));
    }
    if(id==='inventoryTable'){
      const tracks=visibleHeaders.map(th=>{
        if(th.classList.contains('col-base')) return '1.4fr';
        if(th.classList.contains('col-name')) return '1.25fr';
        if(th.classList.contains('col-no') || th.classList.contains('col-action')) return '.8fr';
        return '1fr';
      });
      table.style.setProperty('--column-tracks',tracks.join(' '));
      // 轨道通过 CSS 变量在 ≥601px 的 grid 布局中生效，不用内联样式以免破坏窄屏卡片布局
    }
  });
}

// 属性圆徽色（仿灵枢宝鉴底部罗盘条；config.js 冻结不改，此处另设主题色）。
const ATTR_MEDALLION_COLORS = {金:'#d8a531',木:'#6fa76f',水:'#5f9ec7',火:'#c9573f',土:'#a8845c',雷:'#9a7bc0',体:'#8d8d8d'};

function libraryFilterAttribute(){
  const wrap = document.getElementById('libraryFilterAttribute');
  if(!wrap) return '';
  const btn = wrap.querySelector('button.attr-medallion.active');
  return btn ? (btn.dataset.attrFilter || '') : '';
}

function setLibraryFilter(value){
  const wrap = document.getElementById('libraryFilterAttribute');
  if(!wrap) return;
  wrap.querySelectorAll('button.attr-medallion').forEach(b=>{
    const isActive = (b.dataset.attrFilter || '') === value;
    b.classList.toggle('active', isActive);
    b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function initLibraryFilter(){
  const wrap = document.getElementById('libraryFilterAttribute');
  if(!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  const makeBtn = (value,label,color)=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'attr-medallion';
    b.dataset.attrFilter = value;
    b.setAttribute('aria-pressed','false');
    b.title = value ? `只看${label}属性法宝` : '显示全部属性法宝';
    b.innerHTML = (color ? `<span class="attr-dot" style="background:${color}"></span>` : '') + `<span class="attr-name">${label}</span>`;
    wrap.appendChild(b);
  };
  makeBtn('', '全部', null);
  for(const a of ATTRIBUTE_OPTIONS) makeBtn(a.id, a.name, ATTR_MEDALLION_COLORS[a.id] || a.displayColor);
  // 默认只展示金属性法宝，避免页面一次性全量展示；用户可切回“全部”或其他属性。
  setLibraryFilter('金');
}

// 基础属性固定三行展示：按注册表顺序（攻击力/防御/生命值）每项一行，缺失或 0 的项目显示 0，纯文本无装饰（同一单元格内多个 <div> 纵向排列，内部已转义）。
function baseStatsLinesHtml(it){
  const stats = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []);
  const lines = stats.map(s=>{
    const v = it.baseStats ? Number(it.baseStats[s.id]) : 0;
    return `<div>${escapeHtml(s.name)} ${escapeHtml(formatNum(Number.isFinite(v) && v > 0 ? v : 0))}</div>`;
  });
  return lines.length ? lines.join('') : escapeHtml('-');
}

// 加成列逐行展示（同一单元格内纵向排列）：首行提升方式徽章（提升相邻/提升自己/无，
// 类名与最初 bonusControlHtml 一致），其后每个加成项目与加成率各占一行（.hint 灰色小字，内部已转义）。
// 仅用于法宝库/清单表格；结果页等其他展示仍用 bonusControlHtml/bonusDescription。
function bonusLinesHtml(it){
  const kind = bonusKind(it);
  const pill = kind === 'provider' ? '<div><span class="pill green">提升相邻</span></div>'
    : kind === 'self' ? '<div><span class="pill">提升自己</span></div>'
    : '<div><span class="pill gray">无</span></div>';
  const parts = [];
  if(it.bonusRates && Object.keys(it.bonusRates).length){
    Object.keys(it.bonusRates).filter(k=>Number(it.bonusRates[k]) > 0)
      .forEach(k=>parts.push({name:statName(k), rate:it.bonusRates[k]}));
  }else if(Array.isArray(it.rates)){
    const ids = (window.TALISMAN_DB && window.TALISMAN_DB.bonusStats || []).map(s=>s.id);
    it.rates.forEach((v,k)=>{ if(Number(v) > 0) parts.push({name:statName(ids[k] || ('stat' + k)), rate:v}); });
  }
  const lines = parts.map(p=>`<div class="hint">${escapeHtml(p.name)} +${escapeHtml(formatNum(p.rate))}%</div>`);
  return pill + lines.join('');
}

function renderItemsTable(){
  const tbody = document.querySelector('#itemsTable tbody');
  tbody.innerHTML = '';
  const attrFilter = libraryFilterAttribute();
  // 按属性筛选；同属性同名的法宝归并为一个家族（分组键 属性+名称，库中名称不跨属性冲突），保持首次出现顺序。
  const families = new Map();
  itemDefs.forEach((it, idx)=>{
    if(attrFilter && it.attribute !== attrFilter) return;
    const key = it.attribute + '|' + it.name;
    if(!families.has(key)) families.set(key, []);
    families.get(key).push({it, idx});
  });
  const rows = [...families.values()];
  if(!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = '<td class="col-empty" colspan="7"><div class="empty">当前筛选条件下没有法宝。</div></td>';
    tbody.appendChild(tr);
    updateTableColumnLayout();
    return;
  }
  rows.forEach(variants=>{
    // 行内品质下拉默认选中“金”变体；家族无金变体时默认第一个（如红专属家族默认红）。
    const defVariant = variants.find(v=>v.it.quality === '金') || variants[0];
    const it = defVariant.it;
    const area = it.cells.length;
    const attr = ATTRIBUTE_MAP[it.attribute] || {name:it.attribute, displayColor:'#6b7280'};
    const qualityOpts = variants.map(v=>`<option value="${v.idx}" data-q="${QUALITY_NAME_TO_ID[v.it.quality] || ''}"${v === defVariant ? ' selected' : ''}>${escapeHtml(v.it.quality)}</option>`).join('');
    // 长老星级下拉选项（表驱动，文案「N星（无加成/+X%）」，默认 1 星）；仅红品质行展示。
    const starOpts = STAR_LEVEL_BONUS.map((b,i)=>`<option value="${i+1}"${i === 0 ? ' selected' : ''}>${i+1}星${b === 0 ? '（无加成）' : `（+${Math.round(b*100)}%）`}</option>`).join('');
    const defIsRed = it.quality === '红';
    const defQualityId = QUALITY_NAME_TO_ID[it.quality] || '';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="col-name" data-label="名称"><div class="name-line"><span class="shape-name">${escapeHtml(it.name)}</span><span class="hint">${area} 格</span></div></td>
      <td class="col-attribute" data-label="属性"><span class="attr-tag" style="border-color:${attr.displayColor};color:${attr.displayColor}">${escapeHtml(attr.name)}</span></td>
      <td class="col-quality" data-label="品质"><select data-quality-select data-q="${defQualityId}"${defIsRed ? ' hidden' : ''}>${qualityOpts}</select><select data-star-select data-q="red"${defIsRed ? '' : ' hidden'} title="长老星级：基础属性按星级放大（1星无加成）">${starOpts}</select></td>
      <td class="col-shape" data-label="形状预览"></td>
      <td class="col-base" data-label="基础属性"></td>
      <td class="col-bonus" data-label="加成"></td>
      <td class="col-action" data-label="操作"><button class="compact" data-add>添加</button></td>`;
    // 按当前选中变体刷新该行的形状预览/基础属性/加成（切换品质时只更新本行，不整表重建）。
    const fillVariantCells = variant=>{
      const shapeTd = tr.querySelector('.col-shape');
      shapeTd.innerHTML = '';
      shapeTd.appendChild(makeMiniPreview(variant.it.cells));
      tr.querySelector('.col-base').innerHTML = baseStatsLinesHtml(variant.it);
      tr.querySelector('.col-bonus').innerHTML = bonusLinesHtml(variant.it);
    };
    fillVariantCells(defVariant);
    // 品质/星级双下拉显隐：当前变体红→显星级隐品质，非红反之（混合家族兜底）。
    const syncQualityStarVisibility = variant=>{
      const isRed = variant.it.quality === '红';
      tr.querySelector('select[data-quality-select]').hidden = isRed;
      tr.querySelector('select[data-star-select]').hidden = !isRed;
    };
    tr.querySelector('select[data-quality-select]').addEventListener('change', e=>{
      const v = variants.find(x=>x.idx === Number(e.target.value));
      if(!v) return;
      fillVariantCells(v);
      // 同步品质色联动：下拉闭合态底色（data-q）跟随当前品质
      const qid = QUALITY_NAME_TO_ID[v.it.quality] || '';
      e.target.dataset.q = qid;
      syncQualityStarVisibility(v);
    });
    // 添加时取该行当前所显控件：红变体读星级下拉值透传 addToInventory，非红照旧。
    tr.querySelector('button[data-add]').addEventListener('click', ()=>{
      const qualitySel = tr.querySelector('select[data-quality-select]');
      if(qualitySel.hidden){
        addToInventory(Number(qualitySel.value), Number(tr.querySelector('select[data-star-select]').value));
      }else{
        addToInventory(Number(qualitySel.value));
      }
    });
    tbody.appendChild(tr);
  });
  updateTableColumnLayout();
}
