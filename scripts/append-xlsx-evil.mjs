// scripts/append-xlsx-evil.mjs —— 一次性脚本：向「法宝属性.xlsx」新增「邪」属性 Sheet（44 行 = 9 族×4 品质 + 8 红宝）。
// 用法（PowerShell，工作区根目录）：
//   $env:XLSX_MODULE_DIR = "$env:TEMP\xlsx-conv"   # 已 npm install xlsx 的目录（默认也会尝试该路径）
//   node scripts/append-xlsx-evil.mjs
// 数据来源：laozu-solver（resourceVersion web_2608121223_pc）调研报告 R1 数据表，1:1 转录。
// 表头与既有 Sheet 完全一致：法宝名|形状|共鸣值|攻击力|防御|生命值|加成率|加成部位|加成属性|颜色|种类。
// 规则：每族首行写法宝名+形状，后续品质行留空沿用；加成部位 相邻→provider/相邻自身→self/无→none；
// 「伤害」加成照写，convert-excel.mjs 会将其落入 extraRates 备查（不参与计算）。
// 执行动作：备份现网 xlsx → .vercel-tmp/法宝属性.backup.xlsx → 读取基线（HEAD 7-Sheet 版）→
// 覆盖写入「邪」Sheet（若已存在则先删除，防止并发任务残留伪造数据）→ writeFile 回写。

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(__dirname, '..');
const XLSX_PATH = path.join(WORKSPACE, '法宝属性.xlsx');
const BACKUP_PATH = path.join(WORKSPACE, '.vercel-tmp', '法宝属性.backup.xlsx');

// ---------- 加载 SheetJS（与 convert-excel.mjs 同款候选加载逻辑） ----------
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

// ---------- 邪属性 44 条数据（laozu-solver R1 数据表 1:1 转录） ----------
// 形状串：按包围盒对齐逐行 0/1（解析器逐行独立取列）。
// 族定义：[法宝名, 形状串, 种类, 加成部位(相邻/相邻自身/无), 加成属性, 各行(颜色/共鸣值/攻/防/生命/加成率)]
const FAMILIES = [
  ['邪源珠', '[1]', '珠', '相邻', '伤害', [
    ['绿', 2, 6, 0, 113, 2], ['蓝', 4, 9, 0, 285, 4], ['紫', 8, 13, 0, 585, 6], ['金', 16, 20, 0, 1135, 8]
  ]],
  ['玄阴枪', '[1]\n[1]', '枪', '无', '无', [
    ['绿', 3, 13, 0, 175], ['蓝', 6, 20, 0, 470], ['紫', 12, 30, 0, 970], ['金', 24, 47, 0, 1920]
  ]],
  ['血灵短矛', '[1]\n[1]\n[1]', '枪', '无', '无', [
    ['绿', 4, 20, 2, 138], ['蓝', 8, 32, 3, 455], ['紫', 16, 48, 4, 1105], ['金', 32, 76, 7, 2255]
  ]],
  ['血灵钻魂枪', '[1]\n[1]\n[1]\n[1]', '枪', '相邻自身', '攻击力', [
    ['绿', 5, 27, 2, 200, 20], ['蓝', 10, 43, 4, 590, 20], ['紫', 20, 64, 6, 1440, 20], ['金', 40, 101, 10, 2990, 40]
  ]],
  ['欢愉短匕', '[0 1]\n[1 1]', '匕', '无', '无', [
    ['绿', 4, 22, 2, 38], ['蓝', 8, 35, 3, 305], ['紫', 16, 52, 5, 855], ['金', 32, 82, 8, 1905]
  ]],
  ['欢愉蚀骨刃', '[1 1]\n[1 0]\n[1 0]', '匕', '相邻自身', '攻击力', [
    ['绿', 5, 29, 2, 100, 20], ['蓝', 10, 46, 4, 440, 20], ['紫', 20, 69, 6, 1190, 20], ['金', 40, 109, 10, 2590, 20]
  ]],
  ['炼魂小幡', '[1 1]\n[1 0]', '幡', '无', '无', [
    ['绿', 4, 19, 1, 238], ['蓝', 8, 30, 3, 555], ['紫', 16, 45, 4, 1255], ['金', 32, 71, 7, 2505]
  ]],
  ['炼魂万千幡', '[0 1]\n[0 1]\n[1 1]', '幡', '相邻自身', '伤害', [
    ['绿', 5, 26, 2, 250, 5], ['蓝', 10, 41, 4, 690, 5], ['紫', 20, 61, 6, 1590, 5], ['金', 40, 96, 9, 3290, 10]
  ]],
  ['玄阴旗', '[1 1]', '幡', '无', '无', [
    ['绿', 3, 14, 0, 125], ['蓝', 6, 22, 0, 370], ['紫', 12, 33, 0, 820], ['金', 24, 52, 0, 1670]
  ]],
  // 八红宝（独立家族，单行，颜色=红）
  ['煞魔血叉', '[1]\n[1]\n[1]\n[1]', '枪', '无', '无', [['红', 56, 108, 10, 4700]]],
  ['凶神戮世', '[1 1]\n[1 0]\n[1 0]\n[1 0]', '枪', '相邻自身', '攻击力', [['红', 64, 143, 14, 5400, 40]]],
  ['剖心夺爱', '[1 1]\n[1 0]\n[1 0]', '匕', '无', '无', [['红', 56, 116, 11, 4250]]],
  ['合欢极乐', '[0 1]\n[1 1]\n[1 1]', '匕', '相邻自身', '攻击力', [['红', 64, 154, 15, 4800, 20]]],
  ['勾魂索命', '[0 1]\n[0 1]\n[1 1]', '幡', '无', '无', [['红', 56, 100, 10, 5100]]],
  ['酆都帝律', '[1 1]\n[1 1]\n[1 0]', '幡', '相邻自身', '伤害', [['红', 64, 136, 13, 5800, 10]]],
  ['恶鬼喋血', '[1]\n[1]\n[1]', '枪', '相邻自身', '攻击力', [['红', 32, 91, 9, 2950, 20]]],
  ['花妖魅匕', '[0 1]\n[1 1]', '匕', '相邻自身', '攻击力', [['红', 32, 99, 9, 2550, 20]]]
];

// ---------- 备份现网 xlsx ----------
if (!existsSync(XLSX_PATH)) { console.error(`未找到 ${XLSX_PATH}`); process.exit(1); }
mkdirSync(path.dirname(BACKUP_PATH), { recursive: true });
copyFileSync(XLSX_PATH, BACKUP_PATH);
console.log(`已备份现网 xlsx → ${BACKUP_PATH}`);

// ---------- 读取基线工作簿（HEAD 7-Sheet 版；若现网已被并发任务写入伪造「邪」Sheet，
//            则从 git HEAD 提取基线重建，确保 7 个既有 Sheet 与 talisman-db.js(314 条)严格一致） ----------
let wb;
const wbNow = XLSX.read(readFileSync(XLSX_PATH), { type: 'buffer' });
if (wbNow.SheetNames.includes('邪')) {
  console.warn('⚠ 现网 xlsx 已含「邪」Sheet（疑似并发任务残留），改用 git HEAD 基线重建。');
  const headBuf = execFileSync('git', ['show', 'HEAD:法宝属性.xlsx'], { cwd: WORKSPACE, maxBuffer: 64 * 1024 * 1024 });
  wb = XLSX.read(headBuf, { type: 'buffer' });
} else {
  wb = wbNow;
}
console.log(`基线 Sheet 列表：${wb.SheetNames.join(' | ')}`);
if (wb.SheetNames.includes('邪')) delete wb.Sheets['邪'];

// ---------- 构造「邪」Sheet（aoa） ----------
const HEADER = ['法宝名', '形状', '共鸣值', '攻击力', '防御', '生命值', '加成率', '加成部位', '加成属性', '颜色', '种类'];
const aoa = [HEADER];
for (const [name, shape, kind, part, stat, rows] of FAMILIES) {
  rows.forEach((r, i) => {
    const [quality, reson, atk, def, hp, rate] = r;
    aoa.push([
      i === 0 ? name : '',        // 法宝名：首行填写，后续行留空沿用
      i === 0 ? shape : '',       // 形状：首行填写，后续行留空沿用
      reson, atk, def, hp,
      part === '无' ? '' : rate,  // 无加成行加成率留空
      part, stat, quality, kind
    ]);
  });
}
wb.Sheets['邪'] = XLSX.utils.aoa_to_sheet(aoa);
wb.SheetNames.push('邪');
console.log(`「邪」Sheet 数据行数：${aoa.length - 1}（9 族×4 品质 + 8 红宝 = 44）`);

// ---------- 回写 ----------
XLSX.writeFile(wb, XLSX_PATH);
console.log(`已回写 ${XLSX_PATH}，Sheet 列表：${wb.SheetNames.join(' | ')}`);
