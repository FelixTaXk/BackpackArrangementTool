# 法宝数据 Excel 格式说明（实际版）

本文档说明「法宝属性.xlsx」的实际结构——供 `scripts/convert-excel.mjs` 转换为内置数据库。**宽表设计**：每个属性一个 Sheet，每行一件法宝（同一法宝的不同品质变体占多行，仅在首行填写法宝名与形状）。

## 一、工作簿结构

8 个 Sheet（属性分组）：**金 / 木 / 水 / 火 / 土 / 雷 / 邪 / 体**。每个 Sheet 一个宽表，表头固定为 12 列：

| 列名 | 说明 |
|---|---|
| 法宝名 | 法宝名称（全局唯一）；同一法宝的后续品质行可留空（沿用上一行法宝名） |
| 形状 | 形状文本（矩阵记法，见下节） |
| 共鸣值 | 基础留存项（不参与计算） |
| 攻击力 | 基础属性 → atk（参与计算） |
| 防御 | 基础属性 → def（参与计算） |
| 生命值 | 基础属性 → hp（参与计算） |
| 加成率 | 百分比数值（如 40 表示 40%） |
| 加成部位 | 相邻 / 相邻自身 / 无 → provider / self / none |
| 加成属性 | 加成的属性项目 |
| 颜色 | 品质：绿 / 蓝 / 紫 / 金 / 红 |
| 种类 | 法宝种类（如 刀/剑/锤…），留空或「无」则不写；供「种类筛选」 |
| 是否造成伤害 | 是 / 1 / true / y / yes → `causesDamage:true`；其余或空 → false |

> 与早期「三表长表规格」不同：实际按此 8-Sheet 宽表整理。各 Sheet 表头须与此完全一致（缺列会告警但不中断）。

## 二、形状填写规范

形状单元格内使用多行文本的**矩阵记法**，用 `[1 0]` 行表示；1 占用、0 空格，逐行解析为 cells 坐标：

- 每行形如 `[1 1]`、`[0 1]\n[1 1]`（Excel 中可用 Alt+Enter 换行）。
- 只读取方括号内的 0/1，括号外游离字符忽略。
- 要求：形状最大 **7 列 × 6 行**；1 格需相互**连通**（上下左右）；至少一个占用格。
- 同品质下形状应一致（转换器会校验「同品质形状一致性」并告警异常）。

示例：

```text
[1]         单格
[1 1 1]     横排三格
[1 1]
[0 1]       L 形（两行）
```

## 三、计算口径（convert-excel.mjs 落地）

- **参与计算的注册表 `bonusStats`**：atk（攻击力）/ def（防御）/ hp（生命值）。形状坐标范围 r∈[0,5]、c∈[0,6]。
- **加成部位 → bonusMode**：相邻→provider（提升相邻同属性）、相邻自身→self（提升自己）、无→none。
- **加成属性 ∈ {攻击力/防御/生命值}** → 写入 `bonusRates[atk|def|hp]` = 加成率。
- **加成属性为其它**（伤害/暴击伤害/治疗效果/护盾值/汲取）→ 留存 `extraRates[名称]` = 加成率，不参与百分比传播（rate-only）。
- **共鸣值 / 种类** → 留存 `extraStats`。
- **是否造成伤害** → `causesDamage:true`（仅当值为 是/1/true/y/yes）。
- 校验：名称不得含单引号/反斜杠/换行；品质合法；`baseStats` 总和必须 > 0；`baseStats`/`bonusRates` 键必须在注册表内。

## 四、运行转换

双击 `convert-talisman-db.bat`（自动安装 SheetJS 到 `%TEMP%\xlsx-conv` 并跑 `scripts/convert-excel.mjs`），或手动：

```powershell
$env:XLSX_MODULE_DIR="$env:TEMP\xlsx-conv"   # 已 npm install xlsx 的目录
node scripts/convert-excel.mjs
```

产物 `data/talisman-db.js`：`window.TALISMAN_DB`（meta/attributes/qualities/bonusStats/talismans）。id 稳定化：按「名称|属性|品质」复用旧 id，新增条目从该 (属性,品质) 组历史最大序号+1 分配，可在 xlsx 任意插行/删行而不改变既有法宝 id。
