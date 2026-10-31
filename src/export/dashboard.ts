import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../config/env.js';
import { prepare } from '../db/db.js';
import { ATTRIBUTION, OVERTURE_ATTRIBUTION, flattenForReports } from './exporter.js';

/**
 * Generates data/exports/dashboard.html: one self-contained file (no server, no external requests).
 * It embeds AGGREGATED counts (category x division x district x scope x band x flagged), not individual
 * businesses, so the file stays small at any scale and exposes no contact details. All numbers are
 * recomputed in the browser from those groups, so filters always agree with totals. The page is built
 * with textContent only - nothing from the data is ever injected as HTML.
 */
export function writeDashboard(): { file: string; groups: number; records: number } {
  const flats = flattenForReports();
  const groups = new Map<string, Record<string, unknown>>();
  for (const f of flats) {
    const flagged = f.RecordStatus === 'needs_review' || f.RecordStatus === 'lead' ? 1 : 0;
    const key = [f._row.category_id, f.AdminDivision ?? '', f.AdminDistrict ?? '', f.DhakaScope ?? '', f.ConfidenceBand ?? 'low', flagged].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { k: f._row.category_id, c: f._row.category_label, dv: f.AdminDivision ?? '', d: f.AdminDistrict ?? '', s: f.DhakaScope ?? '', b: f.ConfidenceBand ?? 'low', fl: flagged, n: 0, w: 0, p: 0, e: 0, f: 0, i: 0, v: 0 };
      groups.set(key, g);
    }
    g.n = (g.n as number) + 1;
    if (f.WebsiteUrl) g.w = (g.w as number) + 1;
    if (f.PublicBusinessPhone) g.p = (g.p as number) + 1;
    if (f.PublicBusinessEmail) g.e = (g.e as number) + 1;
    if (f.FacebookPageUrl) g.f = (g.f as number) + 1;
    if (f.InstagramUrl) g.i = (g.i as number) + 1;
    if (f.WebsiteVerificationStatus === 'verified' || f.ContactVerificationStatus === 'verified' || f.FacebookVerificationStatus === 'verified' || f.InstagramVerificationStatus === 'verified') g.v = (g.v as number) + 1;
  }
  const districts = prepare<{ name: string; division: string | null; population: number | null }>(
    `SELECT d.name, v.name AS division, d.population FROM admin_areas d LEFT JOIN admin_areas v ON v.osm_relation_id=d.parent_id WHERE d.level='district' ORDER BY d.name`,
  ).all();
  const dup = prepare<{ n: number }>(`SELECT COUNT(*) n FROM duplicate_candidates WHERE status='pending'`).get()?.n ?? 0;

  const payload = {
    generatedAt: new Date().toISOString(), attribution: `${ATTRIBUTION} · ${OVERTURE_ATTRIBUTION}`, duplicates: dup,
    populationNote: 'Population: UNFPA / US Census Bureau 2022 estimates via HDX (CC BY-IGO).',
    groups: [...groups.values()], districts,
  };
  // `<` escaped so a "</script>" inside any value cannot end the data block.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(new RegExp('[  ]', 'g'), '');
  const file = resolve(env.exportDir, 'dashboard.html');
  writeFileSync(file, HTML.replace('__DATA__', () => json), 'utf-8');
  return { file, groups: groups.size, records: flats.length };
}

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bangladesh Business Data</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mute:#5d6672;--line:#dfe3e8;--bar:#2f6fed;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--card:#1d2127;--ink:#e8ebef;--mute:#9aa4b0;--line:#2c323a;--bar:#6b9bff;--warn:#f0a14b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1rem;margin:0 0 10px}
.note{color:var(--mute);font-size:.85rem}
.filters{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}label{font-size:.8rem;color:var(--mute);display:flex;flex-direction:column;gap:4px}
select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);min-width:190px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile b{display:block;font-size:1.5rem}.tile span{color:var(--mute);font-size:.8rem}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-top:12px}
.row{display:grid;grid-template-columns:minmax(110px,40%) 1fr 64px;gap:8px;align-items:center;margin:4px 0;font-size:.85rem}
.track{background:var(--line);border-radius:4px;height:10px;overflow:hidden}.fill{background:var(--bar);height:100%;display:block}
.row .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .v{text-align:right;font-variant-numeric:tabular-nums}
</style></head><body><main>
<h1>Bangladesh Business Data</h1>
<div class="note" id="meta"></div>
<div class="filters">
<label>Category<select id="fc"></select></label>
<label>Division<select id="fv"></select></label>
<label>District<select id="fd"></select></label>
<label>Dhaka scope<select id="fs"></select></label>
</div>
<div class="grid" id="tiles"></div>
<div class="cols">
<div class="card"><h2>By category</h2><div id="bycat"></div></div>
<div class="card"><h2>By district (top 15)</h2><div id="bydist"></div></div>
<div class="card"><h2>Data completeness</h2><div id="complete"></div></div>
<div class="card"><h2>Confidence</h2><div id="bands"></div></div>
<div class="card"><h2>Thinnest coverage: records per 10,000 people</h2><div class="note">Lowest 15 districts for the current filter. Low density can mean few businesses or incomplete map data; it is not proof either way.</div><div id="thin"></div></div>
</div>
<p class="note" id="pop"></p><p class="note" id="attr"></p>
</main>
<script id="data" type="application/json">__DATA__</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var $=function(id){return document.getElementById(id)};
function el(t,x,c){var e=document.createElement(t);if(x!==undefined)e.textContent=x;if(c)e.className=c;return e}
function opts(sel,vals,all){sel.textContent='';sel.appendChild(new Option(all,''));vals.forEach(function(v){sel.appendChild(new Option(v[1],v[0]))})}
function uniq(f){var m={};D.groups.forEach(function(g){var k=f(g);if(k[0]!=='')m[k[0]]=k[1]});return Object.keys(m).sort().map(function(k){return [k,m[k]]})}
opts($('fc'),uniq(function(g){return [g.k,g.c]}),'All categories');
opts($('fv'),uniq(function(g){return [g.dv,g.dv]}),'All divisions');
opts($('fd'),uniq(function(g){return [g.d,g.d]}),'All districts');
opts($('fs'),[['dhaka_metropolitan','Dhaka Metropolitan'],['greater_dhaka','Greater Dhaka (border areas)'],['outside_dhaka','Outside Dhaka area']],'All');
function sum(gs,f){return gs.reduce(function(a,g){return a+f(g)},0)}
function bars(host,items,total,fmt){host.textContent='';if(!items.length){host.appendChild(el('div','No data for this filter.','note'));return}
 items.forEach(function(it){var row=el('div',undefined,'row');var l=el('span',it[0],'l');l.title=it[0];var t=el('span',undefined,'track');var f=el('span',undefined,'fill');f.style.width=(total?Math.min(100,Math.round(100*it[1]/total)):0)+'%';t.appendChild(f);row.appendChild(l);row.appendChild(t);row.appendChild(el('span',fmt?fmt(it[1]):it[1].toLocaleString(),'v'));host.appendChild(row)})}
function tally(gs,key){var m={};gs.forEach(function(g){var k=key(g)||'(no district)';m[k]=(m[k]||0)+g.n});return Object.keys(m).map(function(k){return [k,m[k]]}).sort(function(a,b){return b[1]-a[1]})}
function render(){
 var c=$('fc').value,v=$('fv').value,d=$('fd').value,s=$('fs').value;
 var all=D.groups.filter(function(g){return (!c||g.k===c)&&(!v||g.dv===v)&&(!d||g.d===d)&&(!s||g.s===s)});
 var ok=all.filter(function(g){return !g.fl}),flag=sum(all.filter(function(g){return g.fl}),function(g){return g.n});
 var n=sum(ok,function(g){return g.n});
 var pop=0;D.districts.forEach(function(x){if((!v||x.division===v)&&(!d||x.name===d))pop+=x.population||0});
 $('tiles').textContent='';
 [['Businesses (exported)',n],['Held (review + leads)',flag],['With website',sum(ok,function(g){return g.w})],['With Facebook',sum(ok,function(g){return g.f})],
  ['With Instagram',sum(ok,function(g){return g.i})],['With phone',sum(ok,function(g){return g.p})],['With email',sum(ok,function(g){return g.e})],
  ['Verified (any field)',sum(ok,function(g){return g.v})],['Unverified',n-sum(ok,function(g){return g.v})],
  ['Per 10,000 people',pop?(n/pop*10000).toFixed(2):'n/a'],['Duplicate candidates (all data)',D.duplicates]].forEach(function(t){
   var x=el('div',undefined,'tile');x.appendChild(el('b',typeof t[1]==='number'?t[1].toLocaleString():t[1]));x.appendChild(el('span',t[0]));$('tiles').appendChild(x)});
 bars($('bycat'),tally(ok,function(g){return g.c}),n);
 bars($('bydist'),tally(ok,function(g){return g.d}).slice(0,15),n);
 bars($('complete'),[['Website',sum(ok,function(g){return g.w})],['Phone',sum(ok,function(g){return g.p})],['Email',sum(ok,function(g){return g.e})],['Facebook',sum(ok,function(g){return g.f})],['Instagram',sum(ok,function(g){return g.i})]],n);
 bars($('bands'),[['High (85-100)',sum(ok,function(g){return g.b==='high'?g.n:0})],['Medium (65-84)',sum(ok,function(g){return g.b==='medium'?g.n:0})],['Low (<65)',sum(ok,function(g){return g.b==='low'?g.n:0})]],n);
 var byD={};ok.forEach(function(g){if(g.d)byD[g.d]=(byD[g.d]||0)+g.n});
 var dens=D.districts.filter(function(x){return x.population&&(!v||x.division===v)&&(!d||x.name===d)}).map(function(x){return [x.name,(byD[x.name]||0)/x.population*10000]}).sort(function(a,b){return a[1]-b[1]}).slice(0,15);
 var mx=dens.reduce(function(a,x){return Math.max(a,x[1])},0.0001);
 bars($('thin'),dens,mx,function(x){return x.toFixed(2)});
}
['fc','fv','fd','fs'].forEach(function(id){$(id).addEventListener('change',render)});
$('meta').textContent='Generated '+D.generatedAt+'. Not an exhaustive directory: empty means no public data was found.';
$('pop').textContent=D.populationNote;$('attr').textContent=D.attribution;
render();
})();
</script></body></html>
`;
