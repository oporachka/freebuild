// Collision shapes and structural edges mirror index.html; no client-reported hits are trusted.
const S=4,H=4;
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const FACES=[[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]];
export function rayBox(o,d,b){let near=0,far=Infinity;for(let k=0;k<3;k++){if(Math.abs(d[k])<1e-9){if(o[k]<b[k]||o[k]>b[k+3])return -1;continue;}let a=(b[k]-o[k])/d[k],c=(b[k+3]-o[k])/d[k];if(a>c)[a,c]=[c,a];near=Math.max(near,a);far=Math.min(far,c);if(near>far)return -1;}return near;}
function rayTri(o,d,a,b,c){const e1=sub(b,a),e2=sub(c,a),p=cross(d,e2),det=dot(e1,p);if(Math.abs(det)<1e-9)return-1;const iv=1/det,t0=sub(o,a),u=dot(t0,p)*iv;if(u<0||u>1)return-1;const q=cross(t0,e1),v=dot(d,q)*iv;if(v<0||u+v>1)return-1;return dot(e2,q)*iv}
export function createGeometry(pieces=new Map()){
const boxC=(x0,y0,z0,x1,y1,z1)=>[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]];
const rampT=(d,u,v)=>d==0?v:d==1?u:d==2?1-v:1-u;
function rampCorners(i,j,l,d,hs){let u0=0,u1=1,v0=0,v1=1;if(hs>=0){if(d==0||d==2){u0=hs*.5;u1=u0+.5}else{v0=hs*.5;v1=v0+.5}}
 const xs=[u0,u1,u1,u0],zs=[v0,v0,v1,v1],o=[];for(let k=0;k<8;k++){const u=xs[k%4],v=zs[k%4];o.push([(i+u)*S,l*H+rampT(d,u,v)*H+(k<4?-.15:.1),(j+v)*S])}return o}
const rampIn=(p,u,v)=>{if(!(p.hs>=0))return true;const w=(p.d==0||p.d==2)?u:v;return p.hs==0?w<.5:w>=.5};
// клетка редакта: a — по горизонтали, c — по вертикали (стена) или по Z (пол)
function tileBox(p,a,c,w,h){w=w||1;h=h||w;const{i,j,l}=p;
 if(p.t=='f')return boxC(i*S+a*S/2,l*H-.15,j*S+c*S/2,i*S+(a+w)*S/2,l*H+.1,j*S+(c+h)*S/2);
 return wallBox(p,a*S/3,(a+w)*S/3,l*H+c*H/3,l*H+(c+h)*H/3,.12)}
// коробка в плоскости стены: al — смещение вдоль стены, y — абсолютная высота
function wallBox(p,al0,al1,y0,y1,hf){const{i,j}=p;return p.ax==0?boxC(i*S+al0,y0,j*S-hf,i*S+al1,y1,j*S+hf):boxC(i*S-hf,y0,j*S+al0,i*S+hf,y1,j*S+al1)}
// повернутая коробка (дверь): s — вдоль полотна, t — толщина, поворот вокруг петли
function doorBox(p,hinge,th,s0,s1,t0,t1,y0,y1){const cs=Math.cos(th),sn=Math.sin(th),o=[];
 const pts=[[s0,t0],[s1,t0],[s1,t1],[s0,t1]];for(const y of[y0,y1])for(const[s_,t_]of pts){const al=hinge+s_*cs-t_*sn,ac=s_*sn+t_*cs;
  o.push(p.ax==0?[p.i*S+al,y,p.j*S+ac]:[p.i*S+ac,y,p.j*S+al])}return o}
// конус: 4 угла (биты 0:x0z0 1:x1z0 2:x0z1 3:x1z1), выбранные углы поднимаются до вершины
const coneH=m=>[m&1?1:0,m&2?1:0,m&8?1:0,m&4?1:0],CC=[[0,0],[1,0],[1,1],[0,1]];
const CSL={12:0,10:1,3:2,5:3};
const PK={1:[0,0],2:[1,0],4:[0,1],8:[1,1]};const pkT=(m,u,v)=>{const c=PK[m];return Math.min(c[0]?u:1-u,c[1]?v:1-v)};
function coneParts(i,j,l,mask){if(mask in CSL)return[rampCorners(i,j,l,CSL[mask])];
 if(mask in PK){const c=PK[mask],a=[c[0],c[1]],b=[1-c[0],c[1]],d=[c[0],1-c[1]],e=[1-c[0],1-c[1]];
  const P=(q,dy)=>[(i+q[0])*S,l*H+.1+pkT(mask,q[0],q[1])*H+dy,(j+q[1])*S];
  return [[a,b,e,e],[a,e,d,d]].map(Q=>[...Q.map(q=>P(q,-.25)),...Q.map(q=>P(q,0))])}const x0=i*S,z0=j*S,yb=l*H+.02,pk=H/2,hh=coneH(mask),out=[],xc=x0+S/2,zc=z0+S/2;
 for(let k=0;k<4;k++){const a=CC[k],b=CC[(k+1)%4],ha=yb+hh[k]*pk,hb=yb+hh[(k+1)%4]*pk,hc=yb+pk,ax=x0+a[0]*S,az=z0+a[1]*S,bx=x0+b[0]*S,bz=z0+b[1]*S;
  out.push([[ax,ha-.25,az],[bx,hb-.25,bz],[xc,hc-.25,zc],[xc,hc-.25,zc],[ax,ha,az],[bx,hb,bz],[xc,hc,zc],[xc,hc,zc]])}return out}
function coneHt(mask,u,v){if(mask in CSL)return rampT(CSL[mask],u,v)*2;if(mask in PK)return pkT(mask,u,v)*2+.16/H;const hh=coneH(mask),dx=u-.5,dz=v-.5;let k;if(Math.abs(dz)>=Math.abs(dx))k=dz<0?0:2;else k=dx>0?1:3;
 const a=CC[k],b=CC[(k+1)%4],det=(b[1]-.5)*(a[0]-.5)+(.5-b[0])*(a[1]-.5);
 const la=((b[1]-.5)*dx+(.5-b[0])*dz)/det,lb=((.5-a[1])*dx+(a[0]-.5)*dz)/det;return la*hh[k]+lb*hh[(k+1)%4]+(1-la-lb)}
// распознавание редакта (как в Fortnite)
// разрешённые редакты (как в Fortnite, вместе с зеркальными)
const OK_EDITS={w:new Set([8,16,32,40,9,18,36,63,27,54,448,504,11,38,416,200]),f:new Set([1,2,4,8,3,12,5,10,7,11,13,14])};
const DIAG={11:[0,1],38:[1,1],200:[0,1],416:[1,1]};
function validEdit(t,mask){if(!mask)return true;const s=OK_EDITS[t];return!s||s.has(mask)}
function pattern(t,mask){if(!mask)return{type:'none',name:'Целая'};
 const cnt=x=>{let n=0;while(x){n+=x&1;x>>=1}return n};
 if(t=='f'){const n=cnt(mask);return{type:'hole',name:n==1?'Угол':n==2?([3,12,5,10].includes(mask)?'Полпола':'Диагональ'):n==3?'Четверть пола':'Пусто'}}
 if(t=='k'){const n=cnt(mask);return{type:'cone',name:n==1?'Пика (с полом — дурка)':n==2?([3,12,5,10].includes(mask)?'Скат (как рампа)':'Седло'):n==3?'Угол крыши':'Плоская крыша'}}
 for(let a=0;a<3;a++)if(mask==((1<<a)|(1<<(a+3))))return{type:'door',a,name:'Дверь'};
 if(mask==63)return{type:'arch',fil:[[0,1,'tl'],[2,1,'tr']],name:'Арка'};
 if(mask==54)return{type:'arch',fil:[[1,1,'tl']],name:'Полуарка'};
 if(mask==27)return{type:'arch',fil:[[1,1,'tr']],name:'Полуарка'};
 for(let b=3;b<9;b++)if(mask==(1<<b))return{type:'window',name:'Окно'};
 if(mask==40)return{type:'window',name:'Два окна'};
 if(mask==448)return{type:'hole',name:'Низкая стена'};if(mask==504)return{type:'hole',name:'Полстены'};
 if(mask==11||mask==38)return{type:'diag',name:'Диагональный срез'};if(mask==416||mask==200)return{type:'hole',name:'Диагональный срез'};
 if(mask&7)return{type:'pass',name:'Проход'};return{type:'hole',name:'Проём'}}
function fillet(p,a,c,sd,add){const T=S/3,A0=a*T,A1=A0+T,Y0=p.l*H+c*H/3,Y1=Y0+H/3,N=14;
 for(let k=0;k<N;k++){const xa=A0+k*T/N,xb=xa+T/N,xm=(xa+xb)/2,dx=sd=='tl'?(A1-xm)/T:(xm-A0)/T,yc=Y0+(H/3)*Math.sqrt(Math.max(0,1-dx*dx));
  if(Y1-yc>.01)add(wallBox(p,xa,xb,yc,Y1,.12),1)}}
function coneHoleQ(p){const m=p.mask||0;if(![1,2,4,8].includes(m))return-1;const q=Math.log2(m),f=pieces.get('f'+p.i+','+p.j+','+p.l);return f&&(f.mask>>q&1)?q:-1}
const kHole=(p,u,v)=>p.hole>=0&&Math.floor(u*2)+Math.floor(v*2)*2==p.hole;
const keyOf=p=>p.t+p.i+','+p.j+','+p.l+(p.t=='w'?','+p.ax:'');

// ================= Мир =================

function greedy(K,n){const used=new Array(n*n).fill(false),out=[];
 for(let c=0;c<n;c++)for(let a=0;a<n;a++){const b=a+c*n;if(!(K>>b&1)||used[b])continue;let w=1;while(a+w<n&&(K>>(b+w)&1)&&!used[b+w])w++;
  let h=1;outer:while(c+h<n){for(let x=0;x<w;x++){const bb=a+x+(c+h)*n;if(!(K>>bb&1)||used[bb])break outer}h++}
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)used[a+x+(c+y)*n]=true;out.push([a,c,w,h])}return out}
function finalize(p){const parts=[],{i,j,l}=p;p.pat=null;
 const add=(c,k,col,nocol)=>parts.push({c,k,col,nocol});
 if(p.t=='r')add(rampCorners(i,j,l,p.d,p.hs),1);
 else if(p.t=='k'){p.hole=coneHoleQ(p);if(p.hole>=0){const N=8,yb=l*H+.02;for(let a=0;a<N;a++)for(let c=0;c<N;c++){const u0=a/N,u1=(a+1)/N,v0=c/N,v1=(c+1)/N;
   if(Math.floor((u0+u1))+Math.floor((v0+v1))*2==p.hole)continue;const P=(u,v,dy)=>[(i+u)*S,yb+coneHt(p.mask,u,v)*H/2+dy,(j+v)*S];
   const Q=(p.mask==2||p.mask==4)?[[u1,v0],[u1,v1],[u0,v1],[u0,v0]]:[[u0,v0],[u1,v0],[u1,v1],[u0,v1]];add([...Q.map(q=>P(q[0],q[1],-.22)),...Q.map(q=>P(q[0],q[1],0))],1)}}
  else for(const c of coneParts(i,j,l,p.mask||0))add(c,1);p.pat=pattern('k',p.mask||0);if(p.hole>=0)p.pat={type:'cone',name:'Дурка (проход)'}}
 else if(p.t=='w'&&DIAG[p.mask]){p.pat=pattern('w',p.mask);const[fu,fv]=DIAG[p.mask],hf=.12,e=.05;
  // угловой редакт по диагонали: срез идёт прямой линией через внутренний угол
  const Wp=(q,sd)=>{const al=(fu?1-q[0]:q[0])*S,y=l*H+(fv?.1:0)+(fv?1-q[1]:q[1])*H;return p.ax==0?[i*S+al,y,j*S+sd]:[i*S+sd,y,j*S+al]};
  const hx=(Q,h)=>[...Q.map(q=>Wp(q,-h)),...Q.map(q=>Wp(q,h))];
  if(fv){add(hx([[0,1],[1,0],[1,1],[0,1]],hf),1,null,true);
   add(hx([[0,1],[1,0],[1,e],[e,1]],.17),.62,null,true);
   const base=p.ax==0?i*S:j*S;p.xr=[];for(let k=0;k<24;k++){const u0=k/24,u1=(k+1)/24,vl=1-(k+.5)/24;
    const a0=fu?1-u1:u0,a1=fu?1-u0:u1;p.xr.push([base+a0*S,base+a1*S,l*H+.1,l*H+.1+(1-vl)*H])}}
  else{add(hx([[0,2/3],[2/3,0],[2/3,1],[0,1]],hf),1,null,true);add(hx([[2/3,0],[1,0],[1,1],[2/3,1]],hf),1);
   add(hx([[0,2/3],[2/3,0],[2/3+e,0],[0,2/3+e]],.17),.62,null,true);
   const base=p.ax==0?i*S:j*S;p.xr=[];for(let k=0;k<8;k++){const u0=k/12,u1=(k+1)/12,vl=2/3-(k+.5)/12;
    const a0=fu?1-u1:u0,a1=fu?1-u0:u1;p.xr.push([base+a0*S,base+a1*S,l*H+vl*H,l*H+H])}}}
 else{const n=p.t=='w'?3:2,T=S/n,K=(~p.mask)&((1<<(n*n))-1);for(const[a,c,w,h]of greedy(K,n))add(tileBox(p,a,c,w,h),1);
  const pat=p.pat=pattern(p.t,p.mask),fil=pat.fil||[],isK=(a,c)=>a>=0&&a<n&&c>=0&&c<n&&(K>>(a+c*n)&1),tw=.14;
  for(const[a,c,sd]of fil)fillet(p,a,c,sd,add);
  for(let c=0;c<n;c++)for(let a=0;a<n;a++){if(isK(a,c))continue;const f=fil.find(x=>x[0]==a&&x[1]==c);
   if(p.t=='w'){const A0=a*T,A1=A0+T,Y0=l*H+c*H/3,Y1=Y0+H/3,hf=.17;
    if(isK(a-1,c)&&!(f&&f[2]=='tl'))add(wallBox(p,A0,A0+tw,Y0,Y1,hf),.62);if(isK(a+1,c)&&!(f&&f[2]=='tr'))add(wallBox(p,A1-tw,A1,Y0,Y1,hf),.62);
    if(isK(a,c+1)&&!f)add(wallBox(p,A0,A1,Y1-tw,Y1,hf),.62);if(isK(a,c-1))add(wallBox(p,A0,A1,Y0,Y0+tw,hf),.62)}
   else{const X0=i*S+a*T,X1=X0+T,Z0=j*S+c*T,Z1=Z0+T,y0=l*H-.18,y1=l*H+.14;
    if(isK(a-1,c))add(boxC(X0,y0,Z0,X0+tw,y1,Z1),.62);if(isK(a+1,c))add(boxC(X1-tw,y0,Z0,X1,y1,Z1),.62);
    if(isK(a,c-1))add(boxC(X0,y0,Z0,X1,y1,Z0+tw),.62);if(isK(a,c+1))add(boxC(X0,y0,Z1-tw,X1,y1,Z1),.62)}}
  if(pat.type=='door'){const an=p.anim||0,th=an*Math.PI/2*.92,hinge=pat.a*T+tw,Lp=T-2*tw,y0=l*H,y1=l*H+2*H/3-tw;
   add(doorBox(p,hinge,th,0,Lp,-.07,.07,y0,y1),.78,null,an>.5);
   add(doorBox(p,hinge,th,Lp*.12,Lp*.88,-.09,.09,y0+.35,y0+.5),.6,null,true);add(doorBox(p,hinge,th,Lp*.12,Lp*.88,-.09,.09,y1-.5,y1-.35),.6,null,true);
   add(doorBox(p,hinge,th,Lp-.3,Lp-.16,-.16,.16,y0+1.25,y0+1.4),0,[.85,.75,.35],true)}}
 p.parts=parts;p.glass=[];p.boxes=parts.map(x=>x.c);
 if(p.t=='w'){const ax=p.ax==0?0:2,rr=c=>{let a0=1e9,a1=-1e9,y0=1e9,y1=-1e9;for(const v of c){a0=Math.min(a0,v[ax]);a1=Math.max(a1,v[ax]);y0=Math.min(y0,v[1]);y1=Math.max(y1,v[1])}return[a0,a1,y0,y1]};
  p.rects=parts.filter(x=>!x.nocol).map(x=>rr(x.c));if(p.xr&&DIAG[p.mask])p.rects.push(...p.xr);p.xr=null}
 const cc=p.t=='w'?(p.ax==0?[(p.i+.5)*S,(p.l+.5)*H,p.j*S]:[p.i*S,(p.l+.5)*H,(p.j+.5)*S]):[(p.i+.5)*S,(p.l+.5)*H,(p.j+.5)*S];
 p.cen=cc;p.r2=4*S*S}
function connKeys(p){const{i,j,l}=p,o=[],hx=(i,j,l)=>'x'+i+','+j+','+l,hz=(i,j,l)=>'z'+i+','+j+','+l,v=(i,j,l)=>'v'+i+','+j+','+l;
 if(p.t=='w'){if(p.ax==0)o.push(hx(i,j,l),hx(i,j,l+1),v(i,j,l),v(i+1,j,l));else o.push(hz(i,j,l),hz(i,j,l+1),v(i,j,l),v(i,j+1,l))}
 else{const cell=L=>[hx(i,j,L),hx(i,j+1,L),hz(i,j,L),hz(i+1,j,L)];o.push(...cell(l));
  const d=p.t=='r'?p.d:p.t=='k'&&(p.mask in CSL)?CSL[p.mask]:-1;
  if(d>=0){const L=l+1;if(d==0)o.push(hx(i,j+1,L),v(i,j+1,l),v(i+1,j+1,l));else if(d==2)o.push(hx(i,j,L),v(i,j,l),v(i+1,j,l));else if(d==1)o.push(hz(i+1,j,L),v(i+1,j,l),v(i+1,j+1,l));else o.push(hz(i,j,L),v(i,j,l),v(i,j+1,l))}}
 return o}
function edgeMap(){const m=new Map();for(const[k,p]of pieces)for(const e of connKeys(p)){let a=m.get(e);if(!a)m.set(e,a=[]);a.push(k)}return m}

function refresh(p){finalize(p);const cone=pieces.get('k'+p.i+','+p.j+','+p.l);if(p.t==='f'&&cone)finalize(cone);}
function collapse(){const edges=edgeMap(),seen=new Set(),queue=[];for(const[k,p]of pieces)if(p.l===0){seen.add(k);queue.push(k);}while(queue.length){const p=pieces.get(queue.pop());for(const e of connKeys(p))for(const key of edges.get(e)||[])if(!seen.has(key)){seen.add(key);queue.push(key);}}const gone=[];for(const[k]of pieces)if(!seen.has(k)){pieces.delete(k);gone.push(k);}for(const p of pieces.values())if(p.t==='k')finalize(p);return gone;}
function ray(o,d,limit){let hit=null,best=limit;for(const[k,p]of pieces){const oc=sub(p.cen,o),tc=dot(oc,d);if(tc<-S||dot(oc,oc)-tc*tc>p.r2)continue;for(const box of p.boxes)for(const f of FACES)for(const t of [rayTri(o,d,box[f[0]],box[f[1]],box[f[2]]),rayTri(o,d,box[f[0]],box[f[2]],box[f[3]])])if(t>=0&&t<best){best=t;hit={key:k,t};}}return hit;}
return {pieces,refresh,finalize,keyOf,validEdit,collapse,ray,canPlace:p=>p.l===0||connKeys(p).some(e=>edgeMap().has(e))};
}
