'use strict';
/* МЭР: Живой город. Self-contained simulation, no server, no ads, no external requests.
 * Parameters to tweak: CONFIG, STAFF, INCIDENT_TYPES, BUILDINGS, EVENTS, TRAFFIC_LINES. */
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const lim=(n,a,b)=>Math.max(a,Math.min(b,n));
const fmt=n=>(Math.round(n*10)/10).toFixed(1).replace('.',',');
const CONFIG={secondsPerDay:52,days:12,startCash:13,startMood:69,baseTaxes:4.2,fixedCosts:2.5};
const KEY='ekb_workers_traffic_v1';
const STAFF={utility:{icon:'👷',name:'Ремонтники',vehicle:'🚚',hire:2.2,salary:.55,work:.33},transit:{icon:'🚋',name:'Путейцы',vehicle:'🚐',hire:2.5,salary:.65,work:.42},clean:{icon:'🧹',name:'Коммунальщики',vehicle:'🚛',hire:1.8,salary:.45,work:.27}};
const INCIDENT_TYPES={
 water:{icon:'💧',name:'Прорвало трубу',type:'utility',cost:2,penalty:2.3,emoji:'😡',detail:'Жители остались без воды.'},
 road:{icon:'🚧',name:'Разбитая дорога',type:'utility',cost:2.4,penalty:1.7,emoji:'😠',detail:'Пробка растёт с каждым днём.'},
 tram:{icon:'🚋',name:'Сломались пути',type:'transit',cost:2.3,penalty:2.2,emoji:'😠',detail:'Трамваи едут медленно.'},
 trash:{icon:'🗑️',name:'Мусор во дворах',type:'clean',cost:1.4,penalty:1.5,emoji:'😡',detail:'Дворы завалены мусором.'},
 heritage:{icon:'🏛️',name:'Осыпается фасад',type:'utility',cost:2.6,penalty:1.5,emoji:'😠',detail:'Историческое здание разрушается.'},
 park:{icon:'🌳',name:'Заросший сквер',type:'clean',cost:1.5,penalty:1.2,emoji:'😠',detail:'Городской парк требует ухода.'}
};
const BUILDINGS={park:{icon:'🌳',name:'Сквер',cost:3,time:.7,tax:0,upkeep:.3,trust:8,traffic:-.3},shop:{icon:'🏪',name:'Магазин',cost:5,time:1.05,tax:2.2,upkeep:.25,trust:1,traffic:1}};
const PLOTS=[{id:'a',x:75,y:40},{id:'b',x:12,y:79},{id:'c',x:77,y:93}];
const EVENTS=[
 {day:2,id:'road-1',kind:'road',x:47,y:61},
 {day:3,id:'tram-1',kind:'tram',x:33,y:58},
 {day:4,id:'heritage-1',kind:'heritage',x:38,y:43},
 {day:5,id:'trash-2',kind:'trash',x:71,y:90},
 {day:6,id:'water-2',kind:'water',x:64,y:37},
 {day:7,id:'park-1',kind:'park',x:25,y:77},
 {day:8,id:'road-2',kind:'road',x:59,y:73},
 {day:9,id:'tram-2',kind:'tram',x:51,y:75},
 {day:10,id:'trash-3',kind:'trash',x:13,y:86}
];
const TRAFFIC_LINES=[
 {id:'lenina1',path:'M 12 643 L 178 694 L 320 731',pts:[[12,643],[178,694],[320,731]],offset:-1},
 {id:'lenina2',path:'M 320 731 L 466 785 L 565 816',pts:[[320,731],[466,785],[565,816]],offset:1},
 {id:'lenina3',path:'M 565 816 L 641 841',pts:[[565,816],[641,841]],offset:0},
 {id:'malysheva1',path:'M 0 947 L 158 1000 L 302 1053',pts:[[0,947],[158,1000],[302,1053]],offset:-2},
 {id:'malysheva2',path:'M 530 1080 L 658 1121 L 795 1169',pts:[[530,1080],[658,1121],[795,1169]],offset:1},
 {id:'bridge',path:'M 639 496 L 605 579 L 566 658',pts:[[639,496],[605,579],[566,658]],offset:0},
 {id:'eastern',path:'M 582 807 L 580 916 L 543 1019',pts:[[582,807],[580,916],[543,1019]],offset:-1},
 {id:'western',path:'M 245 270 L 158 372 L 89 494',pts:[[245,270],[158,372],[89,494]],offset:-2}
];
function newGame(){return {elapsed:.37,speed:1,cash:CONFIG.startCash,mood:CONFIG.startMood,trafficBase:5,employees:[{id:'u1',type:'utility',job:null},{id:'t1',type:'transit',job:null}],incidents:[{id:'water-1',kind:'water',x:66,y:43,spawn:1,assigned:null},{id:'trash-1',kind:'trash',x:17,y:79,spawn:1,assigned:null}],plots:PLOTS.map(p=>({...p,kind:null,readyAt:null})),finished:false,selectedBuild:null,incidentCount:2,log:[],completed:0,step:0,nextWorker:3,wasLastMood:CONFIG.startMood};}
function load(){try{const raw=localStorage.getItem(KEY);if(!raw)return newGame();const v=JSON.parse(raw);if(v?.version!==1||!Array.isArray(v.employees)||!Array.isArray(v.incidents))return newGame();v.speed=0;v.selectedBuild=null;return v}catch{return newGame()}}
let s=load(),last=performance.now(),savedAt=0,lastHud=0,panel='',panelId='',returnSpeed=1,toastTimer=0,lastTrafficSig='';
function save(){try{localStorage.setItem(KEY,JSON.stringify({...s,version:1,selectedBuild:null}))}catch{}}
const clock=()=>{let h=Math.floor((s.elapsed%1)*24),m=Math.floor((((s.elapsed%1)*24)%1)*60);return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`};
const day=()=>Math.floor(s.elapsed)+1;
function workerSalary(){return s.employees.reduce((n,e)=>n+STAFF[e.type].salary,0)}
function taxes(){return CONFIG.baseTaxes+s.plots.reduce((n,p)=>n+(p.kind&&p.readyAt===null?BUILDINGS[p.kind].tax:0),0)}
function costs(){return CONFIG.fixedCosts+workerSalary()+s.plots.reduce((n,p)=>n+(p.kind&&p.readyAt===null?BUILDINGS[p.kind].upkeep:0),0)}
function net(){return taxes()-costs()}
function idle(type){return s.employees.find(e=>e.type===type&&!e.job)}
function crewCount(type){return s.employees.filter(e=>e.type===type).length}
function busyCount(){return s.employees.filter(e=>e.job).length}
function incidentsOpen(){return s.incidents.filter(i=>!i.resolved)}
function scoreTraffic(){const roadInc=incidentsOpen().filter(i=>i.kind==='road'||i.kind==='tram').length;return lim(Math.round(s.trafficBase+roadInc*.9+(Math.sin((s.elapsed%1)*Math.PI*2)*.8)),1,10)}
function facesFor(){const happy=lim(Math.round(s.mood*.3),0,30);const angry=lim(Math.round((100-s.mood)*.16),0,30-happy);return {happy,neutral:30-happy-angry,angry}}
function log(message){s.log.unshift(`День ${day()}: ${message}`);s.log=s.log.slice(0,18)}
function toast(t){const el=$('#toast');el.textContent=t;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2200)}
function fx(x,y,t){const e=document.createElement('div');e.className='particle';e.textContent=t;e.style.left=x+'%';e.style.top=y+'%';$('#effects').append(e);setTimeout(()=>e.remove(),1300)}
function coinFly(x,y){const world=$('#world').getBoundingClientRect(),cash=$('#cash').getBoundingClientRect(),el=document.createElement('div');el.className='coin-flight';el.textContent='🪙';const startX=world.left+world.width*x/100,startY=world.top+world.height*y/100,dx=cash.left+cash.width/2-startX,dy=cash.top+cash.height/2-startY;el.style.left=startX+'px';el.style.top=startY+'px';document.body.append(el);el.animate([{transform:'translate(-50%,-50%) scale(.7)',opacity:0},{transform:'translate(-50%,-32px) scale(1.25)',opacity:1,offset:.25},{transform:`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) scale(.5)`,opacity:0}],{duration:1050,easing:'ease-in-out'}).onfinish=()=>el.remove()}
function moodFx(x,y,amount){fx(x,y,amount>=0?`😊 +${fmt(amount)}`:`😡 ${fmt(amount)}`);if(amount>0){setTimeout(()=>{const face=$('#faces').getBoundingClientRect(),e=document.createElement('div');e.className='coin-flight';e.textContent='😊';e.style.left=(window.innerWidth>540?(window.innerWidth-540)/2:0)+x/100*$('#world').clientWidth+'px';e.style.top=($('#world').getBoundingClientRect().top+y/100*$('#world').clientHeight)+'px';document.body.append(e);const a=e.getBoundingClientRect(),dx=face.left+face.width/2-a.left,dy=face.top+face.height/2-a.top;e.animate([{transform:'translate(0,0)',opacity:1},{transform:`translate(${dx}px,${dy}px) scale(.5)`,opacity:0}],{duration:850}).onfinish=()=>e.remove()},280)}}
function changeMood(amount,x=45,y=55){s.mood=lim(s.mood+amount,0,100);moodFx(x,y,amount)}
function staffText(type){return `${STAFF[type].icon} ${STAFF[type].name}`}
function mission(){if(s.step===0)return {icon:'💧',title:'Авария водопровода',sub:'Нажми 💧 на карте'};if(s.step===1)return {icon:'🚚',title:'Бригада едет на ремонт',sub:'Посмотри, как машина движется'};if(s.step===2)return {icon:'🧹',title:'Грязные дворы',sub:'Найми 🧹 и убери мусор'};if(s.step===3)return {icon:'🏪',title:'Городу нужны доходы',sub:'Построй магазин на жёлтом участке'};return {icon:incidentsOpen().length?'🚨':'😊',title:incidentsOpen().length?`Проблем в городе: ${incidentsOpen().length}`:'В городе спокойно!',sub:incidentsOpen().length?'Нажми на значок проблемы':'Развивай город и следи за казной'}}
function renderFaces(){const v=facesFor(),previous=$('#faces').dataset.signature||'',signature=`${v.happy}/${v.neutral}/${v.angry}`;if(signature===previous)return;const old=[...$('#faces').children].map(e=>e.textContent);const arr=[...Array(v.happy).fill('😊'),...Array(v.neutral).fill('😐'),...Array(v.angry).fill('😡')];$('#faces').replaceChildren(...arr.map((e,i)=>{const el=document.createElement('span');el.className='face'+(old[i]&&old[i]!==e?' changed':'');el.textContent=e;return el}));$('#faces').dataset.signature=signature;$('#moodCaption').textContent=v.angry>=12?'Горожане злятся':v.happy>=18?'Большинство довольны':'Жители сомневаются';$('#moodTotal').textContent=`😊 ${v.happy}`}
function renderHud(){const m=mission();$('#cash').textContent=fmt(s.cash);$('#income').textContent=`${net()>=0?'+':''}${fmt(net())}/день`;$('#income').style.color=net()<0?'#d44837':'#17845b';$('#trafficNum').textContent=scoreTraffic();$('#trafficBar').style.width=(scoreTraffic()*10)+'%';$('#trafficBar').style.background=scoreTraffic()<=3?'#1eaa70':scoreTraffic()<=6?'#f0ae32':'#dc4a3e';$('#teamCount').textContent=s.employees.length;$('#teamBusy').textContent=`${s.employees.length-busyCount()} свободны`;$('#dayText').textContent=`${Math.min(day(),CONFIG.days)} / ${CONFIG.days}`;$('#timeText').textContent=clock();$('#taskIcon').textContent=m.icon;$('#taskTitle').textContent=m.title;$('#taskSub').textContent=m.sub;$('#openProblems').textContent=incidentsOpen().length;$('.side-tools [data-open="incidents"]').classList.toggle('alert',incidentsOpen().some(i=>day()-i.spawn>=2));$$('.speed').forEach(b=>b.classList.toggle('active',+b.dataset.speed===s.speed));$('#speedLegend').textContent=s.speed?'ГОРОД В ДВИЖЕНИИ · ×'+s.speed:'ПАУЗА';$('#maparea').classList.toggle('paused',s.speed===0);$('#mapHint').textContent=s.selectedBuild?`Нажми на жёлтый участок · ${BUILDINGS[s.selectedBuild].cost} млрд`:(s.speed?'Нажми на проблему → отправь бригаду':'Игра на паузе · нажми ▶');$$('[data-build]').forEach(b=>b.classList.toggle('selected',b.dataset.build===s.selectedBuild));renderFaces()}
function renderTraffic(){const traffic=scoreTraffic(),signature=`${traffic}:${incidentsOpen().some(i=>i.kind==='road')}:${incidentsOpen().some(i=>i.kind==='tram')}`;if(signature===lastTrafficSig)return;lastTrafficSig=signature;const el=$('#trafficSegments');el.innerHTML=TRAFFIC_LINES.map(l=>{const roadTrouble=incidentsOpen().some(i=>i.kind==='road')&&(l.id==='lenina2'||l.id==='lenina3');const tramTrouble=incidentsOpen().some(i=>i.kind==='tram')&&l.id.startsWith('lenina');const level=lim(traffic+l.offset+(roadTrouble?2:0)+(tramTrouble?1:0),1,10);const color=level<=3?'#28bd77':level<=6?'#e6c047':level<=8?'#f28832':'#ea3e38';return `<path class="traffic-segment underlay" d="${l.path}" stroke-width="14"/><path class="traffic-segment" d="${l.path}" stroke="${color}" stroke-width="7" opacity=".92"/><path class="traffic-highlight" d="${l.path}" data-road="${l.id}"/>`}).join('')}
function incidentCost(i){return INCIDENT_TYPES[i.kind].cost+Math.max(0,day()-i.spawn)*.45}
function renderMap(){const layer=$('#mapObjects');layer.replaceChildren();for(const i of incidentsOpen()){const t=INCIDENT_TYPES[i.kind],b=document.createElement('button');b.className='incident'+(i.assigned?' onjob':'')+(day()-i.spawn>=2&&!i.assigned?' critical':'')+(s.step===0&&i.kind==='water'?' guide':'');b.style.setProperty('--x',i.x+'%');b.style.setProperty('--y',i.y+'%');b.style.setProperty('--color',i.assigned?'#ecc45d':'#d85143');b.dataset.incident=i.id;b.dataset.age=i.assigned?'':`!`;b.textContent=t.icon;b.setAttribute('aria-label',t.name);layer.append(b)}for(const p of s.plots){const b=document.createElement('button');b.className='plot'+(p.kind?(p.readyAt===null?' built':' construct'):'')+(s.selectedBuild&&!p.kind?' selected':'');b.style.setProperty('--x',p.x+'%');b.style.setProperty('--y',p.y+'%');b.textContent=p.kind?(p.readyAt===null?BUILDINGS[p.kind].icon:'🏗️'):'＋';b.dataset.plot=p.id;b.setAttribute('aria-label',p.kind?BUILDINGS[p.kind].name:'Свободный участок');layer.append(b)}renderTraffic()}
function renderCrew(){const layer=$('#crewLayer');const ids=new Set(s.employees.map(e=>e.id));for(const child of [...layer.children])if(!ids.has(child.dataset.worker))child.remove();for(const w of s.employees){let el=layer.querySelector(`[data-worker="${w.id}"]`);if(!el){el=document.createElement('button');el.dataset.worker=w.id;el.className='crew-unit';el.innerHTML=`${STAFF[w.type].vehicle}<i><b></b></i>`;layer.append(el)}el.classList.toggle('busy',!!w.job);el.title=w.job?`${STAFF[w.type].name}: работает`:`${STAFF[w.type].name}: свободна`;const {x,y,percent}=workerPos(w);el.style.left=x+'%';el.style.top=y+'%';el.querySelector('i b').style.width=(100*percent)+'%'}}
// Crews drive along a handful of approximate roads (waypoints), not through a direct straight line.
// A routed street graph / A* is the next technical step for geographic accuracy.
const DEPOTS={utility:[35,54],transit:[27,58],clean:[34,82]};
function crewPath(w,i){const base=DEPOTS[w.type];let via=[];
 if(w.type==='utility'){
   if(i.kind==='water')via=[[41,58],[53,64],[67,68],[78,53]];
   else if(i.kind==='road')via=[[41,60]];
   else via=[[31,51]];
 }else if(w.type==='transit')via=[[30,60]];
 else if(i.x<25)via=[[28,82],[21,80]];
 else via=[[40,82],[56,85]];
 return [base,...via,[i.x,i.y]];
}
function pointOnPath(path,ratio){let total=0;const lengths=[];for(let n=1;n<path.length;n++){const dx=path[n][0]-path[n-1][0],dy=path[n][1]-path[n-1][1];const d=Math.hypot(dx,dy);lengths.push(d);total+=d}let left=lim(ratio,0,1)*total;for(let n=1;n<path.length;n++){const d=lengths[n-1];if(left<=d||n===path.length-1){const t=d?left/d:1;return [path[n-1][0]+(path[n][0]-path[n-1][0])*t,path[n-1][1]+(path[n][1]-path[n-1][1])*t]}left-=d}return path.at(-1)}
function workerPos(w){const same=s.employees.filter(v=>v.type===w.type&&!v.job),order=same.findIndex(v=>v.id===w.id);const base=DEPOTS[w.type];if(!w.job)return {x:base[0]+Math.max(0,order)*4,y:base[1],percent:1};const i=s.incidents.find(k=>k.id===w.job.id);if(!i)return {x:base[0],y:base[1],percent:1};const t=s.elapsed,wj=w.job,path=crewPath(w,i);let q,xy;if(t<wj.arrive){q=lim((t-wj.depart)/(wj.arrive-wj.depart),0,1);xy=pointOnPath(path,smooth(q))}else if(t<wj.finish){xy=[i.x,i.y];q=lim((t-wj.arrive)/(wj.finish-wj.arrive),0,1)}else{q=lim((t-wj.finish)/(wj.back-wj.finish),0,1);xy=pointOnPath(path,1-smooth(q))}return {x:xy[0],y:xy[1],percent:q}}
const smooth=x=>x*x*(3-2*x);
function renderAll(){renderHud();renderMap();renderCrew()}
function openSheet(name,id=''){returnSpeed=s.speed;if(s.speed)s.speed=0;panel=name;panelId=id;$('#shade').classList.remove('hidden');$('#sheet').classList.remove('hidden');updateSheet();renderHud()}
function closeSheet(resume=true){$('#shade').classList.add('hidden');$('#sheet').classList.add('hidden');panel='';panelId='';if(resume&&!s.finished)s.speed=returnSpeed;renderHud()}
const disabled=b=>b?' disabled':'';
function updateSheet(){if(!panel)return;const e=$('#sheetContent');
 if(panel==='incident'){
   const i=s.incidents.find(i=>i.id===panelId);if(!i||i.resolved){closeSheet();return}const kind=INCIDENT_TYPES[i.kind],staff=STAFF[kind.type],free=idle(kind.type),cost=incidentCost(i),age=Math.max(0,day()-i.spawn);
   e.innerHTML=`<div class="eyebrow">ПРОБЛЕМА НА КАРТЕ</div><h2>${kind.icon} ${kind.name}</h2><p>${kind.detail} ${age?'Ремонт подорожал за время ожидания.':''}</p><div class="triple"><div class="mini-card"><b>🪙 ${fmt(cost)}</b>млрд</div><div class="mini-card"><b>${staff.vehicle}</b>${staff.name}</div><div class="mini-card"><b>${i.assigned?'🚧':'😡'}</b>${i.assigned?'В работе':'Жители ждут'}</div></div>${i.assigned?`<div class="notice">🚚 Бригада уже в пути или на ремонте. Работа завершится автоматически.</div>`:`<button class="primary" data-action="dispatch" data-id="${i.id}"${disabled(!free||s.cash<cost)}>${free?`${staff.vehicle} Отправить · ${fmt(cost)} млрд`:`${staff.icon} Нет свободных бригад`}</button>`}${!i.assigned&&!free?`<button class="secondary" data-action="hire" data-type="${kind.type}"${disabled(s.cash<staff.hire)}>＋ Нанять ${staff.icon} · ${fmt(staff.hire)} млрд</button>`:''}<p>После ремонта значок аварии исчезнет, а жители станут довольнее.</p>`;
 }else if(panel==='staff'){
  e.innerHTML=`<div class="eyebrow">ГОРОДСКИЕ СЛУЖБЫ</div><h2>👷 Бригады · ${busyCount()} заняты</h2><p>Нанимай новые бригады, чтобы устранять несколько аварий одновременно. Зарплата списывается каждый игровой день.</p>${Object.entries(STAFF).map(([id,m])=>{let c=crewCount(id),free=s.employees.filter(w=>w.type===id&&!w.job).length;return `<div class="compact"><span class="crewicon">${m.vehicle}</span><div style="flex:1"><strong>${m.name} · ${free}/${c} свободны</strong><small>Зарплата ${fmt(m.salary)} млрд/день за бригаду</small></div><button data-action="hire" data-type="${id}"${disabled(s.cash<m.hire||c>=4)}>＋ ${fmt(m.hire)}</button></div>`}).join('')}<div class="notice">🪙 Весь штат: −${fmt(workerSalary())} млрд/день. Не нанимай слишком много — зарплату придётся платить даже без аварий.</div>`;
 }else if(panel==='budget'){
  e.innerHTML=`<div class="eyebrow">ДЕНЬГИ ГОРОДА</div><h2>🪙 Казна ${fmt(s.cash)} млрд</h2><div class="triple"><div class="mini-card"><b style="color:#198d64">+${fmt(taxes())}</b>налоги/день</div><div class="mini-card"><b style="color:#b64035">−${fmt(costs())}</b>расходы/день</div><div class="mini-card"><b>${net()>=0?'+':''}${fmt(net())}</b>чистыми</div></div><div class="compact"><div><strong>👷 Зарплаты бригад</strong><small>${s.employees.length} сотрудников</small></div><strong>−${fmt(workerSalary())}</strong></div><div class="compact"><div><strong>🏛️ Содержание города</strong><small>Улицы, школы, услуги</small></div><strong>−${fmt(CONFIG.fixedCosts)}</strong></div><div class="compact"><div><strong>🏪 Новые здания</strong><small>Добавляют налоги после строительства</small></div><strong>+${fmt(taxes()-CONFIG.baseTaxes)}</strong></div><div class="notice">💡 Построй магазин на жёлтом участке, чтобы получать +${fmt(BUILDINGS.shop.tax-BUILDINGS.shop.upkeep)} млрд чистыми каждый день.</div>`;
 }else if(panel==='moods'){
  let m=facesFor();e.innerHTML=`<div class="eyebrow">НАСТРОЕНИЕ ГОРОЖАН</div><h2>😊 ${m.happy} / 😐 ${m.neutral} / 😡 ${m.angry}</h2><p>Каждый из 30 смайликов обозначает часть жителей. При авариях красных становится больше, после ремонта и новых скверов — меньше.</p><div class="notice">⚠️ Для победы на выборах нужно сохранить хотя бы половину жителей довольными и не уйти в долги.</div>`;
 }else if(panel==='traffic'){
  const rating=scoreTraffic();e.innerHTML=`<div class="eyebrow">ДОРОГИ НА КАРТЕ</div><h2>🚦 Пробки ${rating} / 10</h2><p>Цветные линии показывают загруженность улиц: 🟢 свободно · 🟡 медленно · 🔴 затор.</p><div class="progress"><i style="width:${rating*10}%;background:${rating>=7?'#df503c':'#dbb644'}"></i></div><div class="notice">🚧 Дороги и трамвайные пути ухудшают движение, пока они неисправны. После ремонта красные участки могут снова стать зелёными.</div>`;
 }else if(panel==='incidents'){
  const inc=incidentsOpen();e.innerHTML=`<div class="eyebrow">НЕОТЛОЖНЫЕ ДЕЛА</div><h2>🚨 Проблемы · ${inc.length}</h2>${inc.length?inc.map(i=>{const m=INCIDENT_TYPES[i.kind];return `<div class="compact"><span class="crewicon">${m.icon}</span><div style="flex:1"><strong>${m.name}</strong><small>${i.assigned?'Бригада работает':`Ремонт ${fmt(incidentCost(i))} млрд`}</small></div><button data-action="showincident" data-id="${i.id}">Открыть</button></div>`}).join(''):'<p>Все текущие проблемы решены. Город живёт спокойно.</p>'}`;
 }else if(panel==='plot'){
  const plot=s.plots.find(p=>p.id===panelId);if(!plot)return;
  if(plot.kind){const b=BUILDINGS[plot.kind];e.innerHTML=`<div class="eyebrow">ОБЪЕКТ НА КАРТЕ</div><h2>${b.icon} ${b.name}</h2><p>${plot.readyAt===null?'Объект работает.':'Идёт строительство — скоро появится готовое здание.'}</p><div class="notice">${plot.readyAt===null?`Налоги +${fmt(b.tax)} · обслуживание −${fmt(b.upkeep)} млрд/день`:`Осталось ${Math.ceil((plot.readyAt-s.elapsed)*24)} игровых часов`}</div>`}
  else e.innerHTML=`<div class="eyebrow">СВОБОДНЫЙ УЧАСТОК</div><h2>🏗️ Что построить?</h2>${Object.entries(BUILDINGS).map(([k,b])=>`<button class="secondary" data-action="buildnow" data-plot="${plot.id}" data-kind="${k}"${disabled(s.cash<b.cost)}>${b.icon} ${b.name} · ${fmt(b.cost)} млрд</button>`).join('')}<p>Сквер порадует жителей. Магазин пополнит казну, но увеличит трафик.</p>`;
 }else if(panel==='help'){
  e.innerHTML=`<div class="eyebrow">КАК ИГРАТЬ</div><h2>Мэр · Екатеринбург</h2><p><b>1.</b> Нажимай на аварии на карте. <b>2.</b> Отправляй свободных работников. <b>3.</b> Нанимай бригады, если их не хватает. <b>4.</b> Строй магазины, чтобы оплачивать зарплаты.</p><div class="notice">⏯️ День длится ${CONFIG.secondsPerDay} секунд на ×1. Игра идёт только при открытой вкладке. После обновления страницы сохраняется и загружается на паузе.</div><button class="secondary" data-action="reset">↻ Начать заново</button>`;
 }}
function hire(type){const m=STAFF[type];if(!m||s.cash<m.hire||crewCount(type)>=4){toast('Не хватает денег или достигнут лимит');return} s.cash-=m.hire;s.employees.push({id:'w'+s.nextWorker++,type,job:null});log(`Нанята бригада: ${m.name}`);fx(36,59,`${m.icon} +1`);if(type==='clean'&&s.step===2)s.step=2;renderAll();updateSheet();save();toast(`${m.icon} Бригада нанята · зарплата ${fmt(m.salary)} млрд/день`)}
function dispatch(id){const i=s.incidents.find(x=>x.id===id);if(!i||i.resolved||i.assigned)return;const t=INCIDENT_TYPES[i.kind],w=idle(t.type),cost=incidentCost(i);if(!w){toast('Нужна свободная бригада');return}if(s.cash<cost){toast('Не хватает денег на ремонт');return}s.cash-=cost;const start=s.elapsed;w.job={id:i.id,depart:start,arrive:start+.22,finish:start+.22+STAFF[w.type].work,back:start+.22+STAFF[w.type].work+.17};i.assigned=w.id;log(`Выезд: ${t.name} (−${fmt(cost)} млрд)`);fx(i.x,i.y,'🚧');if(s.step===0){s.step=1;}closeSheet();renderAll();save();toast(`${STAFF[w.type].vehicle} Бригада выехала — смотри на карту!`)}
function build(id,kind){const p=s.plots.find(x=>x.id===id),b=BUILDINGS[kind];if(!p||p.kind||!b)return;if(s.cash<b.cost){toast('Не хватает денег');return}s.cash-=b.cost;p.kind=kind;p.readyAt=s.elapsed+b.time;fx(p.x,p.y,'🚧');log(`Строительство: ${b.name} (−${fmt(b.cost)} млрд)`);s.selectedBuild=null;closeSheet();renderAll();toast('🏗️ Стройка началась!');save()}
function finishRepairs(){let changed=false;for(const w of s.employees){if(!w.job)continue;const job=w.job,inc=s.incidents.find(i=>i.id===job.id);if(inc&&!inc.resolved&&s.elapsed>=job.finish){inc.resolved=true;s.completed++;if(inc.kind==='road'||inc.kind==='tram')s.trafficBase=lim(s.trafficBase-1.25,1,10);changeMood(inc.kind==='water'?5:3.7,inc.x,inc.y);log(`Устранено: ${INCIDENT_TYPES[inc.kind].name}`);toast('✅ Ремонт завершён!');if(s.step===1)s.step=2;else if(s.step===2&&inc.kind==='trash')s.step=3;changed=true}if(s.elapsed>=job.back){w.job=null;changed=true}}for(const p of s.plots){if(p.kind&&p.readyAt!==null&&s.elapsed>=p.readyAt){p.readyAt=null;const b=BUILDINGS[p.kind];changeMood(b.trust,p.x,p.y);s.trafficBase=lim(s.trafficBase+b.traffic,1,10);fx(p.x,p.y,b.icon);log(`Открыт объект: ${b.name}`);toast(`${b.icon} ${b.name} готов!`);if(s.step===3&&p.kind==='shop')s.step=4;changed=true}}if(changed){lastTrafficSig='';renderAll();save()}}
function daily(d){const n=net();s.cash+=n;const active=incidentsOpen();const unhappy=active.reduce((v,i)=>v+INCIDENT_TYPES[i.kind].penalty*(i.assigned?.28:1),0);let moodChange=lim(1.7-unhappy,-6,2);changeMood(moodChange,Math.random()*40+25,Math.random()*15+55);s.trafficBase=lim(s.trafficBase+.24+(active.some(i=>i.kind==='road'||i.kind==='tram')?.43:0),1,10);for(const i of active)if(!i.assigned&&d-i.spawn>1&&d%2===0)fx(i.x,i.y,'😡');
 const e=EVENTS.find(x=>x.day===d);if(e&&active.length<5){s.incidents.push({...e,spawn:d,assigned:null,resolved:false});s.incidentCount++;fx(e.x,e.y,'🚨');log(`Новая проблема: ${INCIDENT_TYPES[e.kind].name}`);toast('⚠️ Новая проблема в городе!')}
 if(n>=0){coinFly(59,78);if(taxes()>CONFIG.baseTaxes)coinFly(17,78)}else fx(38,58,'🪙 −'+fmt(-n));
 log(`Казна: ${n>=0?'+':''}${fmt(n)} млрд за день`);if(s.cash<0){changeMood(-3);toast('⚠️ Казна ушла в минус!')}
 lastTrafficSig='';renderAll();save();if(d>=CONFIG.days)endGame()}
function endGame(){s.finished=true;s.speed=0;save();const win=s.mood>=50&&s.cash>=0&&scoreTraffic()<=9;$('#endIcon').textContent=win?'🏆':'🗳️';$('#endTitle').textContent=win?'Тебя переизбрали!':'Выборы проиграны';$('#endText').textContent=`12 игровых дней завершились. Поддержка ${Math.round(s.mood)}/100, бюджет ${fmt(s.cash)} млрд, отремонтировано объектов ${s.completed}. ${win?'Город справился с проблемами.':'Попробуй иначе распределить бюджет и бригады.'}`;$('#end').classList.remove('hidden');renderHud()}
function advance(dt){const from=Math.floor(s.elapsed);s.elapsed+=dt;finishRepairs();for(let d=from+1;d<=Math.floor(s.elapsed);d++){daily(d);if(s.finished)break}}
function pOnRoute(arr,progress){const n=arr.length-1,z=lim(progress,0,.999999)*n,j=Math.floor(z),v=z-j;return [arr[j][0]+(arr[j+1][0]-arr[j][0])*v,arr[j][1]+(arr[j+1][1])*v]}
function animateActors(){const speedFactor=s.speed?1:0,shift=s.elapsed*24;const routes={tramActor:{pts:[[127,628],[280,684],[428,742],[577,797]],v:.16},carActor1:{pts:[[20,645],[185,696],[338,747],[542,809]],v:.23},carActor2:{pts:[[544,1080],[658,1114],[778,1153]],v:.31}};for(const [id,r] of Object.entries(routes)){const e=$('#'+id),[x,y]=pOnRoute(r.pts,(shift*r.v+(id==='tramActor'?.4:.2))%1);e.style.left=(x/802*100)+'%';e.style.top=(y/1240*100)+'%'}renderCrew()}
function refreshPanels(){if(panel)updateSheet()}
function restart(){s=newGame();$('#end').classList.add('hidden');closeSheet(false);$('#mapscroll').scrollTop=0;lastTrafficSig='';renderAll();save();toast('Новая игра началась')}
function handleClick(event){const btn=event.target.closest('button');if(!btn)return;
 if(btn.dataset.speed!==undefined){if(panel)closeSheet(false);s.speed=Number(btn.dataset.speed);renderHud();save();return}
 if(btn.id==='sheetClose'){closeSheet();return}
 if(btn.dataset.open){openSheet(btn.dataset.open);return}
 if(btn.id==='timeButton'){openSheet('help');return}
 if(btn.id==='taskButton'){const first=s.step===0?s.incidents.find(i=>i.kind==='water'&&!i.resolved):s.step===2?s.incidents.find(i=>i.kind==='trash'&&!i.resolved):incidentsOpen()[0];if(first)openSheet('incident',first.id);else if(s.step===3){s.selectedBuild='shop';renderHud();toast('🏪 Нажми на жёлтый участок')}else openSheet('budget');return}
 if(btn.dataset.incident){openSheet('incident',btn.dataset.incident);return}
 if(btn.dataset.worker){openSheet('staff');return}
 if(btn.dataset.plot){if(s.selectedBuild){build(btn.dataset.plot,s.selectedBuild)}else openSheet('plot',btn.dataset.plot);return}
 if(btn.dataset.build){s.selectedBuild=s.selectedBuild===btn.dataset.build?null:btn.dataset.build;renderHud();renderMap();toast(s.selectedBuild?`Нажми на жёлтый участок · ${BUILDINGS[s.selectedBuild].cost} млрд`:'Строительство отменено');return}
 if(btn.dataset.action==='hire'){hire(btn.dataset.type);return}
 if(btn.dataset.action==='dispatch'){dispatch(btn.dataset.id);return}
 if(btn.dataset.action==='showincident'){panel='incident';panelId=btn.dataset.id;updateSheet();return}
 if(btn.dataset.action==='buildnow'){build(btn.dataset.plot,btn.dataset.kind);return}
 if(btn.dataset.action==='reset'){restart();return}
}
$('#app').addEventListener('click',handleClick);$('#shade').addEventListener('click',()=>closeSheet());$('#trafficSvg').addEventListener('click',e=>{if(e.target.dataset.road)openSheet('traffic')});
document.addEventListener('visibilitychange',()=>{last=performance.now();save()});window.addEventListener('pagehide',save);
function frame(t){const delta=Math.min(.1,Math.max(0,(t-last)/1000));last=t;if(!document.hidden&&s.speed>0&&!s.finished)advance(delta*s.speed/CONFIG.secondsPerDay);animateActors();if(t-lastHud>240){renderHud();renderTraffic();lastHud=t}if(t-savedAt>3500){save();savedAt=t}requestAnimationFrame(frame)}
renderAll();animateActors();if(s.speed===0&&!s.finished)toast('⏸️ Игра загружена на паузе — нажми ▶');if(s.finished)endGame();requestAnimationFrame(frame);
