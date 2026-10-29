const http=require('http'),fs=require('fs'),crypto=require('crypto'),path=require('path');
const E=process.env,PORT=E.PORT||3000,TOKEN=E.BOT_TOKEN,ADMIN=E.ADMIN_CHAT_ID,GID=E.GOOGLE_CLIENT_ID,CP=E.CRYPTO_PAY_TOKEN,CPH=E.CRYPTO_PAY_TESTNET?'testnet-pay.crypt.bot':'pay.crypt.bot',DBU=E.DATABASE_URL;
let db={users:{},orders:[],ops:[],sess:{},promos:{},revs:[],nextUid:10001},pool=null,skins=[],lastErr='',loadedAt=0;

function ensureUids(){
 db.nextUid=db.nextUid||10001;
 for(const k in db.users){
  if(!db.users[k].uid)db.users[k].uid=db.nextUid++;
 }
}

async function dbInit(){
 if(DBU){const{Pool}=require('pg');pool=new Pool({connectionString:DBU,ssl:{rejectUnauthorized:false}});await pool.query('create table if not exists kv(k text primary key,v jsonb)');const r=await pool.query("select v from kv where k='db'");if(r.rows[0])db=r.rows[0].v;console.log('DB: postgres')}
 else{try{db=JSON.parse(fs.readFileSync('data.json'))}catch{}console.log('DB: data.json')}
 db.users=db.users||{};db.orders=db.orders||[];db.ops=db.ops||[];db.sess=db.sess||{};
 db.cfg=Object.assign({adj:0,buyAdj:10,notice:'',hideOn:false,minOn:667,maxOn:1214,botsOn:true,botSec:5,minWd:5,reqDep:true,dailyCents:5},db.cfg||{});
 db.promos=db.promos||{};db.revs=db.revs||[];
 ensureUids();
}
let st;function save(){clearTimeout(st);st=setTimeout(async()=>{try{if(pool)await pool.query("insert into kv(k,v) values('db',$1) on conflict(k) do update set v=$1",[JSON.stringify(db)]);else fs.writeFileSync('data.json',JSON.stringify(db))}catch(e){console.log('save fail',e.message)}},200)}

/* skins */
async function prices(){
 try{const r=await fetch('https://api.skinport.com/v1/items?app_id=730&currency=USD',{headers:{'Accept-Encoding':'br, gzip'}});if(!r.ok)throw new Error('skinport '+r.status);const p={};(await r.json()).forEach(i=>{if(i.min_price)p[i.market_hash_name]=i.min_price});if(Object.keys(p).length>100)return p}catch(e){lastErr=e.message}
 const j=await fetch('https://prices.csgotrader.app/latest/prices_v6.json').then(r=>r.json()),p={};
 for(const k in j){const x=j[k],v=(x.skinport&&x.skinport.starting_at)||(x.steam&&x.steam.last_24h)||0;if(v>0)p[k]=+v}return p}
async function load(){try{
 const[a,p]=await Promise.all([fetch('https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins_not_grouped.json').then(r=>r.json()),prices()]);
 skins=a.filter(s=>p[s.market_hash_name]).map(s=>({id:s.market_hash_name,n:s.name,img:s.image,t:(s.category&&s.category.name)||'',w:(s.wear&&s.wear.name)||'',r:(s.rarity&&s.rarity.name)||'',c:(s.rarity&&s.rarity.color)||'#888',p:p[s.market_hash_name]})).sort((x,y)=>y.p-x.p);
 loadedAt=Date.now();lastErr='';console.log('skins loaded:',skins.length)}catch(e){lastErr=e.message;console.log('load failed:',e.message);setTimeout(load,3e4)}}

/* totp */
const b32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32e(buf){let b='',o='';for(const x of buf)b+=x.toString(2).padStart(8,'0');for(let i=0;i<b.length;i+=5)o+=b32[parseInt(b.slice(i,i+5).padEnd(5,'0'),2)];return o}
function b32d(s){let b='';for(const c of s)b+=b32.indexOf(c).toString(2).padStart(5,'0');const o=[];for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o)}
function totp(sec,t=Date.now()){const c=Buffer.alloc(8);c.writeBigUInt64BE(BigInt(Math.floor(t/30000)));const h=crypto.createHmac('sha1',b32d(sec)).update(c).digest(),o=h[19]&15;return String((h.readUInt32BE(o)&0x7fffffff)%1e6).padStart(6,'0')}
const chk=(sec,code)=>[-1,0,1].some(d=>totp(sec,Date.now()+d*3e4)===String(code||'').trim());

/* telegram: полное управление всем сайтом */
const tg=(m,b)=>fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const esc=s=>String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const OS={buy:'покупка, ждёт отправки',bought:'отправлено',refunded:'деньги возвращены',new:'новая',accepted:'принята, hold 7 дней',credited:'зачислена',rejected:'отклонена'},PS={pending:'ожидает',done:'выполнено',rejected:'отклонено'};
const pr=s=>Math.max(.01,+(s.p*(1+(db.cfg.adj||0)/100)).toFixed(2));
const bp=s=>Math.max(.01,+(s.p*(1+(db.cfg.buyAdj??10)/100)).toFixed(2)),seen=new Map();

let fakeOnl=895,fakeTarget=1080;
setInterval(()=>{
 const mn=db.cfg.minOn||667,mx=Math.max(mn+10,db.cfg.maxOn||1214);
 if(Math.abs(fakeOnl-fakeTarget)<18||fakeTarget<mn||fakeTarget>mx)fakeTarget=mn+Math.floor(Math.random()*(mx-mn+1));
 const dir=fakeTarget>fakeOnl?1:-1;
 const step=Math.floor(Math.random()*15)+4;
 const noise=Math.floor(Math.random()*9)-4;
 fakeOnl=Math.max(mn,Math.min(mx,fakeOnl+dir*step+noise));
},2500);

const buyTxt=()=>{const a=db.cfg.buyAdj??10;return a?(a>0?'+':'')+a+'% к рынку':'рыночные'};
const usd=c=>'$'+(c/100).toFixed(2);
const adjTxt=()=>db.cfg.adj?(db.cfg.adj>0?'+':'')+db.cfg.adj+'% к рынку':'рыночные';
const uBtn=l=>[{text:'Профиль '+l+' (#'+(db.users[l]?.uid||0)+')',callback_data:'u:'+l}];
const fmtO=o=>`<b>${o.kind=='buy'?'Покупка':'Продажа'} #${o.id}</b> · ${OS[o.status]}\n${esc(o.skin)}\n<b>${usd(Math.round(o.price*100))}</b>\nКлиент: ${esc(o.user)} (ID #${db.users[o.user]?.uid||0})\n<code>${esc(o.tl)}</code>`;
const fmtP=p=>`${p.type=='dep'?'<b>Пополнение':'<b>Вывод'} #${p.id}</b> · ${PS[p.status]}\n<b>${usd(p.cents)}</b>${p.method?'\n'+esc(p.method)+(p.details?': <code>'+esc(p.details)+'</code>':''):''}\nКлиент: ${esc(p.user)} (ID #${db.users[p.user]?.uid||0})`;
const kbO=o=>({inline_keyboard:[...(o.status=='new'?[[{text:'Принять',callback_data:'o:accepted:'+o.id},{text:'Сразу зачислить $',callback_data:'o:credited:'+o.id}],[{text:'Отклонить',callback_data:'o:rejected:'+o.id}]]:o.status=='buy'?[[{text:'Отправил скин',callback_data:'o:bought:'+o.id},{text:'Отказ + возврат $',callback_data:'o:refunded:'+o.id}]]:[]),uBtn(o.user)]});
const kbP=p=>({inline_keyboard:[...(p.status=='pending'&&p.type=='wd'?[[{text:'Выплачено',callback_data:'p:done:'+p.id},{text:'Отклонить + возврат $',callback_data:'p:rejected:'+p.id}]]:[]),uBtn(p.user)]});
const note=async(t,k,img)=>{if(!(TOKEN&&ADMIN))return;const b={chat_id:ADMIN,parse_mode:'HTML',reply_markup:k};try{if(img){const r=await tg('sendPhoto',{...b,photo:img,caption:t});if(r.ok)return}await tg('sendMessage',{...b,text:t,link_preview_options:{is_disabled:true}})}catch(e){}};
const kb=r=>({inline_keyboard:r}),BACK=[{text:'← В главное меню',callback_data:'m:main'}],CANCEL=kb([[{text:'Отмена',callback_data:'m:main'}]]),MENU='Меню управления',wait={};

async function screen(chat,mid,text,k){const b={chat_id:chat,text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:k||kb([BACK])};
 if(mid){const r=await tg('editMessageText',{...b,message_id:mid}).catch(()=>({}));if(r.ok||/not modified/.test(r.description||''))return r}
 return tg('sendMessage',b)}

const cnt=(k)=>db.orders.filter(o=>o.status==k).length,pendP=()=>db.ops.filter(o=>o.type=='wd'&&o.status=='pending');

function mainScr(){
 const n=cnt('new')+cnt('buy'),w=pendP().length,pCnt=Object.keys(db.promos||{}).length;
 return{
  t:`<b>CS2PAY · ГЛАВНЫЙ ПУЛЬТ УПРАВЛЕНИЯ</b>\n\nЗаявок ждёт: <b>${n}</b> · Выводов ждёт: <b>${w}</b>\nЦены выкупа: <b>${adjTxt()}</b> · Продажи: <b>${buyTxt()}</b>\nОнлайн: <b>${db.cfg.minOn}–${db.cfg.maxOn}</b> (${db.cfg.hideOn?'скрыт':'виден'})\nБоты-отзывы: <b>${db.cfg.botsOn?'ВКЛ (каждые '+db.cfg.botSec+'с)':'ВЫКЛ'}</b>\nВывод без депа: <b>${db.cfg.reqDep?'ЗАПРЕЩЁН':'РАЗРЕШЁН'}</b>\nМин. вывод: <b>$${db.cfg.minWd}</b> · Ежедневка: <b>${usd(db.cfg.dailyCents)}</b>`,
  k:kb([
   [{text:'Заявки и выводы'+(n+w?` (${n+w})`:''),callback_data:'m:pend'},{text:'Полная статистика',callback_data:'m:stats'}],
   [{text:'Пользователи ('+Object.keys(db.users).length+')',callback_data:'m:users:0'},{text:'Поиск по ID / логину',callback_data:'m:find'}],
   [{text:'Цены выкупа (все скины)',callback_data:'m:price'},{text:'Цены продажи (все скины)',callback_data:'m:buyp'}],
   [{text:'Промокоды ('+pCnt+')',callback_data:'m:promos'},{text:'Управление ботами и онлайном',callback_data:'m:bots'}],
   [{text:'Настройки вывода и бонусов',callback_data:'m:wcfg'},{text:'Отзывы на сайте',callback_data:'m:revs'}],
   [{text:'Баннер-объявление',callback_data:'m:notice'},{text:'Рассылка / Начислить всем',callback_data:'m:mass'}],
   [{text:'Скачать бэкап базы',callback_data:'m:bk'}]
  ])
 }
}

function botsScr(m){
 return{
  t:`<b>Управление онлайном и ботами</b>${m?'\n\n'+m:''}\n\nТекущий онлайн на сайте: <b>${fakeOnl}</b>\nДиапазон скачков: <b>${db.cfg.minOn} – ${db.cfg.maxOn}</b>\nОтображение онлайна: <b>${db.cfg.hideOn?'Скрыт':'Виден всем'}</b>\nАвто-отзывы ботов: <b>${db.cfg.botsOn?'Включены':'Выключены'}</b>\nСкорость ботов: <b>1 отзыв каждые ${db.cfg.botSec} сек</b> (2 за ${db.cfg.botSec*2}с)`,
  k:kb([
   [{text:db.cfg.hideOn?'Показать онлайн':'Скрыть онлайн',callback_data:'b:hon'},{text:'Задать диапазон онлайна',callback_data:'b:rng'}],
   [{text:db.cfg.botsOn?'Выключить ботов':'Включить ботов',callback_data:'b:bon'},{text:'Скорость: 3 сек',callback_data:'b:sp:3'},{text:'5 сек',callback_data:'b:sp:5'},{text:'10 сек',callback_data:'b:sp:10'}],
   [{text:'Задать свою скорость (сек)',callback_data:'b:spc'}],
   BACK
  ])
 }
}

function wcfgScr(m){
 return{
  t:`<b>Настройки вывода и бонусов</b>${m?'\n\n'+m:''}\n\nТребовать депозит для вывода: <b>${db.cfg.reqDep?'ДА (защита от абуза бонусов)':'НЕТ (вывод открыт всем)'}</b>\nМинимальная сумма вывода: <b>$${db.cfg.minWd}</b>\nЕжедневный бонус: <b>${usd(db.cfg.dailyCents)}</b>`,
  k:kb([
   [{text:db.cfg.reqDep?'Разрешить вывод без депозита':'Включить защиту (вывод только с депом)',callback_data:'w:req'}],
   [{text:'Мин. вывод $1',callback_data:'w:min:1'},{text:'$3',callback_data:'w:min:3'},{text:'$5',callback_data:'w:min:5'},{text:'$10',callback_data:'w:min:10'},{text:'Свой $',callback_data:'w:minc'}],
   [{text:'Ежедневка $0.05',callback_data:'w:dl:5'},{text:'$0.10',callback_data:'w:dl:10'},{text:'$0.25',callback_data:'w:dl:25'},{text:'$1.00',callback_data:'w:dl:100'},{text:'Своя',callback_data:'w:dlc'}],
   BACK
  ])
 }
}

function revsScr(m){
 const R=(db.revs||[]).slice(-8).reverse();
 const list=R.length?R.map((r,i)=>`• <b>${esc(r.nick)}</b> (${r.stars}★): ${esc(r.text)}`).join('\n'):'<i>Кастомных отзывов в базе нет (крутятся авто-боты)</i>';
 return{
  t:`<b>Управление отзывами на сайте</b>${m?'\n\n'+m:''}\n\nПоследние сохранённые отзывы:\n${list}\n\nТы можешь отправить в ленту сайта свой кастомный отзыв от любого имени:`,
  k:kb([
   [{text:'+ Вбросить свой отзыв на сайт',callback_data:'rv:add'}],
   [{text:'Очистить сохранённые отзывы',callback_data:'rv:clr'}],
   BACK
  ])
 }
}

function massScr(m){
 return{
  t:`<b>Массовые действия</b>${m?'\n\n'+m:''}\n\nВсего аккаунтов: <b>${Object.keys(db.users).length}</b>\nНовых заявок на продажу: <b>${cnt('new')}</b>`,
  k:kb([
   [{text:'Начислить бонус ($) ВСЕМ юзерам',callback_data:'ms:bal'}],
   [{text:'Принять ВСЕ новые заявки в hold',callback_data:'ms:acc'}],
   [{text:'Зачислить $ по ВСЕМ hold-заявкам сейчас',callback_data:'ms:cred'}],
   BACK
  ])
 }
}

function statsScr(){const sum=(l,f)=>l.reduce((t,x)=>t+f(x),0),W=pendP(),D=db.ops.filter(o=>o.type=='dep'&&o.status=='pending');
 return{t:`<b>Полная статистика</b>\n\nПользователей: <b>${Object.keys(db.users).length}</b>\nСкинов в каталоге: <b>${skins.length}</b>\n\nЗаявки: новые ${cnt('new')} · hold ${cnt('accepted')} · зачислено ${cnt('credited')} · покупки ${cnt('buy')} · отклонено ${cnt('rejected')}\nНа балансах у всех: <b>${usd(sum(Object.values(db.users),x=>x.bal||0))}</b>\nВыводы в ожидании: ${W.length} на ${usd(sum(W,o=>o.cents))}\nПополнения в ожидании: ${D.length} на ${usd(sum(D,o=>o.cents))}\nЦены выкупа: ${adjTxt()} · продажи: ${buyTxt()}`,k:kb([[{text:'Обновить',callback_data:'m:stats'}],BACK])}}

function usersScr(pg){const L=Object.entries(db.users).sort((a,b)=>(b[1].created||0)-(a[1].created||0)),per=8,N=Math.max(1,Math.ceil(L.length/per));pg=Math.min(Math.max(0,pg),N-1);
 const nav=[];if(pg>0)nav.push({text:'←',callback_data:'m:users:'+(pg-1)});nav.push({text:`${pg+1}/${N}`,callback_data:'noop'});if(pg<N-1)nav.push({text:'→',callback_data:'m:users:'+(pg+1)});
 return{t:`<b>Пользователи</b> · всего ${L.length}\nУ каждого свой уникальный ID. Нажми для полного управления:`,k:kb([...L.slice(pg*per,pg*per+per).map(([l,x])=>[{text:`#${x.uid||0} · ${x.ban?'[БАН] ':''}${l} · ${usd(x.bal||0)}`,callback_data:'u:'+l}]),nav,BACK])}}

function userScr(l,m){const x=db.users[l];if(!x)return{t:'Пользователь не найден',k:kb([BACK])};
 const hasDep=db.ops.some(o=>o.user==l&&o.type=='dep'&&o.status=='done');
 return{t:`<b>Профиль: ${esc(l)}</b> · ID: <code>#${x.uid||0}</code>${x.ban?' · <b>ЗАБЛОКИРОВАН</b>':''}${m?'\n\n'+m:''}\n\nБаланс: <b>${usd(x.bal||0)}</b>\nБонус к продаже: <b>+${x.sellB||0}%</b> · к депу: <b>+${x.depB||0}%</b>\nРеальный депозит: <b>${hasDep?'Был (вывод открыт)':'Не было'}</b>\n2FA: <b>${x.totp?'Включена':'Нет'}</b>\nТрейд-ссылка: ${x.tl?'<code>'+esc(x.tl)+'</code>':'не указана'}\nЗаявок: ${db.orders.filter(o=>o.user==l).length} · Операций: ${db.ops.filter(o=>o.user==l).length}`,
 k:kb([
  [{text:'Изменить баланс ($)',callback_data:'ab:'+l},{text:'Дать % бонус юзеру',callback_data:'ub:'+l}],
  [{text:x.ban?'Разблокировать':'Заблокировать',callback_data:'ban:'+l},{text:'Разрешить вывод без депа',callback_data:'ufd:'+l}],
  [...(x.totp?[[{text:'Сбросить 2FA юзеру',callback_data:'u2fa:'+l}]]:[])],
  [{text:'← К списку пользователей',callback_data:'m:users:0'}],
  BACK
 ])}}

function balScr(l){const B=a=>a.map(v=>({text:(v>0?'+':'−')+Math.abs(v)+'$',callback_data:`ad:${l}:${v}`}));
 return{t:`<b>Баланс ${esc(l)} (#${db.users[l]?.uid||0})</b>: ${usd((db.users[l]||{}).bal||0)}\nВыбери сумму или введи любую свою:`,k:kb([B([1,5,10,50]),B([100,250,500,1000]),B([-1,-5,-10,-50]),[{text:'Ввести точную сумму',callback_data:'ac:'+l}],[{text:'Обнулить баланс (0$)',callback_data:`az:${l}`}],[{text:'← К пользователю',callback_data:'u:'+l}]])}}

function priceScr(m){const B=a=>a.map(v=>({text:(v>0?'+':'')+v+'%',callback_data:'pr:'+v}));
 return{t:`<b>Цены выкупа ВСЕХ скинов</b>: ${adjTxt()}${m?'\n\n'+m:''}\nПовышай или понижай цены всех скинов на сайте на любой процент:`,k:kb([B([-90,-70,-50,-30]),B([-20,-10,-5,0]),B([5,10,20,35]),B([50,100,200,500]),[{text:'Ввести любой свой %',callback_data:'pr:c'}],BACK])}}

function buyScr(m){const B=a=>a.map(v=>({text:(v>0?'+':'')+v+'%',callback_data:'bp:'+v}));
 return{t:`<b>Цены продажи ВСЕХ скинов (покупка на сайте)</b>: ${buyTxt()}${m?'\n\n'+m:''}\nМеняет стоимость всех скинов и ножей в разделе «Купить»:`,k:kb([B([-90,-70,-50,-30]),B([-15,-5,0,10]),B([20,35,50,100]),B([150,250,500,1000]),[{text:'Ввести любой свой %',callback_data:'bp:c'}],BACK])}}

function promosScr(m){
 const P=Object.entries(db.promos||{});
 const tp={bal:'$ на баланс',sell:'% к продаже',dep:'% к пополнению'};
 const list=P.length?P.map(([k,v])=>`• <code>${esc(k)}</code> — <b>+${v.val}${v.type=='bal'?'$':'%'}</b> (${tp[v.type]}) · исп: ${(v.used||[]).length}/${v.max}`).join('\n'):'<i>Активных промокодов пока нет</i>';
 const delBtns=P.slice(0,10).map(([k])=>[{text:'Удалить '+k,callback_data:'pd:'+k}]);
 return{t:`<b>Управление промокодами</b>${m?'\n\n'+m:''}\n\n${list}\n\nВыбери тип нового промокода:`,k:kb([[{text:'+ На баланс ($)',callback_data:'pc:bal'}],[{text:'+ На % к продаже скинов',callback_data:'pc:sell'}],[{text:'+ На % к пополнению',callback_data:'pc:dep'}],...delBtns,BACK])}}

function noticeScr(){return{t:`<b>Объявление (баннер сверху сайта)</b>\n\n${db.cfg.notice?esc(db.cfg.notice):'<i>сейчас пусто</i>'}`,k:kb([[{text:'Изменить текст',callback_data:'n:e'},{text:'Убрать баннер',callback_data:'n:off'}],BACK])}}

function setBal(l,v,al){const x=db.users[l];if(!x||!v)return;if((x.bal||0)+v*100<0){al.t='Баланс не может уйти в минус';return}
 x.bal=(x.bal||0)+Math.round(v*100);db.ops.push({id:db.ops.length+1,user:l,type:v>0?'dep':'wd',cents:Math.round(Math.abs(v)*100),method:'Корректировка',details:'admin',status:'done',t:Date.now()});save()}

async function pending(chat,mid){const O=db.orders.filter(o=>o.status=='new'||o.status=='buy').slice(0,12),P=pendP().slice(0,12);
 if(!O.length&&!P.length)return screen(chat,mid,'<b>Ожидающих заявок и выводов нет</b>',kb([[{text:'Обновить',callback_data:'m:pend'}],BACK]));
 await screen(chat,mid,`<b>Ждут решения</b>: заявок ${O.length}, выводов ${P.length}`,kb([BACK]));
 for(const o of O)await tg('sendMessage',{chat_id:chat,text:fmtO(o),parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:kbO(o)});
 for(const p of P)await tg('sendMessage',{chat_id:chat,text:fmtP(p),parse_mode:'HTML',reply_markup:kbP(p)});
 return screen(chat,0,'Это все активные заявки.',kb([[{text:'Обновить',callback_data:'m:pend'}],BACK]))}

const show=(chat,mid,s)=>screen(chat,mid,s.t,s.k);

async function onInput(chat,w,t){
 if(w.k=='find'){
  const q=t.trim().replace(/^#/,'').toLowerCase();
  if(db.users[q])return show(chat,0,userScr(q));
  const byId=Object.entries(db.users).find(([k,v])=>String(v.uid)===q||k.includes(q));
  if(byId)return show(chat,0,userScr(byId[0]));
  return show(chat,0,{t:'Пользователь с таким логином или ID не найден',k:kb([BACK])});
 }
 if(w.k=='pcode'){
  const parts=t.trim().split(/\s+/);
  const code=(parts[0]||'').toUpperCase().replace(/[^A-Z0-9_-]/g,'');
  const val=parseFloat((parts[1]||'').replace(',','.'));
  const max=parseInt(parts[2]||'100',10)||100;
  if(!code||isNaN(val)||val<=0){wait[chat]=w;return screen(chat,0,'Неверный формат. Отправь через пробел:\n<code>КОД ЧИСЛО ЛИМИТ</code>\nНапример: <code>SELLSKIN 15 100</code>',CANCEL)}
  db.promos[code]={type:w.tp,val,max,used:[]};save();
  return show(chat,0,promosScr('Промокод '+code+' создан'))
 }
 if(w.k=='onrng'){
  const parts=t.trim().split(/\s+/);
  const mn=parseInt(parts[0],10),mx=parseInt(parts[1],10);
  if(isNaN(mn)||isNaN(mx)||mn<1||mx<=mn){wait[chat]=w;return screen(chat,0,'Отправь два числа через пробел (мин и макс), например: <code>667 1214</code>',CANCEL)}
  db.cfg.minOn=mn;db.cfg.maxOn=mx;fakeOnl=Math.floor((mn+mx)/2);fakeTarget=mx;save();
  return show(chat,0,botsScr('Диапазон онлайна обновлён'))
 }
 if(w.k=='addrev'){
  const parts=t.split('|').map(s=>s.trim());
  const nick=parts[0]||'w1ndow',text=parts[1]||parts[0]||'все прийшло на моно дякую';
  const sk=skins[Math.floor(Math.random()*Math.min(skins.length,150))]||{id:'AK-47 | Slate (Field-Tested)',img:'',p:3.2};
  const rev={nick,stars:5,skin:sk.id,img:sk.img,p:sk.p||3.2,text,t:Date.now()};
  db.revs.push(rev);if(db.revs.length>30)db.revs.shift();save();
  return show(chat,0,revsScr('Отзыв от '+nick+' опубликован на сайте'))
 }
 const v=parseFloat(t.replace(',','.'));
 if(isNaN(v)){wait[chat]=w;return screen(chat,0,'Не похоже на число. Попробуй ещё раз:',CANCEL)}
 if(w.k=='addbal'){const al={};setBal(w.l,v,al);return show(chat,0,balScr(w.l))}
 if(w.k=='ub'){const u=db.users[w.l];if(u){u.sellB=v;u.depB=v;save()}return show(chat,0,userScr(w.l,'Бонус +'+v+'% выдан'))}
 if(w.k=='massbal'){
  let c=0;for(const k in db.users){db.users[k].bal=Math.max(0,(db.users[k].bal||0)+Math.round(v*100));c++}
  save();return show(chat,0,massScr(`Начислено по $${v} всем (${c} чел.)`))
 }
 if(w.k=='botsp'){db.cfg.botSec=Math.max(1,Math.min(120,Math.round(v)));save();return show(chat,0,botsScr('Скорость обновлена'))}
 if(w.k=='minwd'){db.cfg.minWd=Math.max(0.1,v);save();return show(chat,0,wcfgScr('Мин. вывод обновлён'))}
 if(w.k=='dlc'){db.cfg.dailyCents=Math.max(1,Math.round(v*100));save();return show(chat,0,wcfgScr('Ежедневный бонус обновлён'))}
 if(w.k=='buyp'){if(v<-99||v>50000){wait[chat]=w;return screen(chat,0,'Допустимо от -99 до 50000',CANCEL)}db.cfg.buyAdj=v;save();return show(chat,0,buyScr('Установлено '+v+'%'))}
 if(w.k=='price'){if(v<-99||v>50000){wait[chat]=w;return screen(chat,0,'Допустимо от -99 до 50000',CANCEL)}db.cfg.adj=v;save();return show(chat,0,priceScr('Установлено '+v+'%'))}
}

async function backup(chat){const f=new FormData();f.append('chat_id',String(chat));f.append('caption','Резервная копия данных cs2pay');f.append('document',new Blob([JSON.stringify(db)],{type:'application/json'}),'cs2pay-backup-'+new Date().toISOString().slice(0,10)+'.json');return fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`,{method:'POST',body:f}).then(r=>r.json())}

async function onUpdate(u){const m=u.message,c=u.callback_query;
 if(m&&m.text){const chat=m.chat.id,t=m.text.trim();
  if(String(chat)!==String(ADMIN)){if(t.startsWith('/start'))await tg('sendMessage',{chat_id:chat,text:'ID этого чата: '+chat+'\nУкажи его в ADMIN_CHAT_ID.'});return}
  const w=wait[chat];delete wait[chat];
  if(w&&t[0]!='/'&&t!=MENU){if(w.k=='notice'){db.cfg.notice=t.slice(0,300);save();return show(chat,0,noticeScr())}return onInput(chat,w,t)}
  if(t.startsWith('/start'))await tg('sendMessage',{chat_id:chat,text:'Полный пульт управления cs2pay активирован.',reply_markup:{keyboard:[[{text:MENU}]],resize_keyboard:true,is_persistent:true}});
  return show(chat,0,mainScr())}
 if(!c||String(c.message.chat.id)!==String(ADMIN))return;
 const chat=c.message.chat.id,mid=c.message.message_id,p=(c.data||'').split(':'),k=p[0],al={};
 if(k!='o'&&k!='p'&&k!='noop')delete wait[chat];
 if(k=='m'){
  const s=p[1];
  if(s=='main')await show(chat,mid,mainScr());
  else if(s=='stats')await show(chat,mid,statsScr());
  else if(s=='pend')await pending(chat,mid);
  else if(s=='users')await show(chat,mid,usersScr(+p[2]||0));
  else if(s=='price')await show(chat,mid,priceScr());
  else if(s=='buyp')await show(chat,mid,buyScr());
  else if(s=='promos')await show(chat,mid,promosScr());
  else if(s=='bots')await show(chat,mid,botsScr());
  else if(s=='wcfg')await show(chat,mid,wcfgScr());
  else if(s=='revs')await show(chat,mid,revsScr());
  else if(s=='mass')await show(chat,mid,massScr());
  else if(s=='bk'){await backup(chat);al.t='Бэкап отправлен'}
  else if(s=='onl'){db.cfg.hideOn=!db.cfg.hideOn;save();await show(chat,mid,mainScr())}
  else if(s=='notice')await show(chat,mid,noticeScr());
  else if(s=='find'){wait[chat]={k:'find'};await screen(chat,mid,'Отправь логин или ID пользователя (например <code>10001</code> или <code>vlad</code>):',CANCEL)}
 }
 else if(k=='b'){
  if(p[1]=='hon'){db.cfg.hideOn=!db.cfg.hideOn;save();await show(chat,mid,botsScr())}
  else if(p[1]=='bon'){db.cfg.botsOn=!db.cfg.botsOn;save();await show(chat,mid,botsScr())}
  else if(p[1]=='sp'){db.cfg.botSec=+p[2];save();await show(chat,mid,botsScr('Скорость: каждые '+p[2]+' сек'))}
  else if(p[1]=='spc'){wait[chat]={k:'botsp'};await screen(chat,mid,'Отправь интервал появления ботов в секундах (от 1 до 120):',CANCEL)}
  else if(p[1]=='rng'){wait[chat]={k:'onrng'};await screen(chat,mid,'Отправь мин и макс онлайн через пробел, например: <code>667 1214</code>',CANCEL)}
 }
 else if(k=='w'){
  if(p[1]=='req'){db.cfg.reqDep=!db.cfg.reqDep;save();await show(chat,mid,wcfgScr())}
  else if(p[1]=='min'){db.cfg.minWd=+p[2];save();await show(chat,mid,wcfgScr('Мин. вывод: $'+p[2]))}
  else if(p[1]=='minc'){wait[chat]={k:'minwd'};await screen(chat,mid,'Отправь минимальную сумму вывода в $:',CANCEL)}
  else if(p[1]=='dl'){db.cfg.dailyCents=+p[2];save();await show(chat,mid,wcfgScr('Ежедневка обновлена'))}
  else if(p[1]=='dlc'){wait[chat]={k:'dlc'};await screen(chat,mid,'Отправь сумму ежедневного бонуса в $, например <code>0.15</code>:',CANCEL)}
 }
 else if(k=='rv'){
  if(p[1]=='add'){wait[chat]={k:'addrev'};await screen(chat,mid,'Отправь ник и текст отзыва через вертикальную черту <code>|</code>\nНапример:\n<code>s1mple | продал нож, бабки пришли за минуту на моно</code>',CANCEL)}
  else if(p[1]=='clr'){db.revs=[];save();await show(chat,mid,revsScr('Сохранённые отзывы очищены'))}
 }
 else if(k=='ms'){
  if(p[1]=='bal'){wait[chat]={k:'massbal'};await screen(chat,mid,'Отправь сумму в $, которую нужно начислить ВСЕМ пользователям сайта:',CANCEL)}
  else if(p[1]=='acc'){let c=0;for(const o of db.orders)if(o.status=='new'){o.status='accepted';o.hold=Date.now()+7*864e5;c++}save();await show(chat,mid,massScr('Принято заявок: '+c))}
  else if(p[1]=='cred'){let c=0;for(const o of db.orders)if(o.status=='accepted'||o.status=='new'){o.status='credited';const u=db.users[o.user];if(u)u.bal=(u.bal||0)+Math.round(o.price*100);c++}save();await show(chat,mid,massScr('Зачислено заявок: '+c))}
 }
 else if(k=='pc'){
  wait[chat]={k:'pcode',tp:p[1]};
  const desc=p[1]=='bal'?'сумму в $ (например: <code>FREE5 5 20</code> — даст 5$ на баланс, лимит 20 активаций)':p[1]=='sell'?'бонус в % к продаже (например: <code>SELLSKIN 15 100</code> — даст +15% к продаже, лимит 100)':'бонус в % к пополнению (например: <code>DEP20 20 50</code> — даст +20% к депозиту, лимит 50)';
  await screen(chat,mid,`Отправь: <code>КОД ЗНАЧЕНИЕ ЛИМИТ</code>\nУкажи ${desc}`,CANCEL)
 }
 else if(k=='pd'){delete db.promos[p[1]];save();await show(chat,mid,promosScr('Удалён '+p[1]))}
 else if(k=='u')await show(chat,mid,userScr(p[1]));
 else if(k=='ban'){const x=db.users[p[1]];if(x){x.ban=!x.ban;save()}await show(chat,mid,userScr(p[1]))}
 else if(k=='u2fa'){const x=db.users[p[1]];if(x){delete x.totp;save()}await show(chat,mid,userScr(p[1],'2FA сброшена'))}
 else if(k=='ufd'){const l=p[1];db.ops.push({id:db.ops.length+1,user:l,type:'dep',cents:0,method:'Доступ к выводу (admin)',inv:'admin_unlock',status:'done',t:Date.now()});save();await show(chat,mid,userScr(l,'Вывод без депа открыт для этого юзера'))}
 else if(k=='ub'){wait[chat]={k:'ub',l:p[1]};await screen(chat,mid,'Отправь процент бонуса для '+p[1]+' (например <code>15</code>):',CANCEL)}
 else if(k=='ab')await show(chat,mid,balScr(p[1]));
 else if(k=='az'){if(db.users[p[1]]){db.users[p[1]].bal=0;save()}await show(chat,mid,balScr(p[1]))}
 else if(k=='ad'){setBal(p[1],+p[2],al);await show(chat,mid,balScr(p[1]))}
 else if(k=='ac'){wait[chat]={k:'addbal',l:p[1]};await screen(chat,mid,'Отправь сумму в $, например 12.5 или -3',CANCEL)}
 else if(k=='pr'){if(p[1]=='c'){wait[chat]={k:'price'};await screen(chat,mid,'Отправь любой процент (например -45 или 120):',CANCEL)}else{db.cfg.adj=+p[1];save();await show(chat,mid,priceScr('Установлено '+p[1]+'%'))}}
 else if(k=='bp'){if(p[1]=='c'){wait[chat]={k:'buyp'};await screen(chat,mid,'Отправь любой процент для цен покупки (например -30 или 150):',CANCEL)}else{db.cfg.buyAdj=+p[1];save();await show(chat,mid,buyScr('Установлено '+p[1]+'%'))}}
 else if(k=='n'){if(p[1]=='e'){wait[chat]={k:'notice'};await screen(chat,mid,'Отправь текст объявления сообщением',CANCEL)}else{db.cfg.notice='';save();await show(chat,mid,noticeScr())}}
 else if(k=='o'||k=='p'){const id=+p[2];let txt,kk;
  if(k=='o'){
   const o=db.orders.find(x=>x.id==id);
   if(o&&o.status=='new'){
    o.status=p[1];
    if(p[1]=='accepted')o.hold=Date.now()+7*864e5;
    else if(p[1]=='credited'){const us=db.users[o.user];if(us)us.bal=(us.bal||0)+Math.round(o.price*100)}
    save();
   }else if(o&&o.status=='buy'&&(p[1]=='bought'||p[1]=='refunded')){
    o.status=p[1];if(p[1]=='refunded'){const us=db.users[o.user];if(us)us.bal=(us.bal||0)+Math.round(o.price*100)}save();
   }
   if(o){txt=fmtO(o);kk=kbO(o)}
  }else{
   const q=db.ops.find(x=>x.id==id);
   if(q&&q.status=='pending'){q.status=p[1];const us=db.users[q.user];if(us&&((p[1]=='done'&&q.type=='dep')||(p[1]=='rejected'&&q.type=='wd')))us.bal=(us.bal||0)+q.cents;save()}
   if(q){txt=fmtP(q);kk=kbP(q)}
  }
  if(txt)await(c.message.photo?tg('editMessageCaption',{chat_id:chat,message_id:mid,caption:txt,parse_mode:'HTML',reply_markup:kk}):tg('editMessageText',{chat_id:chat,message_id:mid,text:txt,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:kk}))}
 await tg('answerCallbackQuery',{callback_query_id:c.id,text:al.t,show_alert:!!al.t})}

let off=0;(async()=>{if(!TOKEN)return console.log('BOT_TOKEN не задан: бот выключен');tg('setMyCommands',{commands:[{command:'menu',description:'Открыть пульт управления cs2pay'}]}).catch(()=>{});
 for(;;){try{const r=await tg('getUpdates',{offset:off,timeout:30});if(!r.ok){await new Promise(x=>setTimeout(x,5000));continue}
  for(const u of r.result){off=u.update_id+1;try{await onUpdate(u)}catch(e){console.log('bot:',e.message)}}}catch(e){await new Promise(x=>setTimeout(x,5000))}}})();

function settle(){let ch=0;for(const o of db.orders)if(o.status=='accepted'&&o.hold<=Date.now()){o.status='credited';const u=db.users[o.user];if(u){u.bal=(u.bal||0)+Math.round(o.price*100);ch=1;note(`<b>Баланс начислен по истечении 7 дней</b>\n\n${esc(o.skin)}\nНачислено: <b>+${usd(Math.round(o.price*100))}</b>\nПользователь: ${esc(o.user)} (#${u.uid||0})`,null,o.img)}}if(ch)save()}
setInterval(settle,6e4);

/* Crypto Pay */
const cp=(m,b)=>fetch(`https://${CPH}/api/${m}`,{method:'POST',headers:{'Crypto-Pay-API-Token':CP,'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
async function checkDeps(){if(!CP)return;const P=db.ops.filter(o=>o.type=='dep'&&o.status=='pending'&&o.inv);if(!P.length)return;try{
 const r=await cp('getInvoices',{invoice_ids:P.map(o=>o.inv).join(',')});
 for(const it of(r.result&&r.result.items)||[]){const o=P.find(x=>x.inv==it.invoice_id);if(!o||o.status!='pending')continue;
  if(it.status=='paid'&&Math.round(+it.amount*100)==(o.baseCents||o.cents)){o.status='done';db.users[o.user].bal=(db.users[o.user].bal||0)+o.cents;save();note(`<b>Баланс пополнен</b>\n\nПополнение #${o.id} через Crypto-бот\nПользователь: ${esc(o.user)} (#${db.users[o.user]?.uid||0})\nСумма: <b>+${usd(o.cents)}</b>`)}
  else if(it.status=='expired'){o.status='rejected';save()}}}catch(e){console.log('crypto pay:',e.message)}}
setInterval(checkDeps,2e4);

/* rates */
let rates={USD:1,UAH:41.5,EUR:.86,PLN:3.65,GBP:.75,KZT:520,RUB:80},ratesAt=0;
async function loadRates(){try{const j=await fetch('https://open.er-api.com/v6/latest/USD').then(r=>r.json());if(j.rates){for(const k in rates)if(j.rates[k]>0)rates[k]=j.rates[k];ratesAt=Date.now()}}catch(e){console.log('rates:',e.message)}}

/* http */
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const body=req=>new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e5)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d||'{}'))}catch{r({})}})});
const send=(res,c,o,h)=>{res.writeHead(c,{'Content-Type':'application/json',...h});res.end(JSON.stringify(o))};
const bad=(res,m,c=400,x)=>send(res,c,{error:m,...x});
const me=req=>{const sid=(/sid=(\w+)/.exec(req.headers.cookie||'')||[])[1],s=sid&&db.sess[sid];return s&&Date.now()-s.t<30*864e5&&db.users[s.n]&&!db.users[s.n].ban?s.n:null};
const start=(req,res,n)=>{const sid=crypto.randomBytes(24).toString('hex');db.sess[sid]={n,t:Date.now()};save();send(res,200,{name:n},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto']=='https'?'; Secure':''}`})};
const pub=n=>{const u=db.users[n];return{name:n,uid:u.uid||10001,bal:u.bal||0,tl:u.tl||'',tfa:!!u.totp,google:!!u.google,sellB:u.sellB||0,depB:u.depB||0,tasks:u.tasks||{},dailyAt:u.dailyAt||0,orders:db.orders.filter(o=>o.user==n).map(({id,skin,img,price,status,hold,t,kind})=>({id,skin,img,price,status,hold,t,kind})),ops:db.ops.filter(o=>o.user==n)}};
const fails={};const lim=k=>{const f=fails[k]=(fails[k]||[]).filter(t=>Date.now()-t<6e5);return f.length>=8};
const TL=/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/;

http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://x'),p=u.pathname;
 if(!p.startsWith('/api/')){const root=path.join(__dirname,'public'),f=path.join(root,p=='/'?'index.html':path.normalize(p));
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('404')}
  res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream','Cache-Control':'no-cache'});return fs.createReadStream(f).pipe(res)}
 if(p=='/api/config')return send(res,200,{gid:GID||'',cp:!!CP,adj:db.cfg.adj||0,buyAdj:db.cfg.buyAdj??10,notice:db.cfg.notice||'',botsOn:db.cfg.botsOn!==false,botSec:db.cfg.botSec||5,minWd:db.cfg.minWd||5,dailyCents:db.cfg.dailyCents||5,reqDep:db.cfg.reqDep!==false,rates,ratesAt,revs:(db.revs||[]).slice(-15)});
 if(p=='/api/health')return send(res,200,{skins:skins.length,loadedAt,lastErr,db:pool?'postgres':'file',users:Object.keys(db.users).length});
 if(p=='/api/market'){const g=k=>u.searchParams.get(k)||'',q=g('q').toLowerCase(),pg=+g('page')||1,mn=+g('min')||0,mx=+g('max')||1e9,so=g('sort'),P=g('buy')=='1'?bp:pr;
  let f=skins.filter(s=>(!q||s.n.toLowerCase().includes(q))&&(!g('r')||s.r==g('r'))&&(!g('t')||s.t==g('t'))&&(!g('w')||s.w==g('w'))&&P(s)>=mn&&P(s)<=mx&&(!g('ids')||g('ids').split(',').includes(String(s.id)))&&(!g('st')||s.n.includes('StatTrak')==(g('st')=='1')));
  if(so=='asc')f=f.slice().sort((a,b)=>a.p-b.p);else if(so=='name')f=f.slice().sort((a,b)=>a.n.localeCompare(b.n));
  const uq=k=>[...new Set(skins.map(s=>s[k]))].filter(Boolean);
  return send(res,200,{total:f.length,all:skins.length,items:f.slice((pg-1)*48,pg*48).map(s=>({...s,p:pr(s),b:bp(s)})),rarities:uq('r'),cats:uq('t'),wears:uq('w')})}
 if(p=='/api/register'){const b=await body(req),l=String(b.login||'').trim().toLowerCase(),pw=String(b.password||'');
  if(!/^[a-z0-9_.@-]{3,40}$/.test(l))return bad(res,'Логин: 3–40 символов, латиница, цифры, _ . - @');
  if(pw.length<6)return bad(res,'Пароль от 6 символов');
  if(db.users[l])return bad(res,'Такой логин уже занят',409);
  const s=crypto.randomBytes(8).toString('hex');
  db.nextUid=(db.nextUid||10001)+1;
  db.users[l]={uid:db.nextUid,s,h:hash(pw,s),bal:0,created:Date.now(),tasks:{}};save();return start(req,res,l)}
 if(p=='/api/login'){const b=await body(req),l=String(b.login||'').trim().toLowerCase(),x=db.users[l];
  if(lim(l))return bad(res,'Слишком много попыток, подожди 10 минут',429);
  if(!x||!x.h||x.h!==hash(String(b.password||''),x.s)){(fails[l]=fails[l]||[]).push(Date.now());return bad(res,'Неверный логин или пароль',401)}
  if(x.ban)return bad(res,'Аккаунт заблокирован',403);
  if(x.totp&&!chk(x.totp,b.code)){if(b.code)(fails[l]=fails[l]||[]).push(Date.now());return bad(res,b.code?'Неверный код 2FA':'Нужен код 2FA',401,{need2fa:true})}
  return start(req,res,l)}
 if(p=='/api/google'){const b=await body(req);const j=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(b.credential||'')).then(r=>r.json());
  if(!GID||j.aud!==GID||!j.email)return bad(res,'Google-вход не прошёл',401);const l=j.email.toLowerCase();
  if(!db.users[l]){db.nextUid=(db.nextUid||10001)+1;db.users[l]={uid:db.nextUid,google:true,bal:0,created:Date.now(),tasks:{}};save()}return start(req,res,l)}
 if(p=='/api/logout'){const sid=(/sid=(\w+)/.exec(req.headers.cookie||'')||[])[1];if(sid){delete db.sess[sid];save()}return send(res,200,{},{'Set-Cookie':'sid=; Max-Age=0; Path=/'})}
 const n=me(req);
 if(p=='/api/recent'){const C=db.orders.filter(o=>o.status=='credited'),paid=C.reduce((t,o)=>t+o.price,0);return send(res,200,{paid:+paid.toFixed(2),n:C.length,items:C.slice(-8).reverse().map(o=>({n:o.skin,img:o.img,p:o.price}))})}
 if(p=='/api/ping'){const v=(u.searchParams.get('v')||'').slice(0,40),now=Date.now();if(v)seen.set(v,now);for(const[a,t]of seen)if(now-t>9e4)seen.delete(a);return send(res,200,{n:fakeOnl,h:!!db.cfg.hideOn,botsOn:db.cfg.botsOn!==false,botSec:db.cfg.botSec||5})}
 if(p=='/api/me'){if(!n)return send(res,200,{});settle();return send(res,200,pub(n))}
 if(!n)return bad(res,'Войди в аккаунт',401);
 const x=db.users[n],b=req.method=='POST'?await body(req):{};
 x.tasks=x.tasks||{};
 if(p=='/api/promo'){
  const code=String(b.code||'').trim().toUpperCase();
  const prm=(db.promos||{})[code];
  if(!prm)return bad(res,'Промокод не найден или истёк');
  prm.used=prm.used||[];
  if(prm.used.includes(n))return bad(res,'Ты уже активировал этот промокод');
  if(prm.used.length>=prm.max)return bad(res,'Лимит активаций этого промокода исчерпан');
  prm.used.push(n);
  let msg='',cents=0;
  if(prm.type=='bal'){
   cents=Math.round(prm.val*100);
   x.bal=(x.bal||0)+cents;
   db.ops.push({id:db.ops.length+1,user:n,type:'bonus',cents,method:'Промокод '+code,status:'done',t:Date.now()});
   msg='Промокод активирован';
  }else if(prm.type=='sell'){
   x.sellB=(x.sellB||0)+prm.val;
   msg=`Промокод активирован! Бонус +${prm.val}% к следующей продаже скинов`;
  }else if(prm.type=='dep'){
   x.depB=(x.depB||0)+prm.val;
   msg=`Промокод активирован! Бонус +${prm.val}% к следующему пополнению`;
  }
  save();note(`<b>Активирован промокод</b>\nКод: <code>${esc(code)}</code>\nПользователь: ${esc(n)} (#${x.uid||0})`);
  return send(res,200,{ok:true,msg,cents})
 }
 if(p=='/api/task'){
  const tid=String(b.id||'');
  if(tid=='daily'){
   if(Date.now()-(x.dailyAt||0)<864e5)return bad(res,'Ежедневный бонус уже получен, приходи завтра');
   const dc=db.cfg.dailyCents||5;
   x.dailyAt=Date.now();x.bal=(x.bal||0)+dc;
   db.ops.push({id:db.ops.length+1,user:n,type:'bonus',cents:dc,method:'Ежедневный бонус',status:'done',t:Date.now()});
   save();return send(res,200,{ok:true,cents:dc})
  }
  if(x.tasks[tid])return bad(res,'Задание уже выполнено');
  const rewards={tg_chan:15,tg_mgr:10,tl_set:10,tfa_set:25,first_deal:30};
  const rw=rewards[tid];
  if(!rw)return bad(res,'Неизвестное задание');
  if(tid=='tl_set'&&!x.tl)return bad(res,'Сначала сохрани трейд-ссылку в настройках профиля');
  if(tid=='tfa_set'&&!x.totp)return bad(res,'Сначала подключи 2FA в настройках профиля');
  if(tid=='first_deal'&&!db.orders.some(o=>o.user==n))return bad(res,'Сначала соверши хотя бы одну покупку или продажу скина');
  x.tasks[tid]=1;x.bal=(x.bal||0)+rw;
  db.ops.push({id:db.ops.length+1,user:n,type:'bonus',cents:rw,method:'Бонус за задание',status:'done',t:Date.now()});
  save();return send(res,200,{ok:true,cents:rw})
 }
 if(p=='/api/review'){
  const myOrders=db.orders.filter(o=>o.user==n);
  if(!myOrders.length)return bad(res,'Оставить отзыв можно только после покупки или продажи скина');
  const stars=+b.stars===4?4:5;
  const text=String(b.text||'').trim().slice(0,180);
  if(text.length<3)return bad(res,'Напиши хотя бы пару слов в отзыве');
  const lastOrd=myOrders[myOrders.length-1];
  const rev={nick:n.split('@')[0],stars,skin:lastOrd.skin,img:lastOrd.img,p:lastOrd.price,text,t:Date.now()};
  db.revs=db.revs||[];db.revs.push(rev);if(db.revs.length>30)db.revs.shift();
  save();return send(res,200,{ok:true,rev})
 }
 if(p=='/api/settings'){if(b.tl&&!TL.test(b.tl))return bad(res,'Трейд-ссылка неверная: нужна целая ссылка с partner и token');x.tl=b.tl||'';save();return send(res,200,{ok:true})}
 if(p=='/api/password'){if(!x.h||x.h!==hash(String(b.old||''),x.s))return bad(res,'Старый пароль неверный');if(String(b.new||'').length<6)return bad(res,'Новый пароль от 6 символов');x.s=crypto.randomBytes(8).toString('hex');x.h=hash(b.new,x.s);save();return send(res,200,{ok:true})}
 if(p=='/api/2fa/setup'){if(x.totp)return bad(res,'2FA уже включена');x.tmp=b32e(crypto.randomBytes(20));save();return send(res,200,{secret:x.tmp,url:`otpauth://totp/cs2pay:${encodeURIComponent(n)}?secret=${x.tmp}&issuer=cs2pay`})}
 if(p=='/api/2fa/enable'){if(!x.tmp||!chk(x.tmp,b.code))return bad(res,'Неверный код');x.totp=x.tmp;delete x.tmp;save();return send(res,200,{ok:true})}
 if(p=='/api/2fa/disable'){if(!x.totp||!chk(x.totp,b.code))return bad(res,'Неверный код');if(x.h&&x.h!==hash(String(b.password||''),x.s))return bad(res,'Неверный пароль');delete x.totp;save();return send(res,200,{ok:true})}
 if(p=='/api/sell'){const ss=[].concat(b.ids||[]).slice(0,20).map(i=>skins.find(s=>s.id==i)).filter(Boolean);
  if(!ss.length)return bad(res,'Скины не найдены, обнови страницу');if(!TL.test(b.tl||''))return bad(res,'Укажи верную трейд-ссылку Steam');
  x.tl=b.tl;const mult=1+(x.sellB||0)/100;x.sellB=0;
  for(const s of ss){const finalP=+(pr(s)*mult).toFixed(2);const o={id:db.orders.length+1,user:n,skin:s.id,img:s.img,price:finalP,tl:b.tl,status:'new',t:Date.now()};db.orders.push(o);note(fmtO(o),kbO(o),o.img)}
  save();return send(res,200,{ok:true,n:ss.length})}
 if(p=='/api/buy'){const s=skins.find(k=>k.id==b.id);if(!s)return bad(res,'Скин не найден, обнови страницу');if(!TL.test(b.tl||''))return bad(res,'Укажи верную трейд-ссылку Steam');
  const c=Math.round(bp(s)*100);if((x.bal||0)<c)return bad(res,'Не хватает баланса: нужно '+usd(c));
  x.bal-=c;x.tl=b.tl;const o={id:db.orders.length+1,user:n,skin:s.id,img:s.img,price:c/100,tl:b.tl,status:'buy',kind:'buy',t:Date.now()};db.orders.push(o);save();note(fmtO(o),kbO(o),o.img);return send(res,200,{ok:true})}
 if(p=='/api/deposit'){if(!CP)return bad(res,'Пополнение через Crypto-бот пока не подключено');const baseC=Math.round((+b.amount||0)*100);if(baseC<500||baseC>1e6)return bad(res,'Сумма от $5 до $10000');
  const mult=1+(x.depB||0)/100;const finalC=Math.round(baseC*mult);x.depB=0;
  const r=await cp('createInvoice',{asset:'USDT',amount:(baseC/100).toFixed(2),description:'Пополнение баланса cs2pay',expires_in:3600}).catch(()=>({}));
  if(!r.ok)return bad(res,'Crypto-бот не создал счёт, попробуй позже',502);const v=r.result;
  const o={id:db.ops.length+1,user:n,type:'dep',cents:finalC,baseCents:baseC,method:'Crypto-бот',status:'pending',inv:v.invoice_id,url:v.bot_invoice_url||v.pay_url,t:Date.now()};db.ops.push(o);save();return send(res,200,{ok:true,id:o.id,url:o.url})}
 if(p=='/api/withdraw'){const c=Math.round((+b.amount||0)*100),d=String(b.details||'').trim().replace(/\s+/g,' ').slice(0,100);
  const minC=Math.round((db.cfg.minWd||5)*100);
  if(c<minC)return bad(res,'Минимальный вывод $'+(db.cfg.minWd||5));
  if(c>(x.bal||0))return bad(res,'Недостаточно средств на балансе');
  if(db.cfg.reqDep!==false){
   const hasRealDep=db.ops.some(o=>o.user==n&&o.type=='dep'&&o.status=='done'&&o.inv);
   if(!hasRealDep)return bad(res,'Для вывода средств (включая бонусные) необходимо совершить хотя бы одно пополнение баланса');
  }
  if(x.totp&&!chk(x.totp,b.code))return bad(res,'Неверный код 2FA');
  if(b.method=='TRC20'&&!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(d))return bad(res,'Неверный адрес TRC20');
  if(b.method=='Crypto-бот'&&!/^@?\w{3,32}$/.test(d))return bad(res,'Укажи @username в Telegram');
  if(b.method=='Карта'&&!/^\d{13,19}$/.test(d.replace(/\s/g,'')))return bad(res,'Неверный номер карты');
  if(!['TRC20','Crypto-бот','Карта'].includes(b.method))return bad(res,'Способ вывода неверный');
  x.bal-=c;const o={id:db.ops.length+1,user:n,type:'wd',cents:c,method:b.method,details:d,status:'pending',t:Date.now()};db.ops.push(o);save();note(fmtP(o),kbP(o));return send(res,200,{ok:true})}
 return bad(res,'404',404);
}catch(e){console.log(e);send(res,500,{error:'Ошибка сервера'})}}).listen(PORT,()=>console.log('http://localhost:'+PORT));
dbInit().then(()=>{load();setInterval(load,18e5);loadRates();setInterval(loadRates,36e5);settle();if(!DBU&&E.RENDER)note('<b>Внимание:</b> не задан DATABASE_URL. Аккаунты и заявки пропадут при обновлении сайта. Подключи базу PostgreSQL в Render.')}).catch(e=>{console.log('DB ERROR',e.message);process.exit(1)});

const flushNow=()=>{clearTimeout(st);return Promise.resolve().then(()=>pool?pool.query("insert into kv(k,v) values('db',$1) on conflict(k) do update set v=$1",[JSON.stringify(db)]):fs.writeFileSync('data.json',JSON.stringify(db))).catch(()=>{})};
process.on('SIGTERM',()=>flushNow().then(()=>process.exit(0)));

if(TOKEN&&ADMIN)setInterval(()=>backup(ADMIN).catch(()=>{}),864e5);