// Builds the light theme ("月之亮面") from a dark stylesheet: every declaration that
// carries a color is repeated inside @media (prefers-color-scheme: light) with the
// color mapped. Same selectors, later in the cascade, so it overrides the dark value.
// Usage: node scripts/build-light-theme.cjs ui/app.css ui/theme-light.css [overrides.css]
const fs=require('fs');
const [input,output,extra]=process.argv.slice(2);

function tokenize(css){
  const out=[];let i=0;
  const block=()=>{let depth=0,start=i,q=null;for(;i<css.length;i++){const c=css[i];if(q){if(c==='\\'){i++;continue;}if(c===q)q=null;continue;}if(c==='"'||c==="'"){q=c;continue;}if(c==='/'&&css[i+1]==='*'){i=css.indexOf('*/',i+2)+1;continue;}if(c==='{')depth++;else if(c==='}'&&!--depth){i++;return css.slice(start+1,i-1);}}throw Error('unbalanced');};
  while(true){while(i<css.length&&/\s/.test(css[i]))i++;if(i>=css.length)break;
    if(css.startsWith('/*',i)){i=css.indexOf('*/',i+2)+2;continue;}
    const start=i;while(i<css.length&&css[i]!=='{'&&css[i]!==';')i++;const prelude=css.slice(start,i).trim();
    if(css[i]===';'){i++;continue;}out.push({prelude,body:block()});}
  return out;
}
function declarations(body){
  const list=[];let cur='',q=null,paren=0;
  for(let i=0;i<body.length;i++){const c=body[i];if(q){cur+=c;if(c===q)q=null;continue;}if(c==='"'||c==="'"){q=c;cur+=c;continue;}if(c==='/'&&body[i+1]==='*'){i=body.indexOf('*/',i+2)+1;continue;}if(c==='(')paren++;if(c===')')paren--;if(c===';'&&!paren){if(cur.trim())list.push(cur.trim());cur='';continue;}cur+=c;}
  if(cur.trim())list.push(cur.trim());
  return list.map(text=>{const at=text.indexOf(':');return{prop:text.slice(0,at).trim(),value:text.slice(at+1).trim()};});
}

// ── color math ──
const HEX=/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
function parseHex(h){if(h.length<=4)h=[...h].map(c=>c+c).join('');const n=parseInt(h.slice(0,6),16);return{r:n>>16&255,g:n>>8&255,b:n&255,a:h.length===8?parseInt(h.slice(6),16)/255:1};}
function toHsl({r,g,b}){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;let h=0,s=0;if(max!==min){const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);h=max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4;h/=6;}return{h,s,l};}
function fromHsl({h,s,l}){const f=n=>{const k=(n+h*12)%12,a=s*Math.min(l,1-l);return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))));};return{r:f(0),g:f(8),b:f(4)};}
const hex=({r,g,b,a})=>'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('')+(a<1?Math.round(a*255).toString(16).padStart(2,'0'):'');
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
// Neutral lightness, piecewise: dark surfaces become near-white, mid greys (secondary
// text, borders) stay readable on white, light text becomes near-black.
const FLIP=[[0,1],[0.1,0.975],[0.2,0.92],[0.3,0.62],[0.45,0.45],[0.6,0.36],[0.75,0.24],[0.9,0.14],[1,0.06]];
function flip(l){for(let i=1;i<FLIP.length;i++){const [x0,y0]=FLIP[i-1],[x1,y1]=FLIP[i];if(l<=x1)return y0+(y1-y0)*(l-x0)/(x1-x0);}return FLIP.at(-1)[1];}
function mapColor(c,{shadow=false}={}){
  if(shadow)return{...c,a:Math.min(c.a,1)*0.42};
  const hsl=toHsl(c);
  let next;
  // Greys, dark tinted surfaces and very light tinted text are flipped like neutrals
  // (keeping a hint of their hue); real accent colors are darkened for white backgrounds.
  if(hsl.s<0.16||hsl.l<0.4||hsl.l>0.78){next={h:hsl.h,s:Math.min(hsl.s,0.3),l:flip(hsl.l)};}
  else next={h:hsl.h,s:clamp(hsl.s*1.05,0,1),l:clamp(hsl.l-0.27,0.28,0.5)};
  return{...fromHsl(next),a:c.a};
}
const SHADOW_PROPS=/^(box-shadow|text-shadow|filter)$/;
function mapValue(prop,value){
  if(prop==='color-scheme')return value.replace(/\bdark\b/,'light');
  const shadow=SHADOW_PROPS.test(prop);
  return value.replace(HEX,m=>hex(mapColor(parseHex(m.slice(1)),{shadow})))
    .replace(/(^|[\s,(])white\b(?!-)/g,(m,p)=>p+hex(mapColor({r:255,g:255,b:255,a:1},{shadow})))
    .replace(/(^|[\s,(])black\b(?!-)/g,(m,p)=>p+hex(mapColor({r:0,g:0,b:0,a:1},{shadow})));
}
// The outline shorthand is repeated as outline-color only. The whole shorthand would also
// bring back width and style, undoing a later rule such as .composer textarea{outline:none}.
const SHORTHAND=/^outline$/;
function colorOnly(prop,value){
  if(!SHORTHAND.test(prop))return null;
  const colors=value.match(new RegExp(HEX.source+'|(?:^|\s)(?:white|black)\b','g'))||[];
  return colors.length===1?{prop:`${prop}-color`,value:colors[0].trim()}:null;
}
const hasColor=(prop,value)=>prop==='color-scheme'||HEX.test(value)||/(^|[\s,(])(white|black)\b(?!-)/.test(value);

let out=`/* Light theme ("月之亮面"), generated from ${input.split(/[\\/]/).pop()} by scripts/build-light-theme.cjs — do not edit by hand.\n   Active when the app theme is light, or follows a light system theme. */\n`;
function emit(rules,media){
  const body=rules.map(({prelude,body})=>{
    const decls=declarations(body).filter(d=>{HEX.lastIndex=0;return hasColor(d.prop,d.value);}).map(d=>colorOnly(d.prop,d.value)||d).map(d=>{HEX.lastIndex=0;return `${d.prop}:${mapValue(d.prop,d.value)}`;});
    return decls.length?`  ${prelude.replace(/\s+/g,' ')}{${decls.join(';')}}`:'';
  }).filter(Boolean);
  if(body.length)out+=`@media (prefers-color-scheme:light)${media?` and ${media}`:''}{\n${body.join('\n')}\n}\n`;
}
const top=[];
for(const node of tokenize(fs.readFileSync(input,'utf8'))){
  if(!node.prelude.startsWith('@')){top.push(node);continue;}
  const media=/^@media\s*(.*)$/i.exec(node.prelude);
  if(media&&!/prefers-/.test(media[1])){emit(top.splice(0),'');emit(tokenize(node.body),media[1].trim());}
}
emit(top,'');
if(extra)out+=`\n/* Hand-tuned light theme details */\n@media (prefers-color-scheme:light){\n${fs.readFileSync(extra,'utf8').trim()}\n}\n`;
fs.writeFileSync(output,out);
console.log(`${output}: ${out.length} bytes`);
