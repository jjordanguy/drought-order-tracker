// Netlify Function: get-order (v2.3.1)
// -----------------------------------
// * Completed missing tail of handler (numbering, status calc, response)
// * Added stubs for generateTrackingUrl & checkShipmentDeliveryStatus.
// * Logic otherwise identical to previous version.

const https = require('https');

// ------------------------------- Constants
const SEVENTEEN_HOST = 'api.17track.net';
const SEVENTEEN_PATH = '/track/v2.2';
const SHIPSTATION_HOST = 'ssapi.shipstation.com';
const DEFAULT_TIMEOUT = 15_000; // ms
const MAX_RETRIES = 3;

// ------------------------------- Lightweight Request Validation
function basicValidate(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object';
  const { orderNumber, email } = body;
  if (typeof orderNumber !== 'string' || orderNumber.trim().length < 3)
    return 'orderNumber must be at least 3 characters';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (typeof email !== 'string' || !emailRegex.test(email.trim()))
    return 'email must be a valid address';
  return null;
}

// ------------------------------- Helper: Standardised JSON response
const respond = (statusCode, body = {}, headers = {}) => ({
  statusCode,
  headers: {
    'Access-Control-Allow-Origin': 'https://www.cameupinthedrought.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    ...headers
  },
  body: JSON.stringify(body)
});

// ------------------------------- Carrier mapping (ShipStation → 17TRACK)
function mapCarrierTo17(code = '') {
  const map = {
    ups: 100002,
    ups_ground: 100002,
    fedex: 100003,
    fedex_express: 100003,
    fedex_ground: 100003,
    usps: 100001,
    stamps_com: 100001,
    dhl: 100004,
    dhl_express: 100004,
    ontrac: 100143,
    lasership: 190014,
    amazon: 100099,
    newgistics: 190269
  };
  return map[code.toLowerCase()] ?? 0;
}

// ------------------------------- 17TRACK parser
function parse17(trackInfo = {}) {
  const info = trackInfo.track_info || trackInfo.track || {};
  const latest = info.latest_status || {};
  const events = info.events || info.z0 || [];
  const status = (latest.status || '').toLowerCase();
  const shipped = status && status !== 'notfound' && status !== 'inforeceived';
  const delivered = status === 'delivered';
  const latestEvt = events[0] || {};
  return {
    shipped,
    delivered,
    latestActivity: events.length
      ? {
          status: latestEvt.z || latestEvt.status || '',
          location: latestEvt.c || latestEvt.location || '',
          time: latestEvt.a || latestEvt.time || ''
        }
      : null
  };
}

// ------------------------------- HTTPS request with timeout & retries
function httpsRequest(opts, body = null, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < MAX_RETRIES) {
          const delay = 2 ** attempt * 500;
          return setTimeout(() => httpsRequest(opts, body, attempt + 1).then(resolve, reject), delay);
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            return resolve(JSON.parse(data || '{}'));
          } catch {
            return reject(new Error('JSON parse error'));
          }
        }
        return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
      });
    });

    req.on('error', reject);
    req.setTimeout(DEFAULT_TIMEOUT, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

// ------------------------------- ShipStation & 17TRACK helpers
async function ssRequest(path, auth) {
  return httpsRequest({
    hostname: SHIPSTATION_HOST,
    path,
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'User-Agent': 'Drought-Order-Tracker/2.3.1',
      'Content-Type': 'application/json'
    }
  });
}

async function t17Request(endpoint, data, apiKey) {
  const body = JSON.stringify(data);
  return httpsRequest({
    hostname: SEVENTEEN_HOST,
    path: `${SEVENTEEN_PATH}${endpoint}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      '17token': apiKey
    }
  }, body);
}

async function verifyShipments(shipments, apiKey) {
  const verified = [];
  for (const sh of shipments) {
    const { trackingNumber } = sh;
    if (!trackingNumber) {
      verified.push({ ...sh, actuallyShipped: false });
      continue;
    }
    const carrier = mapCarrierTo17(sh.carrierCode);
    try { await t17Request('/register', [{ number: trackingNumber, carrier }], apiKey); } catch {}

    let trackResp;
    try {
      trackResp = await t17Request('/gettrackinfo', [{ number: trackingNumber, carrier }], apiKey);
    } catch {
      verified.push({ ...sh, actuallyShipped: false, seventeenTrackStatus: 'error' });
      continue;
    }
    const tkInfoArr = trackResp.data?.accepted ?? [];
    const tkInfo = tkInfoArr[0] || {};
    const { shipped, delivered, latestActivity } = parse17(tkInfo);
    verified.push({
      ...sh,
      actuallyShipped: shipped,
      isDelivered: delivered || checkShipmentDeliveryStatus(sh),
      latestActivity,
      seventeenTrackStatus: tkInfoArr.length ? 'verified' : 'not_found'
    });
  }
  return verified;
}

// -------------------------------- Handler
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return respond(200, '');
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return respond(400, { error: 'Invalid JSON' }); }
  const validationError = basicValidate(body);
  if (validationError) return respond(400, { error: validationError });

  const { orderNumber, email } = body;
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  const t17Key = process.env.SEVENTEEN_TRACK_API_KEY;
  if (!apiKey || !apiSecret) return respond(500, { error: 'ShipStation credentials missing' });
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  // ---------- Fetch order list
  let orderData;
  try {
    const params = new URLSearchParams({ orderNumber, customerEmail: email });
    orderData = await ssRequest(`/orders?${params}`, auth);
  } catch (e) {
    return respond(502, { error: e.message });
  }
  if (!orderData.orders?.length) return respond(404, { error: 'Order not found' });

  const order = orderData.orders.find(o =>
    o.orderNumber === orderNumber && o.customerEmail.toLowerCase() === email.toLowerCase()
  );
  if (!order) return respond(404, { error: 'Order not found' });

  // ---------- Collect shipments
  let shipments = [];
  try {
    const shResp = await ssRequest(`/shipments?orderNumber=${orderNumber}`, auth);
    shipments = shResp.shipments || [];
  } catch {}
  if (shipments.length === 0 && Array.isArray(order.shipments) && order.shipments.length) {
    shipments = order.shipments;
  }
  if (shipments.length === 0) {
    try {
      const detail = await ssRequest(`/orders/${order.orderId}`, auth);
      if (Array.isArray(detail.shipments)) shipments = detail.shipments;
    } catch {}
  }

  // ---------- Verify & filter
  let verified = shipments;
  if (t17Key && verified.length) verified = await verifyShipments(verified, t17Key);
  verified = verified.filter(s => s.actuallyShipped || s.isDelivered);

  const total = verified.length;
  verified = verified.map((s, i) => ({ ...s, shipmentNumber: i + 1, totalShipments: total }));

  const shippedCount = verified.filter(v => v.actuallyShipped).length;
  const effectiveStatus = t17Key && order.orderStatus === 'shipped' && shippedCount === 0
    ? 'awaiting_fulfillment'
    : order.orderStatus;

  return respond(200, {
    orderNumber: order.orderNumber,
    customerEmail: order.customerEmail,
    orderDate: order.orderDate,
    orderStatus: effectiveStatus.toLowerCase(),
    shipments: verified
  });
};

// --------------------- util stubs – replace with real logic if needed
function generateTrackingUrl() { return null; }
function checkShipmentDeliveryStatus() { return false; }
