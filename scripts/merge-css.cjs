// Merges the UI stylesheets into one file in cascade order and removes declarations
// that a later rule with the same selector and media condition overrides anyway.
// Removing those cannot change any computed style; rule order is preserved.
const fs=require('fs'),path=require('path');
const [uiDir,outFile,...files]=process.argv.slice(2);

function tokenize(css){
  // Splits into top-level blocks: {type:'comment'|'rule'|'at', prelude, body, raw}
  const out=[];let i=0;
  const skipWs=()=>{while(i<css.length&&/\s/.test(css[i]))i++;};
  function block(){ // returns content between matching braces starting at css[i]==='{'
    let depth=0,start=i,q=null;
    for(;i<css.length;i++){const c=css[i];
      if(q){if(c==='\\'){i++;continue;}if(c===q)q=null;continue;}
      if(c==='"'||c==="'"){q=c;continue;}
      if(c==='/'&&css[i+1]==='*'){const end=css.indexOf('*/',i+2);i=end+1;continue;}
      if(c==='{')depth++;else if(c==='}'){depth--;if(!depth){i++;return css.slice(start+1,i-1);}}
    }
    throw Error('unbalanced braces');
  }
  while(true){skipWs();if(i>=css.length)break;
    if(css.startsWith('/*',i)){const end=css.indexOf('*/',i+2);out.push({type:'comment',raw:css.slice(i,end+2)});i=end+2;continue;}
    let start=i;while(i<css.length&&css[i]!=='{'&&css[i]!==';')i++;
    const prelude=css.slice(start,i).trim();
    if(css[i]===';'){out.push({type:'statement',raw:prelude+';'});i++;continue;}
    const body=block();
    out.push(prelude.startsWith('@')?{type:'at',prelude,body}:{type:'rule',prelude,body});
  }
  return out;
}
function declarations(body){
  const list=[];let cur='',q=null,paren=0;
  for(let i=0;i<body.length;i++){const c=body[i];
    if(q){cur+=c;if(c==='\\'){cur+=body[++i];continue;}if(c===q)q=null;continue;}
    if(c==='"'||c==="'"){q=c;cur+=c;continue;}
    if(c==='/'&&body[i+1]==='*'){const end=body.indexOf('*/',i+2);i=end+1;continue;}
    if(c==='(')paren++;if(c===')')paren--;
    if(c===';'&&!paren){if(cur.trim())list.push(cur.trim());cur='';continue;}
    cur+=c;
  }
  if(cur.trim())list.push(cur.trim());
  return list.map(text=>{const at=text.indexOf(':');return{prop:text.slice(0,at).trim().toLowerCase(),text,important:/!important\s*$/i.test(text)};});
}
const norm=selector=>selector.replace(/\s+/g,' ').replace(/\s*([>,+~])\s*/g,'$1').trim();

// Flatten to a list of style rules with their media context, keeping order.
const items=[];
for(const file of files){
  const css=fs.readFileSync(path.join(uiDir,file),'utf8');
  items.push({kind:'section',file});
  for(const node of tokenize(css)){
    if(node.type==='rule')items.push({kind:'rule',context:'',selector:norm(node.prelude),decls:declarations(node.body)});
    else if(node.type==='at'&&/^@media\b/i.test(node.prelude)){
      const media=node.prelude.replace(/\s+/g,' ');const inner=[];
      for(const child of tokenize(node.body))if(child.type==='rule')inner.push({selector:norm(child.prelude),decls:declarations(child.body)});else if(child.type!=='comment')throw Error('unsupported in @media: '+child.prelude);
      items.push({kind:'media',media,rules:inner});
    }
    else if(node.type==='at')items.push({kind:'raw',raw:`${node.prelude}{${node.body.trim()}}`});
    else if(node.type==='statement')items.push({kind:'raw',raw:node.raw});
  }
}
// Mark overridden declarations: walk backwards remembering which (context, selector, property) are set later.
const later=new Map();let removed=0,total=0;
const visit=(context,rule)=>{
  rule.decls=rule.decls.slice().reverse().filter(d=>{
    total++;const key=context+'\u0000'+rule.selector+'\u0000'+d.prop,seen=later.get(key);
    if(seen!==undefined&&(seen||!d.important)){removed++;return false;}
    later.set(key,(seen||false)||d.important);return true;
  }).reverse();
};
for(let k=items.length-1;k>=0;k--){const item=items[k];
  if(item.kind==='rule')visit('',item);
  if(item.kind==='media')for(let r=item.rules.length-1;r>=0;r--)visit(item.media,item.rules[r]);
}
// Within one rule, keep repeated properties (vendor fallbacks) as written.
let out=`/* Claude Desk UI styles — merged from ${files.join(', ')} by scripts/merge-css.cjs.\n   Sections keep their original cascade order; overridden declarations were removed. */\n`;
for(const item of items){
  if(item.kind==='section')out+=`\n/* ── from ${item.file} ── */\n`;
  else if(item.kind==='rule'){if(item.decls.length)out+=`${item.selector}{${item.decls.map(d=>d.text).join(';')}}\n`;}
  else if(item.kind==='media'){const rules=item.rules.filter(r=>r.decls.length);if(rules.length)out+=`${item.media}{\n${rules.map(r=>`  ${r.selector}{${r.decls.map(d=>d.text).join(';')}}`).join('\n')}\n}\n`;}
  else out+=item.raw+'\n';
}
fs.writeFileSync(outFile,out);
console.log(`declarations ${total}, overridden and removed ${removed}, output ${out.length} bytes`);
