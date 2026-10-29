import fs from 'node:fs';
import {build} from 'esbuild';
fs.mkdirSync('output/playwright',{recursive:true});
const turns=Array.from({length:63},(_,i)=>({id:'t'+(i+1),title:'第 '+(i+1)+' 轮',input:(i+1)*100,cached:(i+1)*1000,cacheRead:(i+1)*1000,output:(i+1)*10,totalTokens:(i+1)*1110,usd:[(i+1)*.001,(i+1)*.002,(i+1)*.003],amount:(i+1)*.006,costComplete:true,status:'completed',model:'gpt-6.1-sol',reasoning:0}));
const usage={live:true,threadId:'ui-test',title:'构建 Codex Cost Meter 插件',observedAt:Date.now(),currentTurnId:'t63',turns,total:{...turns[62],id:'total',title:'对话累计'},warnings:[]};
let js=fs.readFileSync('web/app.js','utf8');
js+='\nwindow.testReceive=receive;window.testUsage='+JSON.stringify(usage)+';receive({_meta:{usage:window.testUsage}});';
const out=await build({stdin:{contents:js,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',write:false});
fs.writeFileSync('output/playwright/check.html',fs.readFileSync('web/index.html','utf8').replace('/* TOKENLENS_APP_SCRIPT */',()=>out.outputFiles[0].text.replaceAll('</script','<\\/script')));
