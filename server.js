const http=require('http'),fs=require('fs'),crypto=require('crypto'),path=require('path');
const E=process.env,PORT=E.PORT||3000,TOKEN=E.BOT_TOKEN,ADMIN=E.ADMIN_CHAT_ID,GID=E.GOOGLE_CLIENT_ID,CP=E.CRYPTO_PAY_TOKEN,CPH=E.CRYPTO_PAY_TESTNET?'testnet-pay.crypt.bot':'pay.crypt.bot',DBU=E.DATABASE_URL;
let db={users:{},orders:[],ops:[],sess:{}},pool=null,skins=[],lastErr='',loadedAt=0;
async function dbInit(){
 if(DBU){const{Pool}=require('pg');pool=new Pool({connectionString:DBU,ssl:{rejectUnauthorized:false}});await pool.query('create table if not exists kv(k text primary key,v jsonb)');const r=await pool.query("select v from kv where k='db'");if(r.rows[0])db=r.rows[0].v;console.log('DB: postgres')}
 else{try{db=JSON.parse(fs.readFileSync('data.json'))}catch{}console.log('DB: data.json (на Render пропадёт при перезапуске, задай DATABASE_URL)')}
 db.users=db.users||{};db.orders=db.orders||[];db.ops=db.ops||[];db.sess=db.sess||{};db.cfg=db.cfg||{adj:0,notice:''}}
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
/* telegram */
const tg=(m,b)=>fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const OS={new:'новая',accepted:'принята, hold 7 дней',credited:'зачислена на баланс',rejected:'отклонена'},PS={pending:'ожидает',done:'выполнено',rejected:'отклонено'};
const pr=s=>Math.max(.01,+(s.p*(1+(db.cfg.adj||0)/100)).toFixed(2));
const usd=c=>'$'+(c/100).toFixed(2);
const fmtO=o=>`Продажа #${o.id} (${OS[o.status]})\n${o.skin}\n${usd(Math.round(o.price*100))}\nПользователь: ${o.user}\n${o.tl}`;
const fmtP=p=>`${p.type=='dep'?'Пополнение':'Вывод'} #${p.id} (${PS[p.status]})\n${usd(p.cents)}${p.method?' · '+p.method+': '+p.details:''}\nПользователь: ${p.user}`;
const kbO=o=>({inline_keyboard:o.status=='new'?[[{text:'Принять',callback_data:'o:accepted:'+o.id},{text:'Отклонить',callback_data:'o:rejected:'+o.id}]]:[]});
const kbP=p=>({inline_keyboard:p.status=='pending'&&p.type=='wd'?[[{text:'Выплачено',callback_data:'p:done:'+p.id},{text:'Отклонить',callback_data:'p:rejected:'+p.id}]]:[]});
const note=(t,k)=>{if(TOKEN&&ADMIN)tg('sendMessage',{chat_id:ADMIN,text:t,reply_markup:k}).catch(()=>{})};
async function adminCmd(c,a,chat){const say=t=>tg('sendMessage',{chat_id:chat,text:t}),U=l=>db.users[String(l||'').toLowerCase()],sum=(l,f)=>l.reduce((t,x)=>t+f(x),0);
 if(c=='/price'){if(a[0]===undefined)return say('Корректировка цен сейчас: '+(db.cfg.adj>0?'+':'')+db.cfg.adj+'%\n/price -10 понизить все цены на 10%\n/price 5 повысить на 5% (максимум +15)\n/price 0 вернуть рыночные цены');
  const v=parseFloat(String(a[0]).replace(',','.'));if(isNaN(v)||v<-90||v>15)return say('Допустимо от -90 до +15');db.cfg.adj=v;save();
  return say('Готово. Цены на сайте: '+(v>0?'+':'')+v+'% к рынку. Действует на новые заявки, на сайте показан баннер.')}
 if(c=='/stats'){const cnt=s=>db.orders.filter(o=>o.status==s).length,pend=t=>db.ops.filter(o=>o.type==t&&o.status=='pending');
  return say(`Пользователей: ${Object.keys(db.users).length}\nСкинов в каталоге: ${skins.length}\nЗаявки: новые ${cnt('new')}, на hold ${cnt('accepted')}, зачислено ${cnt('credited')}, отклонено ${cnt('rejected')}\nСумма на балансах: ${usd(sum(Object.values(db.users),x=>x.bal||0))}\nВыводы в ожидании: ${pend('wd').length} на ${usd(sum(pend('wd'),o=>o.cents))}\nПополнения в ожидании: ${pend('dep').length} на ${usd(sum(pend('dep'),o=>o.cents))}\nКорректировка цен: ${db.cfg.adj}%`)}
 if(c=='/pending'){const O=db.orders.filter(o=>o.status=='new').slice(0,10),P=db.ops.filter(o=>o.type=='wd'&&o.status=='pending').slice(0,10);if(!O.length&&!P.length)return say('Ожидающих заявок нет');
  for(const o of O)await tg('sendMessage',{chat_id:chat,text:fmtO(o),reply_markup:kbO(o)});for(const p of P)await tg('sendMessage',{chat_id:chat,text:fmtP(p),reply_markup:kbP(p)});return}
 if(c=='/user'){const x=U(a[0]);if(!x)return say('Пользователь не найден');const l=a[0].toLowerCase();
  return say(`${l}${x.ban?' (заблокирован)':''}\nБаланс: ${usd(x.bal||0)}\n2FA: ${x.totp?'включена':'нет'}\nТрейд-ссылка: ${x.tl||'не указана'}\nЗаявок на скины: ${db.orders.filter(o=>o.user==l).length}\nОпераций кошелька: ${db.ops.filter(o=>o.user==l).length}`)}
 if(c=='/addbal'){const x=U(a[0]),v=Math.round(parseFloat(String(a[1]).replace(',','.'))*100);if(!x||!v)return say('Формат: /addbal логин 10.5 (можно с минусом)');x.bal=(x.bal||0)+v;
  db.ops.push({id:db.ops.length+1,user:a[0].toLowerCase(),type:v>0?'dep':'wd',cents:Math.abs(v),method:'Корректировка',details:'admin',status:'done',t:Date.now()});save();return say('Баланс '+a[0]+': '+usd(x.bal))}
 if(c=='/ban'||c=='/unban'){const x=U(a[0]);if(!x)return say('Пользователь не найден');x.ban=c=='/ban';save();return say(a[0]+(x.ban?' заблокирован':' разблокирован'))}
 if(c=='/notice'){const t=a.join(' ');db.cfg.notice=t=='off'?'':t;save();return say(db.cfg.notice?'Объявление на сайте: '+db.cfg.notice:'Объявление убрано')}
 if(c=='/help'||c=='/menu')return say('Команды:\n/stats статистика\n/pending заявки в ожидании\n/price -10 | 5 | 0 акция: изменить цены всех скинов в процентах\n/user логин данные пользователя\n/addbal логин сумма изменить баланс\n/ban логин и /unban логин\n/notice текст объявление на сайте, /notice off убрать')}
let off=0;(async()=>{if(!TOKEN)return console.log('BOT_TOKEN не задан: бот выключен');for(;;){try{
 if(!off)tg('setMyCommands',{commands:[{command:'stats',description:'Статистика'},{command:'pending',description:'Заявки в ожидании'},{command:'price',description:'Акция: цены в процентах'},{command:'user',description:'Данные пользователя'},{command:'addbal',description:'Изменить баланс'},{command:'ban',description:'Заблокировать'},{command:'unban',description:'Разблокировать'},{command:'notice',description:'Объявление на сайте'},{command:'help',description:'Список команд'}]}).catch(()=>{});
 const r=await tg('getUpdates',{offset:off,timeout:30});
 for(const u of r.result||[]){off=u.update_id+1;
  const m=u.message;if(m&&m.text&&m.text.startsWith('/start'))await tg('sendMessage',{chat_id:m.chat.id,text:'ID этого чата: '+m.chat.id+'\nУкажи его в ADMIN_CHAT_ID.'});
  if(m&&m.text&&m.text[0]=='/'&&String(m.chat.id)===String(ADMIN)){const[cm,...ar]=m.text.trim().split(/\s+/);try{await adminCmd(cm.split('@')[0].toLowerCase(),ar,m.chat.id)}catch(e){console.log(e)}}
  const c=u.callback_query;
  if(c&&String(c.message.chat.id)===String(ADMIN)){const[k,a,i]=c.data.split(':'),id=+i;let txt,kb;
   if(k=='o'){const o=db.orders.find(x=>x.id==id);if(o&&o.status=='new'){o.status=a;if(a=='accepted')o.hold=Date.now()+7*864e5;save()}if(o){txt=fmtO(o);kb=kbO(o)}}
   if(k=='p'){const p=db.ops.find(x=>x.id==id);if(p&&p.status=='pending'){p.status=a;const us=db.users[p.user];if((a=='done'&&p.type=='dep')||(a=='rejected'&&p.type=='wd'))us.bal=(us.bal||0)+p.cents;save()}if(p){txt=fmtP(p);kb=kbP(p)}}
   if(txt)await tg('editMessageText',{chat_id:ADMIN,message_id:c.message.message_id,text:txt,reply_markup:kb});
   await tg('answerCallbackQuery',{callback_query_id:c.id})}}
}catch(e){await new Promise(r=>setTimeout(r,5000))}}})();
function settle(){let ch=0;for(const o of db.orders)if(o.status=='accepted'&&o.hold<=Date.now()){o.status='credited';const u=db.users[o.user];u.bal=(u.bal||0)+Math.round(o.price*100);ch=1}if(ch)save()}
setInterval(settle,6e4);
/* Crypto Pay: пополнение только через Crypto-бот, зачисление автоматически после оплаты счёта */
const cp=(m,b)=>fetch(`https://${CPH}/api/${m}`,{method:'POST',headers:{'Crypto-Pay-API-Token':CP,'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
async function checkDeps(){if(!CP)return;const P=db.ops.filter(o=>o.type=='dep'&&o.status=='pending'&&o.inv);if(!P.length)return;try{
 const r=await cp('getInvoices',{invoice_ids:P.map(o=>o.inv).join(',')});
 for(const it of(r.result&&r.result.items)||[]){const o=P.find(x=>x.inv==it.invoice_id);if(!o||o.status!='pending')continue;
  if(it.status=='paid'&&Math.round(+it.amount*100)==o.cents){o.status='done';db.users[o.user].bal=(db.users[o.user].bal||0)+o.cents;save();note(`Пополнение #${o.id} оплачено через Crypto-бот\n${o.user}, ${usd(o.cents)}`)}
  else if(it.status=='expired'){o.status='rejected';save()}}}catch(e){console.log('crypto pay:',e.message)}}
setInterval(checkDeps,2e4);
/* http */
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
const body=req=>new Promise(r=>{let d='';req.on('data',c=>{d+=c;if(d.length>1e5)req.destroy()});req.on('end',()=>{try{r(JSON.parse(d||'{}'))}catch{r({})}})});
const send=(res,c,o,h)=>{res.writeHead(c,{'Content-Type':'application/json',...h});res.end(JSON.stringify(o))};
const bad=(res,m,c=400,x)=>send(res,c,{error:m,...x});
const me=req=>{const sid=(/sid=(\w+)/.exec(req.headers.cookie||'')||[])[1],s=sid&&db.sess[sid];return s&&Date.now()-s.t<30*864e5&&db.users[s.n]&&!db.users[s.n].ban?s.n:null};
const start=(req,res,n)=>{const sid=crypto.randomBytes(24).toString('hex');db.sess[sid]={n,t:Date.now()};save();send(res,200,{name:n},{'Set-Cookie':`sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.headers['x-forwarded-proto']=='https'?'; Secure':''}`})};
const pub=n=>{const u=db.users[n];return{name:n,bal:u.bal||0,tl:u.tl||'',tfa:!!u.totp,google:!!u.google,orders:db.orders.filter(o=>o.user==n).map(({id,skin,img,price,status,hold,t})=>({id,skin,img,price,status,hold,t})),ops:db.ops.filter(o=>o.user==n)}};
const fails={};const lim=k=>{const f=fails[k]=(fails[k]||[]).filter(t=>Date.now()-t<6e5);return f.length>=8};
const TL=/^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d+&token=[\w-]+$/;
http.createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://x'),p=u.pathname;
 if(!p.startsWith('/api/')){const root=path.join(__dirname,'public'),f=path.join(root,p=='/'?'index.html':path.normalize(p));
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('404')}
  res.writeHead(200,{'Content-Type':f.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream','Cache-Control':'no-cache'});return fs.createReadStream(f).pipe(res)}
 if(p=='/api/config')return send(res,200,{gid:GID||'',cp:!!CP,adj:db.cfg.adj||0,notice:db.cfg.notice||''});
 if(p=='/api/health')return send(res,200,{skins:skins.length,loadedAt,lastErr,db:pool?'postgres':'file',users:Object.keys(db.users).length});
 if(p=='/api/market'){const g=k=>u.searchParams.get(k)||'',q=g('q').toLowerCase(),pg=+g('page')||1,mn=+g('min')||0,mx=+g('max')||1e9,so=g('sort');
  let f=skins.filter(s=>(!q||s.n.toLowerCase().includes(q))&&(!g('r')||s.r==g('r'))&&(!g('t')||s.t==g('t'))&&(!g('w')||s.w==g('w'))&&pr(s)>=mn&&pr(s)<=mx&&(!g('st')||s.n.includes('StatTrak')==(g('st')=='1')));
  if(so=='asc')f=f.slice().sort((a,b)=>a.p-b.p);else if(so=='name')f=f.slice().sort((a,b)=>a.n.localeCompare(b.n));
  const uq=k=>[...new Set(skins.map(s=>s[k]))].filter(Boolean);
  return send(res,200,{total:f.length,all:skins.length,items:f.slice((pg-1)*48,pg*48).map(s=>({...s,p:pr(s)})),rarities:uq('r'),cats:uq('t'),wears:uq('w')})}
 if(p=='/api/register'){const b=await body(req),l=String(b.login||'').trim().toLowerCase(),pw=String(b.password||'');
  if(!/^[a-z0-9_.@-]{3,40}$/.test(l))return bad(res,'Логин: 3–40 символов, латиница, цифры, _ . - @');
  if(pw.length<6)return bad(res,'Пароль от 6 символов');
  if(db.users[l])return bad(res,'Такой логин уже занят',409);
  const s=crypto.randomBytes(8).toString('hex');db.users[l]={s,h:hash(pw,s),bal:0,created:Date.now()};save();return start(req,res,l)}
 if(p=='/api/login'){const b=await body(req),l=String(b.login||'').trim().toLowerCase(),x=db.users[l];
  if(lim(l))return bad(res,'Слишком много попыток, подожди 10 минут',429);
  if(!x||!x.h||x.h!==hash(String(b.password||''),x.s)){(fails[l]=fails[l]||[]).push(Date.now());return bad(res,'Неверный логин или пароль',401)}
  if(x.ban)return bad(res,'Аккаунт заблокирован',403);
  if(x.totp&&!chk(x.totp,b.code)){if(b.code)(fails[l]=fails[l]||[]).push(Date.now());return bad(res,b.code?'Неверный код 2FA':'Нужен код 2FA',401,{need2fa:true})}
  return start(req,res,l)}
 if(p=='/api/google'){const b=await body(req);const j=await fetch('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(b.credential||'')).then(r=>r.json());
  if(!GID||j.aud!==GID||!j.email)return bad(res,'Google-вход не прошёл',401);const l=j.email.toLowerCase();if(!db.users[l]){db.users[l]={google:true,bal:0,created:Date.now()};save()}return start(req,res,l)}
 if(p=='/api/logout'){const sid=(/sid=(\w+)/.exec(req.headers.cookie||'')||[])[1];if(sid){delete db.sess[sid];save()}return send(res,200,{},{'Set-Cookie':'sid=; Max-Age=0; Path=/'})}
 const n=me(req);
 if(p=='/api/me'){if(!n)return send(res,200,{});settle();return send(res,200,pub(n))}
 if(!n)return bad(res,'Войди в аккаунт',401);
 const x=db.users[n],b=req.method=='POST'?await body(req):{};
 if(p=='/api/settings'){if(b.tl&&!TL.test(b.tl))return bad(res,'Трейд-ссылка неверная: нужна целая ссылка с partner и token');x.tl=b.tl||'';save();return send(res,200,{ok:true})}
 if(p=='/api/password'){if(!x.h||x.h!==hash(String(b.old||''),x.s))return bad(res,'Старый пароль неверный');if(String(b.new||'').length<6)return bad(res,'Новый пароль от 6 символов');x.s=crypto.randomBytes(8).toString('hex');x.h=hash(b.new,x.s);save();return send(res,200,{ok:true})}
 if(p=='/api/2fa/setup'){if(x.totp)return bad(res,'2FA уже включена');x.tmp=b32e(crypto.randomBytes(20));save();return send(res,200,{secret:x.tmp,url:`otpauth://totp/cs2pay:${encodeURIComponent(n)}?secret=${x.tmp}&issuer=cs2pay`})}
 if(p=='/api/2fa/enable'){if(!x.tmp||!chk(x.tmp,b.code))return bad(res,'Неверный код');x.totp=x.tmp;delete x.tmp;save();return send(res,200,{ok:true})}
 if(p=='/api/2fa/disable'){if(!x.totp||!chk(x.totp,b.code))return bad(res,'Неверный код');if(x.h&&x.h!==hash(String(b.password||''),x.s))return bad(res,'Неверный пароль');delete x.totp;save();return send(res,200,{ok:true})}
 if(p=='/api/sell'){const ss=[].concat(b.ids||[]).slice(0,20).map(i=>skins.find(s=>s.id==i)).filter(Boolean);
  if(!ss.length)return bad(res,'Скины не найдены, обнови страницу');if(!TL.test(b.tl||''))return bad(res,'Укажи верную трейд-ссылку Steam');
  x.tl=b.tl;for(const s of ss){const o={id:db.orders.length+1,user:n,skin:s.id,img:s.img,price:pr(s),tl:b.tl,status:'new',t:Date.now()};db.orders.push(o);note(fmtO(o),kbO(o))}
  save();return send(res,200,{ok:true,n:ss.length})}
 if(p=='/api/deposit'){if(!CP)return bad(res,'Пополнение через Crypto-бот пока не подключено');const c=Math.round((+b.amount||0)*100);if(c<500||c>1e6)return bad(res,'Сумма от $5 до $10000');
  const r=await cp('createInvoice',{asset:'USDT',amount:(c/100).toFixed(2),description:'Пополнение баланса cs2pay',expires_in:3600}).catch(()=>({}));
  if(!r.ok)return bad(res,'Crypto-бот не создал счёт, попробуй позже',502);const v=r.result;
  const o={id:db.ops.length+1,user:n,type:'dep',cents:c,method:'Crypto-бот',status:'pending',inv:v.invoice_id,url:v.bot_invoice_url||v.pay_url,t:Date.now()};db.ops.push(o);save();return send(res,200,{ok:true,id:o.id,url:o.url})}
 if(p=='/api/withdraw'){const c=Math.round((+b.amount||0)*100),d=String(b.details||'').trim().replace(/\s+/g,' ').slice(0,100);
  if(c<500)return bad(res,'Минимальный вывод $5');if(c>(x.bal||0))return bad(res,'Недостаточно средств на балансе');
  if(x.totp&&!chk(x.totp,b.code))return bad(res,'Неверный код 2FA');
  if(b.method=='TRC20'&&!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(d))return bad(res,'Неверный адрес TRC20');
  if(b.method=='Crypto-бот'&&!/^@?\w{3,32}$/.test(d))return bad(res,'Укажи @username в Telegram');
  if(b.method=='Карта'&&!/^\d{13,19}$/.test(d.replace(/\s/g,'')))return bad(res,'Неверный номер карты');
  if(!['TRC20','Crypto-бот','Карта'].includes(b.method))return bad(res,'Способ вывода неверный');
  x.bal-=c;const o={id:db.ops.length+1,user:n,type:'wd',cents:c,method:b.method,details:d,status:'pending',t:Date.now()};db.ops.push(o);save();note(fmtP(o),kbP(o));return send(res,200,{ok:true})}
 return bad(res,'404',404);
}catch(e){console.log(e);send(res,500,{error:'Ошибка сервера'})}}).listen(PORT,()=>console.log('http://localhost:'+PORT));
dbInit().then(()=>{load();setInterval(load,18e5);settle()}).catch(e=>{console.log('DB ERROR',e.message);process.exit(1)});
