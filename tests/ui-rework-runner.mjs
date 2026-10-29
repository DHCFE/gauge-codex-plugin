import {pathToFileURL} from 'node:url';
import check from './ui-rework.mjs';
import {buildFixture} from './ui-fixture.mjs';
import {data,outputDir} from './ui-rework-fixture.mjs';
const {chromium}=await import(pathToFileURL(process.env.TOKENLENS_PLAYWRIGHT_MODULE).href);
const fixture=await buildFixture({outputDir,overrides:data});
const browser=await chromium.launch({headless:true,args:['--disable-gpu'],...(process.env.TOKENLENS_TEST_BROWSER?{executablePath:process.env.TOKENLENS_TEST_BROWSER}:{})});
const page=await browser.newPage({acceptDownloads:true,timezoneId:'Asia/Shanghai'});const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{await page.goto(pathToFileURL(process.cwd()+'/'+fixture).href);console.log(await check(page,{outputDir}));if(errors.length)throw new Error(errors.join('\n'));}finally{await browser.close();}
