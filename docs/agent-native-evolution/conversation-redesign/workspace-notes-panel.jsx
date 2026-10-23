import React, {useLayoutEffect, useRef, useState} from 'react';
import {ArrowUpRight, FileText, NotebookText, Search, X} from 'lucide-react';
import {PaperCardEditor} from './workspace-paper-notes.jsx';
import './workspace-notes-panel.css';

function noteTime(note) {
 const value=note.updatedAt??note.createdAt;
 if(typeof value==='number')return value;
 if(value){const time=Date.parse(value);if(Number.isFinite(time))return time}
 return Number(String(note.id).match(/\d+/g)?.at(-1)||0);
}

export function notesForScope(excerpts,cards,scope,documentId,query='') {
 const sources=new Map(excerpts.map(source=>[source.id,source]));
 const rows=[
  ...excerpts.map(source=>({id:source.id,kind:'excerpt',source,title:'原文摘录',text:source.quote||'',updatedAt:noteTime(source)})),
  ...cards.map(card=>({id:card.id,kind:'card',source:sources.get(card.evidenceId)||null,card,title:card.title||'未命名卡片',text:card.body||'',updatedAt:noteTime(card)})),
 ];
 const needle=query.trim().toLocaleLowerCase();
 return rows.filter(row=>(scope!=='document'||row.source?.documentId===documentId)&&(!needle||[row.title,row.text,row.source?.documentTitle,row.source?.quote].some(value=>value?.toLocaleLowerCase().includes(needle)))).sort((a,b)=>b.updatedAt-a.updatedAt||a.id.localeCompare(b.id));
}

export default function NotesPanel({open,editorOpen,draft,drafts,excerpts,cards,documentInfo,mainRef,focusNote,onDraftChange,onCloseEditor,onSave,onEdit,onResume,onSource,onClose}) {
 const [scope,setScope]=useState('research'),[query,setQuery]=useState(''),[expanded,setExpanded]=useState({}),[highlight,setHighlight]=useState(null),[unavailable,setUnavailable]=useState(null);
 const [position,setPosition]=useState({left:12,top:64,width:360,maxHeight:'calc(100dvh - 80px)'});
 const list=useRef(null),appliedFocus=useRef(null),pendingFocus=useRef(null);
 const rows=notesForScope(excerpts,cards,scope,documentInfo.id,query);
 useLayoutEffect(()=>{
  const host=mainRef.current;if(!host)return;
  function place(){
   const box=host.getBoundingClientRect(),margin=box.width<304?8:12;
   const preferred=innerWidth>=1400?360:innerWidth>=1200?340:320;
   const width=Math.max(0,Math.min(preferred,box.width-margin*2)),top=box.top+64;
   const next={left:box.right-margin-width,top,width,maxHeight:Math.max(0,Math.min(box.bottom,innerHeight)-top-16)};
   setPosition(old=>Object.keys(next).every(key=>old[key]===next[key])?old:next);
  }
  place();const observer=new ResizeObserver(place);observer.observe(host);window.addEventListener('resize',place);
  return()=>{observer.disconnect();window.removeEventListener('resize',place)};
 },[mainRef,open]);
 useLayoutEffect(()=>{
  if(!open||editorOpen||!focusNote||appliedFocus.current===focusNote.token)return;
  appliedFocus.current=focusNote.token;pendingFocus.current=focusNote.id;
  setScope('research');setQuery('');setHighlight(focusNote.id);
 },[focusNote?.token,open,editorOpen]);
 useLayoutEffect(()=>{
  if(!open||editorOpen||!pendingFocus.current||scope!=='research'||query)return;
  const target=Array.from(list.current?.querySelectorAll('[data-note-id]')||[]).find(item=>item.dataset.noteId===pendingFocus.current);
  if(!target)return;
  const parent=list.current,box=target.getBoundingClientRect(),bounds=parent.getBoundingClientRect();
  if(box.top<bounds.top)parent.scrollTop-=bounds.top-box.top+8;
  else if(box.bottom>bounds.bottom)parent.scrollTop+=box.bottom-bounds.bottom+8;
  pendingFocus.current=null;
 },[rows,scope,query,open,editorOpen]);
 function sourceFor(source,id){const found=source&&onSource(source);setUnavailable(found?null:id);return !!found}
 function edit(source,card){setUnavailable(null);onEdit(source,card)}
 return <section hidden={!open} className="workspace-notes-panel" role={editorOpen?'region':'dialog'} aria-label={editorOpen?'卡片编辑区域':'卡片与摘录'} style={position} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();editorOpen?onCloseEditor():onClose()}}}>
  <div hidden={editorOpen} className="notes-collection">
   <header className="notes-panel-head"><h3><NotebookText size={15}/>卡片与摘录</h3><button className="icon" aria-label="关闭卡片与摘录" onClick={onClose}><X size={16}/></button></header>
   <div className="notes-scope" aria-label="笔记范围"><button aria-pressed={scope==='research'} onClick={()=>setScope('research')}>本研究</button><button aria-pressed={scope==='document'} title={documentInfo.title} onClick={()=>setScope('document')}>本篇：{documentInfo.title}</button></div>
   <label className="notes-search"><Search size={14}/><input aria-label="搜索笔记" placeholder="搜索笔记" value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button className="icon" aria-label="清空搜索" onClick={()=>setQuery('')}><X size={13}/></button>}</label>
   {Object.keys(drafts).length>0&&<button className="notes-resume" onClick={()=>{setUnavailable(null);onResume()}}><span className="notes-draft-dot"/>继续卡片草稿<ArrowUpRight size={12}/></button>}
   <div className="notes-panel-list" ref={list}>
    {!rows.length&&(query?<div className="notes-empty"><p>没有找到匹配的笔记</p><button onClick={()=>setQuery('')}>清空搜索</button></div>:<p className="notes-empty">选中原文，保存摘录或制作卡片</p>)}
    {rows.map(row=>{
     const entry=row.kind==='card'?[row.id,drafts[row.id]]:Object.entries(drafts).findLast(([,value])=>!value.id&&value.source?.id===row.id);
     const key=entry?.[0],hasDraft=!!entry?.[1];
     return <article key={row.id} className={'reader-note '+(highlight===row.id?'note-focused':'')} data-note-kind={row.kind} data-note-id={row.id} data-document-id={row.source?.documentId} data-page-index={row.source?.pageIndex} data-evidence-id={row.card?.evidenceId||row.source?.id}>
      <div className="note-kind">{row.kind==='card'?<NotebookText size={12}/>:<FileText size={12}/>}<span>{row.kind==='card'?'卡片':'摘录'}</span>{hasDraft&&<span className="notes-draft-dot" title="未保存草稿" aria-label="未保存草稿"/>}</div>
      {row.kind==='card'?<button className="note-card-body" onClick={()=>row.source?edit(row.source,row.card):setUnavailable(row.id)}><b>{row.title}</b><span>{row.text}</span></button>:<button className={'note-quote '+(expanded[row.id]?'expanded':'')} aria-expanded={!!expanded[row.id]} onClick={()=>setExpanded(old=>({...old,[row.id]:!old[row.id]}))}>{row.text}</button>}
      <footer>{row.source?<button className="note-source" onClick={()=>sourceFor(row.source,row.id)}>{row.source.documentTitle} · 第{row.source.pageIndex+1}页 <ArrowUpRight size={11}/></button>:<span className="note-no-source">无原文依据</span>}<div>{hasDraft?<button className="note-action" onClick={()=>{setUnavailable(null);onResume(key)}}>继续草稿</button>:row.kind==='excerpt'&&<button className="note-action" onClick={()=>edit(row.source)}>写成卡片</button>}</div></footer>
      {unavailable===row.id&&<p className="note-source-error" role="status">原文不可用</p>}
     </article>;
    })}
   </div>
  </div>
  {editorOpen&&draft&&<div className="notes-editor-host"><PaperCardEditor draft={draft} onChange={onDraftChange} onClose={onCloseEditor} onSave={onSave} onSource={source=>sourceFor(source,'editor')}/>{unavailable==='editor'&&<p className="note-source-error" role="status">原文不可用</p>}</div>}
 </section>;
}
