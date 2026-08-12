// data/talisman-db.js —— 法宝内置数据库（用户 Excel 转换产物，当前为占位数据）。
// 必须在 js/config.js 之前加载；config.js 的 validateTalismanDB() 会在启动时逐条校验。
// 数值设计原则：单格法宝为 provider（对相邻法宝加成，5-16%）；多格法宝为 self（每相邻一个不同法宝给自身加成，20-40%）或 none；
// baseStats 按格数与品质递增（参考旧版“按格数×品质的基础属性表”量级，分摊到 1-2 个项目）。
// id 规则：拼音属性 + 品质英文 + 三位序号。
window.TALISMAN_DB = {
  meta:{ version:2 },
  attributes:['金','木','水','火','土','雷','体'],
  qualities:['绿','蓝','紫','金','红'],
  bonusStats:[
    {id:'damage', name:'伤害'},
    {id:'hp', name:'生命值'},
    {id:'def', name:'防御'},
    {id:'atk', name:'攻击'}
  ],
  talismans:[
    // ===== 金 =====
    {id:'jin-green-001', name:'铜钱符', attribute:'金', quality:'绿', cells:[[0,0]],
     baseStats:{damage:2}, bonusMode:'provider', bonusRates:{damage:5}},
    {id:'jin-blue-001', name:'银鳞印', attribute:'金', quality:'蓝', cells:[[0,0],[1,0]],
     baseStats:{damage:4, hp:2}, bonusMode:'self', bonusRates:{damage:20, hp:20}},
    {id:'jin-purple-001', name:'紫金剑符', attribute:'金', quality:'紫', cells:[[0,0],[0,1],[0,2]],
     baseStats:{damage:10, hp:6}, bonusMode:'self', bonusRates:{damage:24, hp:24}},
    {id:'jin-gold-001', name:'庚金令', attribute:'金', quality:'金', cells:[[0,0],[0,1],[1,0],[1,1]],
     baseStats:{damage:24, hp:16}, bonusMode:'self', bonusRates:{damage:32, hp:32}},
    {id:'jin-red-001', name:'诛仙剑', attribute:'金', quality:'红', cells:[[0,0],[0,1],[1,1],[2,0],[2,1]],
     baseStats:{damage:40, hp:24}, bonusMode:'self', bonusRates:{damage:40, hp:40}},
    // ===== 木 =====
    {id:'mu-green-001', name:'青藤符', attribute:'木', quality:'绿', cells:[[0,0]],
     baseStats:{hp:2}, bonusMode:'provider', bonusRates:{hp:6}},
    {id:'mu-blue-001', name:'灵木牌', attribute:'木', quality:'蓝', cells:[[0,0],[0,1]],
     baseStats:{hp:4, def:2}, bonusMode:'self', bonusRates:{hp:22, def:22}},
    {id:'mu-purple-001', name:'建木枝', attribute:'木', quality:'紫', cells:[[0,0],[1,0],[2,0]],
     baseStats:{hp:10, def:6}, bonusMode:'self', bonusRates:{hp:24, def:24}},
    {id:'mu-gold-001', name:'扶桑木符', attribute:'木', quality:'金', cells:[[0,0],[1,0],[2,0],[0,1]],
     baseStats:{hp:24, def:16}, bonusMode:'self', bonusRates:{hp:32, def:32}},
    {id:'mu-red-001', name:'万载神木', attribute:'木', quality:'红', cells:[[0,1],[1,0],[1,1],[2,0],[2,1]],
     baseStats:{hp:64}, bonusMode:'self', bonusRates:{hp:36}},
    // ===== 水 =====
    {id:'shui-green-001', name:'寒露珠', attribute:'水', quality:'绿', cells:[[0,0]],
     baseStats:{def:2}, bonusMode:'provider', bonusRates:{def:8}},
    {id:'shui-blue-001', name:'碧水符', attribute:'水', quality:'蓝', cells:[[0,1],[1,0],[1,1]],
     baseStats:{def:6, hp:6}, bonusMode:'none', bonusRates:{}},
    {id:'shui-purple-001', name:'玄冰镜', attribute:'水', quality:'紫', cells:[[0,0],[0,1],[1,0],[1,1]],
     baseStats:{def:20}, bonusMode:'self', bonusRates:{def:26}},
    {id:'shui-gold-001', name:'沧澜令', attribute:'水', quality:'金', cells:[[0,1],[1,1],[2,1],[2,0]],
     baseStats:{hp:40}, bonusMode:'self', bonusRates:{hp:30}},
    {id:'shui-red-001', name:'天河玉露', attribute:'水', quality:'红', cells:[[0,0],[1,0],[2,0],[3,0],[0,1]],
     baseStats:{hp:38, def:26}, bonusMode:'self', bonusRates:{hp:38, def:38}},
    // ===== 火 =====
    {id:'huo-green-001', name:'火鸦符', attribute:'火', quality:'绿', cells:[[0,0]],
     baseStats:{atk:2}, bonusMode:'provider', bonusRates:{atk:10}},
    {id:'huo-blue-001', name:'炎阳珠', attribute:'火', quality:'蓝', cells:[[0,0],[1,0]],
     baseStats:{atk:4, damage:2}, bonusMode:'self', bonusRates:{atk:20, damage:20}},
    {id:'huo-purple-001', name:'离火罩', attribute:'火', quality:'紫', cells:[[0,0],[0,1],[1,0]],
     baseStats:{damage:16}, bonusMode:'self', bonusRates:{damage:28}},
    {id:'huo-gold-001', name:'金乌旗', attribute:'火', quality:'金', cells:[[0,0],[1,0],[2,0],[3,0]],
     baseStats:{atk:24, damage:16}, bonusMode:'self', bonusRates:{atk:34, damage:34}},
    {id:'huo-red-001', name:'焚天炉', attribute:'火', quality:'红', cells:[[0,0],[0,1],[1,0],[1,1],[2,0]],
     baseStats:{damage:64}, bonusMode:'self', bonusRates:{damage:36}},
    // ===== 土 =====
    {id:'tu-green-001', name:'厚土符', attribute:'土', quality:'绿', cells:[[0,0]],
     baseStats:{def:2}, bonusMode:'provider', bonusRates:{def:12}},
    {id:'tu-blue-001', name:'磐石印', attribute:'土', quality:'蓝', cells:[[0,0],[0,1]],
     baseStats:{def:4, atk:2}, bonusMode:'self', bonusRates:{def:20, atk:20}},
    {id:'tu-purple-001', name:'镇岳碑', attribute:'土', quality:'紫', cells:[[0,1],[0,2],[1,1],[2,0],[2,1]],
     baseStats:{damage:16, hp:16}, bonusMode:'none', bonusRates:{}},
    {id:'tu-gold-001', name:'昆仑土符', attribute:'土', quality:'金', cells:[[0,1],[1,0],[1,1],[2,0],[2,1]],
     baseStats:{def:24, hp:16}, bonusMode:'self', bonusRates:{def:32, hp:32}},
    {id:'tu-red-001', name:'社稷鼎', attribute:'土', quality:'红', cells:[[0,1],[1,1],[2,1],[3,1],[3,0]],
     baseStats:{def:32, hp:32}, bonusMode:'self', bonusRates:{def:40, hp:40}},
    // ===== 雷 =====
    {id:'lei-green-001', name:'惊雷符', attribute:'雷', quality:'绿', cells:[[0,0]],
     baseStats:{damage:2}, bonusMode:'provider', bonusRates:{damage:14}},
    {id:'lei-blue-001', name:'紫电珠', attribute:'雷', quality:'蓝', cells:[[0,0],[0,1],[0,2]],
     baseStats:{damage:8, atk:4}, bonusMode:'self', bonusRates:{damage:26, atk:26}},
    {id:'lei-purple-001', name:'五雷令', attribute:'雷', quality:'紫', cells:[[0,0],[0,1],[1,0]],
     baseStats:{atk:16}, bonusMode:'self', bonusRates:{atk:30}},
    {id:'lei-gold-001', name:'雷泽鼓', attribute:'雷', quality:'金', cells:[[0,0],[0,1],[1,0],[1,1]],
     baseStats:{damage:40}, bonusMode:'self', bonusRates:{damage:36}},
    {id:'lei-red-001', name:'九霄神雷', attribute:'雷', quality:'红', cells:[[0,1],[0,2],[1,1],[2,0],[2,1]],
     baseStats:{damage:40, atk:24}, bonusMode:'self', bonusRates:{damage:40, atk:40}},
    // ===== 体 =====
    {id:'ti-green-001', name:'养气符', attribute:'体', quality:'绿', cells:[[0,0]],
     baseStats:{hp:2}, bonusMode:'provider', bonusRates:{hp:16}},
    {id:'ti-blue-001', name:'铁骨牌', attribute:'体', quality:'蓝', cells:[[0,1],[1,0],[1,1]],
     baseStats:{hp:6, atk:6}, bonusMode:'none', bonusRates:{}},
    {id:'ti-purple-001', name:'金刚身符', attribute:'体', quality:'紫', cells:[[0,0],[1,0],[2,0],[0,1]],
     baseStats:{hp:20}, bonusMode:'self', bonusRates:{hp:28}},
    {id:'ti-gold-001', name:'不灭金身', attribute:'体', quality:'金', cells:[[0,1],[1,1],[2,1],[2,0]],
     baseStats:{hp:26, def:14}, bonusMode:'self', bonusRates:{hp:30, def:30}},
    {id:'ti-red-001', name:'肉身成圣', attribute:'体', quality:'红', cells:[[0,0],[1,0],[2,0],[3,0],[0,1]],
     baseStats:{hp:60, def:4}, bonusMode:'self', bonusRates:{hp:36, def:36}},
    // ===== 补充组合 =====
    {id:'jin-red-002', name:'陷仙剑', attribute:'金', quality:'红', cells:[[0,1],[1,1],[2,1],[3,1],[3,0]],
     baseStats:{atk:64}, bonusMode:'self', bonusRates:{atk:40}},
    {id:'huo-red-002', name:'六丁神火', attribute:'火', quality:'红', cells:[[0,0],[0,1],[0,2]],
     baseStats:{damage:32}, bonusMode:'self', bonusRates:{damage:36}}
  ]
};
