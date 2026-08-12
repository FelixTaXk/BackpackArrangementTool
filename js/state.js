// state.js —— 全局可变状态（var 声明以保证跨经典脚本共享）。加载顺序 4/13，无依赖。
var W = 7, H = 6;
var active = [];
var itemDefs = [];
var inventory = [];
var nextItemNo = 1;
var lastResult = null;
var solverWorker = null;
var solverWorkers = [];
var solverStatusTimer = null;
var solverStatusState = null;
