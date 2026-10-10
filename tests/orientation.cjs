const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const page=process.argv[2]||path.join(__dirname,'..','index.html');
const source=fs.readFileSync(page,'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

// Run the complete page script. Only sensors, timestamps and drawing APIs are
// mocked; these checks do not claim to validate real-device sensor quality.
function runtime(webgl){
  const events={},cardEvents={},frames=[];
  const face={style:{}};
  const card={style:{},classList:{add(){},remove(){}},querySelector:()=>face,
    addEventListener:(name,fn)=>{cardEvents[name]=fn;},setPointerCapture(){},
    getBoundingClientRect:()=>({width:400,height:600})};
  const button={hidden:true,addEventListener:(name,fn)=>{events['button:'+name]=fn;}};
  const gl=new Proxy({}, {get:(_,key)=>{
    if(['getShaderParameter','getProgramParameter'].includes(key))return ()=>true;
    if(key==='getUniformLocation')return (_,name)=>name;
    return ()=>{};
  }});
  const canvas={style:{},getContext:kind=>kind==='webgl'?(webgl?gl:null):{}};
  const screen={orientation:{angle:0,addEventListener:(name,fn)=>{events['screen:'+name]=fn;}}};
  const document={hidden:false,addEventListener:(name,fn)=>{events['document:'+name]=fn;},
    querySelector:()=>face,getElementById:id=>({card,cardCanvas:canvas,motionToggle:button}[id]),
    createElement:()=>({getContext:()=>({})})};
  vm.runInNewContext(source,{
    console:{info(){},error:console.error},Math,Number,Float32Array,Uint8Array,
    navigator:{maxTouchPoints:1,userAgent:'Android'},screen,document,
    DeviceOrientationEvent:function(){},
    window:{matchMedia:()=>({matches:true}),DeviceOrientationEvent:function(){},isSecureContext:true,
      addEventListener:(name,fn)=>{events[name]=fn;}},
    Image:class {},performance:{now:()=>0},setTimeout:()=>1,clearTimeout(){},
    requestAnimationFrame:fn=>frames.push(fn)
  });
  let time=0;
  function frame(t){assert.equal(frames.length,1);frames.shift()(t);}
  frame(0);
  return {
    sensor(alpha,beta,gamma){events.deviceorientation({alpha,beta,gamma});},
    advance(seconds=2,fps=60){
      const start=time;
      for(let i=1;i<=Math.round(seconds*fps);i++)frame(start+i*1000/fps);
      time=start+seconds*1000;
    },
    calibrate(){events['button:click']();},
    screen(angle){screen.orientation.angle=angle;events['screen:change']();},
    resume(){events['document:visibilitychange']();},
    angles(){
      const m=card.style.transform.match(/rotateX\(([-\d.]+)deg\) rotateY\(([-\d.]+)deg\)/);
      return {pitch:Number(m[1]),yaw:Number(m[2])};
    }
  };
}

// Independent quaternion fixtures describe physical rotations about local axes.
function multiply(a,b){
  const [w,x,y,z]=a,[v,i,j,k]=b;
  return [w*v-x*i-y*j-z*k,w*i+x*v+y*k-z*j,w*j-x*k+y*v+z*i,w*k+x*j-y*i+z*v];
}
function axis(index,degrees){
  const half=degrees*Math.PI/360,q=[Math.cos(half),0,0,0];q[index]=Math.sin(half);return q;
}
function pose(a,b,g){return multiply(multiply(axis(3,a),axis(1,b)),axis(2,g));}
function reading(q){
  const [w,x,y,z]=q;
  const m=[1-2*(y*y+z*z),2*(x*y-w*z),2*(x*z+w*y),
    2*(x*y+w*z),1-2*(x*x+z*z),2*(y*z-w*x),
    2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)];
  let b=Math.asin(Math.max(-1,Math.min(1,m[7]))),a,g;
  if(Math.abs(Math.cos(b))<1e-8){a=Math.atan2(m[3],m[0]);g=0;}
  else{a=Math.atan2(-m[1],m[4]);g=Math.atan2(-m[6],m[8]);}
  if(Math.abs(g)>Math.PI/2){b=b>=0?Math.PI-b:-Math.PI-b;a+=Math.PI;g+=Math.PI;}
  const wrap=d=>((d+180)%360+360)%360-180;
  return [((a*180/Math.PI)%360+360)%360,b*180/Math.PI,wrap(g*180/Math.PI)];
}
function zero(r,label){const a=r.angles();assert(Math.abs(a.pitch)<.002&&Math.abs(a.yaw)<.002,`${label}: ${JSON.stringify(a)}`);}
function bounded(r){const a=r.angles();assert(Number.isFinite(a.pitch)&&Number.isFinite(a.yaw));assert(Math.abs(a.pitch)<=10.001&&Math.abs(a.yaw)<=12.001);}
const basis=pose(37,88,23);
for(const webgl of [true,false]){
  const equivalent=runtime(webgl);
  equivalent.sensor(0,90,20);equivalent.sensor(20,90,0);equivalent.advance();
  zero(equivalent,'equivalent upright poses must not move the card');

  const pitch=runtime(webgl);pitch.sensor(...reading(basis));
  pitch.sensor(...reading(multiply(basis,axis(1,15))));pitch.advance();
  assert(Math.abs(pitch.angles().yaw)<.002,'local pitch must not introduce sideways tilt');
  assert(pitch.angles().pitch<-6&&pitch.angles().pitch>-7);
  const yaw=runtime(webgl);yaw.sensor(...reading(basis));
  yaw.sensor(...reading(multiply(basis,axis(2,15))));yaw.advance();
  assert(Math.abs(yaw.angles().pitch)<.002,'local yaw must not introduce front/back tilt');
  assert(yaw.angles().yaw>8&&yaw.angles().yaw<9);
  const twist=runtime(webgl);twist.sensor(...reading(basis));
  twist.sensor(...reading(multiply(basis,axis(3,45))));twist.advance();zero(twist,'screen-normal twist');

  for(const screenAngle of [0,90,180,270]){
    const r=runtime(webgl);r.screen(screenAngle);r.sensor(...reading(basis));
    r.sensor(...reading(multiply(basis,axis(2,15))));r.advance();bounded(r);
    const a=r.angles();
    if(screenAngle%180===0){assert(Math.abs(a.pitch)<.002);assert(Math.sign(a.yaw)===(screenAngle===0?1:-1));}
    else{assert(Math.abs(a.yaw)<.002);assert(Math.sign(a.pitch)===(screenAngle===90?-1:1));}
    r.calibrate();r.sensor(...reading(multiply(basis,axis(2,15))));r.advance();zero(r,'recalibration');
    r.resume();r.sensor(...reading(basis));r.advance();zero(r,'resume recalibration');
  }

  const upright=runtime(webgl);upright.sensor(0,80,0);
  let previous=0;
  for(let b=80;b<=100;b++){
    upright.sensor(0,b,0);upright.advance(.1);
    const a=upright.angles();assert(Math.abs(a.yaw)<.002);assert(a.pitch<=previous+.001);previous=a.pitch;bounded(upright);
  }
  const noHeading=runtime(webgl);noHeading.sensor(null,90,20);noHeading.sensor(null,90,0);
  noHeading.advance();zero(noHeading,'no-heading upright readings');
  noHeading.sensor(null,75,0);noHeading.advance();bounded(noHeading);assert(noHeading.angles().pitch>0);
  noHeading.sensor(12,75,0);noHeading.advance();zero(noHeading,'heading availability recalibrates');

  const dynamic=runtime(webgl);dynamic.sensor(...reading(basis));
  for(let i=0;i<240;i++){
    const q=multiply(multiply(basis,axis(1,70*Math.sin(i*.08))),axis(2,80*Math.cos(i*.12)));
    dynamic.sensor(...reading(q));dynamic.advance(1/60);bounded(dynamic);
  }
  dynamic.sensor(NaN,NaN,Infinity);dynamic.advance();bounded(dynamic);
  dynamic.sensor(...reading(basis));dynamic.advance();zero(dynamic,'return to centre');
  const rates=[30,60,120].map(fps=>{
    const r=runtime(webgl);r.sensor(...reading(basis));
    r.sensor(...reading(multiply(basis,axis(1,15))));r.advance(.2,fps);return r.angles().pitch;
  });
  rates.forEach(value=>assert(Math.abs(value-rates[0])<.002));
  console.log(JSON.stringify({renderer:webgl?'WebGL':'Canvas',equivalent:equivalent.angles(),
    pitch:pitch.angles(),yaw:yaw.angles(),rates}));
}
console.log('PASS: equivalent poses, local axes, twist, upright crossing, four screen rotations, calibration, missing heading, limits and 30/60/120 Hz');
