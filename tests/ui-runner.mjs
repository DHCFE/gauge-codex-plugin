// Uses an existing Playwright installation and browser; never installs dependencies.
import {pathToFileURL} from 'node:url';
import history from './ui-history.mjs';
import account from './ui-account.mjs';
import roundPicker from './ui-round-picker.mjs';
const runtime=process.env.TOKENLENS_PLAYWRIGHT_MODULE;
if(!runtime)throw new Error('Set TOKENLENS_PLAYWRIGHT_MODULE to an existing playwright/index.mjs');
const {chromium}=await import(pathToFileURL(runtime).href);
const browser=await chromium.launch({headless:true,args:['--disable-gpu'],...(process.env.TOKENLENS_TEST_BROWSER?{executablePath:process.env.TOKENLENS_TEST_BROWSER}:{})});
const page=await browser.newPage({acceptDownloads:true,timezoneId:'Asia/Shanghai'});
if(process.env.TOKENLENS_UI_ARTIFACT_DIR){const takeScreenshot=page.screenshot.bind(page);page.screenshot=options=>takeScreenshot({...options,path:options.path?.replace(/^output\/playwright\//,process.env.TOKENLENS_UI_ARTIFACT_DIR+'/')});}
const errors=[];page.on('pageerror',error=>errors.push(error.message));
try{
  await page.goto(pathToFileURL(process.env.TOKENLENS_UI_FIXTURE||process.cwd()+'/output/playwright/ui-account.html').href);
  console.log(await roundPicker(page));console.log(await history(page));console.log(await account(page));
  if(errors.length)throw new Error(errors.join('\n'));
}finally{await browser.close();}
