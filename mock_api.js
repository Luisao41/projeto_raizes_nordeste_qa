'use strict';
// API de referência descartável para validação acadêmica de QA.
// NÃO é o sistema Raízes do Nordeste nem deve ser exposta à internet/produção.
const http = require('node:http');
const crypto = require('node:crypto');
const PORT = Number(process.env.PORT || 3000);
const orders = new Map();
const events = [];
const preferences = { personalizacaoFidelidade: true, comunicacoesPromocionais: false };
let nextOrder = 1;
let nextRequest = 1;
const TOKEN_CUSTOMER = 'qa-customer-token-reference-only';

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined || status === 204 ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('payload_limit'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}
function authRole(req) {
  const raw = req.headers.authorization || '';
  if (raw === `Bearer ${TOKEN_CUSTOMER}`) return 'customer';
  if (raw === 'Bearer qa-admin-token-reference-only') return 'admin';
  if (raw.startsWith('Bearer ')) return 'invalid';
  return 'anonymous';
}
function addEvent(action, req, details = {}) {
  // Não armazena corpo bruto, senha, token nem dados de cartão.
  events.push({ action, correlationId: String(details.correlationId || req.headers['x-correlation-id'] || 'qa-no-correlation'), at: new Date().toISOString(), ...details });
  if (events.length > 2000) events.shift();
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  const method = req.method || 'GET';
  const role = authRole(req);
  let body;
  try {
    if (['POST', 'PUT', 'PATCH'].includes(method)) body = await readBody(req);
  } catch (e) {
    return send(res, 400, { error: 'invalid_request', message: 'Requisição inválida.' });
  }
  try {
    if (method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', target: 'mock-reference-only' });

    if (method === 'POST' && path === '/auth/login') {
      const email = String(body.email || '');
      const senha = String(body.senha || '');
      const injection = /('|--|;|\bor\b\s*1\s*=\s*1|union\s+select)/i.test(email + ' ' + senha);
      const valid = email === 'cliente.qa@example.test' && senha === 'SenhaFicticia-123' && !injection;
      addEvent(valid ? 'login_success' : 'login_rejected', req, { reason: injection ? 'input_rejected' : 'credentials_rejected' });
      if (!valid) return send(res, 401, { error: 'unauthorized', message: 'Credenciais inválidas.' });
      return send(res, 200, { accessToken: TOKEN_CUSTOMER, tokenType: 'Bearer', expiresIn: 900, customerId: 'cliente-teste-01' });
    }

    if (method === 'GET' && /^\/units\/[^/]+\/menu$/.test(path)) {
      const unitId = path.split('/')[2];
      return send(res, 200, { unitId, items: [{ productId: 'produto-teste-01', name: 'Tapioca QA', available: true, seasonal: false }, { productId: 'produto-sazonal-01', name: 'Cuscuz Junino QA', available: true, seasonal: true }] });
    }
    if (method === 'GET' && /^\/units\/[^/]+\/stock$/.test(path)) {
      const unitId = path.split('/')[2];
      const productId = url.searchParams.get('productId') || 'produto-teste-01';
      return send(res, 200, { unitId, productId, available: true, quantity: 25 });
    }

    if (method === 'POST' && path === '/orders') {
      if (role !== 'customer' && role !== 'admin') return send(res, 401, { error: 'unauthorized', message: 'Autenticação necessária.' });
      if (!Array.isArray(body.items) || body.items.length === 0 || !body.unitId) return send(res, 422, { error: 'validation_error', message: 'Informe a unidade e pelo menos um item.' });
      const id = `order-${String(nextOrder++).padStart(4, '0')}`;
      const order = { orderId: id, customerId: body.customerId || 'cliente-teste-01', unitId: body.unitId, channel: body.channel || 'APP', items: body.items, status: 'aguardando pagamento', paymentStatus: 'pending', correlationId: String(body.correlationId || 'qa-correlation-missing'), createdAt: new Date().toISOString() };
      orders.set(id, order);
      addEvent('order_created', req, { orderId: id, unitId: order.unitId, correlationId: order.correlationId });
      return send(res, 201, order);
    }
    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (method === 'GET' && orderMatch) {
      if (role !== 'customer' && role !== 'admin') return send(res, 401, { error: 'unauthorized', message: 'Autenticação necessária.' });
      const order = orders.get(decodeURIComponent(orderMatch[1]));
      if (!order) return send(res, 404, { error: 'not_found', message: 'Pedido não encontrado.' });
      if (role === 'customer' && order.customerId !== 'cliente-teste-01') return send(res, 403, { error: 'forbidden', message: 'Acesso negado.' });
      return send(res, 200, order);
    }

    if (method === 'POST' && path === '/payments/mock') {
      if (role !== 'customer' && role !== 'admin') return send(res, 401, { error: 'unauthorized', message: 'Autenticação necessária.' });
      const order = orders.get(String(body.orderId || ''));
      if (!order) return send(res, 404, { error: 'order_not_found', message: 'Pedido de teste não encontrado.' });
      if (order.paymentStatus !== 'pending') return send(res, 409, { error: 'payment_already_processed', message: 'Pagamento já processado.' });
      const scenario = body.scenario === 'declined' ? 'declined' : 'approved';
      const paymentId = `payment-${crypto.randomUUID()}`;
      if (scenario === 'approved') {
        order.paymentStatus = 'approved';
        order.status = 'em preparo';
      } else {
        order.paymentStatus = 'declined';
        order.status = 'pagamento não aprovado';
      }
      order.paymentId = paymentId;
      addEvent('payment_processed', req, { orderId: order.orderId, unitId: order.unitId, correlationId: body.correlationId || order.correlationId, outcome: scenario });
      return send(res, 200, { paymentId, orderId: order.orderId, status: scenario, orderStatus: order.status, correlationId: body.correlationId || order.correlationId });
    }

    if (path.startsWith('/privacy/')) {
      if (role !== 'customer' && role !== 'admin') return send(res, 401, { error: 'unauthorized', message: 'Autenticação necessária.' });
      if (method === 'GET' && path === '/privacy/preferences') return send(res, 200, { ...preferences });
      if (method === 'PUT' && path === '/privacy/preferences') {
        if (typeof body.personalizacaoFidelidade !== 'boolean' || typeof body.comunicacoesPromocionais !== 'boolean') return send(res, 422, { error: 'validation_error', message: 'As preferências devem ser booleanas.' });
        Object.assign(preferences, body);
        addEvent('privacy_preferences_updated', req, { correlationId: req.headers['x-correlation-id'] || 'qa-privacy-test' });
        return send(res, 200, { ...preferences, updated: true });
      }
      if (method === 'GET' && path === '/privacy/data') return send(res, 200, { customerId: 'cliente-teste-01', data: { nomeExibicao: 'Cliente QA', email: 'cliente.qa@example.test', preferences: { ...preferences } }, personalDataFiltered: true });
      if (method === 'POST' && ['/privacy/correction-requests', '/privacy/deletion-requests'].includes(path)) {
        const requestId = `privacy-request-${String(nextRequest++).padStart(4, '0')}`;
        addEvent(path.includes('deletion') ? 'deletion_requested' : 'correction_requested', req, { requestId, correlationId: body.correlationId || 'qa-privacy-test' });
        return send(res, 202, { requestId, status: 'received', message: 'Solicitação registrada para tratamento; nenhuma conta real foi alterada.' });
      }
      if (method === 'POST' && path === '/privacy/consent-revocations') {
        const consents = Array.isArray(body.consents) ? body.consents : [];
        for (const c of consents) if (Object.hasOwn(preferences, c)) preferences[c] = false;
        addEvent('consent_revoked', req, { correlationId: body.correlationId || 'qa-privacy-test' });
        return send(res, 200, { status: 'revoked', revoked: consents, preferences: { ...preferences } });
      }
    }

    if (method === 'GET' && path === '/audit/events') {
      if (role !== 'admin') return send(res, role === 'anonymous' || role === 'invalid' ? 401 : 403, { error: role === 'customer' ? 'forbidden' : 'unauthorized', message: 'Acesso restrito à equipe autorizada.' });
      const corr = url.searchParams.get('correlationId');
      return send(res, 200, { events: events.filter(e => !corr || e.correlationId === corr) });
    }
    if (method === 'GET' && path === '/reports/head-office') {
      if (role !== 'admin') return send(res, role === 'anonymous' || role === 'invalid' ? 401 : 403, { error: role === 'customer' ? 'forbidden' : 'unauthorized', message: 'Acesso restrito à matriz.' });
      return send(res, 200, { unitId: url.searchParams.get('unitId') || 'unidade-teste-01', totals: { orders: orders.size }, note: 'Resumo demonstrativo; nenhum dado pessoal real.' });
    }
    return send(res, 404, { error: 'not_found', message: 'Recurso não encontrado.' });
  } catch (e) {
    // Nunca devolver stack trace nem SQL interno ao cliente.
    return send(res, 500, { error: 'internal_error', message: 'Erro interno controlado.' });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`READY http://127.0.0.1:${PORT}/api (MOCK ONLY)`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
