// Build a clickable, backend-free preview of the real pages (sample data in localStorage), for review only.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
const out = join(root, "preview");
await mkdir(out, { recursive: true });

const qr = await readFile(join(pub, "static", "qr.js"), "utf8");

const MOCK = `
<script>${qr}</script>
<script>
// ---- PREVIEW ONLY: in-browser mock of the Worker API, shared across pages via localStorage ----
(function(){
  var KEY="inv_demo_v1";
  function seed(){ return { bins:[
    {id:"A12",name:"Nitrile gloves (Medium)",quantity:14,unit:"boxes",low_threshold:5,location:"Shelf 3",notes:"Reorder from Acme when low",created_at:0,updated_at:0},
    {id:"SOLDER",name:"Solder wire 0.8mm",quantity:3,unit:"reels",low_threshold:4,location:"Bench 2",notes:"",created_at:0,updated_at:0},
    {id:"PAPER-A4",name:"Printer paper A4",quantity:0,unit:"reams",low_threshold:2,location:"Cupboard",notes:"",created_at:0,updated_at:0}
  ], log:[] }; }
  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)) || seed(); }catch(e){ return seed(); } }
  function save(s){ try{ localStorage.setItem(KEY, JSON.stringify(s)); }catch(e){} }
  if(!localStorage.getItem(KEY)) save(seed());
  var now=function(){return Math.floor(Date.now()/1000);};
  function reply(obj,status){ status=status||200; return Promise.resolve({ ok:status<400, status:status, json:function(){return Promise.resolve(obj);}, text:function(){return Promise.resolve(JSON.stringify(obj));} }); }
  var real = window.fetch.bind(window);
  window.fetch=function(url,opts){
    url=String(url); opts=opts||{};
    var u; try{ u=new URL(url, location.href);}catch(e){ return real(url,opts); }
    var p=u.pathname.replace(/^\\/preview/,"");
    if(p.indexOf("/api/")===-1) return real(url,opts);
    var s=load();
    var body={}; try{ body=opts.body?JSON.parse(opts.body):{}; }catch(e){}
    var byId=function(id){ return s.bins.filter(function(b){return b.id===id;})[0]; };
    if(p==="/api/bins") return reply({bins:s.bins.slice().sort(function(a,b){return a.name.localeCompare(b.name);})});
    if(p==="/api/bin" && (opts.method||"GET")==="GET"){ var b=byId(u.searchParams.get("id")); return b?reply({bin:b}):reply({error:"not found"},404); }
    if(p==="/api/log"){ var id=u.searchParams.get("id"); var L=s.log.slice(); if(id) L=L.filter(function(x){return x.bin_id===id;}); return reply({log:L.slice(-40).reverse()}); }
    if(p==="/api/bin"){ var ex=byId(body.id);
      if(!/^[A-Za-z0-9_-]{1,64}$/.test(body.id||"")) return reply({error:"bad id"},400);
      if(!String(body.name||"").trim()) return reply({error:"An item name is required."},400);
      var q=Math.max(0,Math.trunc(+body.quantity||0));
      if(ex){ ex.name=body.name; ex.unit=body.unit||null; ex.low_threshold=(body.low_threshold===""||body.low_threshold==null)?null:Math.trunc(+body.low_threshold); ex.location=body.location||null; ex.notes=body.notes||null; if(body.quantity!==""&&body.quantity!=null) ex.quantity=q; ex.updated_at=now(); }
      else { ex={id:body.id,name:body.name,quantity:q,unit:body.unit||null,low_threshold:(body.low_threshold===""||body.low_threshold==null)?null:Math.trunc(+body.low_threshold),location:body.location||null,notes:body.notes||null,created_at:now(),updated_at:now()}; s.bins.push(ex); }
      save(s); return reply({ok:true,bin:ex}); }
    if(p==="/api/take"){ var b2=byId(body.id); if(!b2) return reply({error:"That bin doesn't exist."},404);
      var d=Math.trunc(+body.delta||0); if(!d) return reply({error:"Enter a quantity."},400);
      if(b2.quantity+d<0) return reply({error:"Only "+b2.quantity+" left in this bin.",quantity:b2.quantity},409);
      b2.quantity+=d; b2.updated_at=now(); s.log.push({id:s.log.length+1,bin_id:b2.id,name:b2.name,delta:d,resulting_qty:b2.quantity,who:body.who||null,note:body.note||null,at:now()}); save(s); return reply({ok:true,quantity:b2.quantity,delta:d}); }
    if(p==="/api/delete"){ s.bins=s.bins.filter(function(b){return b.id!==body.id;}); save(s); return reply({ok:true}); }
    return reply({error:"not found"},404);
  };
})();
</script>`;

function injectHead(html, extra) { return html.replace("</head>", extra + "\n</head>"); }

// Dashboard preview: base "", mock + inlined qr, drop the external qr.js loader.
let dash = await readFile(join(pub, "index.html"), "utf8");
dash = injectHead(dash, `<script>window.INV_BASE="";window.INV_BIN="";</script>` + MOCK);
dash = dash.replace(/<script>\s*\/\/ Load the vendored QR library[\s\S]*?<\/script>/, "<!-- qr inlined above for preview -->");
await writeFile(join(out, "dashboard.html"), dash);

// Scan preview: base "", bin id from ?bin= (default A12).
let scan = await readFile(join(pub, "bin.html"), "utf8");
scan = injectHead(scan, `<script>window.INV_BASE="";window.INV_BIN=(new URLSearchParams(location.search).get("bin"))||"A12";</script>` + MOCK);
await writeFile(join(out, "scan.html"), scan);

// Launcher
const launcher = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CWG Inventory — preview</title>
<style>body{margin:0;font:16px/1.6 system-ui,sans-serif;background:#0e1017;color:#eef1f7;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:560px;padding:28px;text-align:center}.card h1{font-size:22px}.note{color:#9aa3b6;font-size:14px;margin:6px 0 22px}
.row{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
a.b{display:block;flex:1;min-width:200px;padding:20px;border-radius:14px;border:1px solid #2b3040;background:#171a24;color:#eef1f7;text-decoration:none}
a.b b{display:block;font-size:17px;margin-bottom:4px}a.b span{color:#9aa3b6;font-size:13px}
.tag{display:inline-block;margin-top:18px;font-size:12px;color:#9aa3b6}</style></head>
<body><div class="card"><h1>CWG Department Inventory — preview</h1>
<p class="note">Sample data, running entirely in your browser. Changes you make here (taking, restocking, adding bins) are saved locally and shared between these two views, so you can take from the scan view and watch the dashboard update. Nothing here touches the live site.</p>
<div class="row">
<a class="b" href="dashboard.html"><b>Manager dashboard</b><span>Add bins, see levels, generate &amp; print QR codes, view the activity log</span></a>
<a class="b" href="scan.html?bin=A12"><b>Scan a bin (phone view)</b><span>What someone sees after scanning a bin's QR — enter how many they're taking</span></a>
</div>
<div class="tag">Try: open the dashboard, click a bin's <b>QR</b>; or scan-view <b>SOLDER</b> (<a style="color:#6c8cff" href="scan.html?bin=SOLDER">low stock</a>) and <b>PAPER-A4</b> (<a style="color:#6c8cff" href="scan.html?bin=PAPER-A4">out of stock</a>).</div>
</div></body></html>`;
await writeFile(join(out, "index.html"), launcher);
console.log("preview built:", out);
