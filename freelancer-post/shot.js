const {chromium}=require('playwright-core');
(async()=>{const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage({viewport:{width:1080,height:1350},deviceScaleFactor:2});
await p.goto('file://'+__dirname+'/post.html');await p.evaluate(()=>document.fonts.ready);
await p.screenshot({path:'post.png'});await b.close();})();
