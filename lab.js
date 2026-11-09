
import {prepare,query,group,summarize,modelBreakdown,simulate,isHighRole} from './engine.js';

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2});
const usd = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
const money = cents => usd.format(cents/100);
const pct = value => (100*(value||0)).toFixed(1)+'%';
const dateKey = date => date.toISOString().slice(0,10);
const addDays = (day,count) => dateKey(new Date(Date.parse(day)+count*86400000));
const intervalDays = (from,to) => 1+Math.round((Date.parse(to)-Date.parse(from))/86400000);
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const providerColor = name => 'var(--'+name.toLowerCase()+')';
const roles = {premium:'高性能',economy:'经济档',pro:'Pro',flash:'Flash',thinking:'思考模式','non-thinking':'非思考'};
const evidence = {published_rate:'公开费率',historical_proxy:'历史代理价',assumed_discount:'优惠假设',published_rate_assumed_cutover:'公开费率 / 切换日估计',published_peak_offpeak_weighted:'峰谷价加权估计'};
const PAGE = 10;

let dataset, dailyPayload, playback, visibleRows = [], pageRows = [], timeKeys = [], chartBuckets = [];
const state = {grain:'week',metric:'tokens',mode:'baseline',providers:[],model:'',role:'',targets:{OpenAI:.2,Anthropic:.2,DeepSeek:.2,Google:.2},page:0,replay:0};

async function readJSON(url) {
  const result = await fetch(url);
  if (!result.ok) throw Error('HTTP '+result.status);
  return result.json();
}
function showFilterMessage(message='') {
  $('filter-message').hidden=!message;
  $('filter-message').textContent=message;
}
function stopPlayback(){
  clearInterval(playback);
  playback=null;
  $('play').textContent='▶ 历史回放';
}
function setRange(from,to) {
  stopPlayback();
  state.from=from;
  state.to=to;
  $('from').value=from;
  $('to').value=to;
  state.replay=intervalDays(from,to)-1;
  state.page=0;
  $('replay').max=state.replay;
  $('replay').value=state.replay;
  $('replay').disabled=state.replay===0;
  $('play').disabled=state.replay===0;
  document.querySelectorAll('[data-days]').forEach(b=>{
    const expected=b.dataset.days==='all'?dataset.from:addDays(dataset.to,1-Number(b.dataset.days));
    b.setAttribute('aria-pressed',String(from===expected && to===dataset.to));
  });
}
function chooseGrain(grain) {
  showFilterMessage();
  state.grain=grain;
  state.page=0;
  render();
}
function setStatus() {
  $('dataset-status').textContent='模拟数据快照 · '+dataset.from+' → '+dataset.to+' · '+fmt.format(dataset.daily.length)+' 条日级记录';
}
function filterModels(rows) {
  if(state.model) rows=rows.filter(r=>r.model===state.model);
  if(state.role) rows=rows.filter(r=>isHighRole(r.role)===(state.role==='high'));
  return rows;
}
function displayValue(value) {
  return state.metric==='cost'?money(value):fmt.format(value);
}
function axisValue(value) {
  return state.metric==='cost'?'$'+compact.format(value/100):compact.format(value);
}
function renderKpis(current) {
  const cards=[
    ['总用量',compact.format(current.tokens),fmt.format(current.output)+' 输出 tokens'],
    ['模拟请求',compact.format(current.requests),'按模拟请求形态计数'],
    ['上游成本',money(current.cost),'缓存节省 '+money(current.savings)],
    ['输入缓存命中',pct(current.cacheHit),compact.format(current.read)+' 缓存读取 tokens']
  ];
  $('kpis').innerHTML=cards.map(([label,value,meta])=>'<article class="kpi"><span class="metric-label">'+label+'</span><strong class="metric-value">'+value+'</strong><span class="metric-meta">'+meta+'</span></article>').join('');
}
function chartKey(key) {

  return state.grain==='month'?key:key.slice(5,10);
}
function renderChart(rows) {
  const actual=group(rows,state.grain);
  const byTime=new Map(actual.map(bucket=>[bucket.key,bucket]));
  chartBuckets=timeKeys.map(key=>byTime.get(key)||{key,tokens:0,requests:0,cost:0});
  const chart=$('chart');
  const info=$('chart-detail');
  $('legend').innerHTML=state.providers.map(provider=>'<span><i style="--provider:'+providerColor(provider)+';background:'+providerColor(provider)+'"></i>'+esc(provider)+'</span>').join('');
  if(!actual.length){chart.innerHTML='<p class="empty">这个范围没有匹配的模拟记录。</p>';info.textContent='';return;}
  const perProvider=new Map(state.providers.map(provider=>[provider,new Map(group(rows.filter(r=>r.provider===provider),state.grain).map(item=>[item.key,item[state.metric]]))]));
  const max=Math.max(1,...chartBuckets.map(bucket=>bucket[state.metric]));
  const tickIndices=[...new Set(Array.from({length:Math.min(6,chartBuckets.length)},(_,i)=>Math.round(i*(chartBuckets.length-1)/Math.max(1,Math.min(6,chartBuckets.length)-1))))];
  const ticks=[1,.75,.5,.25,0].map(ratio=>'<span>'+axisValue(max*ratio)+'</span>').join('');
  const bars=chartBuckets.map((bucket,index)=>{
    const value=bucket[state.metric];
    const parts=state.providers.map(provider=>'<span class="bar-segment" style="--provider:'+providerColor(provider)+';flex:'+ (perProvider.get(provider).get(bucket.key)||0)+'"></span>').join('');
    const desc=bucket.key+' · '+displayValue(value);
    return '<button type="button" class="bar-slot" data-bucket="'+index+'" title="'+esc(desc)+'" aria-label="'+esc(desc)+'"><span class="bar-stack" style="--bar-height:'+ (value/max*100)+'%">'+parts+'</span></button>';
  }).join('');
  chart.innerHTML='<div class="chart-grid"><div class="chart-y">'+ticks+'</div><div class="bars">'+bars+'</div><div class="chart-x">'+tickIndices.map(i=>'<span>'+esc(chartKey(chartBuckets[i].key))+'</span>').join('')+'</div></div>';
  const maxBucket=chartBuckets.reduce((a,b)=>a[state.metric]>=b[state.metric]?a:b);
  info.textContent='峰值时间桶 '+maxBucket.key+' · '+displayValue(maxBucket[state.metric])+(state.grain==='day'?' · 点击日期查看日记录':' · 点击柱子下钻');
}
function renderRouting(current,original,singleRoleTokens) {
  const delta=current.cost-original.cost;
  const sign=delta>0?'+':delta<0?'−':'';
  $('routing-delta').innerHTML='<span class="metric-label">筛选范围 · 高性能 / 思考档</span><strong>'+pct(current.highShare)+'</strong>'+
    '<span class="metric-meta">'+(state.mode==='baseline'?'原始模拟占比':'成本差 '+sign+money(Math.abs(delta))+' · 缓存命中 '+pct(original.cacheHit)+' → '+pct(current.cacheHit))+'</span>';
  const note='按当时可用的模型分流，用原模型的单位用量估算成本和缓存。';
  $('routing-note').textContent=note+(state.mode==='scenario'&&singleRoleTokens?' 单档时间桶保留原分配，共 '+compact.format(singleRoleTokens)+' tokens。':'')+(state.mode==='scenario'&&(state.model||state.role)?' 模型和用途筛选应用在分流之后。':'');
  document.querySelectorAll('[data-target]').forEach(input=>{input.disabled=state.mode!=='scenario'||!state.providers.includes(input.dataset.target);});
}
function renderModels(rows) {
  const models=modelBreakdown(rows);
  const max=Math.max(1,...models.map(item=>item.tokens));
  $('models').innerHTML=models.length?models.map(item=>
    '<button type="button" class="model-row" data-model="'+esc(item.model)+'" aria-pressed="'+(state.model===item.model)+'">'+
    '<span class="model-name"><strong>'+esc(item.model)+'</strong><small>'+esc(item.provider)+' · '+esc(roles[item.role]||item.role)+'</small></span><span class="model-stat">'+compact.format(item.tokens)+'<small>'+money(item.cost)+'</small></span>'+
    '<span class="mix-track"><span style="width:'+(100*item.tokens/max)+'%;--provider:'+providerColor(item.provider)+'"></span></span></button>').join(''):'<p class="empty">没有匹配模型。</p>';
  $('reset-model').hidden=!state.model;
}
function renderLedger() {
  const pages=Math.max(1,Math.ceil(visibleRows.length/PAGE));
  state.page=Math.min(state.page,pages-1);
  pageRows=visibleRows.slice(state.page*PAGE,(state.page+1)*PAGE);
  $('ledger-info').textContent=fmt.format(visibleRows.length)+' 条'+'日级记录 · Europe/Berlin';
  $('rows').innerHTML=pageRows.length?pageRows.map((r,i)=>
    '<tr><td>'+esc(r.hour||r.day)+'</td><td><span class="provider-dot" style="background:'+providerColor(r.provider)+'"></span><strong>'+esc(r.model)+'</strong><small>'+esc(r.provider)+' · '+esc(roles[r.role]||r.role)+'</small></td><td>'+compact.format(r.tokens)+'</td><td>'+pct(r.input?r.read/r.input:0)+'</td><td>'+money(r.cost)+'</td><td><button class="row-action" data-row="'+i+'" aria-label="'+esc('查看 '+r.model+' '+(r.hour||r.day)+' 的详情')+'">详情</button></td></tr>').join(''):
    '<tr><td colspan="6" class="empty">没有匹配记录。</td></tr>';
  $('page-info').textContent='第 '+(state.page+1)+' / '+pages+' 页';
  $('prev').disabled=state.page===0;
  $('next').disabled=state.page+1>=pages;
}
function render(){
  if(!dataset) return;
  const end=addDays(state.from,state.replay);
  const source=dataset.daily;
  timeKeys=group(query(source,{from:state.from,to:end}),state.grain).map(bucket=>bucket.key);
  const pool=query(source,{from:state.from,to:end,providers:state.providers});
  const baseline=filterModels(pool);
  const result=state.mode==='scenario'?simulate(pool,state.targets,'day'):{rows:pool,singleRoleTokens:0};
  const filtered=filterModels(result.rows).filter(row=>row.tokens>0);
  const totals=summarize(filtered);
  visibleRows=filtered.slice().sort((a,b)=>(b.hour||b.day).localeCompare(a.hour||a.day)||a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
  $('replay-label').textContent=end;
  $('replay').value=state.replay;
  $('export').disabled=!visibleRows.length;
  document.querySelectorAll('[data-grain]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.grain===state.grain)));
  document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode)));
  renderKpis(totals);
  renderChart(filtered);
  renderRouting(totals,summarize(baseline),result.singleRoleTokens);
  renderModels(result.rows.filter(row=>row.tokens>0));
  renderLedger();
}
function detail(row) {
  if(!row) return;
  const cells=[
    ['日期',row.day],['供应商',row.provider],['模型',row.model],['用途',roles[row.role]||row.role],
    ['总 token',fmt.format(row.tokens)],['普通输入',fmt.format(row.uncached)],['缓存读取',fmt.format(row.read)],['缓存写入',fmt.format(row.write)],
    ['输出 token',fmt.format(row.output)],['输入缓存命中',pct(row.input?row.read/row.input:0)],['模拟请求',fmt.format(row.requests)],['请求口径','按请求形态模拟'],
    ['上游成本',money(row.cost)],['缓存节省',money(row.savings)],['模型发布',row.release],['模拟采用',row.adoption],
    ['模型 API ID',row.modelId],['费率 USD/MTok · 输入 / 输出 / 缓存读 / 写',rateText(row.rates)],['费率依据',evidence[row.pricingEvidence]||row.pricingEvidence],['数据口径',row.status==='synthetic_history'?'历史模拟':'部分预测模拟']
  ];
  const safeSource=/^https:\/\//.test(row.pricingSource||'')?row.pricingSource:'';
  $('detail-content').innerHTML=cells.map(([label,value])=>'<div><span class="metric-label">'+label+'</span><strong>'+esc(value)+'</strong></div>').join('')+(safeSource?'<a href="'+esc(safeSource)+'" target="_blank" rel="noopener noreferrer">打开费率来源 ↗</a>':'');
  $('detail-dialog').showModal();
}
function exportCSV() {
  const header=['dataset','routing_mode','local_day','provider','model','model_id','role','data_status','model_release','scenario_adoption','pricing_evidence','pricing_source','input_usd_per_mtok','output_usd_per_mtok','cache_read_usd_per_mtok','cache_write_usd_per_mtok','tokens','uncached_input_tokens','cache_read_tokens','cache_write_tokens','output_tokens','estimated_requests','upstream_usd_cents','baseline_usd_cents','cache_savings_usd_cents'];
  const values=visibleRows.map(r=>['synthetic_usage_simulation',state.mode,r.day,r.provider,r.model,r.modelId,r.role,r.status,r.release,r.adoption,r.pricingEvidence,r.pricingSource,...r.rates,r.tokens,r.uncached,r.read,r.write,r.output,r.requests,r.cost,r.baseline,r.savings]);
  const escape=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  const url=URL.createObjectURL(new Blob(['\ufeff'+[header,...values].map(row=>row.map(escape).join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='sub2api-simulation-'+state.mode+'-'+state.from+'-to-'+addDays(state.from,state.replay)+'.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

const priceText = value => value == null ? '—' : '$'+String(value);
const rateText = values => values.map(priceText).join(' / ');
const linkOut = (url,label='来源 ↗') => /^https:\/\//.test(url||'') ? '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+label+'</a>' : '';
function renderMonthlyAudit() {
  const selected=$('audit-month').value;
  const m=dailyPayload.monthly_summary.find(row=>row.month===selected);
  if(!m) return;
  $('audit-title').textContent=m.month+' · '+compact.format(m.total_tokens)+' tokens · '+money(m.upstream_usd_cents);
  $('month-summary').querySelectorAll('button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.audit===selected)));
  const eventLines=m.events.map(e=>'<li><strong>'+esc(e.date)+' · '+esc(e.provider)+' · '+esc(e.name)+'</strong>'+
    (e.notes?'<small>'+esc(e.notes)+'</small>':'')+' '+linkOut(e.source)+'</li>');
  const releases=dailyPayload.model_catalog.filter(entry=>entry.release.startsWith(selected));
  const tariffLines=releases.map(entry=>'<li><strong>'+esc(entry.name)+'</strong><small>'+
    esc(entry.release)+' · 发布输入 / 输出 / 缓存读 / 写 '+esc(rateText([entry.input,entry.output,entry.read,entry.write]))+
    '</small><small>'+esc(entry.notes||'')+'</small>'+linkOut(entry.source)+'</li>');
  $('audit-events').innerHTML=eventLines.concat(tariffLines).join('')||'<li>本目录该月无新增事件。</li>';
  $('audit-mix').innerHTML=m.mixture.map(item=>{
    const rateRows=item.rate_periods.map(rate=>'<li><strong>'+esc(rateText([rate.input,rate.output,rate.read,rate.write]))+'</strong>'+
      '<small>'+esc(rate.from_date)+' 至 '+esc(rate.through_date)+' · 采用 '+rate.days+' 天 · '+esc(evidence[rate.evidence]||rate.evidence)+' · '+linkOut(rate.source)+'</small></li>').join('');
    return '<details><summary><strong>'+esc(item.model)+'</strong> · '+pct(item.total_tokens/m.total_tokens)+' · '+compact.format(item.total_tokens)+' tokens · '+money(item.upstream_usd_cents)+'</summary>'+
      '<small>'+esc(item.provider)+' · '+esc(roles[item.role]||item.role)+' · '+esc(item.model_id)+' · 输入 / 输出 / 缓存读 / 写</small><ul>'+rateRows+'</ul></details>';
  }).join('');
}
function setupMonthlyAudit() {
  const months=dailyPayload.monthly_summary;
  $('audit-month').replaceChildren(...months.map(m=>new Option(m.month,m.month)));
  $('audit-month').value=months.at(-1).month;
  $('cohort-budget').textContent='团队范围共 '+compact.format(dailyPayload.totals.total_tokens)+' tokens，模拟上游成本 '+
    money(dailyPayload.totals.upstream_usd_cents)+'。输出占比 '+pct(dailyPayload.totals.output_tokens/dailyPayload.totals.total_tokens)+
    '。对比预算 $3,000,000.00，本模拟低 '+money(300000000-dailyPayload.totals.upstream_usd_cents)+'。2025 年 10 月为新增的 12B 假设。';
  $('month-summary').innerHTML=months.map(m=>'<tr><td><button class="row-action" data-audit="'+m.month+'">'+m.month+'</button></td><td>'+compact.format(m.total_tokens)+'</td><td>'+money(m.upstream_usd_cents)+'</td><td>'+m.mixture.length+'</td><td>'+m.events.length+'</td></tr>').join('');
  $('audit-month').onchange=renderMonthlyAudit;
  $('month-summary').onclick=event=>{
    const selected=event.target.closest('[data-audit]')?.dataset.audit;
    if(!selected) return;
    $('audit-month').value=selected;
    renderMonthlyAudit();
  };
  renderMonthlyAudit();
}

function wire(){
  $('filters').addEventListener('submit',event=>{
    event.preventDefault();
    const from=$('from').value,to=$('to').value;
    if(from>to||from<dataset.from||to>dataset.to){showFilterMessage('请选择数据范围内的起止日期。');return;}
    state.model=$('model').value;
    state.role=$('role').value;
    state.providers=[...$('providers').querySelectorAll('input:checked')].map(input=>input.value);
    setRange(from,to);
    showFilterMessage();
    render();
  });
  document.querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>{
    showFilterMessage();
    setRange(b.dataset.days==='all'?dataset.from:addDays(dataset.to,1-Number(b.dataset.days)),dataset.to);
    render();
  });
  document.querySelectorAll('[data-grain]').forEach(b=>b.onclick=()=>chooseGrain(b.dataset.grain));
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{state.mode=b.dataset.mode;state.page=0;render();});
  $('routing-controls').addEventListener('input',event=>{
    const input=event.target;
    if(!input.dataset.target) return;
    state.targets[input.dataset.target]=Number(input.value)/100;
    input.parentElement.querySelector('output').textContent=input.value+'%';
    state.page=0;
    render();
  });
  $('metric').onchange=()=>{state.metric=$('metric').value;renderChart(visibleRows);};
  $('chart').addEventListener('click',async event=>{
    const bar=event.target.closest('[data-bucket]');
    if(!bar) return;
    const bucket=chartBuckets[Number(bar.dataset.bucket)];
    if(!bucket) return;

    if(state.grain==='day'){
      setRange(bucket.key,bucket.key);
      render();
      document.getElementById('ledger').scrollIntoView({block:'start'});
      return;
    }
    const start=state.grain==='month'?bucket.key+'-01':bucket.key;
    const boundary=state.grain==='month'?dateKey(new Date(Date.UTC(Number(bucket.key.slice(0,4)),Number(bucket.key.slice(5,7)),0))):addDays(start,6);
    const end=addDays(state.from,state.replay);
    setRange(start>state.from?start:state.from,boundary<end?boundary:end);
    await chooseGrain('day');
  });
  $('replay').oninput=()=>{
    stopPlayback();
    state.replay=Number($('replay').value);
    state.page=0;
    render();
  };
  $('play').onclick=()=>{
    if(playback){stopPlayback();return;}
    state.replay=0;
    state.page=0;
    render();
    $('play').textContent='Ⅱ 暂停回放';
    const end=intervalDays(state.from,state.to)-1;
    playback=setInterval(()=>{
      state.replay=Math.min(end,state.replay+Math.max(1,Math.ceil(end/40)));
      render();
      if(state.replay===end) stopPlayback();
    },175);
  };
  $('models').addEventListener('click',event=>{
    const model=event.target.closest('[data-model]')?.dataset.model;
    if(!model) return;
    state.model=state.model===model?'':model;
    $('model').value=state.model;
    state.page=0;
    render();
  });
  $('reset-model').onclick=()=>{state.model='';$('model').value='';state.page=0;render();};
  $('rows').addEventListener('click',event=>{
    const button=event.target.closest('[data-row]');
    if(button) detail(pageRows[Number(button.dataset.row)]);
  });
  $('prev').onclick=()=>{state.page--;renderLedger();};
  $('next').onclick=()=>{state.page++;renderLedger();};
  $('export').onclick=exportCSV;
}
try {
  dailyPayload=await readJSON('./data/daily.json');
  dataset=prepare(dailyPayload);
  const {rows:adjusted}=dataset.correction;
  if(adjusted) $('source-correction').textContent='实验台校正了 '+adjusted+' 条缓存分配超出输入量的记录，保留总 token 和原模拟成本。';
  state.providers=dataset.providers.slice();
  $('providers').innerHTML=dataset.providers.map(name=>'<label><input type="checkbox" checked value="'+esc(name)+'"><span class="provider-dot" style="background:'+providerColor(name)+'"></span>'+esc(name)+'</label>').join('');
  $('model').innerHTML+=[...dataset.models].sort().map(model=>'<option>'+esc(model)+'</option>').join('');
  $('routing-controls').innerHTML=dataset.providers.map(name=>'<div class="route-control"><label for="route-'+name+'"><span>'+esc(name)+'</span></label><output>20%</output><input id="route-'+name+'" type="range" min="0" max="100" step="1" value="20" data-target="'+esc(name)+'" aria-label="'+esc(name)+' 高性能档比例"></div>').join('');
  for(const id of ['from','to']){$(id).min=dataset.from;$(id).max=dataset.to;}
  $('apply').disabled=false;
  setStatus();
  setRange(dataset.from,dataset.to);
  setupMonthlyAudit();
  wire();
  render();
} catch (error) {
  console.error(error);
  $('dataset-status').textContent='无法加载模拟数据。请刷新后重试。';
}





