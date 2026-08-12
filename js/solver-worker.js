// solver-worker.js —— 求解 Worker 主体 solverWorkerMain（原样）与 createSolverWorker（toString+Blob URL）。加载顺序 9/12，依赖 state。
'use strict';

function solverWorkerMain(){
  'use strict';
  self.onmessage = function(ev){
    const data = ev.data;
    const W = data.W, H = data.H;
    const activeMask = BigInt(data.activeMask);
    const activeCells = data.activeCells;
    const nodeLimit = Math.max(1000, Number(data.nodeLimit)||2500000);
    const timeLimit = Math.max(100, Number(data.timeLimit)||20000);
    const useBonus = !!data.useBonus;
    const manualCount = Number(data.manualCount)||0;
    const defaultTierCount = Number(data.defaultTierCount)||0;
    const requiredTotalItems = Math.max(0, Number(data.requiredTotalItems)||0);
    const skippedCount = Math.max(0, Number(data.skippedCount)||0);
    const started = performance.now();
    const hardDeadline = started + timeLimit;
    let rngState = (0x9e3779b9 ^ itemsHashSeed(data.items || []) ^ activeCells ^ nodeLimit ^ (Number(data.seedOffset)||0)) >>> 0;
    function itemsHashSeed(rawItems){
      let h=2166136261>>>0;
      for(const t of rawItems){
        const text=`${t.no}|${t.area}|${t.value}|${t.bonusRate}|${t.bonusKind}|${t.customPriority ?? ''}`;
        for(let i=0;i<text.length;i++){ h^=text.charCodeAt(i); h=Math.imul(h,16777619)>>>0; }
      }
      return h>>>0;
    }
    function rand(){ rngState ^= rngState<<13; rngState ^= rngState>>>17; rngState ^= rngState<<5; return (rngState>>>0)/4294967296; }
    function shuffled(arr){
      const out=arr.slice();
      for(let i=out.length-1;i>0;i--){ const j=Math.floor(rand()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
      return out;
    }
    let nodes = 0;
    let assignmentChecks = 0;
    let lastProgress = started;
    let lastIncumbentReport = started-250;
    let currentStage = '准备搜索';

    function bit(r,c){ return 1n << BigInt(r*W+c); }
    function makeNeighborMask(cells){
      let m = 0n;
      for(const [r,c] of cells){
        if(r>0) m |= bit(r-1,c);
        if(r+1<H) m |= bit(r+1,c);
        if(c>0) m |= bit(r,c-1);
        if(c+1<W) m |= bit(r,c+1);
      }
      return m;
    }
    const items = data.items.map((t,itemIndex)=>({
      ...t,
      itemIndex,
      placements:t.placements.map((p,placementIndex)=>({
        ...p,
        itemIndex,
        placementIndex,
        mask:BigInt(p.mask),
        neighborMask:makeNeighborMask(p.cells)
      }))
    }));

    function areAdjacent(a,b){ return (a.neighborMask & b.mask) !== 0n; }
    function pairBonusEvents(a,b){
      if(!areAdjacent(a,b)) return [];
      const events = [];
      if(a.bonusKind === 'provider' && a.bonusRate > 0){
        events.push({kind:'single_provider', source:a.no, sourceName:a.itemName, target:b.no, targetName:b.itemName, rate:a.bonusRate, base:b.value, bonus:b.value*a.bonusRate/100});
      }
      if(b.bonusKind === 'provider' && b.bonusRate > 0){
        events.push({kind:'single_provider', source:b.no, sourceName:b.itemName, target:a.no, targetName:a.itemName, rate:b.bonusRate, base:a.value, bonus:a.value*b.bonusRate/100});
      }
      if(a.bonusKind === 'self' && a.bonusRate > 0){
        events.push({kind:'self_neighbor', source:a.no, sourceName:a.itemName, target:a.no, targetName:a.itemName, neighbor:b.no, neighborName:b.itemName, rate:a.bonusRate, base:a.value, bonus:a.value*a.bonusRate/100});
      }
      if(b.bonusKind === 'self' && b.bonusRate > 0){
        events.push({kind:'self_neighbor', source:b.no, sourceName:b.itemName, target:b.no, targetName:b.itemName, neighbor:a.no, neighborName:a.itemName, rate:b.bonusRate, base:b.value, bonus:b.value*b.bonusRate/100});
      }
      return events.filter(x=>x.bonus>0);
    }
    function adjacencyGainFor(p, placed){
      const out = {bonus:0, events:[]};
      for(const old of placed){
        for(const e of pairBonusEvents(p,old)){ out.bonus += e.bonus; out.events.push(e); }
      }
      return out;
    }
    function potentialPairBonus(a,b){
      let bonus=0;
      if(a.bonusKind==='provider' && a.bonusRate>0) bonus += b.value*a.bonusRate/100;
      if(b.bonusKind==='provider' && b.bonusRate>0) bonus += a.value*b.bonusRate/100;
      if(a.bonusKind==='self' && a.bonusRate>0) bonus += a.value*a.bonusRate/100;
      if(b.bonusKind==='self' && b.bonusRate>0) bonus += b.value*b.bonusRate/100;
      return bonus;
    }
    function emptyManualVector(){ return Array(manualCount).fill(0); }
    function emptyDefaultVector(){ return Array(defaultTierCount).fill(0); }
    function addVectors(a,b){ return a.map((v,i)=>v+(b[i]||0)); }
    function compareVectors(a,b){
      const n = Math.max(a.length,b.length);
      for(let i=0;i<n;i++){
        const d = (a[i]||0)-(b[i]||0);
        if(d!==0) return d;
      }
      return 0;
    }
    function targetPriorityGain(target, neighbor, manualVector, defaultVector, links){
      if(target.manualOrder >= 0){
        manualVector[target.manualOrder]++;
        links.push({mode:'custom',target:target.no,targetName:target.itemName,neighbor:neighbor.no,neighborName:neighbor.itemName,manualOrder:target.manualOrder,customPriority:target.customPriority});
      }else if(target.priorityTier >= 0){
        defaultVector[target.priorityTier]++;
        links.push({mode:'default',target:target.no,targetName:target.itemName,neighbor:neighbor.no,neighborName:neighbor.itemName,tier:target.priorityTier});
      }
    }
    function priorityGainFor(p, placed){
      const manualVector = emptyManualVector();
      const defaultVector = emptyDefaultVector();
      const links = [];
      for(const old of placed){
        if(!areAdjacent(p,old)) continue;
        targetPriorityGain(p,old,manualVector,defaultVector,links);
        targetPriorityGain(old,p,manualVector,defaultVector,links);
      }
      let weighted = 0;
      for(let i=0;i<manualVector.length;i++) weighted += manualVector[i] * Math.max(1,manualVector.length-i) * 100000000;
      for(let i=0;i<defaultVector.length;i++) weighted += defaultVector[i] * Math.max(1,defaultVector.length-i) * 100000;
      return {manualVector,defaultVector,links,weighted};
    }
    function ownSearchPriority(p){
      if(p.manualOrder >= 0) return 1000000000000 - p.manualOrder*1000000000;
      if(p.priorityTier >= 0) return 100000000 - p.priorityTier*1000000;
      return 0;
    }
    function instantiate(template,item,group=null){
      return {
        ...template,
        uid:item.uid,
        no:item.no,
        itemName:item.name,
        typeName:item.typeName,
        area:item.area,
        quality:item.quality,
        value:item.value,
        bonusRate:item.bonusRate,
        bonusKind:item.bonusKind,
        priorityTier:item.priorityTier,
        customPriority:item.customPriority,
        manualOrder:item.manualOrder,
        itemIndex:item.itemIndex,
        geometryGroupIndex:group && group.mode==='geometry' ? group.groupIndex : (template.geometryGroupIndex ?? null)
      };
    }

    // 完整装入时先按“几何形状 + 邻接优先级”合并，基础属性和加成率留到布局完成后再分配。
    // 这样同形状物品不会因为属性不同而把几何搜索空间重复拆开。
    function geometryGroupKey(t){
      const masks = t.placements.map(p=>p.mask.toString()).sort().join(',');
      return [masks,t.area,t.priorityTier,t.manualOrder,t.customPriority===null?'':t.customPriority].join('|');
    }
    // 无法全部装入时仍需决定取舍，因此部分装入阶段保留原来的完整评分签名。
    function detailedGroupKey(t){
      const masks = t.placements.map(p=>p.mask.toString()).sort().join(',');
      return [masks,t.area,t.quality,t.value,t.bonusRate,t.bonusKind,t.priorityTier,t.manualOrder,t.customPriority===null?'':t.customPriority].join('|');
    }
    function guideInfluence(t){
      if(t.bonusKind==='self') return t.value*t.bonusRate;
      if(t.bonusKind==='provider') return t.bonusRate*1000+t.value;
      return t.value;
    }
    function buildGroups(keyFn,mode){
      const map = new Map();
      for(const t of items){
        const k=keyFn(t);
        if(!map.has(k)) map.set(k,{key:k,canonicalKey:k,items:[],templates:t.placements.slice().sort((a,b)=>a.mask<b.mask?-1:a.mask>b.mask?1:0),area:t.area,value:t.value,mode});
        map.get(k).items.push(t);
      }
      const out=[...map.values()];
      for(const g of out){
        g.items.sort((a,b)=>a.no-b.no);
        g.guideItem=g.items.slice().sort((a,b)=>guideInfluence(b)-guideInfluence(a) || a.no-b.no)[0];
        g.templates.forEach((p,i)=>{ p.placementIndex=i; });
      }
      // 明确的稳定顺序，避免仅因清单添加顺序不同而改变平局时的搜索路线。
      out.sort((a,b)=>{
        const pa=ownSearchPriority(a.items[0]), pb=ownSearchPriority(b.items[0]);
        return pb-pa || b.area-a.area || a.canonicalKey.localeCompare(b.canonicalKey);
      });
      out.forEach((g,i)=>{ g.groupIndex=i; });
      return out;
    }
    const fullGroups = buildGroups(geometryGroupKey,'geometry');
    const partialGroups = buildGroups(detailedGroupKey,'detailed');
    // 完整装入搜索时，单格物品不再逐件参与几何回溯。
    // 先搜索多格物品布局，再把单格物品按真实加成价值分配到剩余格子，可显著减少组合数。
    const singletonItems = items.filter(t=>t.area===1);
    const singletonCount = singletonItems.length;
    const singletonCompletionCache = new Map();
    const fullCoreGroups = fullGroups.filter(g=>g.area>1);
    const fullCoreItemCount = fullCoreGroups.reduce((sum,g)=>sum+g.items.length,0);
    const fullCoreArea = fullCoreGroups.reduce((sum,g)=>sum+g.items.length*g.area,0);
    const itemPlacementLookup = items.map(t=>new Map(t.placements.map(p=>[p.mask.toString(),p])));
    const itemAssignmentClass = items.map(t=>{
      const masks=t.placements.map(p=>p.mask.toString()).sort().join(',');
      return `${t.area}|${masks}`;
    });
    let groups = fullCoreGroups;
    let geometryMode = true;

    const searchableArea = items.reduce((s,x)=>s+x.area,0);
    const searchableBase = items.reduce((s,x)=>s+x.value,0);
    const searchableItems = items.length;
    const totalArea = Math.max(searchableArea, Number(data.requiredTotalArea)||0);
    const totalBase = Math.max(searchableBase, Number(data.requiredTotalBase)||0);
    const totalItems = Math.max(searchableItems, requiredTotalItems);
    const globalMaxBonus = useBonus ? items.reduce((sum,a,i)=>{
      for(let j=i+1;j<items.length;j++) sum += potentialPairBonus(a,items[j]);
      return sum;
    },0) : 0;
    const EPS = 1e-9;
    let best = {
      complete:false,baseScore:-1,bonusScore:0,totalScore:-1,area:-1,itemCount:-1,adjacencyCount:-1,
      manualPriorityVector:emptyManualVector(),defaultPriorityVector:emptyDefaultVector(),
      placements:[],occupied:0n,bonusEvents:[],priorityLinks:[]
    };
    const fullGroupByUid = new Map();
    for(const g of fullGroups) for(const item of g.items) fullGroupByUid.set(String(item.uid),g);

    // 严格字典序：完整装入 > 实际总属性 > 手动优先级 > 默认优先级 > 总邻接数量。
    // 后续字段只用于完全平局时保持结果稳定，不改变上述优化顺序。
    function compareEvaluationObjects(a,b){
      const ac=!!a.complete, bc=!!b.complete;
      if(ac!==bc) return ac?1:-1;
      if(Math.abs(a.totalScore-b.totalScore)>EPS) return a.totalScore>b.totalScore?1:-1;
      const mc=compareVectors(a.manualPriorityVector,b.manualPriorityVector); if(mc!==0) return mc;
      const dc=compareVectors(a.defaultPriorityVector,b.defaultPriorityVector); if(dc!==0) return dc;
      if((a.adjacencyCount||0)!==(b.adjacencyCount||0)) return (a.adjacencyCount||0)>(b.adjacencyCount||0)?1:-1;
      if(a.itemCount!==b.itemCount) return a.itemCount>b.itemCount?1:-1;
      if(a.area!==b.area) return a.area>b.area?1:-1;
      if(Math.abs(a.baseScore-b.baseScore)>EPS) return a.baseScore>b.baseScore?1:-1;
      if(Math.abs(a.bonusScore-b.bonusScore)>EPS) return a.bonusScore>b.bonusScore?1:-1;
      return 0;
    }
    function betterThanBest(candidate){ return compareEvaluationObjects(candidate,best)>0; }
    function accept(candidate){
      if(!betterThanBest(candidate)) return;
      best = candidate;
      const now=performance.now();
      if(now-lastIncumbentReport>=250){
        lastIncumbentReport=now;
        self.postMessage({type:'incumbent',stage:currentStage,best:serializeBest(),nodes,elapsed:Math.round(now-started),fullPackingFound:best.complete,totalArea,totalItems});
      }
    }
    function evaluateConcrete(placements){
      let baseScore=0, area=0, occupied=0n, adjacencyCount=0;
      const manualVector=emptyManualVector(), defaultVector=emptyDefaultVector();
      const bonusEvents=[], priorityLinks=[];
      let bonusScore=0;
      for(const p of placements){ baseScore+=p.value; area+=p.area; occupied|=p.mask; }
      for(let i=0;i<placements.length;i++) for(let j=i+1;j<placements.length;j++){
        const a=placements[i], b=placements[j];
        if(!areAdjacent(a,b)) continue;
        adjacencyCount++;
        targetPriorityGain(a,b,manualVector,defaultVector,priorityLinks);
        targetPriorityGain(b,a,manualVector,defaultVector,priorityLinks);
        if(useBonus){
          for(const e of pairBonusEvents(a,b)){ bonusScore+=e.bonus; bonusEvents.push(e); }
        }
      }
      return {
        complete:placements.length===totalItems,
        baseScore,bonusScore,totalScore:baseScore+bonusScore,area,itemCount:placements.length,adjacencyCount,
        manualPriorityVector:manualVector,defaultPriorityVector:defaultVector,
        placements:placements.slice(),occupied,bonusEvents,priorityLinks
      };
    }
    function scoringSignature(t){ return [t.value,t.bonusRate,t.bonusKind,t.quality].join('|'); }
    function uniquePermutations(arr,limit=720){
      const out=[], used=Array(arr.length).fill(false), cur=[];
      const sorted=arr.slice().sort((a,b)=>scoringSignature(a).localeCompare(scoringSignature(b)) || a.no-b.no);
      function rec(){
        if(out.length>=limit) return;
        if(cur.length===sorted.length){ out.push(cur.slice()); return; }
        const seen=new Set();
        for(let i=0;i<sorted.length;i++){
          if(used[i]) continue;
          const sig=scoringSignature(sorted[i]);
          if(seen.has(sig)) continue;
          seen.add(sig); used[i]=true; cur.push(sorted[i]); rec(); cur.pop(); used[i]=false;
          if(out.length>=limit) return;
        }
      }
      rec();
      return out;
    }
    function slotDegree(slot,allSlots){
      let n=0;
      for(const other of allSlots) if(other!==slot && areAdjacent(slot,other)) n++;
      return n;
    }
    function assignmentSeed(geometryPlacements,mode){
      const concrete=Array(geometryPlacements.length);
      const groupSlots=new Map();
      geometryPlacements.forEach((p,i)=>{
        const gi=p.geometryGroupIndex;
        if(!groupSlots.has(gi)) groupSlots.set(gi,[]);
        groupSlots.get(gi).push({slot:p,index:i,degree:slotDegree(p,geometryPlacements)});
      });
      for(const [gi,slotsRaw] of groupSlots){
        const g=fullGroups[gi];
        const slots=slotsRaw.slice().sort((a,b)=> mode==='influence' ? (b.degree-a.degree || (a.slot.mask<b.slot.mask?-1:1)) : (a.slot.mask<b.slot.mask?-1:1));
        const its=g.items.slice().sort((a,b)=>{
          if(mode==='influence') return guideInfluence(b)-guideInfluence(a) || b.value-a.value || a.no-b.no;
          return a.no-b.no;
        });
        for(let i=0;i<slots.length;i++) concrete[slots[i].index]=instantiate(slots[i].slot,its[i],g);
      }
      return concrete;
    }
    function improveAssignments(seed,geometryPlacements){
      let current=seed.slice();
      let currentEval=evaluateConcrete(current);
      const groupSlots=new Map();
      geometryPlacements.forEach((p,i)=>{
        const gi=p.geometryGroupIndex;
        if(!groupSlots.has(gi)) groupSlots.set(gi,[]);
        groupSlots.get(gi).push(i);
      });
      for(let pass=0;pass<3;pass++){
        let changed=false;
        for(const [gi,indices] of groupSlots){
          if(indices.length<2) continue;
          const g=fullGroups[gi];
          let bestLocal=currentEval, bestItems=null;
          if(indices.length<=7){
            const perms=uniquePermutations(g.items,720);
            for(const perm of perms){
              const candidate=current.slice();
              for(let k=0;k<indices.length;k++) candidate[indices[k]]=instantiate(geometryPlacements[indices[k]],perm[k],g);
              const evc=evaluateConcrete(candidate);
              if(compareEvaluationObjects(evc,bestLocal)>0){ bestLocal=evc; bestItems=perm; }
            }
          }else{
            for(let a=0;a<indices.length;a++) for(let b=a+1;b<indices.length;b++){
              const candidate=current.slice();
              const ia=indices[a], ib=indices[b];
              const itemA=items[current[ia].itemIndex], itemB=items[current[ib].itemIndex];
              candidate[ia]=instantiate(geometryPlacements[ia],itemB,g);
              candidate[ib]=instantiate(geometryPlacements[ib],itemA,g);
              const evc=evaluateConcrete(candidate);
              if(compareEvaluationObjects(evc,bestLocal)>0){ bestLocal=evc; bestItems={swap:[ia,ib],candidate}; }
            }
          }
          if(bestItems){
            if(Array.isArray(bestItems)){
              for(let k=0;k<indices.length;k++) current[indices[k]]=instantiate(geometryPlacements[indices[k]],bestItems[k],g);
            }else current=bestItems.candidate;
            currentEval=bestLocal; changed=true;
          }
        }
        if(!changed) break;
      }
      return currentEval;
    }
    function evaluateGeometry(geometryPlacements){
      if(!useBonus) return evaluateConcrete(assignmentSeed(geometryPlacements,'number'));
      const a=improveAssignments(assignmentSeed(geometryPlacements,'number'),geometryPlacements);
      const b=improveAssignments(assignmentSeed(geometryPlacements,'influence'),geometryPlacements);
      return compareEvaluationObjects(b,a)>0?b:a;
    }
    function placementForItemAtMask(item,mask){
      const template=itemPlacementLookup[item.itemIndex].get(mask.toString());
      if(!template) return null;
      return instantiate(template,item,fullGroupByUid.get(String(item.uid)) || null);
    }
    function activeFreeCells(occupied){
      const out=[];
      for(let r=0;r<H;r++) for(let c=0;c<W;c++){
        const m=bit(r,c);
        if((activeMask&m)!==0n && (occupied&m)===0n) out.push({r,c,mask:m});
      }
      return out;
    }
    function cellTouchesPlacement(cell,p){
      return (makeNeighborMask([[cell.r,cell.c]]) & p.mask)!==0n;
    }
    // 仅作为搜索顺序启发式：估计剩余单格若靠近高价值多格物品可获得的加成机会。
    // 最终结果仍完全由真实总属性比较器决定，不会硬性禁止单格相邻。
    function singletonOpportunityProxy(occupied,placed){
      if(!useBonus || singletonCount===0) return 0;
      const free=activeFreeCells(occupied);
      if(free.length<singletonCount) return -1e30;
      const guides=singletonItems.slice().sort((a,b)=>guideInfluence(b)-guideInfluence(a)||b.value-a.value||a.no-b.no).slice(0,Math.min(4,singletonCount));
      const scores=[];
      for(const cell of free){
        let bestCell=0;
        for(const it of guides){
          const p=placementForItemAtMask(it,cell.mask);
          if(!p) continue;
          let score=0;
          for(const old of placed){
            if(old.area===1 || !areAdjacent(p,old)) continue;
            score += potentialPairBonus(p,old);
          }
          if(score>bestCell) bestCell=score;
        }
        scores.push(bestCell);
      }
      scores.sort((a,b)=>b-a);
      return scores.slice(0,singletonCount).reduce((a,b)=>a+b,0);
    }
    function singletonCellSets(occupied,multiConcrete){
      const free=activeFreeCells(occupied);
      if(free.length<singletonCount) return [];
      if(singletonCount===0) return [[]];
      if(free.length===singletonCount) return [free];
      const sets=[];
      const keyOf=set=>set.map(x=>x.mask.toString()).sort().join(',');
      const seen=new Set();
      function add(set){ const k=keyOf(set); if(!seen.has(k)){ seen.add(k); sets.push(set.slice()); } }
      function cellTargetScore(cell){
        let best=0;
        for(const it of singletonItems){
          const p=placementForItemAtMask(it,cell.mask); if(!p) continue;
          let score=0;
          for(const old of multiConcrete) if(areAdjacent(p,old)) score += potentialPairBonus(p,old);
          if(score>best) best=score;
        }
        return best;
      }
      const ranked=free.map(cell=>({cell,score:cellTargetScore(cell)})).sort((a,b)=>b.score-a.score || (a.cell.mask<b.cell.mask?-1:1));
      add(ranked.slice(0,singletonCount).map(x=>x.cell));
      const spread=[];
      const remain=free.slice();
      while(spread.length<singletonCount && remain.length){
        let bi=0,bs=-Infinity;
        for(let i=0;i<remain.length;i++){
          const cell=remain[i];
          const nearSingles=spread.reduce((n,x)=>n+(Math.abs(x.r-cell.r)+Math.abs(x.c-cell.c)===1?1:0),0);
          const sc=cellTargetScore(cell)-nearSingles*Math.max(1,ranked[0]?.score||1)*0.15;
          if(sc>bs){bs=sc;bi=i;}
        }
        spread.push(remain.splice(bi,1)[0]);
      }
      add(spread);
      for(let k=0;k<4;k++) add(shuffled(free).slice(0,singletonCount));
      return sets;
    }
    function assignSingletons(baseConcrete,cells,mode){
      const placed=baseConcrete.slice();
      let remainingItems=mode==='random'?shuffled(singletonItems):singletonItems.slice().sort((a,b)=>guideInfluence(b)-guideInfluence(a)||b.value-a.value||a.no-b.no);
      let remainingCells=mode==='random'?shuffled(cells):cells.slice();
      if(mode==='number'){
        remainingItems=singletonItems.slice().sort((a,b)=>a.no-b.no);
        remainingCells=cells.slice().sort((a,b)=>a.mask<b.mask?-1:1);
      }
      while(remainingItems.length){
        let bestPair=null;
        for(let ii=0;ii<remainingItems.length;ii++) for(let ci=0;ci<remainingCells.length;ci++){
          const item=remainingItems[ii], cell=remainingCells[ci];
          const p=placementForItemAtMask(item,cell.mask); if(!p) continue;
          const bg=useBonus?adjacencyGainFor(p,placed):{bonus:0,events:[]};
          const pg=priorityGainFor(p,placed);
          let multiBonus=0, singleBonus=0, multiNeighbors=0;
          for(const old of placed){
            if(!areAdjacent(p,old)) continue;
            const b=potentialPairBonus(p,old);
            if(old.area===1) singleBonus+=b; else {multiBonus+=b; multiNeighbors++;}
          }
          let primary=bg.bonus;
          if(mode==='target') primary=multiBonus+singleBonus*0.15;
          if(mode==='spread') primary=bg.bonus-singleBonus*0.20+multiNeighbors*0.0001;
          const cand={ii,ci,p,primary,total:bg.bonus,priority:pg.weighted,multiBonus,multiNeighbors};
          if(!bestPair || cand.primary>bestPair.primary+EPS || (Math.abs(cand.primary-bestPair.primary)<=EPS && cand.total>bestPair.total+EPS) || (Math.abs(cand.primary-bestPair.primary)<=EPS && Math.abs(cand.total-bestPair.total)<=EPS && cand.priority>bestPair.priority) || (Math.abs(cand.primary-bestPair.primary)<=EPS && Math.abs(cand.total-bestPair.total)<=EPS && cand.priority===bestPair.priority && cand.multiBonus>bestPair.multiBonus+EPS)) bestPair=cand;
        }
        if(!bestPair) return null;
        placed.push(bestPair.p);
        remainingItems.splice(bestPair.ii,1);
        remainingCells.splice(bestPair.ci,1);
      }
      return placed;
    }
    function improveConcreteAssignments(seed,maxSteps){
      let current=seed.slice();
      let currentEval=evaluateConcrete(current);
      const classIndices=new Map();
      for(let i=0;i<current.length;i++){
        const key=itemAssignmentClass[current[i].itemIndex];
        if(!classIndices.has(key)) classIndices.set(key,[]);
        classIndices.get(key).push(i);
      }
      for(let step=0;step<maxSteps && performance.now()<hardDeadline;step++){
        let bestEval=currentEval, bestCandidate=null;
        for(const indices of classIndices.values()){
          if(indices.length<2) continue;
          for(let ai=0;ai<indices.length;ai++) for(let bi=ai+1;bi<indices.length;bi++){
            assignmentChecks++;
            const ia=indices[ai], ib=indices[bi];
            const itemA=items[current[ia].itemIndex], itemB=items[current[ib].itemIndex];
            const pa=placementForItemAtMask(itemB,current[ia].mask);
            const pb=placementForItemAtMask(itemA,current[ib].mask);
            if(!pa || !pb) continue;
            const candidate=current.slice(); candidate[ia]=pa; candidate[ib]=pb;
            const evc=evaluateConcrete(candidate);
            if(compareEvaluationObjects(evc,bestEval)>0){ bestEval=evc; bestCandidate=candidate; }
          }
        }
        if(!bestCandidate) break;
        current=bestCandidate; currentEval=bestEval;
      }
      return currentEval;
    }
    function completeGeometryWithSingletons(multiGeometryPlacements,intensive=false){
      const cacheKey=!intensive ? multiGeometryPlacements.map(p=>`${p.geometryGroupIndex}:${p.mask.toString(36)}`).sort().join('|') : '';
      if(cacheKey && singletonCompletionCache.has(cacheKey)) return singletonCompletionCache.get(cacheKey);
      let occupied=0n;
      for(const p of multiGeometryPlacements) occupied|=p.mask;
      const multiSeeds=[];
      if(multiGeometryPlacements.length){
        multiSeeds.push(assignmentSeed(multiGeometryPlacements,'number'));
        multiSeeds.push(assignmentSeed(multiGeometryPlacements,'influence'));
      }else multiSeeds.push([]);
      let bestLocal=null;
      for(const multiConcrete of multiSeeds){
        const cellSets=singletonCellSets(occupied,multiConcrete);
        for(const cells of cellSets){
          const modes=useBonus?['greedy','target','spread']:['number'];
          for(const mode of modes){
            const concrete=assignSingletons(multiConcrete,cells,mode);
            if(!concrete) continue;
            const evc=evaluateConcrete(concrete);
            if(!bestLocal || compareEvaluationObjects(evc,bestLocal)>0) bestLocal=evc;
          }
          if(intensive && useBonus){
            const concrete=assignSingletons(multiConcrete,cells,'random');
            if(concrete){ const evc=evaluateConcrete(concrete); if(!bestLocal || compareEvaluationObjects(evc,bestLocal)>0) bestLocal=evc; }
          }
        }
      }
      if(!bestLocal) return evaluateConcrete([]);
      const closeToBest = best.totalScore<0 || bestLocal.complete!==best.complete || bestLocal.totalScore>=best.totalScore-Math.max(1,Math.abs(best.totalScore)*0.015);
      if(useBonus && (intensive || closeToBest)) bestLocal=improveConcreteAssignments(bestLocal.placements,intensive?28:8);
      if(cacheKey){
        if(singletonCompletionCache.size>=2000) singletonCompletionCache.delete(singletonCompletionCache.keys().next().value);
        singletonCompletionCache.set(cacheKey,bestLocal);
      }
      return bestLocal;
    }
    function evaluateComplete(placements){
      if(geometryMode && singletonCount>0 && placements.length===fullCoreItemCount) return completeGeometryWithSingletons(placements,false);
      if(geometryMode && placements.length && placements.every(p=>p.geometryGroupIndex!==null && p.geometryGroupIndex!==undefined)) return evaluateGeometry(placements);
      return evaluateConcrete(placements);
    }
    function currentCandidate(baseScore,bonusScore,area,itemCount,adjacencyCount,manualVector,defaultVector,placements,occupied,bonusEvents,priorityLinks){
      return {
        complete:itemCount===totalItems,
        baseScore,bonusScore,totalScore:baseScore+bonusScore,area,itemCount,adjacencyCount,
        manualPriorityVector:manualVector.slice(),defaultPriorityVector:defaultVector.slice(),
        placements:placements.slice(),occupied,bonusEvents:bonusEvents.slice(),priorityLinks:priorityLinks.slice()
      };
    }
    function reportProgress(force=false,extra={}){
      const now=performance.now();
      if(!force && now-lastProgress<250) return;
      lastProgress=now;
      self.postMessage({
        type:'progress',stage:currentStage,nodes,elapsed:Math.round(now-started),
        bestComplete:best.complete,bestArea:best.area,bestBase:best.baseScore,bestBonus:best.bonusScore,
        bestTotal:best.totalScore,bestAdjacency:best.adjacencyCount,bestItems:best.itemCount,totalArea,totalItems,...extra
      });
    }
    function serializeBest(){
      return {
        ...best,
        occupied:best.occupied.toString(),
        placements:best.placements.map(p=>({...p,mask:p.mask.toString(),neighborMask:p.neighborMask.toString()}))
      };
    }
    function hitBudget(deadline,nodeCap){
      if(nodes>=nodeCap || performance.now()>=deadline) return true;
      return false;
    }

    function freeComponents(occupied){
      let remaining = activeMask & ~occupied;
      const out=[];
      while(remaining){
        let seed=-1;
        for(let i=0;i<W*H;i++) if((remaining&(1n<<BigInt(i)))!==0n){ seed=i; break; }
        if(seed<0) break;
        let comp=0n, frontier=1n<<BigInt(seed);
        remaining &= ~frontier;
        while(frontier){
          comp |= frontier;
          let next=0n;
          for(let i=0;i<W*H;i++) if((frontier&(1n<<BigInt(i)))!==0n){
            const r=Math.floor(i/W), c=i%W;
            if(r>0) next|=bit(r-1,c);
            if(r+1<H) next|=bit(r+1,c);
            if(c>0) next|=bit(r,c-1);
            if(c+1<W) next|=bit(r,c+1);
          }
          next &= remaining;
          remaining &= ~next;
          frontier=next;
        }
        let size=0;
        for(let i=0;i<W*H;i++) if((comp&(1n<<BigInt(i)))!==0n) size++;
        out.push({mask:comp,size});
      }
      return out;
    }

    // 完整装入阶段的必要条件剪枝：每个剩余物品必须至少有一个合法位置；无剩余空格时，各连通空区面积必须能由剩余物品面积组合出来。
    function fullPackingPrune(occupied,rem,lastIdx,remArea,deferredSingles=0){
      const freeCount=activeCells-countBits(occupied & activeMask);
      if(freeCount<remArea+deferredSingles) return false;
      const comps=freeComponents(occupied);
      const noSlack = deferredSingles===0 && freeCount===remArea;
      const forced=Array(comps.length).fill(0);
      const remainingCopies=[];
      for(let gi=0;gi<groups.length;gi++){
        const cnt=rem[gi];
        if(cnt<=0) continue;
        const g=groups[gi];
        const compSet=new Set();
        let feasibleCount=0;
        for(let pi=lastIdx[gi]+1;pi<g.templates.length;pi++){
          const p=g.templates[pi];
          if((p.mask&occupied)!==0n) continue;
          feasibleCount++;
          for(let ci=0;ci<comps.length;ci++) if((p.mask & ~comps[ci].mask)===0n){ compSet.add(ci); break; }
        }
        if(feasibleCount<cnt || compSet.size===0) return false;
        if(compSet.size===1) forced[[...compSet][0]] += g.area*cnt;
        for(let k=0;k<cnt;k++) remainingCopies.push({area:g.area,compSet});
      }
      for(let ci=0;ci<comps.length;ci++) if(forced[ci]>comps[ci].size) return false;
      if(noSlack){
        for(let ci=0;ci<comps.length;ci++){
          let bits=1n;
          for(const cp of remainingCopies){
            if(cp.compSet.has(ci)) bits |= bits << BigInt(cp.area);
          }
          if((bits & (1n<<BigInt(comps[ci].size)))===0n) return false;
        }
      }
      return true;
    }
    function countBits(m){
      let n=0;
      while(m){ m &= m-1n; n++; }
      return n;
    }

    function selectGroup(rem,lastIdx,occupied){
      let bestSel=null;
      for(let gi=0;gi<groups.length;gi++){
        if(rem[gi]<=0) continue;
        const g=groups[gi];
        const feasible=[];
        for(let pi=lastIdx[gi]+1;pi<g.templates.length;pi++) if((g.templates[pi].mask&occupied)===0n) feasible.push(pi);
        if(feasible.length<rem[gi]) return {dead:true};
        const item=geometryMode ? g.guideItem : g.items[g.items.length-rem[gi]];
        const priority=ownSearchPriority(item);
        const ratio=feasible.length/rem[gi];
        if(!bestSel || ratio<bestSel.ratio || (ratio===bestSel.ratio && feasible.length<bestSel.feasible.length) || (ratio===bestSel.ratio && feasible.length===bestSel.feasible.length && priority>bestSel.priority) || (ratio===bestSel.ratio && feasible.length===bestSel.feasible.length && priority===bestSel.priority && g.area>bestSel.group.area) || (ratio===bestSel.ratio && feasible.length===bestSel.feasible.length && priority===bestSel.priority && g.area===bestSel.group.area && g.canonicalKey<bestSel.group.canonicalKey)){
          bestSel={dead:false,gi,group:g,feasible,ratio,priority,item};
        }
      }
      return bestSel;
    }
    function candidatePackingScore(template,occupied,placed,rem,lastIdx,selectedGi){
      let adjacent=0;
      for(const old of placed) if((template.neighborMask&old.mask)!==0n) adjacent++;
      let future=0;
      const nextOcc=occupied|template.mask;
      for(let gi=0;gi<groups.length;gi++){
        let need=rem[gi]-(gi===selectedGi?1:0);
        if(need<=0) continue;
        const start=gi===selectedGi?template.placementIndex+1:lastIdx[gi]+1;
        let count=0;
        for(let pi=start;pi<groups[gi].templates.length;pi++) if((groups[gi].templates[pi].mask&nextOcc)===0n) count++;
        future += Math.min(count,need*8);
      }
      const opp=singletonOpportunityProxy(nextOcc,placed.concat(template));
      return future*100 + Math.max(0,opp)*0.5 + adjacent*5;
    }

    let fullPackingAttempted = skippedCount===0 && totalArea<=activeCells;
    let fullPackingFound = false;
    let fullSearchCutoff = false;
    let optimizationCutoff = false;
    let fallbackCutoff = false;
    let fullSeed = null;

    function findFullPacking(deadline,nodeCap){
      currentStage='阶段1：优先寻找全部物品可行摆法';
      reportProgress(true,{fullPackingFound:false});
      const rem=groups.map(g=>g.items.length);
      const lastIdx=groups.map(()=>-1);
      const placed=[];
      const memo=new Set();
      const memoCap=180000;
      function rec(occupied,remArea,depth){
        nodes++;
        if((nodes&255)===0) reportProgress(false,{fullPackingFound:false});
        if(hitBudget(deadline,nodeCap)){ fullSearchCutoff=true; return false; }
        if(depth===fullCoreItemCount){
          const evc=completeGeometryWithSingletons(placed,false);
          if(evc.complete){ fullSeed=placed.slice(); accept(evc); return true; }
          return false;
        }
        if(!fullPackingPrune(occupied,rem,lastIdx,remArea,singletonCount)) return false;
        const key=occupied.toString(36)+'|'+rem.join(',')+'|'+lastIdx.join(',');
        if(memo.has(key)) return false;
        const sel=selectGroup(rem,lastIdx,occupied);
        if(!sel || sel.dead){ if(memo.size<memoCap) memo.add(key); return false; }
        const {gi,group,item}=sel;
        const scored=sel.feasible.map(pi=>({pi,score:candidatePackingScore(group.templates[pi],occupied,placed,rem,lastIdx,gi)}));
        scored.sort((a,b)=>b.score-a.score || a.pi-b.pi);
        const oldLast=lastIdx[gi];
        rem[gi]--;
        for(const x of scored){
          const template=group.templates[x.pi];
          lastIdx[gi]=x.pi;
          const p=instantiate(template,item,group);
          placed.push(p);
          if(rec(occupied|p.mask,remArea-group.area,depth+1)) return true;
          placed.pop();
          if(fullSearchCutoff) break;
        }
        rem[gi]++;
        lastIdx[gi]=oldLast;
        if(!fullSearchCutoff && memo.size<memoCap) memo.add(key);
        return false;
      }
      return rec(0n,fullCoreArea,0);
    }

    function localImprove(seed,deadline){
      currentStage='阶段2：单格感知的完整布局局部改进';
      let current=seed.slice();
      let curEval=completeGeometryWithSingletons(current,true);
      accept(curEval);
      let changed=true, passes=0;
      while(changed && performance.now()<deadline && nodes<nodeLimit && passes<3){
        changed=false; passes++;
        for(let i=0;i<current.length;i++){
          if(performance.now()>=deadline || nodes>=nodeLimit) break;
          const gi=current[i].geometryGroupIndex;
          const g=(gi!==null && gi!==undefined)?fullGroups[gi]:null;
          if(!g || g.area===1) continue;
          let occupiedOthers=0n;
          for(let j=0;j<current.length;j++) if(j!==i) occupiedOthers|=current[j].mask;
          let bestMove=null, bestMoveEval=curEval;
          for(const template of g.templates){
            nodes++;
            if((template.mask&occupiedOthers)!==0n) continue;
            const candidate=current.slice();
            candidate[i]=instantiate(template,g.guideItem,g);
            const evc=completeGeometryWithSingletons(candidate,false);
            if(compareEvaluations(evc,bestMoveEval)>0){ bestMoveEval=evc; bestMove=candidate[i]; }
          }
          if(bestMove){ current[i]=bestMove; curEval=bestMoveEval; accept(curEval); changed=true; }
          reportProgress(false,{fullPackingFound:true});
        }
      }
      return current;
    }
    function compareEvaluations(a,b){ return compareEvaluationObjects(a,b); }

    function multiStartFullPackings(deadline,nodeCap){
      currentStage='阶段2：多起点生成不同的多格布局';
      let restart=0;
      while(performance.now()<deadline && nodes<nodeCap){
        restart++;
        const rem=groups.map(g=>g.items.length);
        const lastIdx=groups.map(()=>-1);
        const placed=[];
        const localNodeEnd=Math.min(nodeCap,nodes+Math.max(800,fullCoreItemCount*350));
        function rec(occupied,remArea,depth){
          nodes++;
          if(nodes>=localNodeEnd || performance.now()>=deadline) return false;
          if(depth===fullCoreItemCount){
            const evc=completeGeometryWithSingletons(placed,false);
            accept(evc);
            return evc.complete;
          }
          if(!fullPackingPrune(occupied,rem,lastIdx,remArea,singletonCount)) return false;
          const sel=selectGroup(rem,lastIdx,occupied);
          if(!sel || sel.dead) return false;
          const {gi,group,item}=sel;
          const scored=[];
          for(const pi of sel.feasible){
            const p=instantiate(group.templates[pi],item,group);
            const bg=useBonus?adjacencyGainFor(p,placed):{bonus:0};
            const nextOcc=occupied|p.mask;
            const depthRatio=fullCoreItemCount?depth/fullCoreItemCount:1;
            const opp=depthRatio>0.25?singletonOpportunityProxy(nextOcc,placed.concat(p)):0;
            const compact=placed.reduce((n,old)=>n+(areAdjacent(p,old)?1:0),0);
            const baseScore=bg.bonus+Math.max(0,opp)*(0.15+0.55*depthRatio)+compact*0.01;
            scored.push({pi,p,score:baseScore*(0.92+rand()*0.20)+rand()*Math.max(1,Math.abs(baseScore)*0.03)});
          }
          scored.sort((a,b)=>b.score-a.score || a.pi-b.pi);
          const oldLast=lastIdx[gi]; rem[gi]--;
          const branchLimit=Math.min(scored.length,Math.max(3,Math.ceil(7-depth*0.35)));
          for(let si=0;si<branchLimit;si++){
            const x=scored[si]; lastIdx[gi]=x.pi; placed.push(x.p);
            if(rec(occupied|x.p.mask,remArea-group.area,depth+1)){ placed.pop(); rem[gi]++; lastIdx[gi]=oldLast; return true; }
            placed.pop();
          }
          rem[gi]++; lastIdx[gi]=oldLast; return false;
        }
        rec(0n,fullCoreArea,0);
        reportProgress(false,{fullPackingFound:best.complete,restarts:restart});
      }
    }

    function optimizeFullPackings(deadline,nodeCap){
      currentStage='阶段2：按实际总属性与邻接顺序优化完整方案';
      const rem=groups.map(g=>g.items.length);
      const lastIdx=groups.map(()=>-1);
      const placed=[], bonusEvents=[], priorityLinks=[];
      function rec(occupied,baseScore,bonusScore,manualVector,defaultVector,remArea,depth){
        nodes++;
        if((nodes&255)===0) reportProgress(false,{fullPackingFound:true});
        if(hitBudget(deadline,nodeCap)){ optimizationCutoff=true; return; }
        if(depth===fullCoreItemCount){
          accept(completeGeometryWithSingletons(placed,false));
          return;
        }
        if(!fullPackingPrune(occupied,rem,lastIdx,remArea,singletonCount)) return;
        const sel=selectGroup(rem,lastIdx,occupied);
        if(!sel || sel.dead) return;
        const {gi,group,item}=sel;
        const scored=[];
        for(const pi of sel.feasible){
          const p=instantiate(group.templates[pi],item,group);
          const pg=priorityGainFor(p,placed);
          const bg=useBonus?adjacencyGainFor(p,placed):{bonus:0,events:[]};
          const compact=placed.reduce((s,old)=>s+(areAdjacent(p,old)?1:0),0);
          const nextOcc=occupied|p.mask;
          const depthRatio=fullCoreItemCount?depth/fullCoreItemCount:1;
          const singletonOpp=depthRatio>0.20?singletonOpportunityProxy(nextOcc,placed.concat(p)):0;
          scored.push({pi,p,pg,bg,compact,singletonOpp,branchTotal:bg.bonus+Math.max(0,singletonOpp)*(0.20+0.70*depthRatio)});
        }
        scored.sort((a,b)=>{
          if(Math.abs(a.branchTotal-b.branchTotal)>EPS) return b.branchTotal-a.branchTotal;
          const mc=compareVectors(b.pg.manualVector,a.pg.manualVector); if(mc!==0) return mc;
          const dc=compareVectors(b.pg.defaultVector,a.pg.defaultVector); if(dc!==0) return dc;
          if(a.compact!==b.compact) return b.compact-a.compact;
          return ownSearchPriority(b.p)-ownSearchPriority(a.p) || a.pi-b.pi;
        });
        const oldLast=lastIdx[gi];
        rem[gi]--;
        for(const x of scored){
          lastIdx[gi]=x.pi;
          placed.push(x.p); bonusEvents.push(...x.bg.events); priorityLinks.push(...x.pg.links);
          rec(occupied|x.p.mask,baseScore+x.p.value,bonusScore+x.bg.bonus,addVectors(manualVector,x.pg.manualVector),addVectors(defaultVector,x.pg.defaultVector),remArea-group.area,depth+1);
          for(let k=0;k<x.pg.links.length;k++) priorityLinks.pop();
          for(let k=0;k<x.bg.events.length;k++) bonusEvents.pop();
          placed.pop();
          if(optimizationCutoff) break;
        }
        rem[gi]++;
        lastIdx[gi]=oldLast;
      }
      rec(0n,0,0,emptyManualVector(),emptyDefaultVector(),fullCoreArea,0);
    }

    function searchBestPartial(deadline,nodeCap){
      currentStage='阶段2：按实际总属性与邻接顺序搜索可行子集';
      const rem=groups.map(g=>g.items.length);
      const lastIdx=groups.map(()=>-1);
      const placed=[], bonusEvents=[], priorityLinks=[];
      const initialRemArea=searchableArea, initialRemBase=searchableBase;
      function rec(occupied,baseScore,bonusScore,area,itemCount,adjacencyCount,manualVector,defaultVector,remArea,remBase){
        nodes++;
        if((nodes&255)===0) reportProgress(false,{fullPackingFound:false});
        if(hitBudget(deadline,nodeCap)){ fallbackCutoff=true; return; }
        accept(currentCandidate(baseScore,bonusScore,area,itemCount,adjacencyCount,manualVector,defaultVector,placed,occupied,bonusEvents,priorityLinks));
        const remainingCount=rem.reduce((sum,n)=>sum+n,0);
        const canStillComplete=itemCount+remainingCount>=totalItems;
        if(best.complete && !canStillComplete) return;
        // 仅在本分支已不可能完整装入时，才使用实际总属性的安全上界剪枝。
        if(!canStillComplete && !best.complete && baseScore+remBase+globalMaxBonus<best.totalScore-EPS) return;
        let sel=null;
        for(let gi=0;gi<groups.length;gi++){
          if(rem[gi]<=0) continue;
          const g=groups[gi];
          const feasible=[];
          for(let pi=lastIdx[gi]+1;pi<g.templates.length;pi++) if((g.templates[pi].mask&occupied)===0n) feasible.push(pi);
          const item=g.items[g.items.length-rem[gi]];
          const priority=ownSearchPriority(item);
          const ratio=feasible.length/Math.max(1,rem[gi]);
          if(!sel || ratio<sel.ratio || (ratio===sel.ratio && priority>sel.priority) || (ratio===sel.ratio && priority===sel.priority && g.area>sel.group.area) || (ratio===sel.ratio && priority===sel.priority && g.area===sel.group.area && g.canonicalKey<sel.group.canonicalKey)) sel={gi,group:g,feasible,ratio,priority,item};
        }
        if(!sel) return;
        const {gi,group,item}=sel;
        const scored=[];
        for(const pi of sel.feasible){
          const p=instantiate(group.templates[pi],item,group);
          const pg=priorityGainFor(p,placed);
          const bg=useBonus?adjacencyGainFor(p,placed):{bonus:0,events:[]};
          const compact=placed.reduce((s,old)=>s+(areAdjacent(p,old)?1:0),0);
          scored.push({pi,p,pg,bg,compact,totalGain:p.value+bg.bonus});
        }
        scored.sort((a,b)=>{
          if(Math.abs(a.totalGain-b.totalGain)>EPS) return b.totalGain-a.totalGain;
          const mc=compareVectors(b.pg.manualVector,a.pg.manualVector); if(mc!==0) return mc;
          const dc=compareVectors(b.pg.defaultVector,a.pg.defaultVector); if(dc!==0) return dc;
          if(a.compact!==b.compact) return b.compact-a.compact;
          return ownSearchPriority(b.p)-ownSearchPriority(a.p) || a.pi-b.pi;
        });
        const oldLast=lastIdx[gi];
        rem[gi]--;
        for(const x of scored){
          lastIdx[gi]=x.pi;
          placed.push(x.p); bonusEvents.push(...x.bg.events); priorityLinks.push(...x.pg.links);
          rec(occupied|x.p.mask,baseScore+x.p.value,bonusScore+x.bg.bonus,area+x.p.area,itemCount+1,adjacencyCount+x.compact,addVectors(manualVector,x.pg.manualVector),addVectors(defaultVector,x.pg.defaultVector),remArea-group.area,remBase-group.value);
          for(let k=0;k<x.pg.links.length;k++) priorityLinks.pop();
          for(let k=0;k<x.bg.events.length;k++) bonusEvents.pop();
          placed.pop();
          if(fallbackCutoff) break;
        }
        rem[gi]++;
        lastIdx[gi]=oldLast;
        if(fallbackCutoff) return;
        // 对同组相同物品，跳过分支一次性跳过尚未处理的全部副本，避免重复枚举“跳过哪一个副本”。
        const skipCount=rem[gi];
        const skipArea=skipCount*group.area, skipBase=skipCount*group.value;
        rem[gi]=0;
        rec(occupied,baseScore,bonusScore,area,itemCount,adjacencyCount,manualVector,defaultVector,remArea-skipArea,remBase-skipBase);
        rem[gi]=skipCount;
      }
      rec(0n,0,0,0,0,0,emptyManualVector(),emptyDefaultVector(),initialRemArea,initialRemBase);
    }

    if(fullPackingAttempted){
      groups=fullCoreGroups; geometryMode=true;
      const stageDeadline=Math.min(hardDeadline,started+timeLimit*0.30);
      const stageNodeCap=Math.min(nodeLimit,Math.max(1000,Math.floor(nodeLimit*0.30)));
      fullPackingFound=findFullPacking(stageDeadline,stageNodeCap);
      if(fullPackingFound){
        accept(completeGeometryWithSingletons(fullSeed,true));
        self.postMessage({type:'incumbent',stage:`已找到完整摆法；${singletonCount} 件单格物品已延后按真实加成分配，继续多起点优化`,best:serializeBest(),nodes,elapsed:Math.round(performance.now()-started),fullPackingFound:true,totalArea,totalItems});
        const localDeadline=Math.min(hardDeadline,performance.now()+Math.max(350,Math.min(2200,timeLimit*0.10)));
        fullSeed=localImprove(fullSeed,localDeadline);
        const multiDeadline=Math.min(hardDeadline,performance.now()+Math.max(500,Math.min(5000,timeLimit*0.22)));
        if(performance.now()<multiDeadline && nodes<nodeLimit) multiStartFullPackings(multiDeadline,Math.min(nodeLimit,nodes+Math.max(5000,Math.floor(nodeLimit*0.25))));
        if(performance.now()<hardDeadline && nodes<nodeLimit) optimizeFullPackings(hardDeadline,nodeLimit);
      }else if(performance.now()<hardDeadline && nodes<nodeLimit){
        groups=partialGroups; geometryMode=false;
        searchBestPartial(hardDeadline,nodeLimit);
      }
    }else{
      groups=partialGroups; geometryMode=false;
      searchBestPartial(hardDeadline,nodeLimit);
    }

    if(best.complete) fullPackingFound = true;
    const elapsed=Math.round(performance.now()-started);
    const hardCutoff=performance.now()>=hardDeadline || nodes>=nodeLimit;
    const stopped=hardCutoff || fullSearchCutoff || optimizationCutoff || fallbackCutoff;
    currentStage='完成';
    reportProgress(true,{fullPackingFound});
    self.postMessage({type:'done',best:serializeBest(),nodes,elapsed,stopped,fullPackingAttempted,fullPackingFound,fullSearchCutoff,optimizationCutoff,fallbackCutoff,totalArea,totalBase,totalItems,fullGroupCount:fullGroups.length,detailedGroupCount:partialGroups.length,assignmentStrategy:'multi_cell_first_then_singleton_assignment',singletonDeferredCount:singletonCount,assignmentChecks});
  };
}


function createSolverWorker(){
  const source = `(${solverWorkerMain.toString()})();`;
  const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
  const worker = new Worker(url);
  worker._blobUrl = url;
  return worker;
}


