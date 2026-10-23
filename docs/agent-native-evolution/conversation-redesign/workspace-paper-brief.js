// This module belongs to the synthetic design preview, not the production AI service.
export const briefIdentity = Object.freeze({documentId:'sample-paper-a',assetHash:'sample-paper-a-v1',extractionRevision:'preview-text-1',schema:'paper-brief-1',promptRevision:'preview-1'});
export const briefKey = value => [value.documentId,value.assetHash,value.extractionRevision,value.schema,value.promptRevision].join(':');

export function createBriefCache(generate) {
 const values=new Map(),flights=new Map();
 return {
  get(identity){const value=values.get(briefKey(identity));return value?structuredClone(value):undefined},
  prepare(identity){
   const key=briefKey(identity);
   if(values.has(key))return Promise.resolve(structuredClone(values.get(key)));
   if(!flights.has(key)){
    const work=Promise.resolve().then(()=>generate({...identity})).then(value=>{
     if(!value?.body?.trim()||!value.coverage?.length)throw new Error('简要内容或覆盖范围缺失');
     const record={...structuredClone(value),key,identity:{...identity}};
     values.set(key,record);return record;
    }).finally(()=>flights.delete(key));
    flights.set(key,work);
   }
   return flights.get(key).then(value=>structuredClone(value));
  }
 };
}

export function sampleBrief(){return {
 version:1,provider:'示例生成器（未调用模型）',coverage:[11],totalPages:20,
 title:'文章简要 · 示例 v1',
 body:'研究问题（据合成第12页推测）：如何比较检索扩展后的召回与证据可靠性。\n\n本示例选页指出：B 的召回较高，但同义词扩展也发生变化；需要对齐年份、数据库和去重条件。跨数据库对照仍待核验。\n\n范围：只依据标题和合成第12页，未读取其余19页，无法代表全文结论。',
 role:'background',
};}

export function requestSnapshot({source,history,brief}){
 return structuredClone({source,history,brief:brief||null});
}
