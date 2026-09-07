// scripts/convert-excel.mjs —— 开发期工具：将「法宝属性.xlsx」转换为 data/talisman-db.js。
// 用法（PowerShell，工作区根目录）：
//   $env:XLSX_MODULE_DIR = "$env:TEMP\xlsx-conv"   # 已 npm install xlsx 的目录（默认也会尝试该路径）
//   node scripts/convert-excel.mjs
// 依赖 SheetJS(xlsx)，不写入项目 package.json；本脚本不参与页面运行时，可重复运行。
//
// 实际 Excel 结构（宽表，8 属性 Sheet，见 docs/excel-spec.md）：
//   8 个 Sheet（金/木/水/火/土/雷/邪/体），每个 Sheet 即该属性法宝表，宽表列：
//   法宝名 | 形状 | 共鸣值 | 攻击力 | 防御 | 生命值 | 加成率 | 加成部位 | 加成属性 | 颜色 | 种类 | 是否造成伤害
//   - 法宝名为空的行沿用上一行法宝名（同一法宝的多个品质行）；颜色列即品质。
//   - 形状为矩阵记法（如 "[1 1]"、"[0 1]\n[1 1]"），1 占用、0 空格，逐行解析为 cells [行,列]。
//   - 加成部位：相邻→provider、相邻自身→self、无→none；加成属性即加成的属性项目，加成率即百分比数值。
//   - 是否造成伤害：是/1/true/y/yes → causesDamage=true（伤害加成目标标记）。
// 计算项目限定 atk/def/hp 三项（注册表）；其余项目（共鸣值/种类 及非三项的属性项目）
// 留存于 extraStats（基础侧）/ extraRates（加成侧），不参与计算与校验。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..');
const XLSX_PATH = path.join(WORKSPACE, '法宝属性.xlsx');
const OUT_PATH = path.join(WORKSPACE, 'data', 'talisman-db.js');

// ---------- 加载 SheetJS ----------
function loadXLSX() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.XLSX_MODULE_DIR ? path.join(process.env.XLSX_MODULE_DIR, 'node_modules', 'xlsx') : null,
    path.join(process.env.TEMP || process.env.TMP || '', 'xlsx-conv', 'node_modules', 'xlsx'),
    'xlsx'
  ].filter(Boolean);
  for (const p of candidates) {
    try { return require(p); } catch (e) { /* 尝试下一候选 */ }
  }
  console.error('无法加载 xlsx(SheetJS)。请先在临时目录安装：');
  console.error('  mkdir "$env:TEMP\\xlsx-conv"; cd "$env:TEMP\\xlsx-conv"; npm install xlsx');
  console.error('然后设置 $env:XLSX_MODULE_DIR="$env:TEMP\\xlsx-conv" 后重试。');
  process.exit(1);
}
const XLSX = loadXLSX();

// ---------- 常量映射 ----------
const ATTRIBUTES = ['金', '木', '水', '火', '土', '雷', '邪', '体'];
const QUALITIES = ['绿', '蓝', '紫', '金', '红'];
const ATTR_PINYIN = { 金: 'jin', 木: 'mu', 水: 'shui', 火: 'huo', 土: 'tu', 雷: 'lei', 邪: 'xie', 体: 'ti' };
const QUALITY_EN = { 绿: 'green', 蓝: 'blue', 紫: 'purple', 金: 'gold', 红: 'red' };
// 加成部位（Excel 实际值）→ bonusMode
const MODE_MAP = { '相邻': 'provider', '相邻自身': 'self', '无': 'none' };
// 参与计算的注册表（仅 atk/def/hp 三项，名称取 Excel 实际写法）
const STAT_REGISTRY = [
  { id: 'atk', name: '攻击力' },
  { id: 'def', name: '防御' },
  { id: 'hp', name: '生命值' }
];
const STAT_NAME_TO_ID = new Map(STAT_REGISTRY.map(s => [s.name, s.id]));
// 宽表列定义（按名称定位，容错处理）
const COL_DEFS = [
  { key: 'name', names: ['法宝名', '名称'] },
  { key: 'shape', names: ['形状'] },
  { key: 'resonance', names: ['共鸣值'] },
  { key: 'base', names: ['攻击力', '防御', '生命值'] },
  { key: 'rate', names: ['加成率', '加成率%'] },
  { key: 'bonusPart', names: ['加成部位'] },
  { key: 'bonusStat', names: ['加成属性'] },
  { key: 'quality', names: ['颜色', '品质'] },
  { key: 'kind', names: ['种类'] },
  { key: 'causesDamage', names: ['是否造成伤害'] }
];

const norm = v => String(v ?? '').trim();

// ---------- 形状解析（矩阵记法 "[1 0]\n[1 1]"） ----------
function parseShape(raw) {
  const text = norm(raw);
  const cells = [];
  const errors = [];
  if (!text) return { cells, errors: ['形状为空'] };
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l !== '');
  if (lines.length === 0) return { cells, errors: ['形状为空'] };
  if (lines.length > 6) errors.push(`形状行数 ${lines.length} 超过 6`);
  lines.forEach((line, r) => {
    // 先按 [...] 括号记法提取矩阵段，避免拾取括号外的游离 0/1；无法匹配括号则拒绝该行
    const seg = line.match(/\[([^\[\]]*)\]/);
    if (!seg) { errors.push(`形状第 ${r + 1} 行「${line}」未匹配 [...] 括号记法`); return; }
    const digits = seg[1].match(/[01]/g);
    if (!digits) { errors.push(`形状第 ${r + 1} 行「${line}」未找到 0/1 格子`); return; }
    if (digits.some(d => d === '1')) {
      digits.forEach((d, c) => {
        if (d === '1') {
          if (r > 5 || c > 6) errors.push(`格子 [${r},${c}] 超出 7×6 范围`);
          else cells.push([r, c]);
        }
      });
    } else {
      errors.push(`形状第 ${r + 1} 行「${line}」无占用格`);
    }
  });
  if (cells.length === 0 && errors.length === 0) errors.push('形状中无占用格');
  return { cells, errors };
}
function isConnected(cells) {
  if (cells.length <= 1) return true;
  const set = new Set(cells.map(([r, c]) => `${r},${c}`));
  const queue = [cells[0]];
  const seen = new Set([`${cells[0][0]},${cells[0][1]}`]);
  while (queue.length) {
    const [r, c] = queue.shift();
    for (const [nr, nc] of [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
      const k = `${nr},${nc}`;
      if (set.has(k) && !seen.has(k)) { seen.add(k); queue.push([nr, nc]); }
    }
  }
  return seen.size === cells.length;
}
const shapeKey = cells => cells.map(c => c.join(',')).join(';');

// ---------- 读取工作簿 ----------
console.log(`读取 Excel：${XLSX_PATH}`);
if (!existsSync(XLSX_PATH)) { console.error('未找到 Excel 文件。'); process.exit(1); }
const wb = XLSX.read(readFileSync(XLSX_PATH), { type: 'buffer' });
console.log(`Sheet 列表：${wb.SheetNames.join(' | ')}`);
const sheetDiffs = [];
if (wb.SheetNames.length !== ATTRIBUTES.length || !ATTRIBUTES.every(a => wb.SheetNames.includes(a))) {
  sheetDiffs.push(`期望 Sheet 为 ${ATTRIBUTES.length} 属性（${ATTRIBUTES.join('/')}），实际为：${wb.SheetNames.join('、')}`);
}
// 每个属性取对应名称的 Sheet；缺失则按顺序兜底
function sheetFor(attr, idx) {
  if (wb.SheetNames.includes(attr)) return wb.Sheets[attr];
  return wb.Sheets[wb.SheetNames[idx]];
}

const talismans = [];
const rejected = [];      // {name, reasons[]}
const seenNames = new Set();
const shapeByQuality = new Map(); // 品质 → Map(shapeKey → [名称...])，用于同品质形状一致性校验

function sheetRows(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
function locateCols(header) {
  const cols = {};
  const heads = header.map(norm);
  for (const def of COL_DEFS) {
    if (def.key === 'base') {
      cols.base = {};
      for (const statName of def.names) {
        const i = heads.findIndex(h => h === statName);
        if (i >= 0) cols.base[statName] = i;
        else sheetDiffs.push(`缺少基础属性列：${statName}`);
      }
      continue;
    }
    const i = heads.findIndex(h => def.names.includes(h));
    cols[def.key] = i;
    if (i < 0 && def.key !== 'rate' && def.key !== 'causesDamage') sheetDiffs.push(`缺少列：${def.names.join('/')}`);
  }
  return cols;
}

ATTRIBUTES.forEach((attr, idx) => {
  const ws = sheetFor(attr, idx);
  if (!ws) { sheetDiffs.push(`未找到属性「${attr}」的 Sheet`); return; }
  const rows = sheetRows(ws);
  const header = rows[0] || [];
  console.log(`[Sheet ${attr}] 列头：${header.map(norm).filter(Boolean).join(' / ')}`);
  const c = locateCols(header);
  if (c.name < 0 || c.shape < 0 || c.quality < 0) {
    rejected.push({ name: `(Sheet ${attr})`, reasons: ['缺少必需列（法宝名/形状/颜色），整个 Sheet 无法解析'] });
    return;
  }

  let lastName = '';
  let lastShape = '';
  rows.slice(1).forEach((row, i) => {
    const lineNo = i + 2;
    const nameRaw = norm(row[c.name]);
    // 同一法宝的品质行：法宝名与形状仅在首行填写，后续行沿用首行值（以各行自身形状列为准，空则继承）
    if (nameRaw) { lastName = nameRaw; lastShape = norm(row[c.shape]); }
    else if (norm(row[c.shape])) lastShape = norm(row[c.shape]);
    // 空行判定：法宝名与所有数值/枚举字段均空
    const hasData = row.some((v, j) => j !== c.name && norm(v) !== '');
    if (!lastName || !hasData) return;
    const name = lastName;
    const errors = [];

    // 写入侧模板 name:'${t.name}' 无转义，含单引号/反斜杠/换行的名称会产出非法 JS，显式拒收
    if (/['\\\r\n]/.test(name)) errors.push('名称含单引号/反斜杠/换行，无法安全写入产物');

    const quality = norm(row[c.quality]);
    if (!QUALITIES.includes(quality)) errors.push(`颜色(品质)非法：「${quality}」`);
    if (seenNames.has(`${name}|${quality}`)) errors.push(`名称+品质重复：${name}(${quality})`);

    // 形状（每行以自身形状列为准入库，空则继承首行）
    const { cells, errors: shapeErrors } = parseShape(lastShape);
    errors.push(...shapeErrors);
    if (shapeErrors.length === 0 && !isConnected(cells)) errors.push('形状不连通');
    if (shapeErrors.length === 0 && QUALITIES.includes(quality)) {
      if (!shapeByQuality.has(quality)) shapeByQuality.set(quality, new Map());
      const m = shapeByQuality.get(quality);
      const k = shapeKey(cells);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(`${name}(${attr})`);
    }

    // 加成模式
    const partRaw = c.bonusPart >= 0 ? norm(row[c.bonusPart]) : '无';
    const bonusMode = MODE_MAP[partRaw];
    if (!bonusMode) errors.push(`加成部位非法：「${partRaw}」（限 相邻/相邻自身/无）`);

    // 基础属性：atk/def/hp → baseStats；共鸣值/种类 → extraStats
    const baseStats = {};
    for (const [statName, col] of Object.entries(c.base)) {
      const v = Number(norm(row[col]));
      if (norm(row[col]) !== '') {
        if (!Number.isFinite(v) || v < 0) { errors.push(`${statName} 数值非法：「${norm(row[col])}」`); continue; }
        baseStats[STAT_NAME_TO_ID.get(statName)] = v;
      }
    }
    const extraStats = {};
    if (c.resonance >= 0 && norm(row[c.resonance]) !== '') {
      const v = Number(norm(row[c.resonance]));
      if (!Number.isFinite(v) || v < 0) errors.push(`共鸣值非法：「${norm(row[c.resonance])}」`);
      else extraStats['共鸣值'] = v;
    }
    if (c.kind >= 0 && norm(row[c.kind]) !== '' && norm(row[c.kind]) !== '无') {
      extraStats['种类'] = norm(row[c.kind]);
    }

    // 是否造成伤害（伤害加成目标标记）：是/1/true/y/yes → causesDamage=true（其余/空不置，缺省 false）
    const causesDamage = c.causesDamage >= 0 ? ['是','1','true','y','yes'].includes(norm(row[c.causesDamage]).toLowerCase()) : false;
    // 加成项目：加成属性 ∈ {攻击力,防御,生命值} → bonusRates；否则 → extraRates
    const bonusRates = {};
    const extraRates = {};
    const bonusStatRaw = c.bonusStat >= 0 ? norm(row[c.bonusStat]) : '';
    const rateRaw = c.rate >= 0 ? norm(row[c.rate]) : '';
    if (bonusMode && bonusMode !== 'none') {
      if (!bonusStatRaw || bonusStatRaw === '无') {
        errors.push(`加成部位为「${partRaw}」但缺少加成属性`);
      } else {
        const rate = Number(rateRaw);
        if (!Number.isFinite(rate) || rate < 0) errors.push(`加成率非法：「${rateRaw}」`);
        else {
          const statId = STAT_NAME_TO_ID.get(bonusStatRaw);
          if (statId) bonusRates[statId] = rate;
          else extraRates[bonusStatRaw] = rate; // 非计算项目，留存不参与计算
        }
      }
    } else if (bonusStatRaw && bonusStatRaw !== '无') {
      // 加成模式为无却填了加成属性，留存备查
      const rate = Number(rateRaw);
      if (Number.isFinite(rate) && rate >= 0) extraRates[bonusStatRaw] = rate;
    }

    if (errors.length) {
      rejected.push({ name: `${name}(${attr}/${quality}, Excel 行 ${lineNo})`, reasons: errors });
      return;
    }
    seenNames.add(`${name}|${quality}`);
    talismans.push({
      name, attribute: attr, quality, cells, bonusMode, baseStats, bonusRates,
      ...(causesDamage ? { causesDamage: true } : {}),
      ...(Object.keys(extraStats).length ? { extraStats } : {}),
      ...(Object.keys(extraRates).length ? { extraRates } : {})
    });
  });
});

// ---------- 条目级校验（与 js/config.js validateTalismanDB 对齐） ----------
const baseKeys = STAT_REGISTRY.map(s => s.id);
for (let i = talismans.length - 1; i >= 0; i--) {
  const t = talismans[i];
  const errors = [];
  for (const k of Object.keys(t.baseStats)) if (!baseKeys.includes(k)) errors.push(`baseStats 含未注册项目：${k}`);
  for (const k of Object.keys(t.bonusRates)) if (!baseKeys.includes(k)) errors.push(`bonusRates 含未注册项目：${k}`);
  if (Object.keys(t.baseStats).length === 0) errors.push('baseStats 为空');
  else if (Object.values(t.baseStats).reduce((s, v) => s + Number(v), 0) <= 0) errors.push('baseStats 总和必须大于 0');
  if (errors.length) {
    rejected.push({ name: `${t.name}(${t.attribute}/${t.quality})`, reasons: errors });
    talismans.splice(i, 1);
  }
}

// ---------- 回读上一版产物（ID 稳定化） ----------
// 按自然键「名称|属性|品质」复用旧 id，使 xlsx 任意位置插行/删行都不影响已有法宝的 id。
function loadPrevDb() {
  const empty = { prevByKey: new Map(), prevIds: new Set(), maxSeqByPrefix: new Map(), prevEntries: [] };
  if (!existsSync(OUT_PATH)) {
    console.warn('⚠ 未找到上一版产物 data/talisman-db.js，按首次生成进行顺序编号；若这不是全新仓库，请先恢复该文件再转换，否则 id 可能与既有产物漂移。');
    return empty; // 首次生成
  }
  const text = readFileSync(OUT_PATH, 'utf8');
  // 条目行格式由本脚本自身输出模板生成，正则解析可靠
  const re = /\{id:'([^']+)',\s*name:'([^']+)',\s*attribute:'([^']+)',\s*quality:'([^']+)'/g;
  const prevByKey = new Map();   // 「名称|属性|品质」→ 旧 id
  const prevIds = new Set();     // 全部旧 id（退役序号永不复用）
  const maxSeqByPrefix = new Map(); // 「拼音-品质英文」→ 历史最大序号
  const prevEntries = [];        // {id, name, key}，用于报告「旧库消失」清单
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, id, name, attribute, quality] = m;
    const key = `${name}|${attribute}|${quality}`;
    prevByKey.set(key, id);
    prevIds.add(id);
    prevEntries.push({ id, name, key });
    const sm = /^([a-z]+-[a-z]+)-(\d{3})$/.exec(id);
    if (sm) {
      const seq = Number(sm[2]);
      if (seq > (maxSeqByPrefix.get(sm[1]) || 0)) maxSeqByPrefix.set(sm[1], seq);
    }
  }
  if (prevEntries.length === 0) {
    console.error(`⚠ 现有产物 ${OUT_PATH} 存在但解析出 0 条法宝，拒绝静默全量重发 id。`);
    process.exit(1);
  }
  // 产物头部注释由本脚本自身生成（「talismans 共 N 条」），解析条数与声明不符即疑似损坏
  const countMatch = /talismans 共 (\d+) 条/.exec(text);
  if (countMatch && prevEntries.length !== Number(countMatch[1])) {
    console.error(`⚠ 现有产物头部声明 ${countMatch[1]} 条但仅解析出 ${prevEntries.length} 条，疑似文件损坏或格式漂移，中止以防 id 静默重发。`);
    process.exit(1);
  } else if (!countMatch) {
    console.warn('⚠ 现有产物头部未找到「talismans 共 N 条」声明（更古老版本产物），跳过条数交叉校验。');
  }
  return { prevByKey, prevIds, maxSeqByPrefix, prevEntries };
}

// ---------- id 分配（稳定标识：按「名称|属性|品质」复用旧 id；新条目取该组历史最大序号+1） ----------
const { prevByKey, prevIds, maxSeqByPrefix, prevEntries } = loadPrevDb();
const newKeys = new Set();   // 本次新库的自然键集合（用于统计 removed）
const reusedOldIds = new Set();
const added = [];
let reused = 0;
// 第一遍：自然键命中旧库者沿用旧 id
for (const t of talismans) {
  const key = `${t.name}|${t.attribute}|${t.quality}`;
  newKeys.add(key);
  const oldId = prevByKey.get(key);
  if (oldId === undefined) continue;
  if (reusedOldIds.has(oldId)) {
    console.error(`⚠ 旧 id「${oldId}」被多个新条目命中（自然键：${key}），id 分配中止。请检查旧产物 data/talisman-db.js 是否被手工修改导致同一 id 对应多条记录。`);
    process.exit(1);
  }
  reusedOldIds.add(oldId);
  t.id = oldId;
  reused++;
}
// 第二遍：未命中者视为新法宝，从该 (属性,品质) 组历史最大序号+1 起分配，跳过已占用序号
for (const t of talismans) {
  if (t.id) continue;
  const prefix = `${ATTR_PINYIN[t.attribute]}-${QUALITY_EN[t.quality]}`;
  let seq = (maxSeqByPrefix.get(prefix) || 0) + 1;
  let id;
  for (;;) {
    if (seq > 999) {
      console.error(`⚠ 前缀「${prefix}」序号超过三位数上限 999，拒绝静默截断。`);
      process.exit(1);
    }
    id = `${prefix}-${String(seq).padStart(3, '0')}`;
    if (!prevIds.has(id)) break; // 跳过已被占用的序号（含本次已分配）
    seq++;
  }
  t.id = id;
  prevIds.add(id);
  maxSeqByPrefix.set(prefix, seq);
  added.push({ id, name: t.name });
}
// 全量 id 去重断言
{
  const idSet = new Set();
  for (const t of talismans) {
    if (idSet.has(t.id)) {
      console.error(`⚠ id 重复：「${t.id}」（法宝：${t.name}/${t.attribute}/${t.quality}）。`);
      process.exit(1);
    }
    idSet.add(t.id);
  }
}
// 旧库中消失的条目（自然键未出现在新库）
const removed = prevEntries.filter(e => !newKeys.has(e.key)).map(({ id, name }) => ({ id, name }));

// ---------- 排序：属性分组（金木水火土雷体），组内按出现顺序（稳定排序） ----------
talismans.sort((a, b) => ATTRIBUTES.indexOf(a.attribute) - ATTRIBUTES.indexOf(b.attribute));

// ---------- 生成 data/talisman-db.js ----------
// 值统一用 JSON 双引号字符串；数字直接输出
const fmtObj = obj => `{${Object.entries(obj).map(([k, v]) => `${/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `'${k}'`}:${typeof v === 'number' ? v : JSON.stringify(v)}`).join(', ')}}`;
const fmtCells = cells => `[${cells.map(([r, c2]) => `[${r},${c2}]`).join(',')}]`;

let body = '';
let currentAttr = null;
const entryBlocks = [];
for (const t of talismans) {
  if (t.attribute !== currentAttr) {
    currentAttr = t.attribute;
    entryBlocks.push({ comment: `    // ===== ${currentAttr} =====`, entry: null });
  }
  let line2 = `baseStats:${fmtObj(t.baseStats)}, bonusMode:'${t.bonusMode}', bonusRates:${fmtObj(t.bonusRates)}`;
  if (t.causesDamage) line2 += ', causesDamage:true';
  if (t.extraStats) line2 += `, extraStats:${fmtObj(t.extraStats)}`;
  if (t.extraRates) line2 += `, extraRates:${fmtObj(t.extraRates)}`;
  entryBlocks.push({ comment: null, entry: `    {id:'${t.id}', name:'${t.name}', attribute:'${t.attribute}', quality:'${t.quality}', cells:${fmtCells(t.cells)},\n     ${line2}}` });
}
for (const b of entryBlocks) {
  if (b.comment) body += `${b.comment}\n`;
  else body += `${b.entry},\n`;
}
// 去掉最后一个条目后的多余逗号
if (body.endsWith(',\n')) body = body.slice(0, -2) + '\n';
const bonusStatsCode = STAT_REGISTRY.map(s => `    {id:'${s.id}', name:'${s.name}'}`).join(',\n');

const output = `// data/talisman-db.js —— 法宝内置数据库（由 scripts/convert-excel.mjs 从 法宝属性.xlsx 转换生成）。
// 必须在 js/config.js 之前加载；config.js 的 validateTalismanDB() 会在启动时逐条校验。
// 数据说明：talismans 共 ${talismans.length} 条，按属性分组（金木水火土雷体）；
// 参与计算的属性项目仅 atk/def/hp（见 bonusStats 注册表），加成率为百分比数值（如 40 表示 40%）；
// extraStats/extraRates 为 Excel 中不参与计算的留存项目（如 共鸣值/种类/伤害/暴击伤害等），仅供备查。
// id 规则：id 为稳定标识，按「名称|属性|品质」匹配上一版产物复用旧 id；新增条目从该 (属性,品质) 组
// 历史最大序号+1 分配，退役序号永不复用；可在 xlsx 任意位置插行/删行，已有法宝 id 不变。
window.TALISMAN_DB = {
  meta:{ version:3 },
  attributes:[${ATTRIBUTES.map(a => `'${a}'`).join(',')}],
  qualities:[${QUALITIES.map(q => `'${q}'`).join(',')}],
  bonusStats:[
${bonusStatsCode}
  ],
  talismans:[
${body}  ]
};
`;
writeFileSync(OUT_PATH, output, 'utf8');

// ---------- 报告 ----------
const dist = {};
for (const a of ATTRIBUTES) { dist[a] = {}; for (const q of QUALITIES) dist[a][q] = 0; }
for (const t of talismans) dist[t.attribute][t.quality]++;

console.log('\n================ 转换报告 ================');
console.log(`输出文件：${OUT_PATH}`);
if (sheetDiffs.length) {
  console.warn('⚠ 实际结构与 docs/excel-spec.md 规格差异（已按实际格式容错处理）：');
  for (const d of [...new Set(sheetDiffs)]) console.warn(`  - ${d}`);
}
console.log(`法宝总条数：${talismans.length}`);
console.log(`ID 稳定化：复用旧 id ${reused} 条 / 新增 ${added.length} 条`);
for (const a of added) console.log(`  + ${a.id} → ${a.name}`);
if (removed.length) {
  console.warn(`⚠ 旧库中消失 ${removed.length} 条（对应存档条目读档时将被跳过）：`);
  for (const r of removed) console.warn(`  - ${r.id}（${r.name}）`);
}
console.log('属性 × 品质分布：');
console.log(`  属性   ${QUALITIES.join('   ')}`);
for (const a of ATTRIBUTES) {
  console.log(`  ${a}     ${QUALITIES.map(q => String(dist[a][q]).padStart(3)).join(' ')}`);
}
console.log('同品质形状一致性校验：');
let shapeConsistent = true;
for (const q of QUALITIES) {
  const m = shapeByQuality.get(q);
  if (!m || m.size <= 1) { console.log(`  ${q}：✓ 一致（${m ? [...m.values()][0].length : 0} 件同形状）`); continue; }
  shapeConsistent = false;
  console.warn(`  ${q}：⚠ 存在 ${m.size} 种不同形状（以各行自身形状列入库）：`);
  for (const [k, names] of m) console.warn(`     [${k}] → ${names.join('、')}`);
}
if (shapeConsistent) console.log('  ✓ 全部品质下形状一致。');
console.log(`bonusStats 注册表（参与计算）：${STAT_REGISTRY.map(s => `${s.name}→${s.id}`).join('、')}`);
const extraKeys = new Set();
for (const t of talismans) {
  Object.keys(t.extraStats || {}).forEach(k => extraKeys.add(`extraStats.${k}`));
  Object.keys(t.extraRates || {}).forEach(k => extraKeys.add(`extraRates.${k}`));
}
console.log(`extraStats/extraRates 留存的额外项目：${extraKeys.size ? [...extraKeys].join('、') : '无'}`);
const dmgCausers = talismans.filter(t => t.causesDamage).length;
if (dmgCausers) console.log(`造成伤害标记（causesDamage）：${dmgCausers} 条`);
if (rejected.length) {
  console.warn(`\n⚠ 被拒条目 ${rejected.length} 条（未写入产物）：`);
  for (const r of rejected) console.warn(`  - ${r.name}：${r.reasons.join('；')}`);
  process.exitCode = 2;
} else {
  console.log('\n✓ 校验通过：0 条被拒。');
}
console.log('===========================================');
