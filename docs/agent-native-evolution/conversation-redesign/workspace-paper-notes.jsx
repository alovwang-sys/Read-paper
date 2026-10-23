import React, {useLayoutEffect, useRef, useState} from 'react';
import {BookmarkPlus, MessageCircle, Pencil, X} from 'lucide-react';

const documentId='sample-paper-a';
const quote='样例结果：B的召回更高，但同义词扩展也是变化因素，不能只据此推断证据更可靠。';

export function quoteOffsets(text, quote) {
 if(!quote.trim())return null;
 const exact=text.indexOf(quote);
 if(exact>=0)return {start:exact,end:exact+quote.length};
 const chars=[],positions=[];
 for(let i=0;i<text.length;i++)if(!/\s/.test(text[i])){chars.push(text[i]);positions.push(i)}
 const needle=quote.replace(/\s/g,''),start=chars.join('').indexOf(needle);
 return start<0?null:{start:positions[start],end:positions[start+needle.length-1]+1};
}

export function PaperPreview({view, scrolls, onPage, onAsk, excerpts, cards, onExcerpt, onCard, hasDraft, onResume}) {
 const scroller=useRef(null),copy=useRef(null),sample=useRef(null),selectedRange=useRef(null);
 const [selection,setSelection]=useState(null),[jump,setJump]=useState(null);
 const n=view.pdfPage??12;
 const selected=selection?.pageIndex===n-1?selection:null;
 const source=()=>selected||{documentId,documentTitle:'样例论文A',pageIndex:n-1,quote};
 useLayoutEffect(()=>{scroller.current.scrollTop=scrolls.current.get(view.id)||0},[view.id]);
 useLayoutEffect(()=>{
  if(!jump||jump.pageIndex!==n-1)return;
  const root=copy.current,found=quoteOffsets(root.textContent,jump.quote);
  selectedRange.current=null;window.getSelection()?.removeAllRanges();
  if(found){
   const {start,end:finish}=found;
   const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),range=document.createRange();
   let node,offset=0,started=false;
   while((node=walker.nextNode())){
    const end=offset+node.textContent.length;
    if(!started&&start<end){range.setStart(node,start-offset);started=true}
    if(started&&finish<=end){range.setEnd(node,finish-offset);break}
    offset=end;
   }
   if(started){selectedRange.current=range.cloneRange();const native=window.getSelection();native.removeAllRanges();native.addRange(range);range.startContainer.parentElement.scrollIntoView({block:'nearest'})}
  }else root.scrollIntoView({block:'nearest'});
  setSelection(jump);
 },[jump,n]);
 function capture(){
  const native=window.getSelection();
  if(!native||native.isCollapsed||!native.rangeCount){selectedRange.current=null;setSelection(null);return}
  const range=native.getRangeAt(0);
  if(!copy.current.contains(range.startContainer)||!copy.current.contains(range.endContainer))return;
  const text=native.toString().trim();
  if(text){selectedRange.current=range.cloneRange();setSelection({documentId,documentTitle:'样例论文A',pageIndex:n-1,quote:text})}
 }
 function locate(evidence){onPage(evidence.pageIndex+1);setJump({...evidence})}
 function ask(){
  const value=source(),range=selected&&selectedRange.current;
  const target=range?{get isConnected(){return range.startContainer.isConnected},getBoundingClientRect:()=>range.getBoundingClientRect()}:sample.current;
  const anchor=target.getBoundingClientRect();
  onAsk({title:`样例论文A · 第${n}页`,documentId,text:value.quote,page:n,anchor:{left:anchor.left,top:anchor.top,right:anchor.right,bottom:anchor.bottom}},true,target);
 }
 const saved=excerpts.filter(x=>x.documentId===documentId);
 return <div className="paper-scroll" ref={scroller} onScroll={e=>scrolls.current.set(view.id,e.currentTarget.scrollTop)}>
  <div className="paper-controls"><button className="icon" aria-label="上一页" onClick={()=>onPage(Math.max(1,n-1))}>‹</button><span>第 {n} / 20 页</span><button className="icon" aria-label="下一页" onClick={()=>onPage(Math.min(20,n+1))}>›</button></div>
  <article className="paper" data-reader-view={view.id}>
   <small>示例文献 · RESEARCH NOTE</small>
   <div className="paper-copy" ref={copy} onPointerUp={capture} onKeyUp={capture}>
    <h2>检索扩展与证据覆盖</h2><p>比较两种检索策略时，需要保持年份、数据库与去重条件一致。</p>
    <mark ref={sample}>{quote}</mark><p>跨数据库对照仍需补充核验，并记录检索式和筛选标准。</p>
   </div>
   <div className="paper-selection-tools" aria-label="原文选区操作">
    <span>{selected?`已选 ${selected.quote.length} 字`:'高亮原文'}</span>
    <button className="ask-inline" onClick={()=>onExcerpt(source())}><BookmarkPlus size={13}/>保存摘录</button>
    <button className="ask-inline" onClick={()=>onCard(source())}><Pencil size={13}/>制作卡片</button>
    <button className="ask-inline" onClick={ask}><MessageCircle size={13}/>问这段</button>
   </div>
   <footer>PDF 第 {n} 页 · 合成示例</footer>
  </article>
  {(saved.length>0||hasDraft)&&<section className="reader-notes" aria-label="本篇摘录与卡片"><header><h3>本篇笔记</h3>{hasDraft&&<button onClick={onResume}>继续卡片草稿</button>}</header>
   {cards.filter(card=>saved.some(e=>e.id===card.evidenceId)).map(card=>{const evidence=saved.find(e=>e.id===card.evidenceId);return <article className="reader-note" key={card.id} data-note-kind="card" data-evidence-id={evidence.id}><header><span>卡片</span><button onClick={()=>onCard(evidence,card)}>编辑卡片</button></header><h4>{card.title}</h4><p>{card.body}</p><button className="note-source" onClick={()=>locate(evidence)}>样例论文A · 第{evidence.pageIndex+1}页 ↗</button></article>})}
   {saved.map(e=><article className="reader-note" key={e.id} data-note-kind="excerpt" data-document-id={e.documentId} data-page-index={e.pageIndex} data-evidence-id={e.id}><header><span>摘录</span><button onClick={()=>onCard(e)}>写成卡片</button></header><blockquote>{e.quote}</blockquote><button className="note-source" onClick={()=>locate(e)}>样例论文A · 第{e.pageIndex+1}页 ↗</button></article>)}
  </section>}
 </div>;
}

export function PaperCardEditor({draft,onChange,onClose,onSave}) {
 return <section className="paper-card-editor" role="dialog" aria-label="卡片编辑" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onClose()}}}>
  <header><h3>{draft.id?'编辑卡片':'制作卡片'}</h3><button className="icon" aria-label="关闭卡片编辑" onClick={onClose}><X size={16}/></button></header>
  <form onSubmit={event=>{event.preventDefault();if(draft.body.trim())onSave()}}>
   <input aria-label="卡片标题" placeholder="给观点起个标题" autoFocus value={draft.title} onChange={e=>onChange({...draft,title:e.target.value})}/>
   <textarea aria-label="卡片正文" placeholder="写下你的理解、判断或待验证的问题…" value={draft.body} onChange={e=>onChange({...draft,body:e.target.value})}/>
   <div className="card-evidence"><span>原文依据 · {draft.source.documentTitle} · 第{draft.source.pageIndex+1}页</span><blockquote>{draft.source.quote}</blockquote></div>
   <footer><button type="button" onClick={onClose}>稍后继续</button><button className="save-paper-card" type="submit" disabled={!draft.body.trim()}>保存卡片</button></footer>
  </form>
 </section>;
}
