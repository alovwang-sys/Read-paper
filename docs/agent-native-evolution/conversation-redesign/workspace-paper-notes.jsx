import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {BookmarkPlus, Highlighter, Languages, MessageCircle, MoreHorizontal, Pencil, Scan, ScrollText, X} from 'lucide-react';
import './workspace-selection-reader.css';

const documentId='sample-paper-a',assetHash='sample-paper-a-v1';
const quote='样例结果：B的召回更高，但同义词扩展也是变化因素，不能只据此推断证据更可靠。';
const actionNames={question:'提问',translation:'翻译',summary:'摘要卡片',excerpt:'保存摘录',card:'制作卡片',highlight:'高亮'};
const statusNames={running:'进行中',done:'已完成',draft:'草稿',stopped:'已停止',error:'未完成'};

export function quoteOffsets(text, quote) {
 if(!quote.trim())return null;
 const exact=text.indexOf(quote);
 if(exact>=0)return {start:exact,end:exact+quote.length};
 const chars=[],positions=[];
 for(let i=0;i<text.length;i++)if(!/\s/.test(text[i])){chars.push(text[i]);positions.push(i)}
 const needle=quote.replace(/\s/g,''),start=chars.join('').indexOf(needle);
 return start<0?null:{start:positions[start],end:positions[start+needle.length-1]+1};
}

export function sourceAnchorKey(source) {
 const prefix=`${source.documentId}|${source.assetHash||assetHash}|${source.pageIndex}|`;
 if(source.kind==='region'&&source.rect)return prefix+'region:'+['x','y','width','height'].map(key=>Number(source.rect[key]).toFixed(4)).join(',');
 return prefix+`text:${source.textStart}:${source.textEnd}`;
}

function textRange(root,start,finish) {
 if(!root||start<0||finish<=start||finish>root.textContent.length)return null;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=document.createRange();
 let node,offset=0,started=false;
 while((node=walker.nextNode())){
  const end=offset+node.textContent.length;
  if(!started&&start<end){range.setStart(node,start-offset);started=true}
  if(started&&finish<=end){range.setEnd(node,finish-offset);return range}
  offset=end;
 }
 return null;
}
const plainRect=rect=>({left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height});

export function PaperPreview({view,scrolls,onPage,operations=[],onAction,onOpenActivity,canUseVision=true,jump,onJumpConsumed}) {
 const scroller=useRef(null),copy=useRef(null),area=useRef(null),surface=useRef(null),drag=useRef(null),ignoreClick=useRef(false),appliedJump=useRef(null);
 const [selection,setSelection]=useState(null),[panel,setPanel]=useState('tools'),[more,setMore]=useState(false),[regionMode,setRegionMode]=useState(false),[regionDrag,setRegionDrag]=useState(null);
 const [marks,setMarks]=useState([]),[placement,setPlacement]=useState(null),[layout,setLayout]=useState(0),[translationId,setTranslationId]=useState(null),[previousTranslation,setPreviousTranslation]=useState(null);
 const n=view.pdfPage??12;
 const selected=selection?.pageIndex===n-1?selection:null;
 const currentOps=operations.filter(op=>op.source?.documentId===documentId&&op.source.pageIndex===n-1);
 const selectedOps=selected?currentOps.filter(op=>(op.source.anchorId||sourceAnchorKey(op.source))===selected.anchorId).sort((a,b)=>b.createdAt-a.createdAt):[];
 const translation=translationId?selectedOps.find(op=>op.id===translationId):selectedOps.find(op=>op.kind==='translation'&&op.id!==previousTranslation);
 const close=()=>{setSelection(null);setMore(false);setPlacement(null)};
 function normalizeSource(value){
  const source={...value,documentId,assetHash,documentTitle:'样例论文A',pageIndex:n-1,kind:value.kind||'text'};
  if(source.kind==='text'&&(source.textStart==null||source.textEnd==null)){
   const found=quoteOffsets(copy.current?.textContent||'',source.quote||'');
   if(found){source.textStart=found.start;source.textEnd=found.end}
  }
  source.anchorId=sourceAnchorKey(source);return source;
 }
 function sourceRect(source){
  if(source.kind==='region'&&source.rect&&area.current){
   const box=area.current.getBoundingClientRect(),r=source.rect;
   return {left:box.left+r.x*box.width,top:box.top+r.y*box.height,right:box.left+(r.x+r.width)*box.width,bottom:box.top+(r.y+r.height)*box.height,width:r.width*box.width,height:r.height*box.height};
  }
  return textRange(copy.current,source.textStart,source.textEnd)?.getBoundingClientRect()||null;
 }
 function targetFor(source){return {get isConnected(){return !!area.current?.isConnected&&area.current.dataset.readerPage===String(source.pageIndex)},getBoundingClientRect:()=>sourceRect(source)||source.anchor}}
 function openSource(value,nextPanel='tools'){
  const source=normalizeSource(value),rect=sourceRect(source);if(!rect)return;
  setSelection({...source,anchor:plainRect(rect)});setPanel(nextPanel);setMore(false);setTranslationId(null);setPreviousTranslation(null);
 }
 useLayoutEffect(()=>{scroller.current.scrollTop=scrolls.current.get(view.id)||0},[view.id]);
 useLayoutEffect(()=>{
  const element=scroller.current,observer=new ResizeObserver(()=>setLayout(value=>value+1));observer.observe(element);
  const update=()=>setLayout(value=>value+1);window.addEventListener('resize',update);
  return()=>{observer.disconnect();window.removeEventListener('resize',update)};
 },[]);
 useEffect(()=>{
  const outside=event=>{
   if(surface.current?.contains(event.target)||area.current?.contains(event.target)||event.target.closest?.('[data-region-toggle]'))return;
   close();
  };
  const escape=event=>{if(event.key==='Escape'&&(selection||regionMode)){event.stopPropagation();close();setRegionMode(false);setRegionDrag(null);drag.current=null}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true)};
 },[selection,regionMode]);
 useLayoutEffect(()=>{
  if(!jump||appliedJump.current===jump.token||jump.source.pageIndex!==n-1)return;
  appliedJump.current=jump.token;
  const source=normalizeSource(jump.source),range=source.kind==='text'?textRange(copy.current,source.textStart,source.textEnd):null;
  if(range){const native=window.getSelection();native.removeAllRanges();native.addRange(range);range.startContainer.parentElement.scrollIntoView({block:'nearest'})}
  else area.current.scrollIntoView({block:'nearest'});
  openSource(source);onJumpConsumed?.(jump.token);
 },[jump,n]);
 useLayoutEffect(()=>{
  if(!area.current)return;
  const box=area.current.getBoundingClientRect(),groups=new Map();
  for(const op of currentOps){
   const source=normalizeSource(op.source),key=source.anchorId;
   if(!groups.has(key))groups.set(key,{source,ops:[]});groups.get(key).ops.push(op);
  }
  const next=[];
  for(const [key,entry] of groups){
   const range=entry.source.kind==='text'?textRange(copy.current,entry.source.textStart,entry.source.textEnd):null;
   const rects=range?[...range.getClientRects()]:[sourceRect(entry.source)].filter(Boolean);
   if(!rects.length)continue;
   next.push({...entry,key,highlight:entry.ops.some(op=>op.kind==='highlight'&&op.status==='done'),rects:rects.filter(r=>r.width&&r.height).map(r=>({left:r.left-box.left,top:r.top-box.top,width:r.width,height:r.height}))});
  }
  next.sort((a,b)=>(a.rects[0]?.top||0)-(b.rects[0]?.top||0));
  let last=-24;for(const entry of next){entry.badgeTop=Math.max(entry.rects[0]?.top||0,last+24);last=entry.badgeTop}
  setMarks(next);
 },[operations,n,layout]);
 useLayoutEffect(()=>{
  if(!selected||!scroller.current)return;
  const anchor=sourceRect(selected),bounds=scroller.current.getBoundingClientRect();if(!anchor)return;
  if(anchor.bottom<bounds.top+37||anchor.top>bounds.bottom){setPlacement({visibility:'hidden'});return}
  const width=Math.min(panel==='tools'&&!more?320:350,bounds.width-20),height=surface.current?.offsetHeight||50;
  const left=Math.max(bounds.left+10,Math.min(anchor.left,bounds.right-width-10));
  const below=bounds.bottom-anchor.bottom,above=anchor.top-bounds.top;
  const top=below>=height+10?anchor.bottom+9:above>=height+10?anchor.top-height-9:Math.max(bounds.top+8,Math.min(anchor.bottom+9,bounds.bottom-height-8));
  setPlacement({left,top,width,maxHeight:Math.max(90,bounds.height-16)});
 },[selection,panel,more,operations,layout]);
 function capture(){
  if(regionMode)return;
  const native=window.getSelection();
  if(!native||native.isCollapsed||!native.rangeCount){close();return}
  const range=native.getRangeAt(0);
  if(!copy.current.contains(range.startContainer)||!copy.current.contains(range.endContainer))return;
  const text=native.toString().trim();if(!text){close();return}
  const prefix=document.createRange();prefix.selectNodeContents(copy.current);prefix.setEnd(range.startContainer,range.startOffset);
  const full=range.toString(),rawStart=prefix.toString().length;prefix.setEnd(range.endContainer,range.endOffset);
  const start=rawStart+(full.length-full.trimStart().length),end=prefix.toString().length-(full.length-full.trimEnd().length);
  openSource({kind:'text',quote:text,textStart:start,textEnd:end});
 }
 function perform(kind){
  if(!selected)return;
  const rect=sourceRect(selected),source={...selected,anchor:plainRect(rect||selected.anchor)};
  if(kind==='translation'){setPreviousTranslation(selectedOps.find(op=>op.kind==='translation')?.id||null);setTranslationId(null);setPanel('translation');setMore(false)}
  onAction?.(kind,source,targetFor(source));
  if(kind!=='translation')close();
 }
 function pointerDown(event){
  if(!regionMode||event.button!==0)return;
  event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);window.getSelection()?.removeAllRanges();close();
  const box=area.current.getBoundingClientRect();drag.current={x:Math.max(0,event.clientX-box.left),y:Math.max(0,event.clientY-box.top)};
  setRegionDrag({left:drag.current.x,top:drag.current.y,width:0,height:0});
 }
 function pointerMove(event){
  if(!drag.current)return;
  const box=area.current.getBoundingClientRect(),x=Math.max(0,Math.min(event.clientX-box.left,box.width)),y=Math.max(0,Math.min(event.clientY-box.top,box.height)),start=drag.current;
  setRegionDrag({left:Math.min(start.x,x),top:Math.min(start.y,y),width:Math.abs(x-start.x),height:Math.abs(y-start.y)});
 }
 function pointerUp(event){
  if(!drag.current)return;
  const box=area.current.getBoundingClientRect(),start=drag.current,x=Math.max(0,Math.min(event.clientX-box.left,box.width)),y=Math.max(0,Math.min(event.clientY-box.top,box.height));
  drag.current=null;ignoreClick.current=true;setRegionDrag(null);setRegionMode(false);
  const r={left:Math.min(start.x,x),top:Math.min(start.y,y),width:Math.abs(x-start.x),height:Math.abs(y-start.y)};if(r.width<6||r.height<6)return;
  const bounds={left:box.left+r.left,top:box.top+r.top,right:box.left+r.left+r.width,bottom:box.top+r.top+r.height};
  const chars=[],walker=document.createTreeWalker(copy.current,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode()))for(let i=0;i<node.textContent.length;i++){
   const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const rect=range.getBoundingClientRect(),cx=(rect.left+rect.right)/2,cy=(rect.top+rect.bottom)/2;
   if(rect.width&&rect.height&&cx>=bounds.left&&cx<=bounds.right&&cy>=bounds.top&&cy<=bounds.bottom)chars.push(node.textContent[i]);
  }
  openSource({kind:'region',quote:chars.join('').trim(),rect:{x:r.left/box.width,y:r.top/box.height,width:r.width/box.width,height:r.height/box.height}});
 }
 function openMarkedText(event){
  if(ignoreClick.current){ignoreClick.current=false;return}
  if(regionMode||!window.getSelection()?.isCollapsed)return;
  const box=area.current.getBoundingClientRect(),x=event.clientX-box.left,y=event.clientY-box.top;
  const entry=marks.find(mark=>mark.rects.some(r=>x>=r.left&&x<=r.left+r.width&&y>=r.top&&y<=r.top+r.height));
  if(entry)openSource(entry.source,'history');else close();
 }
 const regionUnsupported=selected?.kind==='region'&&!canUseVision;
 const translationUnavailable=selected?.kind==='region'&&!selected.quote.trim();
 return <div className="paper-scroll selection-reader" ref={scroller} onScroll={event=>{scrolls.current.set(view.id,event.currentTarget.scrollTop);setLayout(value=>value+1)}}>
  <div className="paper-controls"><button className="icon" aria-label="上一页" onClick={()=>{close();onPage(Math.max(1,n-1))}}>‹</button><span>第 {n} / 20 页</span><button className="icon" aria-label="下一页" onClick={()=>{close();onPage(Math.min(20,n+1))}}>›</button><button className="reader-region-toggle" data-region-toggle aria-label="框选区域" aria-pressed={regionMode} onClick={()=>{close();setRegionMode(!regionMode)}}><Scan size={13}/>框选区域</button></div>
  <article className="paper" data-reader-view={view.id}>
   <small>示例文献 · RESEARCH NOTE</small>
   <div className={'paper-selection-area'+(regionMode?' region-selecting':'')} ref={area} data-reader-page={n-1} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{drag.current=null;setRegionDrag(null)}} onClick={openMarkedText}>
    <div className="paper-copy" ref={copy} onPointerUp={capture} onKeyUp={capture}>
     <h2>检索扩展与证据覆盖</h2><p>比较两种检索策略时，需要保持年份、数据库与去重条件一致。</p>
     <mark>{quote}</mark><p>跨数据库对照仍需补充核验，并记录检索式和筛选标准。</p>
    </div>
    <figure className="reader-region-figure" aria-label="图形区域示例"><svg viewBox="0 0 360 58" role="img" aria-label="两个样例检索路径"><path d="M38 40 L103 31 L177 35 L250 17 L322 13"/><path className="secondary-line" d="M38 40 L103 36 L177 29 L250 34 L322 25"/>{[38,103,177,250,322].map((x,i)=><circle key={x} cx={x} cy={[40,31,35,17,13][i]} r="3"/>)}</svg><figcaption>图 1 · 区域示例</figcaption></figure>
    <div className="reader-marks" aria-label="原文操作标记">{marks.map(mark=><React.Fragment key={mark.key}>{mark.rects.map((r,i)=><span key={i} className={'reader-source-mark'+(mark.highlight?' manual-highlight':'')+(mark.source.kind==='region'?' region-mark':'')+(mark.ops.every(op=>['error','stopped'].includes(op.status))?' quiet-mark':'')} style={r}/>)}<button className="reader-source-count" style={{top:mark.badgeTop}} data-source-marker data-anchor-id={mark.key} aria-label={`查看此处记录：${mark.ops.length} 条`} title={`${mark.ops.length} 条操作记录`} onClick={event=>{event.stopPropagation();openSource(mark.source,'history')}}>{mark.ops.length}</button></React.Fragment>)}</div>
    {regionDrag&&<div className="reader-region-drag" style={regionDrag}/>}
   </div>
   <p className="reader-selection-hint">{regionMode?'拖动框选一处，Esc 退出':'选中文字，或框选一处继续研究'}</p>
   <footer>PDF 第 {n} 页 · 合成示例 · 刷新重置</footer>
  </article>
  {selected&&<section ref={surface} className="reader-selection-popover" style={placement||{visibility:'hidden'}} role="dialog" aria-label="选区操作" data-source-anchor={selected.anchorId} data-selection-kind={selected.kind} onPointerDown={event=>event.preventDefault()}>
   <div className="reader-selection-toolbar" role="toolbar" aria-label="原文选区操作">
    <button aria-label="提问" disabled={regionUnsupported} title={regionUnsupported?'当前连接不支持区域图像，可改选文字':'针对这处原文提问'} onClick={()=>perform('question')}><MessageCircle size={14}/><span>提问</span></button>
    <button aria-label="翻译" disabled={translationUnavailable} title={translationUnavailable?'此区域没有可核对的文字层':'翻译所选文字'} onClick={()=>perform('translation')}><Languages size={14}/><span>翻译</span></button>
    <button aria-label="摘要卡片" disabled={regionUnsupported} title={regionUnsupported?'当前连接不支持区域图像，可改选文字':'把这处内容整理为摘要草稿'} onClick={()=>perform('summary')}><ScrollText size={14}/><span>摘要卡片</span></button>
    <button className={'reader-more'+(more?' active':'')} aria-label="更多选区操作" aria-expanded={more} onClick={()=>{setMore(!more);setPanel('tools')}}><MoreHorizontal size={16}/></button>
    <button className="reader-popover-close" aria-label="关闭选区浮窗" onClick={close}><X size={14}/></button>
   </div>
   {more&&<div className="reader-selection-more" role="menu" aria-label="更多选区操作菜单"><button role="menuitem" aria-label="保存摘录" disabled={!selected.quote.trim()} onClick={()=>perform('excerpt')}><BookmarkPlus size={14}/>保存摘录</button><button role="menuitem" aria-label="制作卡片" onClick={()=>perform('card')}><Pencil size={14}/>制作卡片</button><button role="menuitem" aria-label="高亮" onClick={()=>perform('highlight')}><Highlighter size={14}/>高亮</button></div>}
   {(selected.kind==='region'||selectedOps.length>0)&&<div className="reader-selection-meta"><span>{selected.kind==='region'?(selected.quote?'区域示例 · 文字层可核对':'区域示例 · 无文字层'):`第 ${n} 页`}</span>{selectedOps.length>0&&<button aria-label="查看此处记录" onClick={()=>{setPanel(panel==='history'?'tools':'history');setMore(false)}}>{selectedOps.length} 条记录</button>}</div>}
   {regionUnsupported&&<p className="reader-capability-note">当前连接不支持区域图像，可改选文字。</p>}
   {panel==='translation'&&<div className="reader-selection-result" aria-live="polite"><header><b>译文</b><small>合成示例</small></header><blockquote>{selected.quote}</blockquote>{!translation||translation.status==='running'?<p>正在翻译这处文字…</p>:<><p>{translation.result||(translation.status==='error'?'未能完成翻译。':translation.status==='stopped'?'翻译已停止。':'译文暂不可用。')}</p>{translation.status==='done'&&translation.result&&<button className="reader-save-translation" aria-label="存为翻译笔记" onClick={()=>perform('translation-card')}><BookmarkPlus size={13}/>存为翻译笔记</button>}{['error','stopped'].includes(translation.status)&&<button onClick={()=>perform('translation')}>重新翻译</button>}</>}</div>}
   {panel==='history'&&<div className="reader-selection-history" aria-label="此处操作记录"><header><b>此处记录</b></header>{selectedOps.length?selectedOps.map(op=><button key={op.id} className="reader-operation-row" data-operation-id={op.id} data-operation-kind={op.kind} data-operation-status={op.status} onClick={()=>{if(op.kind==='translation'){setTranslationId(op.id);setPanel('translation')}else{onOpenActivity?.(op);close()}}}><span><b>{op.noteKind==='translation'?'翻译笔记':actionNames[op.kind]||op.kind}</b><small>{statusNames[op.status]||op.status}{op.createdAt?' · '+new Date(op.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}</small></span>{op.result&&<p>{op.result}</p>}</button>):<p>还没有操作记录</p>}</div>}
  </section>}
 </div>;
}

export function PaperCardEditor({draft,onChange,onClose,onSave,onSource}) {
 return <section className="paper-card-editor" role="dialog" aria-label="卡片编辑" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose()}}}>
  <header><div><h3>{draft.id?'编辑卡片':'制作卡片'}</h3>{['summary','translation'].includes(draft.kind)&&<small className="card-draft-origin">{draft.kind==='summary'?'基于选区 · 示例草稿':'翻译笔记 · 示例译文'}</small>}</div><button className="icon" aria-label="关闭卡片编辑" onClick={onClose}><X size={16}/></button></header>
  <form onSubmit={event=>{event.preventDefault();if(draft.body.trim())onSave()}}>
   <input aria-label="卡片标题" placeholder="给观点起个标题" autoFocus value={draft.title} onChange={e=>onChange({...draft,title:e.target.value})}/>
   <textarea aria-label="卡片正文" placeholder="写下你的理解、判断或待验证的问题…" value={draft.body} onChange={e=>onChange({...draft,body:e.target.value})}/>
   <div className="card-evidence"><button type="button" className="card-source-link" onClick={()=>onSource?.(draft.source)}>原文依据 · {draft.source.documentTitle} · 第{draft.source.pageIndex+1}页 ↗</button><blockquote>{draft.source.quote}</blockquote></div>
   <footer><button type="button" onClick={onClose}>稍后继续</button><button className="save-paper-card" type="submit" disabled={!draft.body.trim()}>保存卡片</button></footer>
  </form>
 </section>;
}
