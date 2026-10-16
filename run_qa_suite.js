'use strict';
// Executa localmente os scripts pm.test da coleção em um runtime compatível mínimo.
// Não é Postman/Newman oficial; serve como evidência reprodutível contra o mock acadêmico.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const ROOT = path.resolve(__dirname, '..');
const COLLECTION_PATH = path.join(ROOT, 'Raizes_do_Nordeste_Postman_Collection.json');
const REPORT_DIR = path.join(ROOT, 'evidencias');
const API_SCRIPT = path.join(__dirname, 'mock_api.js');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000/api';
const LOAD_USERS = 500;
const LOAD_DURATION_MS = 30_000; // teste de fumaça abreviado, NÃO o ensaio de resistência de 10 min do CT08
const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function walkItems(items, prefix='') {
  const out = [];
  for (const item of items || []) {
    const p = `${prefix}/${item.name}`;
    if (item.request) out.push({ ...item, _path: p });
    if (item.item) out.push(...walkItems(item.item, p));
  }
  return out;
}
function substitute(value, vars) {
  return String(value ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`));
}
function makeExpectation(actual) {
  let negated = false;
  const root = {};
  const proxy = new Proxy(root, {
    get(_target, prop) {
      if (prop === 'to' || prop === 'be' || prop === 'that' || prop === 'have' || prop === 'and') return proxy;
      if (prop === 'not') { negated = !negated; return proxy; }
      if (prop === 'eql' || prop === 'equal') return expected => { const pass = Object.is(actual, expected); if (pass === negated) throw new Error(`expected ${JSON.stringify(actual)} ${negated?'not ':''}to equal ${JSON.stringify(expected)}`); negated = false; };
      if (prop === 'within') return (min,max) => { const pass = actual >= min && actual <= max; if (pass === negated) throw new Error(`expected ${actual} ${negated?'not ':''}to be within ${min}..${max}`); negated = false; };
      if (prop === 'oneOf') return arr => { const pass = arr.includes(actual); if (pass === negated) throw new Error(`expected ${JSON.stringify(actual)} ${negated?'not ':''}to be one of ${JSON.stringify(arr)}`); negated = false; };
      if (prop === 'include' || prop === 'includes') return expected => { const pass = typeof actual === 'string' ? actual.includes(expected) : Array.isArray(actual) ? actual.includes(expected) : (actual && Object.prototype.hasOwnProperty.call(actual, expected)); if (pass === negated) throw new Error(`expected ${JSON.stringify(actual)} ${negated?'not ':''}to include ${JSON.stringify(expected)}`); negated = false; };
      if (prop === 'a' || prop === 'an') return expected => { let pass; if (expected === 'array') pass = Array.isArray(actual); else if (expected === 'null') pass = actual === null; else pass = typeof actual === expected; if (pass === negated) throw new Error(`expected value ${JSON.stringify(actual)} ${negated?'not ':''}to be a ${expected}`); negated = false; };
      if (prop === 'above' || prop === 'greaterThan') return expected => { const pass = actual > expected; if (pass === negated) throw new Error(`expected ${actual} ${negated?'not ':''}to be above ${expected}`); negated = false; };
      if (prop === 'least') return expected => { const pass = actual >= expected; if (pass === negated) throw new Error(`expected ${actual} ${negated?'not ':''}to be at least ${expected}`); negated = false; };
      if (prop === 'true') { const pass = actual === true; if (pass === negated) throw new Error(`expected ${actual} ${negated?'not ':''}to be true`); negated = false; return true; }
      if (prop === 'false') { const pass = actual === false; if (pass === negated) throw new Error(`expected ${actual} ${negated?'not ':''}to be false`); negated = false; return true; }
      return proxy;
    }
  });
  return proxy;
}
function postmanTestRuntime(response, vars, reqChecks) {
  const text = response.bodyText;
  let parsedJson;
  const responseObj = {
    code: response.status,
    responseTime: response.durationMs,
    text: () => text,
    json: () => { try { return JSON.parse(text); } catch { throw new Error('response is not valid JSON'); } },
  };
  Object.defineProperty(responseObj, 'to', { value: { be: {} } });
  Object.defineProperty(responseObj.to.be, 'json', { get() { try { parsedJson = JSON.parse(text); if (parsedJson === undefined) throw 0; } catch { throw new Error('expected JSON response'); } return true; } });
  const collectionVars = {
    set: (k,v) => { vars[k] = String(v); },
    get: k => vars[k],
  };
  const pm = {
    response: responseObj,
    collectionVariables: collectionVars,
    variables: { get: k => vars[k] },
    environment: { get: k => vars[k], set: (k,v) => { vars[k] = String(v); } },
    expect: actual => makeExpectation(actual),
    test: (name, fn) => {
      try { fn(); reqChecks.push({ name, status: 'PASS', detail: '' }); }
      catch (e) { reqChecks.push({ name, status: 'FAIL', detail: String(e.message || e) }); }
    },
  };
  return { pm };
}
async function startMock() {
  const child = spawn(process.execPath, [API_SCRIPT], { env: { ...process.env, PORT: '3000' }, stdio: ['ignore','pipe','pipe'] });
  let buffer = '';
  const started = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout esperando API mock')), 8000);
    child.stdout.on('data', b => { buffer += b.toString(); if (buffer.includes('READY ')) { clearTimeout(timeout); resolve(); } });
    child.stderr.on('data', b => { buffer += b.toString(); });
    child.on('exit', code => { if (code !== null && code !== 0) reject(new Error(`API mock encerrou com ${code}: ${buffer}`)); });
  });
  await started;
  return child;
}
async function runCollection() {
  const collection = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
  const vars = Object.fromEntries((collection.variable || []).map(v => [v.key, v.value]));
  vars.baseUrl = BASE_URL;
  vars.accessToken = '';
  vars.orderId = '';
  vars.orderIdDeclined = '';
  const requests = walkItems(collection.item);
  const requestReports = [];
  for (const item of requests) {
    const request = item.request;
    const method = request.method || 'GET';
    const urlString = substitute(request.url?.raw || '', vars);
    const headers = {};
    for (const h of request.header || []) headers[h.key] = substitute(h.value, vars);
    const bodyRaw = request.body?.raw ? substitute(request.body.raw, vars) : undefined;
    const start = performance.now();
    let resp;
    try {
      const response = await fetch(urlString, { method, headers, body: bodyRaw, signal: AbortSignal.timeout(10000) });
      const bodyText = await response.text();
      resp = { status: response.status, bodyText, durationMs: +(performance.now() - start).toFixed(2) };
    } catch (e) {
      resp = { status: 0, bodyText: String(e.message || e), durationMs: +(performance.now() - start).toFixed(2), transportError: true };
    }
    const assertions = [];
    const scripts = (item.event || []).filter(e => e.listen === 'test').flatMap(e => e.script?.exec || []);
    if (scripts.length) {
      try { vm.runInNewContext(scripts.join('\n'), postmanTestRuntime(resp, vars, assertions), { timeout: 3000 }); }
      catch (e) { assertions.push({ name: 'Execução do script de teste', status: 'FAIL', detail: String(e.message || e) }); }
    } else assertions.push({ name: 'Scripts de teste disponíveis', status: 'FAIL', detail: 'Nenhum script de teste encontrado.' });
    requestReports.push({ request: item.name, group: item._path.split('/')[1] || '', method, url: urlString, httpStatus: resp.status, durationMs: resp.durationMs, assertions, status: assertions.every(a => a.status === 'PASS') ? 'PASS' : 'FAIL', transportError: !!resp.transportError });
  }
  const totalAssertions = requestReports.reduce((n,r)=>n+r.assertions.length,0);
  const passedAssertions = requestReports.reduce((n,r)=>n+r.assertions.filter(a=>a.status==='PASS').length,0);
  return { startedAt: nowIso(), type: 'Execução local de scripts Postman por runtime de compatibilidade mínimo', officialPostmanNewman: false, target: 'API mock local descartável; não é produto implantado', requestCount: requestReports.length, totalAssertions, passedAssertions, failedAssertions: totalAssertions-passedAssertions, requestResults: requestReports, status: passedAssertions===totalAssertions?'PASS':'FAIL' };
}
function percentile(values, p) { if (!values.length) return null; const s=[...values].sort((a,b)=>a-b); return +s[Math.min(s.length-1,Math.ceil(p*s.length)-1)].toFixed(2); }
async function runLoadSmoke() {
  const durations=[]; const samples=[]; let ok=0, errors=0; const start=performance.now(); const until=start+LOAD_DURATION_MS;
  const worker = async () => {
    while (performance.now() < until) {
      const t=performance.now();
      try { const r=await fetch(`${BASE_URL}/units/unidade-teste-01/menu`,{signal:AbortSignal.timeout(5000)}); await r.arrayBuffer(); const ms=performance.now()-t; durations.push(ms); samples.push({status:r.status,durationMs:+ms.toFixed(2)}); if(r.status===200) ok++; else errors++; }
      catch (e) { errors++; samples.push({status:0,durationMs:+(performance.now()-t).toFixed(2),error:String(e.message||e)}); }
      await sleep(1000);
    }
  };
  await Promise.all(Array.from({length:LOAD_USERS},worker));
  const elapsed=(performance.now()-start)/1000;
  return { type:'Teste de carga complementar contra mock local (não JMeter)', users:LOAD_USERS, durationSeconds:+elapsed.toFixed(2), requestCount:ok+errors, successfulRequests:ok, errors, errorRatePercent:+((errors/Math.max(1,ok+errors))*100).toFixed(3), requestsPerSecond:+((ok+errors)/elapsed).toFixed(2), latencyMs:{p50:percentile(durations,.50),p90:percentile(durations,.90),p95:percentile(durations,.95),p99:percentile(durations,.99),max:durations.length?+Math.max(...durations).toFixed(2):null}, targetP95Under2000ms:durations.length?percentile(durations,.95)<2000:false, matchesCT08FullProfile:false, limitation:'30 segundos de duração prática neste relatório, inferior aos 10 minutos previstos no CT08; ambiente é apenas um mock local e não substitui JMeter nem teste do sistema real.', samples };
}
async function runSecurityChecks() {
 const checks=[];
 const check=async(name, method, url, opts, expected, bodyPredicate)=>{
  const t=performance.now(); let response, textBody='';
  try { response=await fetch(`${BASE_URL}${url}`,{method,...opts,signal:AbortSignal.timeout(5000)}); textBody=await response.text(); const pass=response.status===expected && (!bodyPredicate || bodyPredicate(textBody)); checks.push({name,status:pass?'PASS':'FAIL',httpStatus:response.status,expectedStatus:expected,durationMs:+(performance.now()-t).toFixed(2),detail:pass?'':`Resposta inesperada: HTTP ${response.status}; corpo ${textBody.slice(0,160)}`}); }
  catch(e){checks.push({name,status:'FAIL',detail:String(e.message||e)});}
 };
 await check('SEC-01 — Preferências sem autenticação', 'GET','/privacy/preferences',{},401,b=>!b.toLowerCase().includes('stack trace'));
 await check('SEC-02 — Pedido sem autenticação', 'GET','/orders/order-0001',{},401,b=>!b.toLowerCase().includes('stack trace'));
 await check('SEC-03 — SQL injection rejeitada', 'POST','/auth/login',{headers:{'Content-Type':'application/json'},body:JSON.stringify({email:"' OR 1=1--",senha:'invalida'})},401,b=>!b.toLowerCase().includes('sql syntax')&&!b.toLowerCase().includes('stack trace'));
 await check('SEC-04 — Cliente não acessa auditoria', 'GET','/audit/events?correlationId=qa-correlation-001',{headers:{Authorization:'Bearer qa-customer-token-reference-only'}},403,b=>JSON.parse(b).error==='forbidden');
 await check('SEC-05 — Cliente não acessa relatório da matriz', 'GET','/reports/head-office?unitId=unidade-teste-01',{headers:{Authorization:'Bearer qa-customer-token-reference-only'}},403,b=>JSON.parse(b).error==='forbidden');
 await check('SEC-06 — JSON inválido retorna erro controlado', 'POST','/auth/login',{headers:{'Content-Type':'application/json'},body:'{"email":'},400,b=>!b.toLowerCase().includes('stack trace')&&!b.toLowerCase().includes('sql syntax'));
 return {type:'Verificações negativas complementares contra mock local (não OWASP ZAP)', checks, passed:checks.filter(c=>c.status==='PASS').length, failed:checks.filter(c=>c.status==='FAIL').length, officialOwaspZap:false, conclusion:'Os checks indicam apenas o comportamento observado no mock de referência; não constituem varredura OWASP ZAP nem atestado de segurança do produto real.'};
}
async function runGherkinMappedScenarios(loadResult) {
 const cases=[]; const record=(id,name,status,details)=>cases.push({id,name,status,details});
 try {
  const login=await fetch(`${BASE_URL}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'cliente.qa@example.test',senha:'SenhaFicticia-123'})});
  const auth=await login.json(); record('CT01','Login válido no APP',login.status===200 && typeof auth.accessToken==='string'?'PASS':'FAIL',`HTTP ${login.status}; token ${typeof auth.accessToken==='string'?'presente':'ausente'} no mock.`);
 } catch(e){record('CT01','Login válido no APP','FAIL',String(e.message||e));}
 try {
  const headers={'Content-Type':'application/json',Authorization:'Bearer qa-customer-token-reference-only'};
  const orderResponse=await fetch(`${BASE_URL}/orders`,{method:'POST',headers,body:JSON.stringify({customerId:'cliente-teste-01',unitId:'unidade-ct03',channel:'APP',items:[{productId:'produto-teste-01',quantity:1}],correlationId:'ct03-correlation'})});
  const order=await orderResponse.json();
  const payResponse=await fetch(`${BASE_URL}/payments/mock`,{method:'POST',headers,body:JSON.stringify({orderId:order.orderId,scenario:'approved',correlationId:'ct03-correlation'})});
  const pay=await payResponse.json();
  const pass=orderResponse.status===201 && payResponse.status===200 && pay.status==='approved' && pay.orderStatus==='em preparo' && pay.correlationId==='ct03-correlation';
  record('CT03','Pedido concluído com pagamento aprovado',pass?'PASS':'FAIL',`Pedido HTTP ${orderResponse.status}; pagamento HTTP ${payResponse.status}; status ${pay.orderStatus || 'ausente'}; mock.`);
 } catch(e){record('CT03','Pedido concluído com pagamento aprovado','FAIL',String(e.message||e));}
 try {
  const headers={'Content-Type':'application/json',Authorization:'Bearer qa-customer-token-reference-only'};
  const orderResponse=await fetch(`${BASE_URL}/orders`,{method:'POST',headers,body:JSON.stringify({customerId:'cliente-teste-01',unitId:'unidade-ct04',channel:'APP',items:[{productId:'produto-teste-01',quantity:1}],correlationId:'ct04-correlation'})});
  const order=await orderResponse.json();
  const payResponse=await fetch(`${BASE_URL}/payments/mock`,{method:'POST',headers,body:JSON.stringify({orderId:order.orderId,scenario:'declined',correlationId:'ct04-correlation'})});
  const pay=await payResponse.json();
  const pass=orderResponse.status===201 && payResponse.status===200 && pay.status==='declined' && pay.orderStatus==='pagamento não aprovado' && pay.orderStatus!=='em preparo';
  record('CT04','Pagamento negado não confirma o pedido',pass?'PASS':'FAIL',`Pedido HTTP ${orderResponse.status}; pagamento HTTP ${payResponse.status}; status final ${pay.orderStatus || 'ausente'}; mock.`);
 } catch(e){record('CT04','Pagamento negado não confirma o pedido','FAIL',String(e.message||e));}
 const loadEnough=loadResult.users===500 && loadResult.durationSeconds>=600 && loadResult.targetP95Under2000ms && loadResult.errorRatePercent<=0.5;
 const loadPartial=loadResult.users===500 && loadResult.successfulRequests>0 && loadResult.targetP95Under2000ms;
 record('CT08','Atendimento a 500 usuários simultâneos',loadEnough?'PASS':loadPartial?'PARCIAL':'FAIL',`Mock: ${loadResult.users} clientes simulados, ${loadResult.durationSeconds}s, p95 ${loadResult.latencyMs.p95}ms, erros ${loadResult.errorRatePercent}%. Não atende à duração completa de 10 minutos; não é JMeter nem teste do produto.`);
 try {
  const response=await fetch(`${BASE_URL}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:"' OR 1=1--",senha:'invalida'})}); const txt=await response.text();
  const pass=response.status===401 && !txt.toLowerCase().includes('sql syntax') && !txt.toLowerCase().includes('stack trace') && !txt.includes('accessToken');
  record('CT10','Tentativa de SQL Injection no login',pass?'PASS':'FAIL',`HTTP ${response.status}; token ausente; sem stack trace/erro SQL no mock.`);
 } catch(e){record('CT10','Tentativa de SQL Injection no login','FAIL',String(e.message||e));}
 return {type:'Execução mapeada dos cinco cenários Gherkin em código de referência; não foi usado Cucumber oficial', scenarios:cases, passed:cases.filter(c=>c.status==='PASS').length, partial:cases.filter(c=>c.status==='PARCIAL').length, failed:cases.filter(c=>c.status==='FAIL').length, limitation:'As ações foram implementadas em testes de referência contra a API mock local. Não prova execução do sistema real; CT08 permanece parcial por duração e ferramenta.'};
}
(async()=>{
 fs.mkdirSync(REPORT_DIR,{recursive:true});
 const startedAt=nowIso(); let server;
 try {
  server=await startMock();
  const collection=await runCollection();
  const load=await runLoadSmoke();
  const security=await runSecurityChecks();
  const gherkin=await runGherkinMappedScenarios(load);
  const report={project:'Raízes do Nordeste — pacote acadêmico de QA',startedAt,finishedAt:nowIso(),executionMode:'local / loopback only',target:'API mock descartável construída para a atividade; nenhuma aplicação real foi fornecida.',collection,load:{...load,samples:undefined},security,gherkin,overallStatus:(collection.status==='PASS'&&security.failed===0&&gherkin.failed===0)?'PASS_COM_LIMITAÇÕES':'REVISAR',importantLimitations:['Não é uma execução do Postman/Newman oficial: os scripts pm.test foram processados por um runtime de compatibilidade local mínimo.','O Gherkin foi mapeado a verificações automatizadas locais; não foi usado runner Cucumber oficial.','O ensaio de carga foi um smoke test abreviado de 30 segundos com 500 clientes contra o mock, inferior aos 10 minutos previstos no CT08; JMeter não foi executado.','Os checks de segurança foram verificações negativas contra o mock; OWASP ZAP não foi executado.','Nenhum resultado neste relatório valida uma implementação real da Raízes do Nordeste ou pode aprovar uma release real.']};
  const out=path.join(REPORT_DIR,'relatorio_execucao_mock_qa.json'); fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  const csv=['id,status,duration_ms,error']; load.samples.forEach((x,i)=>csv.push(`${i+1},${x.status},${x.durationMs},${JSON.stringify(x.error||'').replace(/\n/g,' ')}`)); fs.writeFileSync(path.join(REPORT_DIR,'carga_local_mock.csv'),csv.join('\n')+'\n');
  const lines=[];
  lines.push('RELATÓRIO DE EXECUÇÃO LOCAL — RAÍZES DO NORDESTE');
  lines.push(`Início: ${report.startedAt}`); lines.push(`Fim: ${report.finishedAt}`); lines.push('Alvo: API mock local descartável, não é sistema real.'); lines.push('');
  lines.push(`POSTMAN COMPAT — ${collection.status}: ${collection.passedAssertions}/${collection.totalAssertions} asserções; ${collection.requestCount} requisições; Newman/Postman oficial: NÃO.`);
  for(const r of collection.requestResults) lines.push(`  ${r.status.padEnd(4)} HTTP ${String(r.httpStatus).padEnd(3)} ${r.request} (${r.durationMs} ms) — ${r.assertions.filter(a=>a.status==='PASS').length}/${r.assertions.length} asserções`);
  lines.push(''); lines.push(`CARGA — ${load.requestCount} requisições; ${load.users} clientes concorrentes; ${load.durationSeconds}s; p95 ${load.latencyMs.p95} ms; erros ${load.errors} (${load.errorRatePercent}%); throughput ${load.requestsPerSecond} req/s.`);
  lines.push('  LIMITE: smoke test de 30 s no mock; não é JMeter e não substitui CT08 de 10 min.');
  lines.push(''); lines.push(`SEGURANÇA COMPLEMENTAR — ${security.passed}/${security.checks.length} checks passaram; OWASP ZAP oficial: NÃO.`);
  for(const c of security.checks) lines.push(`  ${c.status.padEnd(4)} ${c.name} — HTTP ${c.httpStatus ?? 'N/A'}${c.detail?` — ${c.detail}`:''}`);
  lines.push(''); lines.push('CENÁRIOS GHERKIN MAPEADOS');
  for(const c of gherkin.scenarios) lines.push(`  ${c.status.padEnd(7)} ${c.id} — ${c.name}: ${c.details}`);
  lines.push(''); lines.push('INTERPRETAÇÃO: os resultados demonstram apenas que os artefatos de teste funcionam contra o mock acadêmico. Não demonstram que um produto real cumpre requisitos de qualidade.');
  fs.writeFileSync(path.join(REPORT_DIR,'relatorio_execucao_mock_qa.txt'),lines.join('\n')+'\n');
  console.log(lines.join('\n'));
 } catch(e) { console.error(e.stack||e); process.exitCode=1; }
 finally { if(server) { server.kill('SIGTERM'); await new Promise(resolve=>server.once('exit',resolve)); } }
})();
