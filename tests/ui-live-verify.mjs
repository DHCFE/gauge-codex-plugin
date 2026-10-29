// Opt-in real data verification. Only count/cost telemetry is persisted after sanitization.
// No budget mutations, model messages, raw prompts, credentials or account labels.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createIntegration} from '../src/integration-adapter.mjs';
import {readQuotaSnapshot,estimateWeeklyCapacity} from '../src/quota-service.mjs';
import {formatOverviewMoney,formatNumber} from '../web/account-model.js';
import {buildFixture} from './ui-fixture.mjs';
const run=promisify(execFile);
if(!process.argv.includes('--live'))throw new Error('Use --live for the explicitly authorized real telemetry read.');
const scratch=await mkdtemp(join(tmpdir(),'tokenlens-ui-observed-'));
const outDir='output/playwright/ui-d-rework/live';await mkdir(outDir,{recursive:true});
// Invoke the existing ledger's stdin CLI with Python forwarding stdin in memory.
let accountQueue=Promise.resolve();
const readRaw=async request=>{
 const program='import json,sys;sys.path.insert(0,sys.argv[1]);from account_usage import snapshot;print(json.dumps(snapshot(json.loads(sys.argv[2]),data_dir=sys.argv[3])))';
 const {stdout}=await run('python3',['-c',program,resolve('plugin/scripts'),JSON.stringify(request),scratch],{maxBuffer:32*1024*1024,timeout:45000,encoding:'utf8'});
 return JSON.parse(stdout);
};
const query=request=>{const job=accountQueue.then(()=>readRaw(request));accountQueue=job.then(()=>{},()=>{});return job;};
const integration=createIntegration({readAccount:query,readQuota:()=>readQuotaSnapshot(),estimateCapacity:estimateWeeklyCapacity,dataDir:scratch});
let browser;
try{
 let account=await integration.account({limit:1000});
 // Warm the existing incremental ledger until scan discovery has finished, bounded for very large homes.
 for(let pass=0;pass<8&&account.coverage.localScanComplete===false;pass++)account=await integration.account({limit:1000});
 const quota=await integration.quota();account=await integration.account({limit:1000});
 let offset=account.nextOffset;while(offset!==null){const next=await integration.account({limit:1000,offset});account.conversations.push(...next.conversations);offset=next.nextOffset;}
 assert.equal(quota.source,'codex-app-server','Official Codex endpoint');
 const observed=quota.costs;
 assert(observed,'Actual integration cost summary');
 const metrics={};
 for(const [name,row] of Object.entries({today:observed.today,currentWindow:observed.currentWindow,last30Days:observed.last30Days})){
  metrics[name]={usd:row.apiEquivalentUsd,tokens:row.tokens,scanComplete:row.scanComplete};assert(row.apiEquivalentUsd!==null&&row.apiEquivalentUsd>0,'Real '+name+' cost must be populated');assert(row.tokens!==null&&row.tokens>0,'Real '+name+' tokens must be populated');
 }
 assert(quota.weekly?.usedPercent>0,'Real official percent');assert(quota.estimate.capacityUsd>0,'Real labeled weekly estimate');
 // Keep values/quality/period. Drop identity, titles, paths, record ids and source records.
 const cleanCosts=Object.fromEntries(Object.entries({today:observed.today,currentWindow:observed.currentWindow,last30Days:observed.last30Days}).map(([name,row])=>[name,{status:row.status,apiEquivalentUsd:row.apiEquivalentUsd,tokens:row.tokens,totalTokens:row.totalTokens,costComplete:row.costComplete,scanComplete:row.scanComplete,period:row.period,precision:row.precision,qualityReasons:row.qualityReasons}]));
 const cleanQuota={status:quota.status,source:quota.source,observedAt:quota.observedAt,weekly:quota.weekly?{usedPercent:quota.weekly.usedPercent,remainingPercent:quota.weekly.remainingPercent,period:{startAt:quota.weekly.period.startAt,endAt:quota.weekly.period.endAt}}:null,estimate:{status:quota.estimate.status,capacityUsd:quota.estimate.capacityUsd,observedCycleUsd:quota.estimate.observedCycleUsd,periodCostUsd:quota.estimate.periodCostUsd,costComplete:quota.estimate.costComplete,qualityReasons:quota.estimate.qualityReasons},qualityReasons:quota.qualityReasons,costs:{source:'codex-local-ledger',sourceLabel:'Gauge 本地记录',updatedAt:observed.updatedAt,...cleanCosts}};
 const safeGroup=(row,id)=>({id,name:id,amountUsd:row.amountUsd,amount:row.amount,knownUsd:row.knownUsd,costComplete:row.costComplete,tokens:row.tokens,totalTokens:row.totalTokens,requestCount:row.requestCount,unpricedRequests:row.unpricedRequests});
 const cleanAccount={byModel:account.byModel.map(row=>safeGroup(row,row.id)),byProject:account.byProject.map((row,i)=>safeGroup(row,'本地项目 '+(i+1))),byDay:account.byDay.map(row=>({...safeGroup(row,row.id),day:row.id})),byAgent:account.byAgent.map(row=>safeGroup(row,row.id)),breakdown:{tokens:account.breakdown.tokens},status:account.status,observedAt:account.observedAt,summary:account.summary,coverage:{status:account.coverage.status,issues:account.coverage.issues},threadCount:account.conversations.length,conversations:account.conversations.map((row,i)=>({threadId:'observed-'+i,title:'本地记录 '+(i+1),models:row.models,tokens:row.tokens,total:row.total,amountUsd:row.amountUsd,costComplete:row.costComplete,usageStatus:row.usageStatus,updatedAt:row.updatedAt,project:'本地项目'}))};
 const fixture=await buildFixture({outputDir:outDir,overrides:{accountUsage:cleanAccount,quota:cleanQuota,budget:{enabled:false},budgetOverview:{status:'local',allocatedUsd:0,enabledCount:0,budgets:[]}}});
 const {chromium}=await import(pathToFileURL(process.env.TOKENLENS_PLAYWRIGHT_MODULE).href);browser=await chromium.launch({headless:true,args:['--disable-gpu'],executablePath:process.env.TOKENLENS_TEST_BROWSER});
 const page=await browser.newPage({timezoneId:'Asia/Shanghai',viewport:{width:1000,height:900}});await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await page.goto(pathToFileURL(resolve(fixture)).href);await page.locator('#accountTab').click();await page.locator('#accountRows tr').first().waitFor();
 for(const [name,prefix] of [['today','today'],['currentWindow','window'],['last30Days','month']]){assert.equal((await page.locator('#'+prefix+'Cost').textContent()).trim(),(cleanCosts[name].costComplete===false||cleanCosts[name].scanComplete===false?'≥ ':'')+formatOverviewMoney(metrics[name].usd),'Rendered '+name+' cost matches actual adapter');assert((await page.locator('#'+prefix+'Tokens').textContent()).includes(formatNumber(metrics[name].tokens)),'Rendered '+name+' tokens match actual adapter');}
assert.equal((await page.locator('#weeklyCapacity').textContent()).trim(),formatOverviewMoney(quota.estimate.capacityUsd),'Rendered capacity matches actual backend estimate');
 assert(await page.evaluate(()=>window.calls.every(call=>call.name!=='set_conversation_budget'&&call.name!=='get_budget_context')&&window.sentMessages.length===0),'No budget or model interaction');
 await page.screenshot({path:outDir+'/real-costs-light.png',fullPage:true});
 console.log(JSON.stringify({status:'passed',source:quota.source,metrics,weeklyUsedPercent:quota.weekly.usedPercent,estimatedCapacityUsd:quota.estimate.capacityUsd,estimateStatus:quota.estimate.status,discoveredConversations:account.threadCount,renderedConversations:cleanAccount.conversations.length,nativeHostTested:false}));
}finally{if(browser)await browser.close();await rm(scratch,{recursive:true,force:true});}
