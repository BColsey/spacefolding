import * as http from 'node:http';
import type { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import type { RetrievalMode, RetrievalResult } from '../core/retriever.js';

const WEB_RETRIEVAL_MODES: readonly RetrievalMode[] = ['focused', 'broad', 'exhaustive'];

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spacefolding Inspector</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}header,main{padding:16px}header{border-bottom:1px solid #334155;display:grid;gap:12px}input,button,select{font:inherit;padding:10px;border-radius:8px;border:1px solid #475569}input,select{background:#020617;color:#e2e8f0}button{background:#2563eb;color:white;cursor:pointer}button:hover{background:#1d4ed8}.row{display:grid;grid-template-columns:2fr 1fr;gap:16px}section{background:#111827;border:1px solid #334155;border-radius:12px;padding:12px;overflow:auto}table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #1e293b;text-align:left;vertical-align:top}tr:hover{background:#0b1220;cursor:pointer}.hot{background:#7f1d1d66}.warm{background:#78350f66}.cold{background:#1e3a8a55}.compressed{background:#581c8744}.muted{color:#94a3b8}.pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#1e293b;margin-right:6px}.stats{display:flex;flex-wrap:wrap;gap:8px}.mono{font-family:ui-monospace,SFMono-Regular,monospace}.small{font-size:12px;white-space:pre-wrap}.empty-state{padding:32px;text-align:center;color:#94a3b8}
</style></head>
<body>
<header>
  <div><strong>Spacefolding Inspector</strong> <span class="muted">local web UI</span></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="task" placeholder="Score chunks against a task" style="flex:1;min-width:260px"><button id="score">Score</button><button id="refresh">Refresh</button></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="retrieve-query" placeholder="Retrieve context for a query" style="flex:1;min-width:260px"><select id="retrieve-mode"><option value="focused">focused</option><option value="broad">broad</option><option value="exhaustive">exhaustive</option></select><button id="retrieve">Retrieve</button></div>
  <div id="stats" class="stats"></div>
</header>
<main class="row">
  <section>
    <div id="empty-msg" class="empty-state" style="display:none">No chunks ingested.</div>
    <table id="chunk-table"><thead><tr><th>ID</th><th>Path</th><th>Type</th><th>Tokens</th><th>Text</th><th>Timestamp</th></tr></thead><tbody id="rows"></tbody></table>
  </section>
  <section>
    <div><strong>Retrieval</strong></div>
    <pre id="retrieval" class="small muted">No retrieval result.</pre>
    <div style="margin-top:12px"><strong>Dependencies</strong></div>
    <pre id="deps" class="small muted">No chunk selected.</pre>
    <div style="margin-top:12px"><strong>Routing</strong></div>
    <pre id="routing" class="small muted">No routing result.</pre>
  </section>
</main>
<script>
const state={chunks:[],tiers:{}};
const trim=(text,size=120)=>text&&text.length>size?text.slice(0,size-1)+'…':text||'';
const escapeHtml=text=>String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const tierOf=id=>state.tiers[id]||'';
async function load(){
  const [chunks,stats]=await Promise.all([fetch('/api/chunks').then(r=>r.json()),fetch('/api/stats').then(r=>r.json())]);
  state.chunks=chunks; renderStats(stats); renderRows();
  document.getElementById('empty-msg').style.display=chunks.length===0?'block':'none';
  document.getElementById('chunk-table').style.display=chunks.length===0?'none':'table';
}
function renderStats(stats){
  const pills=['Chunks '+stats.totalChunks,'~Tokens '+stats.totalTokensEstimate,'Files '+stats.files.length];
  if(stats.oldestTimestamp)pills.push('From '+new Date(stats.oldestTimestamp).toLocaleDateString());
  if(stats.newestTimestamp)pills.push('To '+new Date(stats.newestTimestamp).toLocaleDateString());
  for(const file of stats.files.slice(0,5))pills.push(file.path+' '+file.chunkCount+' chunks ~'+file.tokensEstimate);
  document.getElementById('stats').innerHTML=pills.map(v=>'<span class="pill">'+escapeHtml(v)+'</span>').join('');
}
function renderRows(){
  document.getElementById('rows').innerHTML=state.chunks.map(chunk=>{
    const tier=tierOf(chunk.id);
    return '<tr class="'+escapeHtml(tier)+'" data-id="'+escapeHtml(chunk.id)+'"><td class="mono">'+escapeHtml(chunk.id.slice(0,8))+'</td><td class="mono small">'+escapeHtml(chunk.path||chunk.source||'')+'</td><td>'+escapeHtml(chunk.type)+'</td><td>'+(chunk.tokensEstimate||0)+'</td><td>'+escapeHtml(trim(chunk.text.replace(/\\s+/g,' ')))+'</td><td class="muted">'+escapeHtml(new Date(chunk.timestamp).toLocaleString())+'</td></tr>';
  }).join('');
}
async function score(){
  const task=document.getElementById('task').value.trim();
  if(!task)return;
  const result=await fetch('/api/score?task='+encodeURIComponent(task)).then(r=>r.json());
  state.tiers={};
  for(const id of result.hot)state.tiers[id]='hot';
  for(const id of result.warm)state.tiers[id]='warm';
  for(const id of result.cold)state.tiers[id]='cold';
  document.getElementById('routing').textContent=JSON.stringify({hot:result.hot.length,warm:result.warm.length,cold:result.cold.length},null,2);
  renderRows();
}
async function retrieve(){
  const query=document.getElementById('retrieve-query').value.trim();
  if(!query)return;
  const mode=document.getElementById('retrieve-mode').value;
  const result=await fetch('/api/retrieve?query='+encodeURIComponent(query)+'&mode='+mode).then(r=>r.json());
  if(result.error){document.getElementById('retrieval').textContent='Error: '+result.error;return;}
  const lines=[];
  lines.push('Intent: '+(result.plan?.intent||'?')+' | Strategy: '+(result.plan?.strategy||'?')+' | Mode: '+(result.selectionPolicy?.mode||mode));
  lines.push('Tokens: '+result.totalTokens+' / '+result.targetBudget+' target ('+result.budget+' hard cap)');
  if(result.chunks&&result.chunks.length>0){
    lines.push('');
    for(const c of result.chunks){
      const tier=c.tier||'warm';
      const reasons=(c.retrievalReasons||[]).join(', ');
      const scores=c.retrievalScores?' score '+Number(c.retrievalScores.final||0).toFixed(3):'';
      lines.push('['+tier.toUpperCase()+'] '+c.id.slice(0,8)+' '+(c.path||c.type)+' ~'+(c.tokensEstimate||0)+' tokens'+scores+(reasons?' ('+reasons+')':''));
    }
  } else {
    lines.push('No chunks returned.');
  }
  if(result.omittedCount>0)lines.push('\n'+result.omittedCount+' chunks omitted: '+result.omitted.slice(0,3).map(o=>o.reason).join(', '));
  if(result.droppedCount>0)lines.push(result.droppedCount+' candidates dropped: '+result.dropped.slice(0,3).map(o=>o.reason).join(', '));
  if(result.compressedCount>0)lines.push(result.compressedCount+' chunks compressed');
  document.getElementById('retrieval').textContent=lines.join('\n');
  state.tiers={};
  if(result.chunks)for(const c of result.chunks)state.tiers[c.id]=c.tier||'warm';
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
document.getElementById('retrieve').onclick=retrieve;
document.getElementById('refresh').onclick=load;
document.getElementById('task').addEventListener('keydown',event=>{if(event.key==='Enter')score();});
document.getElementById('retrieve-query').addEventListener('keydown',event=>{if(event.key==='Enter')retrieve();});
load();
</script>
</body></html>`;

interface WebRequest {
  method?: string;
  url?: string;
}

interface WebResponse {
  writeHead(status: number, headers: http.OutgoingHttpHeaders): void;
  end(data: string): void;
}

function sendJson(res: WebResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendHtml(res: WebResponse, html: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function parseRetrievalMode(value: string | null): { mode?: RetrievalMode; error?: string } {
  if (value === null || value === '') return {};
  if (WEB_RETRIEVAL_MODES.includes(value as RetrievalMode)) {
    return { mode: value as RetrievalMode };
  }
  return { error: `mode must be one of: ${WEB_RETRIEVAL_MODES.join(', ')}` };
}

function parsePositiveIntegerParam(value: string | null, name: string): { value?: number; error?: string } {
  if (value === null || value === '') return {};
  if (!/^\d+$/.test(value)) {
    return { error: `${name} must be a positive integer` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { error: `${name} must be a positive integer` };
  }
  return { value: parsed };
}

function retrievalDiagnosticsByChunkId(retrieval: RetrievalResult[]): Map<string, RetrievalResult> {
  return new Map(retrieval.map((result) => [result.chunkId, result]));
}

export function createWebRequestHandler(pipeline: PipelineOrchestrator) {
  return async (req: WebRequest, res: WebResponse): Promise<void> => {
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
        sendJson(res, 200, pipeline.getAllChunks());
        return;
      }

      if (url.pathname === '/api/stats') {
        sendJson(res, 200, pipeline.getStats());
        return;
      }

      if (url.pathname === '/api/score') {
        const task = url.searchParams.get('task')?.trim();
        if (!task) {
          sendJson(res, 400, { error: 'Missing task query parameter' });
          return;
        }
        sendJson(res, 200, await pipeline.processContext({ text: task }));
        return;
      }

      if (url.pathname === '/api/dependencies') {
        const chunkId = url.searchParams.get('id')?.trim();
        if (!chunkId) {
          sendJson(res, 400, { error: 'Missing id query parameter' });
          return;
        }
        sendJson(res, 200, pipeline.getDependencies(chunkId));
        return;
      }

      if (url.pathname === '/api/retrieve') {
        const query = url.searchParams.get('query')?.trim();
        if (!query) {
          sendJson(res, 400, { error: 'Missing query parameter' });
          return;
        }
        const mode = parseRetrievalMode(url.searchParams.get('mode'));
        if (mode.error) {
          sendJson(res, 400, { error: mode.error });
          return;
        }
        const maxTokens = parsePositiveIntegerParam(url.searchParams.get('maxTokens'), 'maxTokens');
        if (maxTokens.error) {
          sendJson(res, 400, { error: maxTokens.error });
          return;
        }

        const result = await pipeline.retrieve(query, maxTokens.value, {
          mode: mode.mode,
        });
        const retrievalByChunk = retrievalDiagnosticsByChunkId(result.retrieval);
        sendJson(res, 200, {
          chunks: result.chunks.map((c) => ({
            id: c.id,
            type: c.type,
            text: c.text,
            path: c.path,
            tokensEstimate: c.tokensEstimate,
            tier: result.tiers.get(c.id) ?? 'warm',
            compressedFrom: c.metadata?.compressedFrom ?? undefined,
            retrievalSources: retrievalByChunk.get(c.id.split('__compressed')[0])?.sources ?? [],
            retrievalScores: retrievalByChunk.get(c.id.split('__compressed')[0])?.sourceScores ?? undefined,
            retrievalReasons: retrievalByChunk.get(c.id.split('__compressed')[0])?.reasons ?? [],
          })),
          totalTokens: result.totalTokens,
          budget: result.budget,
          hardBudget: result.hardBudget,
          targetBudget: result.targetBudget,
          utilization: result.utilization,
          omittedCount: result.omitted.length,
          omitted: result.omitted,
          droppedCount: result.dropped.length,
          dropped: result.dropped,
          compressedCount: result.compressed.length,
          compressedSummaries: result.compressed.map((c) => ({
            originalChunkId: c.chunkId,
            tokensEstimate: c.tokensEstimate,
          })),
          plan: result.plan,
          selectionPolicy: result.selectionPolicy,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function startWebServer(options: { port: number; pipeline: PipelineOrchestrator }): http.Server {
  const handler = createWebRequestHandler(options.pipeline);
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });

  server.listen(options.port);
  return server;
}
