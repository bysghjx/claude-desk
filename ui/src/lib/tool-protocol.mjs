// Repeated bare tool invocations without recorded tools can be a broken provider
// response. Quoted examples and fenced code are ordinary documentation.
export function hasUnexecutedToolText(turn){
  if(turn?.tools?.length)return false;
  let fence=null,count=0;
  for(const line of String(turn?.answer||'').split('\n')){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if(fence){if(marker&&marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;continue;}
    if(marker){fence=marker[1];continue;}
    if(/^ {0,3}<invoke\s+name=["'](?:Bash|Read|Write|Edit|Grep|Glob)["']\s*>\s*$/.test(line)&&++count>=2)return true;
  }
  return false;
}
