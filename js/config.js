// config.js —— 常量与领域规则（品质表/显示样式/默认物品）。加载顺序 1/12，无依赖。
'use strict';

const QUALITY_OPTIONS = [
  {id:'green', name:'绿'},
  {id:'blue', name:'蓝'},
  {id:'purple', name:'紫'},
  {id:'gold', name:'金'},
  {id:'red', name:'红'}
];
const QUALITY_MAP = Object.fromEntries(QUALITY_OPTIONS.map(q=>[q.id,q]));
// 摆放结果只按品质着色，同品质物品依靠序号与外轮廓区分。
const QUALITY_DISPLAY_STYLES = {
  green:  {fill:'#DDF3D8', border:'#3F7D44', text:'#173A1B'},
  blue:   {fill:'#DCEBFA', border:'#3F6E9D', text:'#183A5A'},
  purple: {fill:'#EADFF5', border:'#76539A', text:'#3E2857'},
  gold:   {fill:'#F7E8B8', border:'#9A7424', text:'#503A08'},
  red:    {fill:'#F4D3D0', border:'#A5443F', text:'#5D1E1B'}
};
function qualityDisplayStyle(q){ return QUALITY_DISPLAY_STYLES[q] || QUALITY_DISPLAY_STYLES.green; }
const AREA_VALUE_BY_QUALITY = {
  1:{green:2, blue:4, purple:8, gold:16},
  2:{green:3, blue:6, purple:12, gold:24},
  3:{green:4, blue:8, purple:16, gold:32, red:32},
  4:{green:5, blue:10, purple:20, gold:40, red:56},
  5:{red:64}
};
const SINGLE_RATE_BY_QUALITY = {green:5, blue:8, purple:12, gold:16};
// 自身受加成物品的邻接优先级。索引越小，比较优先级越高。
// 用户给出的核心顺序：红色五格最高；金色四格 > 红色三格 > 紫色及以下四格。
// 红色四格默认加成率为 0；即使设置自定义加成率，也不自动进入默认邻接优先级，可用手动优先级控制。
const SELF_PRIORITY_TIERS = [
  {id:'five_red', label:'红色五格'},
  {id:'four_gold', label:'金色四格'},
  {id:'three_red', label:'红色三格（自身加成开启）'},
  {id:'four_purple', label:'紫色四格'},
  {id:'four_blue', label:'蓝色四格'},
  {id:'four_green', label:'绿色四格'}
];
const DEFAULT_ITEMS = [
  {id:'one-1', name:'单格', cells:[[0,0]], quality:'purple', enabled:true},
  {id:'two-v', name:'双格-竖条', cells:[[0,0],[1,0]], quality:'gold', enabled:true},
  {id:'two-h', name:'双格-横条', cells:[[0,0],[0,1]], quality:'gold', enabled:true},
  {id:'three-one-h', name:'三个-横条', cells:[[0,0],[0,1],[0,2]], quality:'gold', threeSelfBonus:false, enabled:true},
  {id:'three-i', name:'三格-I型', cells:[[0,0],[1,0],[2,0]], quality:'gold', threeSelfBonus:false, enabled:true},
  {id:'three-l-a', name:'三格-L型A', cells:[[0,1],[1,0],[1,1]], quality:'gold', threeSelfBonus:false, enabled:true},
  {id:'three-l-b', name:'三格-L型B', cells:[[0,0],[0,1],[1,0]], quality:'gold', threeSelfBonus:false, enabled:true},
  {id:'four-o', name:'四格-方块', cells:[[0,0],[0,1],[1,0],[1,1]], quality:'gold', enabled:true},
  {id:'four-l', name:'四格-L型', cells:[[0,0],[1,0],[2,0],[0,1]], quality:'gold', enabled:true},
  {id:'four-j', name:'四格-J型', cells:[[0,1],[1,1],[2,1],[2,0]], quality:'gold', enabled:true},
  {id:'four-i', name:'四格-I型', cells:[[0,0],[1,0],[2,0],[3,0]], quality:'gold', enabled:true},
  {id:'five-p', name:'五格-P型', cells:[[0,0],[0,1],[1,0],[1,1],[2,0]], quality:'red', enabled:true},
  {id:'five-hl', name:'五格-厚L型', cells:[[0,1],[1,0],[1,1],[2,0],[2,1]], quality:'red', enabled:true},
  {id:'five-j', name:'五格-J型', cells:[[0,1],[1,1],[2,1],[3,1],[3,0]], quality:'red', enabled:true},
  {id:'five-l', name:'五格-长L型', cells:[[0,0],[1,0],[2,0],[3,0],[0,1]], quality:'red', enabled:true},
  {id:'five-z', name:'五格-折线型', cells:[[0,1],[0,2],[1,1],[2,0],[2,1]], quality:'red', enabled:true}
];
