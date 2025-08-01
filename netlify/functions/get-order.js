// Netlify Function: get-order (v2.1)
// -----------------------------------
// ✱ Change log (2025‑08‑01)
// • NOW filters out label‑only shipments: frontend receives **only** parcels that
//   17TRACK shows as scanned (actuallyShipped==true) or already delivered.
// • Re‑calculates shipment counts after filtering so numbering stays correct.
// • Minor tidy‑ups in comments; logic otherwise unchanged from v2.

const https = require('https');
const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true });

// ------------------------------- Constants
const SEVENTEEN_HOST = 'api.17track.net';
const SEVENTEEN_PATH = '/track/v2.2';
const SHIPSTATION_HOST = 'ssapi.shipstation.com';
const DEFAULT_TIMEOUT = 15_000; // ms
const MAX_RETRIES = 3;

// ------------------------------- Schemas
const requestSchema = {
  type: 'object',
  properties: {
    orderNumber: { type: 'string', minLength: 3 },
    email: {
      type: 'string',
      pattern: '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    }
  },
  required: ['orderNumber', 'email'],
  additionalProperties: false
};
const validateRequest = ajv.compile(requestSchema);

// ------------------------------- Helpers
const respond = (statusCode, body = {}, headers = {}) => ({
  statusCode,
  headers: {
    'Access-Control-Allow-Origin': 'https://www.cameupinthedrought.com', // TODO: env‑var
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    ...headers
  },
  body: JSON.stringify(body)
});

// ShipStation carrier → 17TRACK numeric code
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
  return map[code.toLowerCase()] ?? 0; // 0 = auto‑detect
}

// Parse 17TRACK v2.2 track_info block
function parse17(trackInfo = {}) {
  const info = trackInfo.track_info || trackInfo.track || {};
  const latest = info.latest_status || {};
  const events = info.events || info.z0 || [];
  const status = (latest.status || '').toLowerCase(); // e.g. intransit
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

// HTTPS request with timeout & retries (429 / 5xx)
function httpsRequest(opts, body = null, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...opts }, res => {
      let data = '';
      res.on('data', d => (data += d));
      res.on('end', () => {
        // retry logic
        if ((res.statusCode === 429 || res.statusCode >= 500) && attempt < MAX_RETRIES) {
          const delay = 2 ** attempt * 500;
          return setTimeout(() =>
            httpsRequest(opts, body, attempt + 1).then(resolve, reject),
            delay
          );
        }
        // success
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            return resolve(JSON.parse(data || '{}'));
          } catch {
            return reject(new Error('JSON parse error'));
          }
        }
        // error
        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
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

// -------- ShipStation generic GET
action("-ssRequest");
async function ssRequest(path, auth) {
  const opts = {
    hostname: SHIPSTATION_HOST,
    path,
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      'User-Agent': 'Drought-Order-Tracker/2.1',
      'Content-Type': 'application/json'
    }
  };
  return httpsRequest(opts);
}

// -------- 17TRACK POST
async function t17Request(endpoint, data, apiKey) {
  const body = JSON.stringify(data);
  const opts = {
    hostname: SEVENTEEN_HOST,
    path: `${SEVENTEEN_PATH}${endpoint}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      '17token': apiKey
    }
  };
  return httpsRequest(opts, body);
}

// Verify shipment list via 17TRACK – returns array w/ actuallyShipped flag
async function verifyShipments(shipments, apiKey) {
  const verified = [];
  for (const sh of shipments) {
    const number = sh.trackingNumber;
    if (!number) {
      verified.push({ ...sh, actuallyShipped: false });
      continue;
    }
    const carrier = mapCarrierTo17(sh.carrierCode);
    // Register (fire & forget)
    try {
      await t17Request('/register', [{ number, carrier }], apiKey);
    } catch {}
    // Fetch info
    let trackResp;
    try {
      trackResp = await t17Request('/gettrackinfo', [{ number, carrier }], apiKey);
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
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }
  if (!validateRequest(body)) {
    return respond(400, { error: 'Invalid parameters', details: ajv.errorsText(validateRequest.errors) });
  }

  const { orderNumber, email } = body;
  const apiKey = process.env.SHIPSTATION_API_KEY;
  const apiSecret = process.env.SHIPSTATION_API_SECRET;
  const t17Key = process.env.SEVENTEEN_TRACK_API_KEY;
  if (!apiKey || !apiSecret) return respond(500, { error: 'ShipStation credentials missing' });

  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  // ---------- Fetch order
  let orderData;
  try {
    const params = new URLSearchParams({ orderNumber, customerEmail: email });
    orderData = await ssRequest(`/orders?${params}`, auth);
  } catch (e) {
    return respond(502, { error: e.message });
  }
  if (!orderData.orders?.length) return respond(404, { error: 'Order not found' });

  const order = orderData.orders.find(o => o.orderNumber === orderNumber && o.customerEmail.toLowerCase() === email.toLowerCase());
  if (!order) return respond(404, { error: 'Order not found' });

  // ---------- Fetch shipments (labels generated in ShipStation)
  let shipments = [];
  try {
    const shResp = await ssRequest(`/shipments?orderNumber=${orderNumber}`, auth);
    shipments = shResp.shipments || [];
  } catch {}

  // ---------- Verify with 17TRACK then FILTER out label‑only parcels
  let verified = shipments;
  if (t17Key && shipments.length) verified = await verifyShipments(shipments, t17Key);

  // Keep only shipments that have at least one courier scan or are delivered
  verified = verified.filter(s => s.actuallyShipped || s.isDelivered);

  // Renumber after filtering
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

// --------------------- util stubs (unchanged)
function generateTrackingUrl() {
  return null;
}
function checkShipmentDeliveryStatus() {
  return false;
}
