const fs=require('node:fs');const zlib=require('node:zlib');const path=require('node:path');
const size=256;const data=Buffer.alloc((size*4+1)*size);
const points=[];for(let i=0;i<24;i++){const a=i*Math.PI/12-Math.PI/2;const r=i%2?29:79;points.push([128+Math.cos(a)*r,128+Math.sin(a)*r]);}
function inside(x,y){let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const [a,b]=points[i],[c,d]=points[j];if(((b>y)!==(d>y))&&(x<(c-a)*(y-b)/(d-b)+a))hit=!hit;}return hit;}
for(let y=0;y<size;y++)for(let x=0;x<size;x++){const offset=y*(size*4+1)+1+x*4;const corner=Math.max(0,42-Math.min(x,255-x)),cy=Math.max(0,42-Math.min(y,255-y));const alpha=corner&&cy&&corner*corner+cy*cy>42*42?0:255;const star=inside(x+.5,y+.5);data[offset]=star?222:30;data[offset+1]=star?162:30;data[offset+2]=star?127:29;data[offset+3]=alpha;}
function crc(buffer){let c=0xffffffff;for(const n of buffer){c^=n;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return(c^0xffffffff)>>>0;}
function chunk(type,body){const b=Buffer.alloc(12+body.length);b.writeUInt32BE(body.length);b.write(type,4);body.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,-4)),b.length-4);return b;}
const head=Buffer.alloc(13);head.writeUInt32BE(size);head.writeUInt32BE(size,4);head[8]=8;head[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',zlib.deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
const target=path.join(__dirname,'../ui');fs.writeFileSync(path.join(target,'icon.png'),png);const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);fs.writeFileSync(path.join(target,'icon.ico'),Buffer.concat([ico,png]));
