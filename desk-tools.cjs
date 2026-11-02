// Tools Claude Desk gives Claude on top of Claude Code's own. wrap_up fills the
// box under a finished turn: a short recap and, when the user has a decision to
// make, one question with reply buttons.
const WRAP_UP='mcp__desk__wrap_up';
const DESCRIPTION='在本轮工作结束、写最后的回复之前调用，填写回复下方的收尾框。recap：两三句话说明现在是什么状态、还有什么没做或没验证。只有需要用户做决定或操作时才填 ask（一句话的问题，不写理由）和 actions（1–2 个按钮文字，每个 1–4 个词，第一个是你推荐的；用户点按钮等于把这段文字发给你）。';
const PROMPT='如果这一轮改了文件、运行了命令或完成了多步工作，在写最后的回复之前调用 wrap_up 工具填写收尾框；简单问答和闲聊不要调用。收尾框不代替回复：调用之后照常写出完整的最后回复，并且不要在回复里重复收尾框里的问题。';
const text=(value,max)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,max):'';
// The recorded box, or null when the call has no recap. Buttons need a question to answer.
function wrapUpOf(input){
  const recap=text(input?.recap,600);if(!recap)return null;
  const ask=text(input?.ask,160);
  const actions=ask&&Array.isArray(input?.actions)?input.actions.map(a=>text(typeof a==='string'?a:a?.label,24)).filter(Boolean).slice(0,2):[];
  return{recap,...(ask?{ask}:{}),...(actions.length?{actions}:{})};
}
// One server per CLI process: an SDK MCP server instance serves a single connection.
function deskServerFactory({createSdkMcpServer,tool,z}){
  return()=>createSdkMcpServer({name:'desk',version:'1.0.0',alwaysLoad:true,tools:[
    tool('wrap_up',DESCRIPTION,{recap:z.string(),ask:z.string().optional(),actions:z.array(z.string()).max(2).optional()},async()=>({content:[{type:'text',text:'收尾框已显示。现在写最后的回复。'}]}))
  ]});
}
module.exports={WRAP_UP,PROMPT,wrapUpOf,deskServerFactory};
