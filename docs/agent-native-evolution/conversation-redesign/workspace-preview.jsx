import React, {useRef, useState, useLayoutEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {BookOpen, MessageCircle, Mic, ArrowUp, PanelRightClose, PanelRightOpen, Columns2, Maximize2, X, ChevronDown, Pencil, Image, ShieldCheck, Search, Plus, ArrowLeft, ExternalLink, NotebookText} from 'lucide-react';
import BoardPreview from './workspace-preview-board.jsx';
import ConversationPicker, {materialKey} from './workspace-conversation-picker.jsx';
import {PaperPreview, sourceAnchorKey} from './workspace-paper-notes.jsx';
import {briefIdentity,createBriefCache,sampleBrief,requestSnapshot} from './workspace-paper-brief.js';
import NotesPanel from './workspace-notes-panel.jsx';
import './workspace-preview.css';

const PAGE={board:'研究白板',pdf:'样例论文A',draft:'研究笔记',sources:'研究资料',global:'全局资料库',chat:'当前对话'};
const initial=[{id:1,title:'比较检索条件',provider:'Codex',draft:'',messages:[{role:'user',text:'帮我比较检索式A和B，并整理需要补查的证据。'},{role:'assistant',text:'B的召回更高，但“找到更多”和“证据更可靠”需要分开判断。\n\n可以先确认年份、数据库与去重条件，再补查不相关文献的比例。白板里保留了目前的判断与待核查点。'}]}, {id:2,title:'补查证据',provider:'Codex',draft:'对照条件还缺哪些？',messages:[]}];
function App(){
 const [page,setPage]=useState('board'),[focus,setFocus]=useState(null),[mode,setMode]=useState('side');
 const [groups,setGroups]=useState([{id:'group-1',active:'view-board',views:[{id:'view-board',kind:'board'},{id:'view-pdf',kind:'pdf',pdfPage:12},{id:'view-draft',kind:'draft'}]}]),[activeGroup,setActiveGroup]=useState('group-1');
 const [drag,setDrag]=useState(null),[dropTarget,setDropTarget]=useState(null);
 const viewIds=useRef(10),dragRef=useRef(null),viewScrolls=useRef(new Map()),pendingFloatAnchor=useRef(null);
 const split=groups.length>1;
 const [convs,setConvs]=useState(initial),[active,setActive]=useState(1),[materials,setMaterials]=useState({}),[linked,setLinked]=useState(false);
 const [popover,setPopover]=useState(null),[nav,setNav]=useState(false),[notice,setNotice]=useState(''),[doc,setDoc]=useState('检索策略比较\n\nB的召回较高，可靠性仍需核对。\n\n待补：相同年份、数据库与去重条件下的对照。');
 const [floatPosition,setFloatPosition]=useState(null),[inspect,setInspect]=useState(null),[search,setSearch]=useState('');
 const [excerpts,setExcerpts]=useState([]),[cards,setCards]=useState([]),[cardDrafts,setCardDrafts]=useState({}),[editingKey,setEditingKey]=useState(null),[cardEditorOpen,setCardEditorOpen]=useState(false);
 const [notesOpen,setNotesOpen]=useState(false),[focusNote,setFocusNote]=useState(null),[paperJump,setPaperJump]=useState(null),[noticeAction,setNoticeAction]=useState(null);
 const [operations,setOperations]=useState([]),[briefState,setBriefState]=useState({status:'idle',value:null}),[briefOpen,setBriefOpen]=useState(null);
 const briefScroll=useRef(0),restoreBriefScroll=useRef(false);
 const operationIds=useRef(0),briefCache=useRef(null);
 if(!briefCache.current)briefCache.current=createBriefCache(async()=>{await new Promise(resolve=>setTimeout(resolve,700));return sampleBrief()});
 const mainSurface=useRef(null),noteEvents=useRef(0);
 const cardDraft=cardDrafts[editingKey]||null;
 const noteIds=useRef(0);
 const live=useRef({active,mode,page});live.current={active,mode,page};
 const scroll=useRef(null),follow=useRef(true),scrolls=useRef(new Map());
 const globalReturn=useRef(null);
 const last=useRef({page:'board',mode:'side',split:false,focus:null}),ids=useRef(2),input=useRef(null),timer=useRef(null),imageInput=useRef(null),chatRun=useRef(new Map());
 const c=convs.find(x=>x.id===active),context=materials[active]||[];
 useLayoutEffect(()=>{const el=scroll.current;if(el){el.scrollTop=scrolls.current.get(active)??el.scrollHeight;follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80}},[active,mode]);
 useLayoutEffect(()=>{const el=scroll.current;if(el&&follow.current)el.scrollTop=el.scrollHeight},[c.messages.length,c.messages.at(-1)?.text]);
 useLayoutEffect(()=>{const element=scroll.current;if(!element)return;if(briefOpen===active){const details=element.querySelector('.inline-paper-brief');if(details)element.scrollTop+=details.getBoundingClientRect().top-element.getBoundingClientRect().top-8;}else if(restoreBriefScroll.current){element.scrollTop=briefScroll.current;restoreBriefScroll.current=false}},[briefOpen]);
 const patch=(id,values)=>setConvs(old=>old.map(x=>x.id===id?{...x,...(typeof values==='function'?values(x):values),updatedAt:Date.now()}:x));
 function toast(text,action=null){setNotice(text);setNoticeAction(()=>action);clearTimeout(timer.current);timer.current=setTimeout(()=>{setNotice('');setNoticeAction(null)},3200)}
 function openResource(value){
  const boardGroup=value==='board'?groups.find(g=>g.views.some(v=>v.kind==='board')):null;
  if(boardGroup){activateView(boardGroup.id,boardGroup.views.find(v=>v.kind==='board').id);setNav(false);if(mode==='closed')setMode('side');return}
  const group=groups.find(g=>g.id===activeGroup)||groups[0];
  const existing=group.views.find(v=>v.kind===value);
  const view=existing||{id:'view-'+(++viewIds.current),kind:value,...(value==='pdf'?{pdfPage:12}:{})};
  setGroups(old=>old.map(g=>g.id===group.id?{...g,active:view.id,views:existing?g.views:[...g.views,view]}:g));
  setActiveGroup(group.id);setPage(value);setNav(false);if(mode==='main'||mode==='closed')setMode('side');
 }
 function activateView(groupId,viewId){const view=groups.find(g=>g.id===groupId)?.views.find(v=>v.id===viewId);if(!view)return;setGroups(old=>old.map(g=>g.id===groupId?{...g,active:viewId}:g));setActiveGroup(groupId);setPage(view.kind);setFocus(old=>old?groupId:null);if(mode==='main')setMode('side')}
 function closeView(groupId,viewId){
  const next=groups.map(g=>{if(g.id!==groupId)return g;const index=g.views.findIndex(v=>v.id===viewId),views=g.views.filter(v=>v.id!==viewId);return {...g,views,active:g.active===viewId?views[Math.min(index,views.length-1)]?.id:g.active}}).filter(g=>g.views.length);
  if(!next.length){const view={id:'view-'+(++viewIds.current),kind:'sources'};next.push({id:groupId,active:view.id,views:[view]})}
  const current=next.find(g=>g.id===activeGroup)||next[0];setGroups(next);setActiveGroup(current.id);setPage(current.views.find(v=>v.id===current.active).kind);if(next.length===1||focus===groupId&&!next.some(g=>g.id===groupId))setFocus(null);
 }
 function splitCurrent(kind){
  const source=groups.find(g=>g.id===activeGroup)||groups[0];
  const current=source.views.find(v=>v.id===source.active);
  const target=groups.find(g=>g.id!==source.id);
  const value=kind||'pdf';
  const view={id:'view-'+(++viewIds.current),kind:value,...(value==='pdf'?{pdfPage:12}:{})};
  if(target){setGroups(old=>old.map(g=>g.id===target.id?{...g,views:[...g.views,view],active:view.id}:g));setActiveGroup(target.id)}
  else{const id='group-'+(++viewIds.current);setGroups(old=>[...old,{id,views:[view],active:view.id}]);setActiveGroup(id)}
  setPage(value);setFocus(null);if(mode==='main')setMode('side');
 }
 function finishDrag(){dragRef.current=null;setDrag(null);setDropTarget(null)}
 function dragOver(event,groupId){
  if(!dragRef.current)return;event.preventDefault();event.dataTransfer.dropEffect='move';
  const pane=event.currentTarget,box=pane.getBoundingClientRect(),x=event.clientX-box.x;
  const onTabs=event.clientY<box.y+40;
  const edge=onTabs?null:x<56?'left':x>box.width-56?'right':null;
  const tabs=[...pane.querySelectorAll('.resource-tab')];
  const index=onTabs?tabs.findIndex(tab=>event.clientX<tab.getBoundingClientRect().x+tab.getBoundingClientRect().width/2):-1;
  setDropTarget({groupId,edge:groups.length===1?edge:null,index:index<0?tabs.length:index,onTabs});
 }
 function dropView(event,groupId){
  if(!dragRef.current||!dropTarget)return;event.preventDefault();event.stopPropagation();
  const origin=dragRef.current,from=groups.find(g=>g.id===origin.groupId),view=from?.views.find(v=>v.id===origin.viewId),destination=groups.find(g=>g.id===groupId);
  if(!view||!destination){finishDrag();return}
  let next=groups.map(g=>({...g,views:[...g.views]})),chosenGroup=groupId,chosenView=view.id;
  if(dropTarget.edge&&groups.length===1){
   // shortcut: this design preview demonstrates two groups; production reuses the existing recursive pane host.
   const duplicate=view.kind!=='board';
   if(!duplicate&&from.views.length===1){toast('同一白板保留一个编辑视图；可先打开论文，再拖到侧边。');finishDrag();return}
   const copy=duplicate?{...view,id:'view-'+(++viewIds.current)}:view;
   if(duplicate)viewScrolls.current.set(copy.id,viewScrolls.current.get(view.id)||0);
   else{next[0].views=next[0].views.filter(v=>v.id!==view.id);if(next[0].active===view.id)next[0].active=next[0].views[0].id}
   const newGroup={id:'group-'+(++viewIds.current),active:copy.id,views:[copy]};
   next=dropTarget.edge==='left'?[newGroup,...next]:[...next,newGroup];chosenGroup=newGroup.id;chosenView=copy.id;
  }else{
   const sourceGroup=next.find(g=>g.id===origin.groupId),targetGroup=next.find(g=>g.id===groupId);
   const oldIndex=sourceGroup.views.findIndex(v=>v.id===view.id);
   sourceGroup.views=sourceGroup.views.filter(v=>v.id!==view.id);
   let index=dropTarget.onTabs?dropTarget.index:targetGroup.views.length;
   if(origin.groupId===groupId&&oldIndex<index)index--;
   targetGroup.views.splice(Math.max(0,index),0,view);targetGroup.active=view.id;
   if(sourceGroup!==targetGroup&&sourceGroup.active===view.id)sourceGroup.active=sourceGroup.views[Math.min(oldIndex,sourceGroup.views.length-1)]?.id;
   next=next.filter(g=>g.views.length);
  }
  setGroups(next);setActiveGroup(chosenGroup);setPage(view.kind);setFocus(null);finishDrag();
 }
 function updateView(id,values){setGroups(old=>old.map(g=>({...g,views:g.views.map(v=>v.id===id?{...v,...values}:v)})))}
 function openGlobal(){if(page==='global')return;globalReturn.current={page,mode,split,focus};setPage('global');setPopover(null);setNav(false)}
 function returnResearch(){const v=globalReturn.current??last.current;setPage(v.page);setMode(v.mode);setFocus(v.focus)}
 function choose(id){if(page==='global')returnResearch();setActive(id);patch(id,{unread:false});setPopover(null);setNav(false);if(mode==='closed')setMode(page==='chat'?'main':'side')}
 function newChat(){const id=++ids.current;setConvs(old=>[{id,title:'新对话',provider:c.provider,draft:'',messages:[]},...old]);setActive(id);setPage('chat');setMode('main');setPopover(null)}
 function chooseFromPicker(id,carry){
  if(carry&&id!==active&&context.length)setMaterials(old=>{const next=[...(old[id]||[])],keys=new Set(next.map(materialKey));for(const item of context)if(!keys.has(materialKey(item))){keys.add(materialKey(item));next.push({...item})}return {...old,[id]:next}});
  choose(id);
 }
 function newFromPicker(carry){const id=++ids.current;setConvs(old=>[{id,title:'新会话',provider:c.provider,draft:'',messages:[],updatedAt:Date.now()},...old]);if(carry&&context.length)setMaterials(old=>({...old,[id]:context.map(x=>({...x}))}));setActive(id);setPopover(null)}
 function floatPlacement(anchor){
  const width=360,height=420,gap=14,margin=8,minY=64,maxX=innerWidth-width-margin,maxY=innerHeight-height-margin;
  if(!anchor){const other=split?document.querySelector(`.resource-pane:not([data-group-id="${activeGroup}"])`):null;const r=other?.getBoundingClientRect();return r?{x:Math.max(margin,Math.min(maxX,r.x+(r.width-width)/2)),y:Math.max(minY,Math.min(maxY,r.y+24))}:null}
  const options=[{x:anchor.right+gap,y:anchor.top},{x:anchor.left-width-gap,y:anchor.top},{x:anchor.left,y:anchor.bottom+gap},{x:anchor.left,y:anchor.top-height-gap}];
  for(const option of options){const p={x:Math.max(margin,Math.min(maxX,option.x)),y:Math.max(minY,Math.min(maxY,option.y))};if(p.x+width<=anchor.left-gap||p.x>=anchor.right+gap||p.y+height<=anchor.top-gap||p.y>=anchor.bottom+gap)return p}
  return null;
 }
 function ask(payload,local=false,anchorElement=null){
  let id=active;
  if(local){
   const existing=payload.source&&convs.find(x=>x.source?.anchorId===payload.source.anchorId);
   if(existing){id=existing.id;patch(id,{unread:false})}
   else{id=++ids.current;setConvs(old=>[{id,title:payload.source?(payload.source.quote?payload.source.quote.slice(0,16)+(payload.source.quote.length>16?'…':''):'图形区域')+' · p'+payload.page:'关于'+payload.title,provider:c.provider,draft:'',messages:[],source:payload.source?structuredClone(payload.source):null},...old])}
   setActive(id);
  }
  setMaterials(old=>{const rows=old[id]||[];return {...old,[id]:payload.source&&rows.some(x=>x.source?.anchorId===payload.source.anchorId)?rows:[...rows,{...payload,id:Date.now()+Math.random()}]}});
  const position=floatPlacement(payload.anchor);pendingFloatAnchor.current=anchorElement?{element:anchorElement,anchor:payload.anchor}:null;
  setMode(payload.anchor&&(!position||mode==='side'&&!anchorElement)?'side':'float');setFloatPosition(position);setPopover(null);setInspect(null);closeNotes();
 }
 function recordAction(kind,source,values={}){const op={id:'action-'+(++operationIds.current),source:structuredClone(source),kind,status:'done',createdAt:Date.now(),...values};setOperations(old=>[...old,op]);return op}
 function updateAction(id,values){setOperations(old=>old.map(op=>op.id===id?{...op,...values}:op))}
 function readerAction(kind,source,target){
  const bound={...source,anchorId:source.anchorId||sourceAnchorKey(source)};
  if(kind==='question'){
   if(bound.kind==='region'&&c.provider!=='Codex'){toast('当前连接不支持区域图像，请切换支持图片的连接');return}
   ask({title:`样例论文A · 第${source.pageIndex+1}页`,documentId:source.documentId,text:source.quote||'区域示例（本原型未裁切图像）',page:source.pageIndex+1,anchor:source.anchor,source:bound},true,target);return;
  }
  if(kind==='translation'){
   if(!bound.quote){toast('这处没有可核对文字，无法翻译');return}
   const result=bound.quote.includes('召回')?'B has higher recall, but synonym expansion is another variable. This alone does not establish stronger evidence.':bound.quote.includes('跨数据库')?'Cross-database comparisons still need verification; record the queries and screening criteria.':bound.quote.includes('数据库')?'Keep the years, databases and deduplication criteria consistent when comparing the two retrieval strategies.':'This is a translation preview for the selected passage. The original quotation is preserved separately.';
   recordAction(kind,bound,{result:'示例译文（未调用模型）\n'+result});return;
  }
  if(kind==='highlight'){recordAction(kind,bound);return}
  if(kind==='excerpt'){saveExcerpt(bound);return}
  if(kind==='summary'&&bound.kind==='region'&&c.provider!=='Codex'){toast('当前连接不支持区域图像');return}
  if(kind==='translation-card'){
   const translation=operations.findLast(op=>op.kind==='translation'&&op.source.anchorId===bound.anchorId);
   if(!translation)return;
   const saved=operations.findLast(op=>op.source.anchorId===bound.anchorId&&op.noteKind==='translation');if(saved?.status==='draft'){resumePaperCard(Object.keys(cardDrafts).find(key=>cardDrafts[key].operationId===saved.id));return}
   const note=recordAction('card',bound,{status:'draft',noteKind:'translation'});editPaperCard(bound,null,{operationId:note.id,title:'翻译笔记',body:translation.result.replace(/^示例译文（未调用模型）\n/,''),kind:'translation'});return;
  }
  const existingDraft=Object.entries(cardDrafts).find(([,draft])=>draft.source.anchorId===bound.anchorId&&(draft.kind||'card')===kind);if(existingDraft){resumePaperCard(existingDraft[0]);return}
  const op=recordAction(kind,bound,{status:'draft'});
  editPaperCard(bound,null,{operationId:op.id,title:kind==='summary'?'选区摘要':'',body:kind==='summary'?(bound.quote.includes('召回')?'召回更高不足以证明证据更可靠，需要控制同义词扩展等检索条件。':bound.quote.includes('跨数据库')?'跨数据库比较需保留检索式与筛选标准，便于后续核验。':bound.quote.includes('去重')?'公平比较检索策略，需统一年份、数据库及去重标准。':bound.quote?'选区讨论检索策略的比较。':'区域内容摘要示例：正式版将依据裁图生成；本原型未识别图像内容。'):'',kind});
 }

 function openActivity(op){
  if(op.sessionId){const conv=convs.find(x=>x.id===op.sessionId);if(!conv)return;choose(conv.id);setMode('float');setFloatPosition(floatPlacement());closeNotes()}
  else if(op.cardId||op.targetId)showNotes(op.cardId||op.targetId);
  else if(op.status==='draft')resumePaperCard(Object.keys(cardDrafts).find(key=>cardDrafts[key].operationId===op.id));
 }
 async function prepareBrief(){
  const cached=briefCache.current.get(briefIdentity);if(cached)return cached;
  setBriefState({status:'loading',value:null});
  try{const value=await briefCache.current.prepare(briefIdentity);setBriefState({status:'ready',value});return value}
  catch(error){setBriefState({status:'error',value:null,error:error.message});throw error}
 }

 useLayoutEffect(()=>{const pending=pendingFloatAnchor.current;if(!pending||mode!=='float')return;pendingFloatAnchor.current=null;const r=pending.element.isConnected?pending.element.getBoundingClientRect():pending.anchor;const position=floatPlacement(r);if(position)setFloatPosition(position);else setMode('side')},[mode,context.length]);
 function inputOption(kind,event){const r=event.currentTarget.getBoundingClientRect();setPopover(popover?.kind===kind?null:{kind,anchor:{left:r.left,top:r.top}})}
 function attachImage(event){const file=event.target.files?.[0];event.target.value='';if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>8*1024*1024){toast('请选择8 MiB以内的PNG、JPEG或WebP图片');return}if(context.filter(m=>m.imageUrl).length>=4){toast('本轮最多保留4张图片');return}setMaterials(old=>({...old,[active]:[...(old[active]||[]),{id:Date.now(),title:file.name,text:'用户提供的图片；此预览不自动识别文字。',imageUrl:URL.createObjectURL(file)}]}))}
 function send(){
  if(c.running){const run=chatRun.current.get(c.id);if(run){run.cancelled=true;clearTimeout(run.timer);if(run.operationId)updateAction(run.operationId,{status:'stopped',result:'已停止，可继续此处提问'});chatRun.current.delete(c.id)}patch(c.id,{running:false,briefPending:false,messages:c.messages.map((m,i)=>i===c.messages.length-1?{...m,text:'已停止。你可以继续修改问题。'}:m)});return}
  const text=c.draft.trim();if(!text)return;
  if(c.provider!=='Codex'&&(c.source?.kind==='region'||context.some(m=>m.imageUrl||m.source?.kind==='region'))){toast('该连接仅支持文字，请保留选区并切回 Codex。');return}
  if(c.title==='新会话'||c.title==='新对话')patch(c.id,{title:text.slice(0,24)});
  const id=c.id,source=c.source?structuredClone(c.source):null,history=c.messages.map(m=>({role:m.role,text:m.text})),submitted=context.map(m=>structuredClone(m));
  const op=source?recordAction('question',source,{status:'running',sessionId:id}):null;
  const run={cancelled:false,operationId:op?.id,started:false};chatRun.current.set(id,run);
  const waiting=!!source&&!c.paperBrief;
  patch(id,{draft:'',running:true,briefPending:waiting,messages:[...c.messages,{role:'user',text,context:submitted},{role:'assistant',text:waiting?'正在准备文章简要 · 合成第12页 / 共20页':'正在整理这次问题…',provider:c.provider}]});
  setMaterials(old=>({...old,[id]:[]}));follow.current=true;
  const answer=brief=>{
   if(run.cancelled||run.started)return;run.started=true;
   const snapshot=requestSnapshot({source,history,brief});snapshot.materials=structuredClone(submitted);
   patch(id,s=>({briefPending:false,paperBrief:brief||s.paperBrief,messages:s.messages.map((m,i)=>i===s.messages.length-2?{...m,requestSnapshot:snapshot}:i===s.messages.length-1?{...m,text:'正在整理这次问题…'}:m)}));
   run.timer=setTimeout(()=>{
    if(run.cancelled)return;
    const result='示例回答：这处内容需要与原文证据分开核对。\n\n建议先对齐检索条件，再确认差异是否来自同义词扩展。'+(source?'\n\n本次围绕这处选区回答；文章简要仅作背景。':'你可以继续在原处追问，或打开引用核查。');
    patch(id,s=>({running:false,unread:live.current.active!==id||live.current.mode==='closed'||live.current.page==='global',messages:s.messages.map((m,i)=>i===s.messages.length-1?{...m,text:result}:m)}));
    if(op)updateAction(op.id,{status:'done',result,requestSnapshot:snapshot});chatRun.current.delete(id);
   },1300);
  };
  run.selectionOnly=()=>answer(null);
  if(source&&!c.paperBrief)prepareBrief().then(answer).catch(error=>{if(run.cancelled||run.started)return;patch(id,s=>({briefPending:false,running:false,messages:s.messages.map((m,i)=>i===s.messages.length-1?{...m,text:'文章简要准备失败：'+error.message+'。原选区保留，请重试。'}:m)}));updateAction(op.id,{status:'error',result:error.message});chatRun.current.delete(id)});
  else answer(c.paperBrief||null);
 }
 function showBrief(){
  if(briefOpen===c.id){restoreBriefScroll.current=true;setBriefOpen(null)}
  else{briefScroll.current=scroll.current?.scrollTop||0;setBriefOpen(c.id)}
 }
 function BriefDetails(){const value=c.paperBrief||briefState.value;return <section className="inline-paper-brief" aria-label="文章简要"><header><b>{value?value.title:'文章简要'}</b><button className="icon" aria-label="收起文章简要" onClick={showBrief}><X size={14}/></button></header><p>{value?.body||'首次实际提问时准备共享简要。本原型仅使用标题和合成第12页，其他页面未读取。'}</p>{value&&<small>覆盖：仅第{value.coverage.map(n=>n+1).join('、')}页 / 共{value.totalPages}页 · {value.provider}<br/>背景材料，不能作为原文引证。</small>}</section>}

 function showRequest(snapshot){setInspect({kind:'context',title:'本轮实际上下文',body:(snapshot.brief?snapshot.brief.title+'\n'+snapshot.brief.body:'本轮未带文章简要')+'\n\n本次选区：\n'+(snapshot.source?.quote||snapshot.source?.kind==='region'&&'区域示例（未裁切真实图像）'||'未绑定原文选区')+'\n\n本会话此前历史（'+snapshot.history.filter(m=>m.role==='user').length+'轮）：\n'+(snapshot.history.map(m=>m.role+'：'+m.text).join('\n')||'无')+'\n\n明确加入的材料：\n'+(snapshot.materials?.map(m=>m.title+'：'+m.text).join('\n')||'无')})}

 function moveChat(next){setPopover(null);if(next==='float')setFloatPosition(floatPlacement());setMode(next);if(next==='main'){if(page!=='chat')last.current={page,mode:'side',split,focus};setPage('chat')}else if(page==='chat')setPage(last.current.page==='global'?'board':last.current.page);patch(active,{unread:false})}
 function source(){setInspect({title:'样例论文A · 第12页',body:'限定2018年后，B与A的召回存在差异；同义词扩展也是变化因素。这里是合成原文，用于展示来源定位。'})}
 function Composer(){return <div className="composer">{c.source&&<div className="reader-context-line" aria-label="局部会话上下文"><button className="brief-chip" data-brief-key={(c.paperBrief||briefState.value)?.key} data-brief-version={(c.paperBrief||briefState.value)?.version} aria-expanded={briefOpen===c.id} onClick={showBrief}>{(c.paperBrief||briefState.value)?`文章简要 v${(c.paperBrief||briefState.value).version} · 仅第${(c.paperBrief||briefState.value).coverage.map(n=>n+1).join('、')}页`:'文章简要 · 首次提问准备'}</button><button onClick={()=>setInspect({kind:'context',title:'本处原文',body:c.source.quote||'区域示例（未裁切图像）'})}>本处选区</button></div>}{c.briefPending&&<div className="brief-wait">准备简要中<button onClick={()=>chatRun.current.get(c.id)?.selectionOnly?.()}>先只按选区回答</button></div>}<div className="material-list">{context.map(m=><div className="material" key={m.id}><button onClick={()=>setPopover({kind:'material',item:m})}>{m.title}</button><button aria-label={'移除'+m.title} onClick={()=>setMaterials(old=>({...old,[active]:old[active].filter(x=>x.id!==m.id)}))}><X size={12}/></button></div>)}</div><textarea ref={input} aria-label="输入消息" placeholder="继续问，或交给 Agent 处理…" value={c.draft} onChange={e=>patch(active,{draft:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send()}}}/><div className="composer-tools"><button className="quiet pill" onClick={()=>setPopover(popover?.kind==='provider'?null:{kind:'provider'})}>{c.provider}<ChevronDown size={12}/></button><button className="quiet permission" aria-label="查看当前权限" onClick={event=>inputOption('permission',event)}><ShieldCheck size={13}/>{c.provider==='Codex'?'研究工具':'文字问答'}</button><input type="file" accept="image/png,image/jpeg,image/webp" ref={imageInput} hidden onChange={attachImage}/><button className="icon" aria-label="添加图片" onClick={()=>imageInput.current?.click()}><Image size={14}/></button><button className="quiet voice" onClick={event=>inputOption('voice',event)}><Mic size={14}/>语音</button><button className="send" aria-label={c.running?'停止回答':'发送'} disabled={!c.running&&!c.draft.trim()} onClick={send}>{c.running?'■':<ArrowUp size={17}/>}</button></div></div>}
 function Chat(){return <section className={'chat chat-'+mode} style={mode==='float'&&floatPosition?{left:`clamp(8px, ${floatPosition.x}px, calc(100vw - 368px))`,top:`clamp(64px, ${floatPosition.y}px, calc(100dvh - 428px))`,right:'auto',bottom:'auto'}:undefined} aria-label="当前会话" data-session-id={c.id} data-source-anchor={c.source?.anchorId}><header className="chat-head" onPointerDown={e=>{if(mode!=='float'||e.target.closest('button'))return;const element=e.currentTarget.parentElement,box=element.getBoundingClientRect(),x=e.clientX,y=e.clientY;e.currentTarget.setPointerCapture(e.pointerId);const move=event=>setFloatPosition({x:Math.max(8,Math.min(innerWidth-box.width-8,box.x+event.clientX-x)),y:Math.max(64,Math.min(innerHeight-box.height-8,box.y+event.clientY-y))});element.querySelector('header').onpointermove=move;element.querySelector('header').onpointerup=()=>{element.querySelector('header').onpointermove=null}}}><div><span className="eyebrow">当前对话</span><button className="chat-title-trigger" aria-label="选择会话" aria-expanded={popover?.kind==='conversation'} onClick={event=>{const r=event.currentTarget.getBoundingClientRect();setPopover(popover?.kind==='conversation'?null:{kind:'conversation',anchor:{left:r.left,top:r.top,bottom:r.bottom}})}}><strong title={c.title}>{c.title}</strong><ChevronDown size={12}/></button></div><div className="chat-actions">{mode==='float'&&<button className="icon" title="在侧边继续" aria-label="在侧边继续" onClick={()=>moveChat('side')}><PanelRightOpen size={16}/></button>}{mode==='side'&&<button className="icon" title="浮窗继续" aria-label="浮窗继续" onClick={()=>moveChat('float')}><MessageCircle size={15}/></button>}{mode!=='main'&&<button className="icon" title="展开完整对话" aria-label="展开完整对话" onClick={()=>moveChat('main')}><Maximize2 size={15}/></button>}<button className="icon" aria-label="关闭聊天" title="关闭后继续处理" onClick={()=>{setMode('closed');setPopover(null);if(page==='chat')setPage(last.current.page)}}><X size={16}/></button></div></header><div className="chat-messages" ref={scroll} onScroll={e=>{const el=e.currentTarget;scrolls.current.set(active,el.scrollTop);follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<80}}>{!c.messages.length&&<div className="chat-empty"><MessageCircle size={22}/><p>围绕这里继续探索</p><small>发送后，回答就留在这里。</small></div>}{c.messages.map((m,i)=><div className={'message '+m.role} key={i}>{m.role==='assistant'&&<span className="author">{m.provider||'Codex'}</span>}<p>{m.text}</p>{m.context?.map((x,j)=><span className="sent-material" key={j}>{x.title}</span>)}{m.requestSnapshot&&<button className="request-context" data-brief-version={m.requestSnapshot.brief?.version||'none'} data-history-turns={m.requestSnapshot.history.filter(x=>x.role==='user').length} onClick={()=>showRequest(m.requestSnapshot)}>{m.requestSnapshot.brief?`本轮材料 · 简要v${m.requestSnapshot.brief.version}`:'本轮材料 · 未带简要'}</button>}{m.role==='assistant'&&!c.running&&<button className="citation" onClick={()=>c.source?locatePaper(c.source):source()}>{c.source?`本处原文 · 第${c.source.pageIndex+1}页`:'样例论文A · 第12页'} ↗</button>}</div>)}{briefOpen===c.id&&BriefDetails()}</div>{Composer()}</section>}
 function ensureExcerpt(source){const found=excerpts.find(x=>source.anchorId&&x.anchorId?x.anchorId===source.anchorId:x.documentId===source.documentId&&x.pageIndex===source.pageIndex&&x.quote===source.quote);if(found)return found;const evidence={...source,id:'excerpt-'+(++noteIds.current),researchId:'sample-research',createdAt:Date.now()};setExcerpts(old=>[...old,evidence]);return evidence}
 function showNotes(id){setNotesOpen(true);setCardEditorOpen(false);if(id)setFocusNote({id,token:++noteEvents.current})}
 function closeNotes(){setNotesOpen(false);setCardEditorOpen(false)}
 function saveExcerpt(source){const found=excerpts.some(x=>source.anchorId&&x.anchorId?x.anchorId===source.anchorId:x.documentId===source.documentId&&x.pageIndex===source.pageIndex&&x.quote===source.quote),evidence=ensureExcerpt(source);if(source.anchorId&&!operations.some(op=>op.kind==='excerpt'&&op.source.anchorId===source.anchorId))recordAction('excerpt',source,{targetId:evidence.id});toast(found?'这段原文已保存':'已保存摘录',()=>showNotes(evidence.id))}
 function editPaperCard(source,card,seed={}){const evidence=ensureExcerpt(source),key=card?.id||'new:'+(seed.kind||'card')+':'+evidence.id;if(!cardDrafts[key])setCardDrafts(old=>({...old,[key]:{id:card?.id,title:card?.title||seed.title||'',body:card?.body||seed.body||'',source:evidence,kind:card?.kind||seed.kind||'card',...seed}}));setEditingKey(key);setCardEditorOpen(true)}
 function resumePaperCard(key){const target=key||(cardDrafts[editingKey]?editingKey:Object.keys(cardDrafts).at(-1));if(target){setEditingKey(target);setCardEditorOpen(true)}}
 function savePaperCard(){const evidence=ensureExcerpt(cardDraft.source),existing=cards.find(x=>x.id===cardDraft.id),card={id:cardDraft.id||'card-'+(++noteIds.current),evidenceId:evidence.id,title:cardDraft.title.trim()||cardDraft.body.trim().slice(0,28),body:cardDraft.body.trim(),kind:cardDraft.kind||'card',createdAt:existing?.createdAt||Date.now(),updatedAt:Date.now()};if(cardDraft.operationId)updateAction(cardDraft.operationId,{status:'done',cardId:card.id,result:card.body});else if(evidence.anchorId)recordAction('card',evidence,{cardId:card.id,result:card.body});setCards(old=>old.some(x=>x.id===card.id)?old.map(x=>x.id===card.id?card:x):[...old,card]);setCardDrafts(old=>{const next={...old};delete next[editingKey];return next});setEditingKey(null);setCardEditorOpen(false);if(notesOpen)setFocusNote({id:card.id,token:++noteEvents.current});toast('已保存卡片',()=>showNotes(card.id))}
 function locatePaper(source){
  if(source?.documentId!=='sample-paper-a'||!Number.isInteger(source.pageIndex)||source.pageIndex<0||source.pageIndex>=20)return false;
  const group=groups.find(g=>g.id===activeGroup)||groups[0];
  const existing=group.views.find(v=>v.kind==='pdf')?group:groups.find(g=>g.views.some(v=>v.kind==='pdf'));
  let viewId;
  if(existing){const view=existing.views.find(v=>v.kind==='pdf');viewId=view.id;activateView(existing.id,view.id);updateView(view.id,{pdfPage:source.pageIndex+1})}
  else{const view={id:'view-'+(++viewIds.current),kind:'pdf',pdfPage:source.pageIndex+1};viewId=view.id;setGroups(old=>old.map(g=>g.id===group.id?{...g,active:view.id,views:[...g.views,view]}:g));setActiveGroup(group.id);setPage('pdf');if(mode==='main')setMode('side')}
  setPaperJump({viewId,source,token:++noteEvents.current});closeNotes();return true;
 }
 function Pdf({view}){return <PaperPreview view={view} scrolls={viewScrolls} onPage={n=>updateView(view.id,{pdfPage:n})} operations={operations} onAction={readerAction} onOpenActivity={openActivity} canUseVision={c.provider==='Codex'} jump={paperJump?.viewId===view.id?paperJump:null} onJumpConsumed={token=>setPaperJump(old=>old?.token===token?null:old)}/>}

 function resource(view){const kind=typeof view==='string'?view:view.kind;if(kind==='board')return <BoardPreview onAsk={payload=>ask(payload)}/>;if(kind==='pdf')return Pdf({view});if(kind==='draft')return <div className="draft-page"><small>研究笔记</small><textarea aria-label="文稿正文" value={doc} ref={el=>{if(el)el.scrollTop=viewScrolls.current.get(view.id)||0}} onScroll={e=>viewScrolls.current.set(view.id,e.currentTarget.scrollTop)} onChange={e=>setDoc(e.target.value)}/><button className="ask-inline" onClick={()=>ask({title:'研究笔记',text:doc})}><MessageCircle size={14}/>问这段文稿</button></div>;return <div className="library-page"><div className="library-heading"><h2>{PAGE[kind]}</h2><span>{kind==='global'?'全部资料':'关联到当前研究的资料'}</span></div>{[{id:'a',t:'样例论文A：检索扩展与证据覆盖',inside:true},{id:'b',t:'样例论文B：跨数据库检索比较',inside:linked}].filter(x=>kind==='global'||x.inside).map(x=><article className="library-row" key={x.id}><BookOpen size={19}/><div><b>{x.t}</b><small>合成示例 · 题录与摘要{x.id==='a'?' · 有全文':''}</small></div>{kind==='global'&&!x.inside?<button onClick={()=>{setLinked(true);toast('已加入本研究')}}>加入本研究</button>:x.id==='a'?<button onClick={()=>openResource('pdf')}>阅读</button>:<span className="inside">已加入本研究</span>}</article>)}</div>}
 function renderGroup(group,index){const view=group.views.find(v=>v.id===group.active)||group.views[0];const target=dropTarget?.groupId===group.id?dropTarget:null;return <section className={'resource-pane '+(index?'secondary ':'')+(activeGroup===group.id?'focused-group ':'')+(drag?'dragging-tabs':'')} data-group-id={group.id} key={group.id} hidden={focus&&focus!==group.id} onPointerDownCapture={()=>{setActiveGroup(group.id);setPage(view.kind)}} onDragOverCapture={e=>dragOver(e,group.id)} onDropCapture={e=>dropView(e,group.id)}><header className="pane-heading"><div className="resource-tabs" role="tablist" aria-label={'工作区 '+(index+1)+' 标签'}>{group.views.map((tab,i)=><div className={'resource-tab '+(tab.id===group.active?'active ':'')+(drag?.viewId===tab.id?'being-dragged ':'')+(target?.onTabs&&!target.edge&&target.index===i?'drop-before':'')} key={tab.id} data-view-id={tab.id} data-kind={tab.kind} draggable onDragStart={e=>{dragRef.current={groupId:group.id,viewId:tab.id};setDrag(dragRef.current);e.dataTransfer.effectAllowed='copyMove';e.dataTransfer.setData('application/x-papertrail-view',tab.id)}} onDragEnd={finishDrag}><button role="tab" aria-selected={tab.id===group.active} onClick={()=>activateView(group.id,tab.id)} title={PAGE[tab.kind]+' · 拖动可排序或分屏'}>{tab.kind==='pdf'?<BookOpen size={12}/>:tab.kind==='draft'?<Pencil size={12}/>:<Columns2 size={12}/>}<span>{PAGE[tab.kind]}</span></button><button className="tab-close" aria-label={'关闭'+PAGE[tab.kind]+'标签'} title="关闭标签" onClick={()=>closeView(group.id,tab.id)}><X size={11}/></button></div>)}{target?.onTabs&&!target.edge&&target.index===group.views.length&&<span className="tab-drop-end"/>}</div>{split&&<button className="icon pane-maximize" aria-label={focus?'恢复分屏':'放大当前页'} title={focus?'恢复分屏':'放大当前页'} onClick={()=>setFocus(focus?null:group.id)}><Maximize2 size={13}/></button>}</header><div className="resource-content" key={view.id}>{resource(view)}</div>{target&&!target.onTabs&&<div className={'tab-drop-preview '+(target.edge||'center')}><span>{target.edge?('向'+(target.edge==='left'?'左':'右')+'分屏'):'移到此窗口'}</span></div>}{target?.edge&&target.onTabs&&<div className={'tab-drop-preview '+target.edge}><span>{'向'+(target.edge==='left'?'左':'右')+'分屏'}</span></div>}</section>}
 return <div onKeyDown={e=>{if(e.key==='Escape'){if(popover)setPopover(null);else if(inspect)setInspect(null);else if(notesOpen||cardEditorOpen)closeNotes();else if(mode==='float')setMode('closed')}}} className={'app '+(mode==='side'&&page!=='global'?'has-chat':'')+(nav?' nav-open':'')}>
 <aside className="sidebar"><div className="brand"><BookOpen size={23}/><b>Papertrail</b></div><button className="research-name" onClick={()=>toast('本稿聚焦同一研究内的连续操作')}>检索策略比较研究<ChevronDown size={13}/></button><button className="new-chat" onClick={newChat}><Plus size={15}/>新会话</button><label className="search"><Search size={14}/><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={e=>setSearch(e.target.value)}/></label><span className="nav-caption">会话</span><nav>{convs.filter(x=>x.title.includes(search)).map(x=><button className={active===x.id?'selected':''} key={x.id} onClick={()=>choose(x.id)}><span>{x.title}</span>{x.unread&&(x.id!==active||mode==='closed'||page==='global')&&<i/>}</button>)}</nav><div className="sidebar-bottom"><span className="nav-caption">本研究</span>{['sources','board','draft'].map(k=><button className={page===k?'selected':''} key={k} onClick={()=>openResource(k)}>{PAGE[k]}</button>)}<button className={'global-library '+(page==='global'?'selected':'')} onClick={openGlobal}>全局资料库<ExternalLink size={13}/></button></div></aside>
 <main className="main" ref={mainSurface}><header className="workspace-head"><button className="icon nav-toggle" aria-label="展开导航" onClick={()=>setNav(!nav)}>☰</button>{page==='global'?<><button className="back-link" onClick={returnResearch}><ArrowLeft size={14}/>返回研究</button><b>全局资料库</b></>:<><div className="workspace-title">{page==='chat'?'完整对话':'检索策略比较研究'}</div><div className="workspace-actions"><button aria-expanded={notesOpen||cardEditorOpen} onClick={()=>notesOpen||cardEditorOpen?closeNotes():showNotes()}><NotebookText size={15}/>卡片与摘录</button>{page!=='chat'&&<button className={split?'active':''} onClick={()=>splitCurrent()} title="也可把标签拖到页面左右边缘"><Columns2 size={15}/>分屏</button>}<button onClick={()=>{if(mode==='closed')moveChat('side');else{setMode('closed');if(page==='chat')setPage(last.current.page)}}}><MessageCircle size={15}/>聊天</button></div></>}</header>
 {page==='chat'&&mode!=='closed'?Chat():page==='global'?<div className="global-content">{resource('global')}</div>:<div className={'panes '+(split?'split':'')}>{groups.map(renderGroup)}</div>}
 <span className="preview-label">交互原型 · 合成资料 / 示例回答 · 刷新重置</span></main>
 {page!=='chat'&&page!=='global'&&['side','float'].includes(mode)&&Chat()}
 {popover&&<div className={'popup-backdrop '+(popover.anchor?'anchored-popup':'')} onClick={()=>setPopover(null)}><section style={popover.kind==='conversation'?{position:'fixed',left:`clamp(12px, ${popover.anchor.left}px, calc(100vw - 332px))`,top:Math.min(popover.anchor.bottom+8,innerHeight-340),bottom:'auto',maxHeight:'min(380px, calc(100dvh - 80px))'}:popover.anchor?{position:'fixed',left:`clamp(12px, ${popover.anchor.left}px, calc(100vw - 332px))`,bottom:`calc(100dvh - ${popover.anchor.top-10}px)`,maxHeight:Math.max(150,popover.anchor.top-22)}:undefined} className={'popover '+(popover.kind==='material'?'wide':'')} onClick={e=>e.stopPropagation()} aria-label="输入选项"><button className="icon pop-close" aria-label="关闭选项" onClick={()=>setPopover(null)}><X size={15}/></button>{popover.kind==='conversation'?<ConversationPicker conversations={convs} current={c} materials={context} onSelect={chooseFromPicker} onNew={newFromPicker}/>:popover.kind==='provider'?<><h3>选择助手</h3>{['Codex','Claude Code','OpenCode'].map(p=><button className="menu-row" key={p} disabled={c.running} onClick={()=>{patch(active,{provider:p});setPopover(null)}}><span>{p}</span><small>{p===c.provider?'✓':p==='Codex'?'研究工具':'文字问答'}</small></button>)}</>:popover.kind==='permission'?<><h3>{c.provider==='Codex'?'研究工具权限':'文字问答'}</h3><p>{c.provider==='Codex'?'可读取研究资料、检索公开文献、生成草稿。':'仅发送明确提供的文字材料。'}</p><small>{c.provider==='Codex'?'此连接不提供通用文件访问设置。':'此适配未开放文件工具或可调文件权限。'}</small><div className="cap-note">当前为布局预览，未连接真实 Agent。</div></>:popover.kind==='voice'?<><h3><Mic size={17}/>系统听写</h3><p>识别文字进入草稿，修改后再发送。</p><small>macOS：使用系统设置中的听写快捷键，常见为连按两次 Fn / 🌐。Windows：Win + H。</small><button className="demo-dictation" onClick={()=>{patch(active,{draft:c.draft+(c.draft?'\n':'')+'请核对这部分检索条件。'});setPopover(null)}}>放入一段示例听写文字</button><div className="cap-note">此浏览器原型不录音或上传音频。</div></>:<><h3>{popover.item.title}</h3>{popover.item.imageUrl&&<img className="selection-preview" src={popover.item.imageUrl} alt="当时选中的白板区域"/>}<pre>{popover.item.text}</pre><small>这是加入时的快照；改变选区不会追加其他内容。</small></>}</section></div>}
 <NotesPanel open={page!=='global'&&(notesOpen||cardEditorOpen)} editorOpen={cardEditorOpen&&!!cardDraft} draft={cardDraft} drafts={cardDrafts} excerpts={excerpts} cards={cards} documentInfo={{id:'sample-paper-a',title:'样例论文A'}} mainRef={mainSurface} focusNote={focusNote} onDraftChange={value=>setCardDrafts(old=>({...old,[editingKey]:value}))} onCloseEditor={()=>setCardEditorOpen(false)} onSave={savePaperCard} onEdit={editPaperCard} onResume={resumePaperCard} onSource={locatePaper} onClose={closeNotes}/>
 {inspect&&<div className={'inspector'+(inspect.kind==='context'?' context-inspector':'')} role="dialog" aria-label="来源预览"><header><b>{inspect.title}</b><button className="icon" aria-label="关闭来源" onClick={()=>setInspect(null)}><X size={15}/></button></header><p style={{whiteSpace:'pre-wrap'}}>{inspect.body}</p>{inspect.kind!=='context'&&<button onClick={()=>{splitCurrent('pdf');if(page==='chat'){setPage('board');setMode('side')}setInspect(null)}}>在分屏中打开</button>}</div>}{notice&&<div className="notice" role="status"><span>{notice}</span>{noticeAction&&<button onClick={()=>{noticeAction();setNotice('');setNoticeAction(null)}}>查看</button>}</div>}
 </div>
}
createRoot(document.getElementById('root')).render(<App/>);
