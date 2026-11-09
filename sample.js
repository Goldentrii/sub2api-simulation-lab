
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const read = id => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const pageSize = 12;
let records = [],page = 0;
const view = {
  provider:read('sample-provider'), model:read('sample-model'), stream:read('sample-stream'),
  rows:read('sample-rows'), label:read('sample-page'), prev:read('sample-prev'), next:read('sample-next')
};

function choices(select, label, values) {
  const selected=select.value;
  select.replaceChildren(new Option(label,''),...values.map(v=>new Option(v,v)));
  if(values.includes(selected)) select.value=selected;
}
function availableModels() {
  const provider=view.provider.value;
  choices(view.model,'全部模型',[...new Set(records.filter(r=>!provider||r.provider===provider).map(r=>r.model))].sort());
}
function render() {
  const provider=view.provider.value,model=view.model.value,stream=view.stream.value;
  const matching=records.filter(r=>(!provider||r.provider===provider)&&(!model||r.model===model)&&(!stream||r.streaming===(stream==='stream')));
  const pages=Math.max(1,Math.ceil(matching.length/pageSize));
  page=Math.min(page,pages-1);
  const rows=matching.slice(page*pageSize,(page+1)*pageSize);
  view.rows.innerHTML=rows.length?rows.map(r=>{
    const fields=[escapeHTML(r.provider)+' / '+escapeHTML(r.model),
      ...['uncached_input_tokens','cache_read_tokens','cache_write_tokens','output_tokens'].map(k=>number.format(r[k])),
      r.streaming?'流式':'非流式',r.ttft_ms==null?'—':number.format(r.ttft_ms),number.format(r.duration_ms),
      '$'+escapeHTML(String(r.upstream_usd_per_request_exact).replace(/0+$/,'').replace(/\.$/,''))];
    return '<tr>'+fields.map(v=>'<td>'+v+'</td>').join('')+'</tr>';
  }).join(''):'<tr><td colspan="9" class="empty">没有匹配的模拟样例。</td></tr>';
  view.label.textContent=number.format(matching.length)+' 条模拟样例 · 第 '+(page+1)+' / '+pages+' 页';
  view.prev.disabled=page===0;
  view.next.disabled=page+1>=pages;
}
try{
  const response=await fetch('./data/sample.json');
  if(!response.ok) throw Error('HTTP '+response.status);
  const payload=await response.json();
  records=payload.rows;
  choices(view.provider,'全部供应商',[...new Set(records.map(r=>r.provider))].sort());
  availableModels();
  view.provider.onchange=()=>{availableModels();page=0;render();};
  view.model.onchange=view.stream.onchange=()=>{page=0;render();};
  view.prev.onclick=()=>{page--;render();};
  view.next.onclick=()=>{page++;render();};
  render();
}catch(error){
  console.error(error);
  view.label.textContent='模拟请求样例加载失败。请刷新后重试。';
}


