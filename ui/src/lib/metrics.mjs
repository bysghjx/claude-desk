// Average output speed over the whole turn (includes waiting, tools and approvals).
export function replySpeed(turn){
  const tokens=turn?.usage?.output,start=turn?.startedAt,end=turn?.finishedAt;
  if(!Number.isFinite(tokens)||tokens<=0||!Number.isFinite(start)||!Number.isFinite(end)||end<=start)return null;
  return tokens/((end-start)/1000);
}
