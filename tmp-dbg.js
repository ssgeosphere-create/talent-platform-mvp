const fs=require('fs'),path=require('path'),{JSDOM}=require('jsdom');
const html=fs.readFileSync('public/index.html','utf8');
const appJs=fs.readFileSync('public/app.js','utf8');
const dom=new JSDOM(html,{url:'http://localhost/#/auth',runScripts:'outside-only',pretendToBeVisual:true});
const win=dom.window;
win.scrollTo=()=>{};
win.HTMLMediaElement.prototype.pause=()=>{};
win.console.error=(...a)=>console.log('ERR',...a);
win.console.log=(...a)=>console.log('LOG',...a);
win.fetch=async(u,o)=>({ok:true,status:200,json:async()=>({categories:[],reportReasons:[],maxVideoMb:80,user:null})});
try { win.eval(appJs); } catch(e){ console.log('EVAL THREW', e); }
setTimeout(()=>{
  console.log('hash:',win.location.hash);
  console.log('view:',win.document.getElementById('view').innerHTML.slice(0,800));
},200);
