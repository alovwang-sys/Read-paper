
const $=s=>document.querySelector(s),E=s=>String(s).replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';'),cl=n=>Math.max(1,Math.min(20,n));
let nid=4,oc=0,opener=null,noticeTimer,doc='研究笔记（样例）\n\n一、检索式A与B在未限定年份时召回接近。\n二、待补：限定年份后的对照。';
const st={cur:1,view:'chat',ref:0,page:12,ret:null,rs:'0'};
const board=[{x:'检索式B对同义词扩展更敏感（样例）'},{x:'限定2018年后样本量减少约三成（样例）'},{x:'样例论文A表3可作为主要对照'}];
const A=(x,a)=>({r:'a',a,st:'ok',x});
const S=[
{id:1,rs:'0',t:'比较检索条件',a:'Claude Code',m:[{r:'u',x:'比较检索式A和B在近五年文献中的召回差异'},A('初步看B召回更高，需要核对限定年份后的结果。','Codex')],d:'限定2018年后再比较一次',g:['检索式B']},
{id:2,rs:'0',t:'补查证据',a:'Claude Code',m:[{r:'u',x:'样例论文A里有没有支持B的数据？'},A('第4页方法部分描述了检索式构造，数据表在后文。','Claude Code')],d:'',g:['样例论文A·第4页']},
{id:3,rs:'0',t:'旧 Codex 原生记录',a:'Codex',nat:1,m:[{r:'u',x:'整理一张检索式对照表'},A('已列出A/B在三个数据库中的命中数（样例）。','Codex')],d:'对照表里补上去重后的数量',g:['对照表草稿']}];
S.push({id:4,rs:'1',t:'确定综述范围',a:'Codex',m:[],d:'先列出综述要回答的问题',g:[]});
const cur=()=>S.find(s=>s.id==st.cur),ta=$('#ta');
let collected=false;
const sendIcon='<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
function notice(text){clearTimeout(noticeTimer);$('#notice').textContent=text;$('#notice').hidden=false;noticeTimer=setTimeout(()=>$('#notice').hidden=true,2600)}
const smallScreen=()=>matchMedia('(max-width:900px)').matches;
function nearBottom(){const v=$('#V');return v.scrollHeight-v.clientHeight-v.scrollTop<80}
function bottom(){const v=$('#V');v.scrollTop=v.scrollHeight;cur().scroll=v.scrollTop}

const quote=n=>n==12?'表3（样例数据）：限定2018年后，检索式B召回0.81，检索式A召回0.66。作者指出差异主要来自同义词扩展。':n==4?'方法（样例）：检索式A为标题关键词组合；检索式B加入同义词与主题词扩展。':`样例论文A第${n}页的示例正文，合成文本，仅用于演示阅读与引用。`;
const pg=n=>`<div class=paper-kicker>RESEARCH NOTE · 示例文献</div><h3>检索扩展与证据覆盖</h3><p>本页比较两种检索策略在相同年份限制下的结果，并讨论它们的适用条件。</p><p><mark>${quote(n)}</mark></p><p>不同数据库与去重方式可能改变结果，跨任务比较仍需补充对照。</p><div class=paper-page>PDF 第 ${n} 页</div>`;
const ANS=`<p><b>结论</b>：限定2018年后，检索式B召回仍高于A（0.81 对 0.66）。</p><ul><li>差异主要来自同义词扩展。</li><li>样本量下降，建议在另一数据库补查。</li></ul><p>依据 <button class=cite data-act=cite data-p=12>样例论文A · PDF第12页 ↗</button></p>`;
const RES={pdf:'样例论文A',card:'文献卡片',board:'白板',doc:'研究笔记',library:'资料库'};
S[0].m[1].h='<p><b>检索式B的召回更高，但还不能直接把它当成更可靠的结论。</b></p><p>样例论文A的对照结果是B为0.81、A为0.66；实验中同时改变了同义词扩展，需把“检索数量”和“相关性”分开比较。</p><ul><li>先确认两组使用相同的年份、数据库与去重条件。</li><li>把不相关文献的比例作为独立变量再比较一次。</li></ul><p>核对依据 <button class="cite" data-act="cite" data-p="12">样例论文A · PDF第12页 ↗</button></p>';
function candidate(){return '<div class="source-result"><div><strong>检索扩展的跨库对照（样例B）</strong><span class="mut">题录与摘要 · 尚无全文</span></div><button data-act="keep" '+(collected?'disabled':'')+'>'+(collected?'已收录':'收录文献')+'</button></div>'}

function rows(){const q=$('#q').value.trim(),L=S.filter(s=>s.rs==st.rs&&s.t.includes(q));
$('#rows').innerHTML=L.length?L.map(s=>`<button class="row${s.id==st.cur?' on':''}${s.un?' un':''}" data-act=go data-id=${s.id} aria-label="${E(s.t)}${s.un?'，有新回复':''}${s.run?'，处理中':''}"${s.id==st.cur?' aria-current=true':''}><span>${E(s.t)}</span>${s.run?'<i class=sp></i>':s.un?'<i class=dot></i>':''}</button>`).join(''):'<div class=mut style="padding:6px 8px">没有匹配的会话</div>';
$('#lib').innerHTML=Object.entries(RES).map(([k,v])=>`<button class="row${st.view==k?' on':''}" data-act=open data-v=${k}><span>${v}</span></button>`).join('')}
function msg(m,i){if(m.r=='u')return`<div class=u>${E(m.x)}${m.g&&m.g.length?'<div>'+m.g.map(t=>`<span class=chip>${E(t)}</span>`).join('')+'</div>':''}</div>`;
return`<div class=a id=m${i}><div class=n>${E(m.a)}</div>${m.st=='run'?'<p class=mut role="status">正在查阅资料…</p>':['fail','stopped'].includes(m.st)?`<p class=err>${m.st=='stopped'?'已停止，已完成内容保留。':'连接中断，尚未完成。'} <button data-act=retry data-i=${i}>重试</button></p>`:m.h?m.h+candidate():`<p>${E(m.x)}</p>`}</div>`}
function res(v){if(v=='library')return `<div class=w><p class=mut>本研究资料</p><div class=source-result><div><strong>样例论文A</strong><span class=mut>已保存 PDF</span></div><button data-act=open data-v=pdf>阅读</button></div>${collected?'<div class=source-result><div><strong>检索扩展的跨库对照（样例B）</strong><span class=mut>已收录 · 题录与摘要</span></div><button data-act=open data-v=card>查看</button></div>':'<p class=mut>会话里收录的文献会出现在这里。</p>'}</div>`;if(v=='pdf')return`<div class=w><div class=bar><button data-act=pg data-d=-1 aria-label="上一页">‹</button><span>第 ${st.page} / 20 页</span><button data-act=pg data-d=1 aria-label="下一页">›</button><button data-act=add data-t="样例论文A·第${st.page}页">加入本页提问</button></div><div class=pg>${pg(st.page)}</div></div>`;
if(v=='board')return`<div class=cards>${board.map((b,i)=>`<div class=card><p>${E(b.x)}</p><button data-act=add data-t="白板卡片${i+1}">加入提问</button></div>`).join('')}</div>`;
if(v=='doc')return`<div class=w style="max-width:none"><div class=bar style="margin-bottom:8px"><span class=mut>自动保存</span><button data-act=add data-t="研究笔记（文稿）">加入提问</button></div><textarea id=doc aria-label="文稿正文">${E(doc)}</textarea></div>`;
return`<div class=w><div class=card><b>样例论文A</b><p class=mut>样例 · 作者甲、作者乙 · 2021 · 自制样例，无DOI</p><p>研究检索式扩展对召回的影响。</p><button data-act=cite data-p=1>打开PDF</button></div></div>`}
function main(){const s=cur(),v=st.view;let h='<button class=tg data-act=nav aria-label="展开侧栏">☰</button>';
if(v=='chat'){const r=s.ret?.v;if(r)h+=`<button class=return-link data-act=return>← 回到${RES[r]}</button>`;h+=`<h1>${E(s.t)}</h1>`;
$('#V').innerHTML=`<div class=w id=thread>${s.m.map(msg).join('')||'<div class=empty-chat><h2>想弄清楚什么？</h2><p class=mut>从一个问题开始，资料和结果都留在这段对话里。</p></div>'}</div>`}
else{h+=`<button class=return-link data-act=chat>← 返回会话${s.un?' · 新回复':''}</button><h1>${RES[v]}</h1>`;$('#V').innerHTML=res(v)}
$('#hd').innerHTML=h;$('#to').innerHTML='';if(v=='chat')$('#V').scrollTop=s.scroll||0;chips();bar()}
function chips(){$('#chips').innerHTML=cur().g.map((t,i)=>`<span class=chip>${E(t)}<button data-act=rm data-i=${i} aria-label="移除${E(t)}">×</button></span>`).join('')}
function bar(){const s=cur();$('#ab').innerHTML=E(s.a)+' <span aria-hidden="true">⌄</span>';$('#ab').disabled=!!s.run;$('#hint').textContent='';$('#sb').innerHTML=s.run?'■':sendIcon;$('#sb').setAttribute('aria-label',s.run?'停止回答':'发送');$('#sb').disabled=!s.run&&!ta.value.trim();$('#latest').hidden=!s.un;}
function ref(){const R=$('#R');document.body.classList.toggle('ro',!!st.ref);$('#G').classList.toggle('nr',!st.ref);R.hidden=!st.ref;if(!st.ref)return;
R.innerHTML=`<div class=rh><b>样例论文A <span class=mut>· 第${st.ref}页</span></b><button data-act=full>全文阅读</button><button data-act=add data-t="样例论文A·第${st.ref}页">加入提问</button><button data-act=x aria-label="关闭原文">×</button></div><div style="overflow:auto"><div class=pg>${pg(st.ref)}</div><div class=bar style="padding:0 12px"><button data-act=rp data-d=-1 aria-label="上一页">‹</button><button data-act=rp data-d=1 aria-label="下一页">›</button></div></div>`}
function render(){rows();main();ref()}
$('#V').addEventListener('scroll',()=>{if(st.view=='chat'){cur().scroll=$('#V').scrollTop; if(nearBottom()&&cur().un){cur().un=0;rows();bar();}}});
function closeNav(f){const L=$('#L');if(L.classList.contains('on')){L.classList.remove('on');f&&$('.tg')&&$('.tg').focus()}}
function menuH(){const s=cur();return ['Codex','Claude Code','OpenCode'].map(n=>n=='OpenCode'&&!oc?`<div class=mi><span>OpenCode</span><button data-act=conn aria-label="连接OpenCode（模拟）">连接</button></div>`:s.nat&&n!=s.a?`<button class=mi data-act=fork data-n="${n}"><span>${n}</span><span class=mut>新会话</span></button>`:`<button class=mi aria-pressed=${n==s.a} data-act=pick data-n="${n}"><span>${n}</span><span class=mut>${n==s.a?'✓':''}</span></button>`).join('')}
function openMenu(o){const m=$('#menu');m.hidden=!o;$('#ab').setAttribute('aria-expanded',o);if(o){m.innerHTML=menuH();const f=m.querySelector('button');f&&f.focus()}}
function run(s,m){s.run=1;m.st='run';s.timer=setTimeout(()=>{const visible=st.cur==s.id&&st.view=='chat',follow=visible&&nearBottom();s.run=0;if(m.f){m.f=0;m.st='fail'}else{m.st='ok';m.h=ANS}if(!visible||!follow)s.un=1;
if(visible){main();if(follow)bottom()}rows();bar();},1800)}
const act={
go(b){st.cur=+b.dataset.id;st.view='chat';const s=cur(),u=s.un;s.un=0;ta.value=s.d;st.ref=smallScreen()?0:s.reference||0;openMenu(0);closeNav();render();const as=document.querySelectorAll('#V .a');u&&as.length?as[as.length-1].scrollIntoView({block:'start'}):($('#V').scrollTop=s.scroll||0)},
new(){const s={id:++nid,rs:st.rs,t:'新会话',a:cur().a,m:[],d:'',g:[]};S.unshift(s);act.go({dataset:{id:s.id}});ta.focus()},
lib(b){const l=$('#lib'),o=l.hidden;l.hidden=!o;b.setAttribute('aria-expanded',o);b.textContent='资料与成果 '+(o?'▾':'▸')},
open(b){if(st.view=='chat')cur().scroll=$('#V').scrollTop;st.view=b.dataset.v;if(st.view=='pdf'&&st.ref){st.page=st.ref;st.ref=0}if(['board','doc','library'].includes(st.view))st.ref=0;closeNav();render();$('#V').scrollTop=0},
chat(){st.view='chat';const unread=cur().un;cur().un=0;st.ref=smallScreen()?0:cur().reference||0;render();if(unread)bottom()},
cite(b){opener=b;st.ref=+b.dataset.p;cur().reference=st.ref;closeNav();ref();$('#R [data-act=x]').focus()},
full(){cur().scroll=$('#V').scrollTop;st.page=st.ref;st.ref=0;st.view='pdf';render()},
x(){st.ref=0;cur().reference=0;ref();(opener&&document.contains(opener)?opener:ta).focus()},
rp(b){st.ref=cl(st.ref+ +b.dataset.d);cur().reference=st.ref;ref()},
pg(b){st.page=cl(st.page+ +b.dataset.d);main()},
add(b){const g=cur().g,t=b.dataset.t;if(!g.includes(t))g.push(t);chips();b.textContent='已加入'},
rm(b){cur().g.splice(+b.dataset.i,1);chips();ta.focus()},
menu(){openMenu($('#menu').hidden)},
pick(b){cur().a=b.dataset.n;openMenu(0);bar();$('#ab').focus()},
conn(){oc=1;openMenu(1);notice('示例连接已就绪')},
fork(b){const s=cur(),n={id:++nid,rs:s.rs,t:s.t+' · '+b.dataset.n,a:b.dataset.n,m:[],d:ta.value,g:[...s.g]};S.splice(S.indexOf(s)+1,0,n);act.go({dataset:{id:n.id}});ta.focus()},
send(){const s=cur(),x=ta.value.trim();if(s.run){clearTimeout(s.timer);s.run=0;const m=s.m.at(-1);m.st='stopped';render();return}if(!x)return;if(!s.m.length&&s.t=='新会话')s.t=x.slice(0,24);s.m.push({r:'u',x,g:s.g});s.g=[];s.d='';ta.value='';
if(st.view!='chat'){s.ret={v:st.view,page:st.page,scroll:$('#V').scrollTop};if(st.view=='pdf'){st.ref=st.page;s.reference=st.ref}else{st.ref=0;s.reference=0}st.view='chat'}
if(smallScreen())st.ref=0;const m={r:'a',a:s.a,f:/模拟失败/.test(x)};s.m.push(m);run(s,m);render();bottom();ta.focus()},
retry(b){const s=cur();run(s,s.m[+b.dataset.i]);render()},
keep(){if(collected)return;collected=true;const top=$('#V').scrollTop;main();$('#V').scrollTop=top;notice('文献已收录，可在资料库查看')},
return(){const r=cur().ret;if(!r)return;st.view=r.v;st.page=r.page;st.ref=0;render();$('#V').scrollTop=r.scroll||0},
latest(){cur().un=0;st.view='chat';render();const as=document.querySelectorAll('#V .a');as[as.length-1]?.scrollIntoView({block:'start'});rows();bar()},
library(){act.open({dataset:{v:'library'}})},
research(){const m=$('#research-menu');m.hidden=!m.hidden;$('#rs').setAttribute('aria-expanded',!m.hidden);if(!m.hidden){m.querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',String(b.dataset.id==st.rs)));m.querySelector('button')?.focus()}},
study(b){st.rs=b.dataset.id;$('#q').value='';$('#research-name').textContent=st.rs=='0'?'检索策略比较研究':'综述写作准备';$('#research-menu').hidden=true;$('#rs').setAttribute('aria-expanded',false);const f=S.find(s=>s.rs==st.rs);act.go({dataset:{id:f.id}})},
image(){if(!cur().g.includes('图片示例'))cur().g.push('图片示例');chips();ta.focus()},
voice(){notice('系统听写入口示例；原型不录音');ta.focus()},
nav(){const L=$('#L'),o=!L.classList.contains('on');L.classList.toggle('on',o);if(o){st.ref=0;ref();$('#rs').focus()}}};
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!e.target.closest('.research-switch')){$('#research-menu').hidden=true;$('#rs').setAttribute('aria-expanded',false);}if(!$('#menu').hidden&&!e.target.closest('#mw'))openMenu(0);
if($('#L').classList.contains('on')&&!e.target.closest('#L')&&!(b&&b.dataset.act=='nav'))closeNav();if(b&&!b.disabled&&act[b.dataset.act])act[b.dataset.act](b)});
document.addEventListener('keydown',e=>{if(e.key=='Escape'){if(!$('#research-menu').hidden){$('#research-menu').hidden=true;$('#rs').setAttribute('aria-expanded',false);$('#rs').focus()}else if(!$('#menu').hidden){openMenu(0);$('#ab').focus()}else if(st.ref)act.x();else closeNav(1)}
if(e.key=='Enter'&&!e.shiftKey&&e.target==ta&&!e.isComposing){e.preventDefault();act.send()}});
document.addEventListener('input',e=>{if(e.target.id=='doc')doc=e.target.value});
ta.oninput=()=>{cur().d=ta.value;bar()};$('#q').oninput=rows;

ta.value=cur().d;render();
