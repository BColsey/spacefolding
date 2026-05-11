import * as http from 'node:http';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spacefolding Inspector</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}header,main{padding:16px}header{border-bottom:1px solid #334155;display:grid;gap:12px}input,button{font:inherit;padding:10px;border-radius:8px;border:1px solid #475569}input{background:#020617;color:#e2e8f0}button{background:#2563eb;color:white;cursor:pointer}button:hover{background:#1d4ed8}.row{display:grid;grid-template-columns:2fr 1fr;gap:16px}section{background:#111827;border:1px solid #334155;border-radius:12px;padding:12px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #1e293b;text-align:left;vertical-align:top}tr:hover{background:#0b1220;cursor:pointer}.hot{background:#7f1d1d66}.warm{background:#78350f66}.cold{background:#1e3a8a55}.muted{color:#94a3b8}.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1e293b;margin-right:6px}.stats{display:flex;flex-wrap:wrap;gap:8px}.mono{font-family:ui-monospace,SFMono-Regular,monospace}.small{font-size:12px;white-space:pre-wrap}
</style></head>
<body>
<header>
  <div><strong>Spacefolding Inspector</strong> <span class="muted">local web UI</span></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="task" placeholder="Score chunks against a task" style="flex:1;min-width:260px"><button id="score">Score</button><button id="refresh">Refresh</button></div>
  <div id="stats" class="stats"></div>
</header>
<main class="row">
  <section><table><thead><tr><th>ID</th><th>Source</th><th>Type</th><th>Text</th><th>Timestamp</th></tr></thead><tbody id="rows"></tbody></table></section>
  <section><div><strong>Dependencies</strong></div><pre id="deps" class="small muted">Click a chunk row to inspect dependencies.</pre><div style="margin-top:12px"><strong>Routing</strong></div><pre id="routing" class="small muted">Run a task score to highlight hot / warm / cold chunks.</pre></section>
</main>
<script>
const state={chunks:[],tiers:{},result:null};
const trim=(text,size=120)=>text&&text.length>size?text.slice(0,size-1)+'…':text||'';
const tierOf=id=>state.tiers[id]||'';
async function load(){
  const [chunks,stats]=await Promise.all([fetch('/api/chunks').then(r=>r.json()),fetch('/api/stats').then(r=>r.json())]);
  state.chunks=chunks; renderStats(stats); renderRows();
}
function renderStats(stats){
  const pills=['Chunks '+stats.totalChunks,'~Tokens '+stats.totalTokensEstimate,'Files '+stats.files.length];
  if(stats.oldestTimestamp)pills.push('From '+new Date(stats.oldestTimestamp).toLocaleDateString());
  if(stats.newestTimestamp)pills.push('To '+new Date(stats.newestTimestamp).toLocaleDateString());
  document.getElementById('stats').innerHTML=pills.map(v=>'<span class="pill">'+v+'</span>').join('');
}
function renderRows(){
  document.getElementById('rows').innerHTML=state.chunks.map(chunk=>'<tr class="'+tierOf(chunk.id)+'" data-id="'+chunk.id+'"><td class="mono">'+chunk.id.slice(0,8)+'</td><td>'+chunk.source+'</td><td>'+chunk.type+'</td><td>'+trim(chunk.text.replace(/\s+/g,' '))+'</td><td class="muted">'+new Date(chunk.timestamp).toLocaleString()+'</td></tr>').join('');
}
async function score(){
  const task=document.getElementById('task').value.trim();
  if(!task)return;
  const result=await fetch('/api/score?task='+encodeURIComponent(task)).then(r=>r.json());
  state.result=result; state.tiers={};
  for(const id of result.hot)state.tiers[id]='hot';
  for(const id of result.warm)state.tiers[id]='warm';
  for(const id of result.cold)state.tiers[id]='cold';
  document.getElementById('routing').textContent=JSON.stringify({hot:result.hot.length,warm:result.warm.length,cold:result.cold.length},null,2);
  renderRows();
}
async function showDependencies(id){
  const deps=await fetch('/api/dependencies?id='+encodeURIComponent(id)).then(r=>r.json());
  document.getElementById('deps').textContent=JSON.stringify(deps,null,2);
}
addEventListener('click',event=>{
  const row=event.target.closest('tr[data-id]');
  if(row)showDependencies(row.dataset.id);
});
document.getElementById('score').onclick=score;
document.getElementById('refresh').onclick=load;
document.getElementById('task').addEventListener('keydown',event=>{if(event.key==='Enter')score();});
load();
</script>
</body></html>`;

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function startWebServer(options: { port: number; pipeline: PipelineOrchestrator }): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (url.pathname === '/') {
        sendHtml(res, PAGE);
        return;
      }

      if (url.pathname === '/api/chunks') {
        sendJson(res, 200, options.pipeline.getAllChunks());
        return;
      }

      if (url.pathname === '/api/stats') {
        sendJson(res, 200, options.pipeline.getStats());
        return;
      }

      if (url.pathname === '/api/score') {
        const task = url.searchParams.get('task')?.trim();
        if (!task) {
          sendJson(res, 400, { error: 'Missing task query parameter' });
          return;
        }
        sendJson(res, 200, await options.pipeline.processContext({ text: task }));
        return;
      }

      if (url.pathname === '/api/dependencies') {
        const chunkId = url.searchParams.get('id')?.trim();
        if (!chunkId) {
          sendJson(res, 400, { error: 'Missing id query parameter' });
          return;
        }
        sendJson(res, 200, options.pipeline.getDependencies(chunkId));
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.listen(options.port);
  return server;
}
