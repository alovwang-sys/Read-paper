import React, {useState} from 'react';
import {Plus, Search, Check} from 'lucide-react';

const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const ignored=new Set(['这个','这些','我们','可以','需要','问题','样例','内容','关于','是否','进行','材料','选中']);
const words=text=>new Set([...segmenter.segment(String(text).toLowerCase())].filter(x=>x.isWordLike&&x.segment.length>1&&!ignored.has(x.segment)).map(x=>x.segment));
const sourceKeys=items=>new Set(items.flatMap(x=>[x.documentId,x.cardId,...(x.elementIds||[])].filter(Boolean)));
export function rankConversations(conversations,current,materials){
 const scope=current.researchId||'sample-research';
 const topic=words(materials.length?materials.map(x=>x.title+' '+x.text).join(' '):current.draft||current.title);
 const sources=sourceKeys(materials);
 return conversations.filter(x=>x.id!==current.id&&(x.researchId||'sample-research')===scope).map(x=>{
  const recent=x.messages.slice(-5),otherSources=sourceKeys(recent.flatMap(m=>m.context||[]));
  const shared=[...sources].some(id=>otherSources.has(id));
  const terms=words(x.title+' '+recent.map(m=>m.text).join(' '));
  const overlap=[...topic].filter(term=>terms.has(term)).length;
  return {...x,related:shared||overlap>=2,score:(shared?3:0)+overlap};
 }).sort((a,b)=>Number(b.related)-Number(a.related)||b.score-a.score||(b.updatedAt||b.id)-(a.updatedAt||a.id));
}
export function materialKey(item){return JSON.stringify([item.documentId,item.cardId,item.title,item.text,item.page,item.bounds,[...(item.elementIds||[])].sort(),!item.documentId&&!item.elementIds?.length?item.imageUrl:null])}
export default function ConversationPicker({conversations,current,materials,onSelect,onNew}){
 const [query,setQuery]=useState(''),[carry,setCarry]=useState(true);
 const ranked=rankConversations(conversations,current,materials);
 const related=ranked.filter(x=>x.related).slice(0,3),suggested=related.length?related:[...ranked].sort((a,b)=>(b.updatedAt||b.id)-(a.updatedAt||a.id)).slice(0,3);
 const rows=query.trim()?conversations.filter(x=>(x.researchId||'sample-research')===(current.researchId||'sample-research')&&x.title.toLowerCase().includes(query.trim().toLowerCase())):suggested;
 const remaining=query.trim()?[]:ranked.filter(x=>!suggested.some(s=>s.id===x.id));
 const row=x=><button className="conversation-choice" key={x.id} data-conversation-id={x.id} onClick={()=>onSelect(x.id,carry)}><span>{x.title}</span><small>{x.id===current.id?<Check size={13}/>:x.running?'处理中':x.draft?'有草稿':''}</small></button>;
 return <div className="conversation-picker"><h3>选择会话</h3><label className="picker-search"><Search size={14}/><input autoFocus aria-label="搜索本研究会话" placeholder="搜索本研究会话" value={query} onChange={e=>setQuery(e.target.value)}/></label><button className="picker-new" onClick={()=>onNew(carry)}><Plus size={14}/>新会话</button><div className="picker-list"><small className="picker-caption">{query.trim()?'搜索结果':related.length?'相关会话':'最近会话'}</small>{rows.length?rows.map(row):<p className="picker-none">没有匹配的会话</p>}{remaining.length>0&&<><small className="picker-caption">其他会话</small>{remaining.map(row)}</>}</div>{materials.length>0&&<label className="picker-carry"><input type="checkbox" checked={carry} onChange={e=>setCarry(e.target.checked)}/>带上当前选区</label>}{current.draft&&<small className="picker-draft-note">切换后恢复该会话的输入；当前文字仍留在原会话。</small>}</div>
}
