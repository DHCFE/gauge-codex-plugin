import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('plugin/assets', { recursive:true });
const ui=await build({ entryPoints:['web/app.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,write:false });
writeFileSync('plugin/assets/tokenlens.html',readFileSync('web/index.html','utf8').replace('/* TOKENLENS_APP_STYLES */',readFileSync('web/styles.css','utf8')).replace('/* TOKENLENS_APP_SCRIPT */',()=>ui.outputFiles[0].text.replaceAll('</script','<\\/script')));
await build({ entryPoints:['src/server.mjs'],outfile:'plugin/server.mjs',bundle:true,format:'esm',platform:'node',target:'node22',banner:{js:'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'} });
await build({define:{'process.env.TOKENLENS_HOOK_LIBRARY':'"1"'},entryPoints:['src/integration-hook.mjs'],outfile:'plugin/budget-hook.mjs',bundle:true,format:'esm',platform:'node',target:'node22'});
console.log('Built native MCP App, optional budget hook and bundled plugin.');
